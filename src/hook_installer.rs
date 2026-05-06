// Coffee CLI Hook Installer
//
// At app launch, ensure all three integrated CLIs are wired to the dynamic
// island status bus:
//
//   Claude Code
//     1. ~/.coffee-cli/hooks/coffee-cli-hook.py — Claude stdin hook protocol
//     2. ~/.claude/settings.json — registers our hook on 5 events
//     3. ~/.claude/settings.local.json — stale entries from v1.8.5 stripped
//
//   Codex
//     1. ~/.coffee-cli/hooks/coffee-cli-codex-notify.py — argv[-1] JSON
//     2. ~/.codex/config.toml — `notify = ["python", "<path>"]` line, only
//        added if there's no top-level `notify` already (don't clobber user
//        config). The script is global to all Codex sessions but no-ops
//        when COFFEE_CLI_* env vars are absent.
//
//   OpenCode
//     1. ~/.config/opencode/plugins/coffee-cli-island.js — auto-loaded by
//        OpenCode/Bun on every session. Same env-var no-op gate as Codex.
//
// IMPORTANT — Claude event list discipline:
// Claude Code rejects the *entire* hooks block if it contains an unknown
// event name (cf. vibe-notch source comment, anthropics/claude-code#6305).
// The 5 events below are the proven-working set as of Claude Code v2.x.
// Permission-prompt detection rides on `Notification` (subtype
// `permission_prompt`), NOT a separate `PermissionRequest` event — that
// name silently invalidated the whole config in Coffee CLI ≤ v1.8.5.
//
// Errors are logged, never fatal — a broken installer must not prevent
// Coffee CLI from starting.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const HOOK_SCRIPT: &str = include_str!("../scripts/coffee-cli-hook.py");
const SCRIPT_FILENAME: &str = "coffee-cli-hook.py";

const CODEX_NOTIFY_SCRIPT: &str = include_str!("../scripts/coffee-cli-codex-notify.py");
const CODEX_NOTIFY_FILENAME: &str = "coffee-cli-codex-notify.py";

const OPENCODE_PLUGIN_SCRIPT: &str = include_str!("../scripts/coffee-cli-opencode-plugin.js");
const OPENCODE_PLUGIN_FILENAME: &str = "coffee-cli-island.js";

/// Events Coffee CLI listens for. Mirrors vibe-notch (ClaudeIsland)'s
/// proven-working set; do not add unknown event names — Claude Code drops
/// the whole hooks block on first unrecognized key.
const EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
];

/// Events where Claude expects a `matcher` regex (tool name filter).
const EVENTS_WITH_MATCHER: &[&str] = &["PreToolUse", "PostToolUse"];

pub fn install_all() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            eprintln!("[hook-installer] no home dir — skipping");
            return;
        }
    };

    install_claude(&home);
    install_codex(&home);
    install_opencode(&home);
}

fn install_claude(home: &Path) {
    let script_path = match write_script(home) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[hook-installer] failed to write claude hook: {}", e);
            return;
        }
    };

    // Primary target: ~/.claude/settings.json. Local-settings.json was
    // tried in v1.8.5 but hooks declared there fire unreliably under Claude
    // Code v2.x (workspace-trust gate, cf. anthropics/claude-code#11519).
    let primary = home.join(".claude").join("settings.json");
    if let Err(e) = patch_settings(&primary, &script_path) {
        eprintln!(
            "[hook-installer] failed to patch {}: {}",
            primary.display(),
            e
        );
    }

    // Strip stale Coffee CLI entries from settings.local.json (v1.8.5 wrote
    // there). Leaves user's other keys untouched. Without this cleanup the
    // hook would fire twice per event on machines that ran v1.8.5.
    let local = home.join(".claude").join("settings.local.json");
    if local.exists() {
        if let Err(e) = strip_coffee_hooks(&local) {
            eprintln!(
                "[hook-installer] failed to clean {}: {}",
                local.display(),
                e
            );
        }
    }
}

