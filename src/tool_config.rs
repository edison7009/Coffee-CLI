//! Per-tool user-configurable launch overrides.
//!
//! Lives at `~/.coffee-cli/tools.json`. Each entry overrides one or more
//! pieces of the built-in defaults for spawning a CLI tool. Empty fields
//! fall through to the built-in behavior — the user only specifies what
//! they want different.
//!
//! Schema:
//! ```json
//! {
//!   "claude": {
//!     "command": "",
//!     "extra_args": ["--dangerously-skip-permissions"],
//!     "default_cwd": "/home/user/work",
//!     "history_path": ""
//!   },
//!   "codex": {
//!     "command": "docker exec mybox codex",
//!     "extra_args": [],
//!     "default_cwd": "",
//!     "history_path": "/var/log/codex-sessions"
//!   }
//! }
//! ```
//!
//! - `command`: full launch executable. Whitespace-split at spawn time —
//!   first token is the binary, the rest are PREPENDED to args. So
//!   `"docker exec mybox codex"` becomes argv `["docker", "exec", "mybox", "codex"]`.
//!   If empty, the built-in default (e.g. `"claude"` for the claude tool)
//!   is used. NOT shell-parsed — paths with spaces are not supported in
//!   v1; document the limitation.
//! - `extra_args`: appended AFTER the built-in args (so `--mcp-config`
//!   etc still come first). String list, NOT split.
//! - `default_cwd`: pre-fills the cwd selector when starting a new tab
//!   of this tool. Empty falls through to the launchpad's last-used cwd.
//! - `history_path`: directory containing this tool's session history
//!   files. Empty falls through to the built-in scan path. Used by the
//!   history board's per-tool collectors.
//!
//! All four fields are independent — set just `extra_args` to add a flag
//! without overriding the binary, set just `command` for a wrapper like
//! `docker exec`, etc.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolConfigEntry {
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default)]
    pub default_cwd: String,
    #[serde(default)]
    pub history_path: String,
}

impl ToolConfigEntry {
    pub fn is_empty(&self) -> bool {
        self.command.is_empty()
            && self.extra_args.is_empty()
            && self.default_cwd.is_empty()
            && self.history_path.is_empty()
    }
}

pub type ToolConfig = HashMap<String, ToolConfigEntry>;

fn config_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".coffee-cli").join("tools.json"))
}

/// Serializes read-modify-write cycles so two saves never lose each other.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Read the config. A missing or empty file is an empty config; a file that
/// cannot be read or parsed is an error, so callers that write never replace
/// a damaged file (the user may have hand-edited it) with a near-empty one.
fn read_config(path: &Path) -> Result<ToolConfig, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("Cannot read {}: {e}", path.display())),
    };
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str::<ToolConfig>(&text).map_err(|e| {
        format!("{} is damaged ({e}). Fix or delete it, then try again.", path.display())
    })
}

/// Launch-time read: a damaged file falls back to the built-in defaults so
/// tools still start. Nothing here ever writes the file back.
pub fn load() -> ToolConfig {
    let Some(p) = config_path() else {
        return HashMap::new();
    };
    read_config(&p).unwrap_or_else(|e| {
        eprintln!("[tool_config] {e}");
        HashMap::new()
    })
}

pub fn get(tool: &str) -> ToolConfigEntry {
    load().remove(tool).unwrap_or_default()
}

fn set_at(path: &Path, tool: &str, entry: ToolConfigEntry) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cfg = read_config(path)?;
    if entry.is_empty() {
        cfg.remove(tool);
    } else {
        cfg.insert(tool.to_string(), entry);
    }
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    crate::json_file::write_atomic(path, body.as_bytes())
        .map_err(|e| format!("Cannot save {}: {e}", path.display()))
}

pub fn set(tool: &str, entry: ToolConfigEntry) -> Result<(), String> {
    let path = config_path().ok_or("Cannot find the home directory")?;
    set_at(&path, tool, entry)
}

/// Whitespace-split the user's `command` field into (binary, prefix_args).
/// Returns (None, vec![]) for an empty string — caller falls through to
/// built-in defaults in that case.
pub fn parse_command(cmd: &str) -> (Option<String>, Vec<String>) {
    let mut parts = cmd.split_whitespace();
    let Some(bin) = parts.next() else {
        return (None, vec![]);
    };
    let rest: Vec<String> = parts.map(|s| s.to_string()).collect();
    (Some(bin.to_string()), rest)
}

/// Keep the previous default command bound to its original tool.
pub fn command_binary<'a>(tool: &str, binary: &'a str) -> &'a str {
    if tool == "cursor" && binary == "agent" { "cursor-agent" } else { binary }
}

/// Expand a leading `~/` or bare `~` to the user's home directory.
/// Used by both `default_cwd` and `history_path` overrides since users
/// reasonably write `~/.hermes/sessions` and expect us to handle it.
/// Windows paths (`\\wsl.localhost\...` / `C:\...`) and absolute Unix
/// paths pass through unchanged.
pub fn expand_path(input: &str) -> std::path::PathBuf {
    if input == "~" {
        if let Some(home) = dirs::home_dir() {
            return home;
        }
        return std::path::PathBuf::from("~");
    }
    if let Some(stripped) = input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped);
        }
    }
    std::path::PathBuf::from(input)
}

