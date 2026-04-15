// Coffee CLI Hook Installer
//
// At app launch, ensure:
//   1. ~/.coffee-cli/hooks/coffee-cli-hook.py is up to date (written from
//      the Python source embedded into the binary via include_str!).
//   2. ~/.claude/settings.json and ~/.qwen/settings.json register our hook
//      on the events we forward. Idempotent: stale entries from prior
//      installs are stripped and replaced.
//
// Errors are logged, never fatal — a broken installer must not prevent
// Coffee CLI from starting.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const HOOK_SCRIPT: &str = include_str!("../scripts/coffee-cli-hook.py");
const SCRIPT_FILENAME: &str = "coffee-cli-hook.py";

/// Events Coffee CLI listens for. Matches the Python script's event map.
const EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "Notification",
    "SessionStart",
    "SessionEnd",
];

/// Events where Claude/Qwen expect a `matcher` regex (tool name filter).
const EVENTS_WITH_MATCHER: &[&str] = &["PreToolUse", "PostToolUse", "PermissionRequest"];

pub fn install_all() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            eprintln!("[hook-installer] no home dir — skipping");
            return;
        }
    };

    let script_path = match write_script(&home) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[hook-installer] failed to write hook script: {}", e);
            return;
        }
    };

    for settings_rel in &[".claude/settings.json", ".qwen/settings.json"] {
        let path = home.join(settings_rel);
        if let Err(e) = patch_settings(&path, &script_path) {
            eprintln!(
                "[hook-installer] failed to patch {}: {}",
                path.display(),
                e
            );
        }
    }
}

fn write_script(home: &Path) -> anyhow::Result<PathBuf> {
    let dir = home.join(".coffee-cli").join("hooks");
    fs::create_dir_all(&dir)?;
    let path = dir.join(SCRIPT_FILENAME);
    fs::write(&path, HOOK_SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms)?;
    }
    Ok(path)
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