/// Codex notify forwarder — keeps ~/.coffee-cli/hooks/<filename> fresh and
/// adds a `notify = [...]` line to ~/.codex/config.toml if (and only if) the
/// user doesn't already have one. We never overwrite an existing notify
/// command — too high a risk of stomping on the user's setup.
fn install_codex(home: &Path) {
    let script_path = match write_aux_script(
        home,
        CODEX_NOTIFY_FILENAME,
        CODEX_NOTIFY_SCRIPT,
    ) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[hook-installer] failed to write codex notify: {}", e);
            return;
        }
    };

    let config_path = home.join(".codex").join("config.toml");
    if let Err(e) = patch_codex_config(&config_path, &script_path) {
        eprintln!(
            "[hook-installer] failed to patch {}: {}",
            config_path.display(),
            e
        );
    }
}

/// OpenCode plugin — written directly to ~/.config/opencode/plugins/ where
/// OpenCode auto-discovers it on session start. No config file edits needed.
/// We also keep a copy at ~/.coffee-cli/hooks/ so the source is co-located
/// with the other forwarders and easy to find when debugging.
fn install_opencode(home: &Path) {
    if let Err(e) = write_aux_script(home, OPENCODE_PLUGIN_FILENAME, OPENCODE_PLUGIN_SCRIPT) {
        eprintln!("[hook-installer] failed to write opencode plugin: {}", e);
        return;
    }

    let plugin_dir = home.join(".config").join("opencode").join("plugins");
    if let Err(e) = fs::create_dir_all(&plugin_dir) {
        eprintln!(
            "[hook-installer] failed to create {}: {}",
            plugin_dir.display(),
            e
        );
        return;
    }
    let plugin_path = plugin_dir.join(OPENCODE_PLUGIN_FILENAME);
    if let Err(e) = fs::write(&plugin_path, OPENCODE_PLUGIN_SCRIPT) {
        eprintln!(
            "[hook-installer] failed to write {}: {}",
            plugin_path.display(),
            e
        );
    }
}

/// Remove every Coffee CLI hook entry from `path` without touching any other
/// user-owned key. Used to clean up after the v1.8.5 settings.local.json
/// install location.
fn strip_coffee_hooks(path: &Path) -> anyhow::Result<()> {
    let text = fs::read_to_string(path)?;
    let mut root: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(()), // unparseable user file — leave it alone
    };
    let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(());
    };

    let mut empty_events = Vec::new();
    for (event, slot) in hooks.iter_mut() {
        if let Some(arr) = slot.as_array_mut() {
            arr.retain(|e| !is_coffee_entry(e));
            if arr.is_empty() {
                empty_events.push(event.clone());
            }
        }
    }
    for k in empty_events {
        hooks.remove(&k);
    }

    // If the hooks object is now fully empty, remove the key itself rather
    // than leaving an empty `"hooks": {}` artifact.
    let hooks_empty = root
        .get("hooks")
        .and_then(|h| h.as_object())
        .map(|o| o.is_empty())
        .unwrap_or(false);
    if hooks_empty {
        if let Some(obj) = root.as_object_mut() {
            obj.remove("hooks");
        }
    }

    fs::write(path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

fn write_script(home: &Path) -> anyhow::Result<PathBuf> {
    write_aux_script(home, SCRIPT_FILENAME, HOOK_SCRIPT)
}

/// Generic helper: write `contents` to ~/.coffee-cli/hooks/<filename>,
/// chmod 755 on Unix, return the absolute path.
fn write_aux_script(home: &Path, filename: &str, contents: &str) -> anyhow::Result<PathBuf> {
    let dir = home.join(".coffee-cli").join("hooks");
    fs::create_dir_all(&dir)?;
    let path = dir.join(filename);
    fs::write(&path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms)?;
    }
    Ok(path)
}

