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
use std::path::PathBuf;

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

pub fn load() -> ToolConfig {
    let Some(p) = config_path() else {
        return HashMap::new();
    };
    let Ok(s) = std::fs::read_to_string(&p) else {
        return HashMap::new();
    };
    serde_json::from_str::<ToolConfig>(&s).unwrap_or_default()
}

pub fn save(cfg: &ToolConfig) -> std::io::Result<()> {
    let Some(p) = config_path() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "no home dir",
        ));
    };
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
    })?;
    // Atomic write so an interrupted save can't leave the file
    // half-written and unparseable on the next launch.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

pub fn get(tool: &str) -> ToolConfigEntry {
    load().remove(tool).unwrap_or_default()
}

pub fn set(tool: &str, entry: ToolConfigEntry) -> std::io::Result<()> {
    let mut cfg = load();
    if entry.is_empty() {
        cfg.remove(tool);
    } else {
        cfg.insert(tool.to_string(), entry);
    }
    save(&cfg)
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
}