/// Resolve a tool's effective history-scan directory: user override
/// (with ~ expansion) if set, else `default` (caller-supplied).
pub fn history_path_for(tool: &str, default: std::path::PathBuf) -> std::path::PathBuf {
    let cfg = get(tool).history_path;
    if cfg.is_empty() {
        default
    } else {
        expand_path(&cfg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_cursor_command_uses_its_distinct_launcher() {
        assert_eq!(command_binary("cursor", "agent"), "cursor-agent");
        assert_eq!(command_binary("cursor", "cursor-agent"), "cursor-agent");
        assert_eq!(command_binary("cursor", "/opt/custom/agent"), "/opt/custom/agent");
        assert_eq!(command_binary("cursor", "wsl"), "wsl");
        assert_eq!(command_binary("other", "agent"), "agent");
    }

    #[test]
    fn parse_simple() {
        assert_eq!(parse_command(""), (None, vec![]));
        assert_eq!(parse_command("claude"), (Some("claude".into()), vec![]));
        assert_eq!(
            parse_command("/opt/coffee/bin/claude"),
            (Some("/opt/coffee/bin/claude".into()), vec![])
        );
        assert_eq!(
            parse_command("  docker exec mybox claude  "),
            (
                Some("docker".into()),
                vec!["exec".into(), "mybox".into(), "claude".into()]
            )
        );
    }

    #[test]
    fn expand_path_handles_tilde_and_passthrough() {
        let home = dirs::home_dir().expect("test needs a home dir");
        // Tilde forms expand
        assert_eq!(expand_path("~"), home);
        assert_eq!(expand_path("~/.hermes/sessions"), home.join(".hermes").join("sessions"));
        // Backslash form on Windows-style paths
        assert_eq!(expand_path("~\\.hermes\\sessions"), home.join(".hermes\\sessions"));
        // Non-tilde paths pass through verbatim — UNC, absolute Unix, drive letters
        assert_eq!(
            expand_path("\\\\nas01\\share\\sessions"),
            std::path::PathBuf::from("\\\\nas01\\share\\sessions"),
        );
        assert_eq!(expand_path("/abs/unix/path"), std::path::PathBuf::from("/abs/unix/path"));
        assert_eq!(expand_path("C:\\Users\\someone"), std::path::PathBuf::from("C:\\Users\\someone"));
        // Tilde-in-middle does NOT expand (only leading)
        assert_eq!(expand_path("/foo/~/bar"), std::path::PathBuf::from("/foo/~/bar"));
    }

    #[test]
    fn empty_entry_check() {
        assert!(ToolConfigEntry::default().is_empty());
        assert!(!ToolConfigEntry {
            command: "x".into(),
            ..Default::default()
        }
        .is_empty());
        assert!(!ToolConfigEntry {
            extra_args: vec!["x".into()],
            ..Default::default()
        }
        .is_empty());
    }

    fn entry(command: &str) -> ToolConfigEntry {
        ToolConfigEntry { command: command.into(), ..Default::default() }
    }

    #[test]
    fn damaged_file_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tools.json");
        let broken = br#"{"claude": {"command": "claude", "extra_args": ["--x"]"#;
        std::fs::write(&path, broken).unwrap();
        let error = set_at(&path, "codex", entry("codex")).unwrap_err();
        assert!(error.contains("damaged"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), broken, "the user's file must stay as it was");
    }

    #[test]
    fn missing_or_blank_file_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tools.json");
        set_at(&path, "claude", entry("claude --x")).unwrap();
        assert_eq!(read_config(&path).unwrap()["claude"].command, "claude --x");
        std::fs::write(&path, "  \n").unwrap();
        assert!(read_config(&path).unwrap().is_empty());
        set_at(&path, "codex", entry("codex")).unwrap();
        assert_eq!(read_config(&path).unwrap().len(), 1);
    }

    #[test]
    fn empty_entry_removes_only_that_tool() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tools.json");
        set_at(&path, "claude", entry("a")).unwrap();
        set_at(&path, "codex", entry("b")).unwrap();
        set_at(&path, "claude", ToolConfigEntry::default()).unwrap();
        let cfg = read_config(&path).unwrap();
        assert!(!cfg.contains_key("claude"));
        assert_eq!(cfg["codex"].command, "b");
    }

    #[test]
    fn concurrent_saves_keep_every_tool() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tools.json");
        let threads: Vec<_> = (0..12)
            .map(|id| {
                let path = path.clone();
                std::thread::spawn(move || set_at(&path, &format!("tool{id}"), entry(&format!("cmd{id}"))).unwrap())
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let cfg = read_config(&path).unwrap();
        assert_eq!(cfg.len(), 12, "no save may be lost to another");
        for id in 0..12 {
            assert_eq!(cfg[&format!("tool{id}")].command, format!("cmd{id}"));
        }
        let leftovers: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers.len(), 1, "no temp files left behind: {leftovers:?}");
    }
}