/// Add a `notify = ["python", "<script>"]` line to ~/.codex/config.toml when
/// safe. Three cases, matched in order:
///   1. File doesn't exist or is empty → create it with our notify line.
///   2. File contains a top-level notify already pointing at our script
///      (any version of the path) → rewrite it to the current absolute path
///      so an upgrade or moved $HOME doesn't break the hook.
///   3. File contains a top-level notify pointing elsewhere → leave it alone
///      and log a warning. Never overwrite a user's custom notify command.
///
/// "Top-level" means before the first `[section]` header. A `notify` entry
/// inside a `[section]` is a different key entirely (e.g. `[mcp.notify]`)
/// and we don't touch it.
fn patch_codex_config(path: &Path, script_path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let python_cmd = detect_python();
    let script_str = script_path.display().to_string();
    // TOML strings escape backslashes and quotes. Windows paths have plenty
    // of backslashes — escape them so the resulting line parses cleanly.
    let escaped = script_str.replace('\\', "\\\\").replace('"', "\\\"");
    let new_line = format!("notify = [\"{}\", \"{}\"]", python_cmd, escaped);

    let existing = if path.exists() {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };

    if existing.trim().is_empty() {
        let header = "# Coffee CLI registered this notify command for the dynamic-island\n# status indicator. Safe to remove if you don't use Coffee CLI — the\n# script no-ops when COFFEE_CLI_* env vars aren't set.\n";
        fs::write(path, format!("{}{}\n", header, new_line))?;
        return Ok(());
    }

    // Scan top-level (before any `[...]` section header) for an existing
    // `notify = ` line.
    let mut top_level_notify_line: Option<usize> = None;
    let mut top_level_notify_value: String = String::new();
    for (i, line) in existing.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') && !trimmed.starts_with("[[") {
            // entered a section table — stop scanning top-level
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("notify") {
            // "notify =" or "notify=" possibly with whitespace
            let rest = rest.trim_start();
            if rest.starts_with('=') {
                top_level_notify_line = Some(i);
                top_level_notify_value = rest.to_string();
                break;
            }
        }
    }

    match top_level_notify_line {
        None => {
            // Append at top so it stays top-level even if user later adds
            // `[section]` blocks below.
            let mut buf = String::new();
            buf.push_str(&new_line);
            buf.push('\n');
            buf.push_str(&existing);
            if !buf.ends_with('\n') {
                buf.push('\n');
            }
            fs::write(path, buf)?;
        }
        Some(idx) => {
            // Is the existing notify pointing at us? Match by filename so
            // we recover from $HOME moves and capitalization differences.
            let points_at_us = top_level_notify_value.contains(CODEX_NOTIFY_FILENAME);
            if points_at_us {
                let mut lines: Vec<String> =
                    existing.lines().map(|s| s.to_string()).collect();
                lines[idx] = new_line;
                let mut joined = lines.join("\n");
                if existing.ends_with('\n') {
                    joined.push('\n');
                }
                fs::write(path, joined)?;
            } else {
                eprintln!(
                    "[hook-installer] codex {} already has a top-level `notify`; \
                     leaving alone — Codex turn-complete events won't reach \
                     the dynamic island",
                    path.display()
                );
            }
        }
    }
    Ok(())
}

fn patch_settings(path: &Path, script_path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut root: Value = if path.exists() {
        let text = fs::read_to_string(path).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }

    // Ensure "hooks" is an object
    let needs_reset = root
        .get("hooks")
        .map(|h| !h.is_object())
        .unwrap_or(true);
    if needs_reset {
        root.as_object_mut()
            .unwrap()
            .insert("hooks".into(), json!({}));
    }

    let python_cmd = detect_python();
    let command = format!("{} \"{}\"", python_cmd, script_path.display());
    let hook_cmd = json!({ "type": "command", "command": command });

    let hooks = root
        .get_mut("hooks")
        .and_then(|h| h.as_object_mut())
        .expect("hooks is object");

    for event in EVENTS {
        let entry = if EVENTS_WITH_MATCHER.contains(event) {
            json!({ "matcher": "*", "hooks": [hook_cmd.clone()] })
        } else {
            json!({ "hooks": [hook_cmd.clone()] })
        };

        let slot = hooks
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        if !slot.is_array() {
            *slot = json!([]);
        }
        let arr = slot.as_array_mut().unwrap();
        arr.retain(|e| !is_coffee_entry(e));
        arr.push(entry);
    }

    fs::write(path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

fn is_coffee_entry(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|s| s.contains(SCRIPT_FILENAME))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn detect_python() -> String {
    // Windows: the `python` launcher (installed with Python.org and the MS
    // Store build) resolves to Python 3. On Unix, prefer `python3` which is
    // always the real 3.x interpreter.
    if cfg!(target_os = "windows") {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}
