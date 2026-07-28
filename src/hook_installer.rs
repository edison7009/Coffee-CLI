// Coffee CLI Hook Installer
//
// At app launch, ensure the hook-capable integrated CLIs are wired to the
// dynamic island status bus:
//
// The forwarder is the Coffee CLI binary itself (`<exe> __hook` /
// `<exe> __codex-notify`, implemented in hook_forwarder.rs) — NOT a Python
// script. The Python forwarders failed on Windows machines without Python
// (`python` hit the MS Store alias stub → "python not found" hook errors in
// Claude's transcript); a native subcommand on the always-present binary
// removes the interpreter dependency entirely. The .py files are still
// dropped under ~/.coffee-cli/hooks/ as protocol-reference copies only.
//
//   Claude Code
//     1. ~/.claude/settings.json — registers `<exe> __hook` on 5 events
//     2. ~/.claude/settings.local.json — stale entries from v1.8.5 stripped
//     3. ~/.coffee-cli/hooks/coffee-cli-hook.py — reference copy (unused)
//
//   Codex
//     1. ~/.codex/config.toml — `notify = ["<exe>", "__codex-notify"]` line,
//        only added if there's no top-level `notify` already (don't clobber
//        user config). It's global to all Codex sessions but no-ops when the
//        COFFEE_CLI_* env vars are absent.
//     2. ~/.coffee-cli/hooks/coffee-cli-codex-notify.py — reference copy
//
//   OpenCode
//     1. ~/.config/opencode/plugins/coffee-cli-island.js — auto-loaded by
//        OpenCode/Bun on every session. Same env-var no-op gate as Codex.
//
//   Hermes Agent (paths are HERMES_HOME-relative — `%LOCALAPPDATA%\hermes`
//   on Windows, `~/.hermes` elsewhere; see tools/hermes.rs::hermes_home)
//     1. <HERMES_HOME>/plugins/coffee-cli-status/__init__.py — Python
//        plugin registering hooks for pre_llm_call / pre_tool_call /
//        pre_approval_request / on_session_start / etc.
//     2. <HERMES_HOME>/plugins/coffee-cli-status/plugin.yaml — manifest
//     3. `hermes plugins enable coffee-cli-status` — Hermes' opt-in CLI
//        gate (third-party plugins don't load until allow-listed in
//        <HERMES_HOME>/config.yaml). We let Hermes' own command do the
//        YAML edit so we don't have to YAML-round-trip user config.
//
//   Kimi Code
//     1. ~/.kimi-code/config.toml — 9 `[[hooks]]` array-of-tables entries
//        pointing at `<exe> __kimi-hook` (see install_kimi). Kimi's stdin
//        hook protocol is Claude-shaped (`hook_event_name` JSON on stdin),
//        so the same native-forwarder pattern drives the 3-color bus.
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

/// Argv markers for the native forwarder built into the Coffee CLI binary
/// (see hook_forwarder.rs). The hook command is now `<exe> __hook` /
/// `<exe> __codex-notify` — no Python. These tokens double as the
/// "is this our entry?" sentinel so re-installs are idempotent and old
/// Python-based entries get migrated in place.
const HOOK_SUBCOMMAND: &str = "__hook";
const CODEX_NOTIFY_SUBCOMMAND: &str = "__codex-notify";

const OPENCODE_PLUGIN_SCRIPT: &str = include_str!("../scripts/coffee-cli-opencode-plugin.js");
const OPENCODE_PLUGIN_FILENAME: &str = "coffee-cli-island.js";

const HERMES_PLUGIN_SCRIPT: &str = include_str!("../scripts/coffee-cli-hermes-plugin.py");
const HERMES_PLUGIN_NAME: &str = "coffee-cli-status";
const HERMES_PLUGIN_YAML: &str = "name: coffee-cli-status\nversion: \"1.0\"\ndescription: Forwards Hermes session lifecycle events to Coffee CLI's tab status bus over local TCP. No-ops outside Coffee CLI.\n";

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

    for tool in crate::tools::TOOLS {
        if tool.has_hook_surface {
            dispatch_install(tool, &home);
        }
    }

    // Grok was T1 (hook-wired) in unreleased test builds; now T2 (no island).
    // Remove the stale ~/.grok/hooks/coffee-cli-status.json those builds wrote
    // so grok stops firing the deleted `__grok-hook` forwarder (which would
    // spawn the full Coffee CLI GUI and stall grok's TUI). One-time migration;
    // no-op once the file is gone. Only deletes if it references __grok-hook
    // (never clobber a user's same-named file).
    cleanup_stale_grok_hook(&home);

    // Windows-only: opencode/mimocode's `opencode upgrade` (which re-runs
    // `npm install -g`) shatters the global bin links when the binary is
    // running — npm renames opencode.cmd → .opencode.cmd-<rand>, then the
    // write of the new file fails because cmd.exe holds a lock on it, leaving
    // orphans and no usable bin. Detect that state at launch and repair it
    // by re-running the install. See repair_broken_npm_bins() for details.
    #[cfg(target_os = "windows")]
    {
        crate::hook_installer::repair_broken_npm_bins();
    }
}

/// Install hook(s) for a single tool. Called from the launchpad's
/// window-focus rescan when a CLI flips from not-installed → installed,
/// so users who install a CLI while Coffee CLI is running don't have
/// to restart to get tab status indicators. Idempotent.
pub fn install_for_tool(tool: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let Some(descriptor) = crate::tools::find(tool) else { return };
    if !descriptor.has_hook_surface {
        return;
    }
    dispatch_install(descriptor, &home);
}

/// Per-tool installer dispatch. Gates on `binary_on_path` (we don't
/// materialize `~/.<tool>/` for tools the user hasn't installed) then
/// runs the tool's bespoke config-patching shape. The unknown-id arm
/// is reachable only when a registry entry declares a hook surface
/// but no installer arm exists yet — that's a build-time omission
/// worth a log line.
fn dispatch_install(tool: &crate::tools::ToolDescriptor, home: &Path) {
    if !crate::server::binary_on_path(tool.binary_name) {
        return;
    }
    match tool.id {
        "claude" => install_claude(home),
        "codex" => install_codex(home),
        "opencode" => {
            install_opencode(home, "opencode");
            ensure_opencode_tui_theme_default(home, "opencode");
        }
        // MiMo Code (Xiaomi OpenCode fork) ships the same opaque #000 default
        // canvas, so it needs the identical tui.json transparency override.
        // Now also gets the OpenCode island plugin — MiMo is an OpenCode fork
        // (same plugin API, config at ~/.config/mimocode), so the same JS plugin
        // drives its tab status, including question.asked / permission.updated.
        "mimocode" => {
            install_opencode(home, "mimocode");
            ensure_opencode_tui_theme_default(home, "mimocode");
        }
        "hermes" => install_hermes(home),
        "kimicode" => install_kimi(home),
        other => {
            eprintln!(
                "[hook-installer] tool '{}' declares a hook surface but has no installer — \
                 add an arm to dispatch_install",
                other
            );
        }
    }
}

/// TUI theme we default OpenCode-family tools (OpenCode, MiMo Code) into.
/// `lucent-orng` sets all four background slots (background / backgroundPanel
/// / backgroundElement / backgroundMenu) to `"transparent"`, which is what
/// makes Coffee CLI's terminal bg — and the Glass theme's wallpaper blur —
/// actually visible behind the TUI. Confirmed working for OpenCode 2026-05-09;
/// MiMo Code is a Xiaomi OpenCode fork that ships the same bundled themes and
/// the same opaque #000 default canvas, so it needs the identical override.
const OPENCODE_DEFAULT_THEME: &str = "lucent-orng";

/// Theme value Coffee CLI used to write into tui.json before we discovered
/// `lucent-orng` actually delivers transparency. `system` *generates* a
/// transparent bg in source, but the panel slots still resolve to opaque
/// shades of palette[0], so OpenCode renders an almost-black canvas. We
/// migrate any tui.json we previously stamped with `system` to the new
/// default; user-set themes (anything other than `system`) are left alone.
const OPENCODE_LEGACY_THEME: &str = "system";

fn install_claude(home: &Path) {
    // Keep a protocol-reference copy of the Python forwarder co-located with
    // the other tools' debug copies. It's no longer the registered command
    // (the native binary is — see below), so a write failure is non-fatal.
    if let Err(e) = write_script(home) {
        eprintln!("[hook-installer] failed to write claude hook reference copy: {}", e);
    }

    // The hook command is the Coffee CLI binary itself: `<exe> __hook`. No
    // interpreter dependency — this is what fixes the "python not found"
    // hook error on Windows machines without Python. The handler entry is
    // shell-pinned (bash or powershell, depending on whether Git Bash is
    // detectable) — see claude_hook_entry for why.
    let hook_entry = match claude_hook_entry() {
        Some(c) => c,
        None => {
            eprintln!("[hook-installer] current_exe() failed — cannot install claude hook");
            return;
        }
    };

    // Primary target: ~/.claude/settings.json. Local-settings.json was
    // tried in v1.8.5 but hooks declared there fire unreliably under Claude
    // Code v2.x (workspace-trust gate, cf. anthropics/claude-code#11519).
    let primary = home.join(".claude").join("settings.json");
    if let Err(e) = patch_settings(&primary, &hook_entry) {
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

/// Codex notify forwarder — registers `notify = ["<exe>", "__codex-notify"]`
/// in ~/.codex/config.toml if (and only if) the user doesn't already have a
/// top-level notify. The forwarder is the Coffee CLI binary itself (no
/// Python). We never overwrite a user's custom notify command — too high a
/// risk of stomping on their setup.
fn install_codex(home: &Path) {
    // Protocol-reference copy alongside the other forwarders' debug copies.
    // No longer the registered command, so a write failure is non-fatal.
    if let Err(e) = write_aux_script(home, CODEX_NOTIFY_FILENAME, CODEX_NOTIFY_SCRIPT) {
        eprintln!("[hook-installer] failed to write codex notify reference copy: {}", e);
    }

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[hook-installer] current_exe() failed — cannot install codex notify: {}", e);
            return;
        }
    };

    let config_path = home.join(".codex").join("config.toml");
    if let Err(e) = patch_codex_config(&config_path, &exe) {
        eprintln!(
            "[hook-installer] failed to patch {}: {}",
            config_path.display(),
            e
        );
    }

    // Hooks system (SessionStart / UserPromptSubmit / PermissionRequest / Stop)
    // — the full 3-color status bus. `notify` only carries turn-complete (idle),
    // so without these hooks Codex's island never shows working (orange) or
    // wait_input (blue). See install_codex_hooks + patch_codex_features.
    let hook_cmd = match hook_command(CODEX_HOOK_SUBCOMMAND) {
        Some(c) => c,
        None => {
            eprintln!("[hook-installer] current_exe() failed — cannot install codex hooks");
            return;
        }
    };
    let hooks_path = home.join(".codex").join("hooks.json");
    if let Err(e) = install_codex_hooks(&hooks_path, &hook_cmd) {
        eprintln!(
            "[hook-installer] failed to patch {}: {}",
            hooks_path.display(),
            e
        );
    }
    if let Err(e) = patch_codex_features(&config_path) {
        eprintln!(
            "[hook-installer] failed to enable [features].hooks in {}: {}",
            config_path.display(),
            e
        );
    }
}

/// OpenCode-family plugin — written directly to ~/.config/<config_subdir>/plugins/
/// where OpenCode (and its fork MiMo Code) auto-discovers it on session start.
/// No config file edits needed. We also keep a copy at ~/.coffee-cli/hooks/ so
/// the source is co-located with the other forwarders and easy to find when
/// debugging. `config_subdir` is "opencode" or "mimocode" (MiMo is Xiaomi's
/// OpenCode fork — same plugin API, separate config dir ~/.config/mimocode).
fn install_opencode(home: &Path, config_subdir: &str) {
    if let Err(e) = write_aux_script(home, OPENCODE_PLUGIN_FILENAME, OPENCODE_PLUGIN_SCRIPT) {
        eprintln!("[hook-installer] failed to write {} plugin: {}", config_subdir, e);
        return;
    }

    let plugin_dir = home.join(".config").join(config_subdir).join("plugins");
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

/// Hermes Agent plugin — drop a 2-file Python plugin into
/// <HERMES_HOME>/plugins/coffee-cli-status/, then ask Hermes itself to
/// enable it via `hermes plugins enable coffee-cli-status`. Hermes
/// general plugins are opt-in by default (third-party code doesn't
/// run until allow-listed in <HERMES_HOME>/config.yaml), and shelling
/// out to Hermes' own CLI is safer than us round-tripping the user's
/// config.yaml — comments and key ordering survive intact.
///
/// `home` here is only used for the debug-copy under `~/.coffee-cli/`;
/// Hermes's plugin dir lives under `hermes_home()` because Windows
/// puts it at `%LOCALAPPDATA%\hermes\plugins\` (not `~/.hermes\plugins\`).
///
/// Idempotent: if the plugin is already enabled, `hermes plugins
/// enable` is a no-op. Errors are logged, never fatal.
fn install_hermes(home: &Path) {
    let plugin_dir = crate::tools::hermes::hermes_home()
        .join("plugins")
        .join(HERMES_PLUGIN_NAME);
    if let Err(e) = fs::create_dir_all(&plugin_dir) {
        eprintln!(
            "[hook-installer] failed to create {}: {}",
            plugin_dir.display(),
            e
        );
        return;
    }

    let init_path = plugin_dir.join("__init__.py");
    if let Err(e) = fs::write(&init_path, HERMES_PLUGIN_SCRIPT) {
        eprintln!(
            "[hook-installer] failed to write {}: {}",
            init_path.display(),
            e
        );
        return;
    }

    let manifest_path = plugin_dir.join("plugin.yaml");
    if let Err(e) = fs::write(&manifest_path, HERMES_PLUGIN_YAML) {
        eprintln!(
            "[hook-installer] failed to write {}: {}",
            manifest_path.display(),
            e
        );
        return;
    }

    // Also keep a debug copy under ~/.coffee-cli/hooks/ so the source is
    // co-located with the other forwarders for grep-friendly debugging.
    let _ = write_aux_script(
        home,
        "coffee-cli-hermes-plugin.py",
        HERMES_PLUGIN_SCRIPT,
    );

    // Hermes' allow-list gate. We invoke `hermes plugins enable
    // coffee-cli-status` rather than editing config.yaml ourselves —
    // Hermes' own command knows the canonical YAML shape and won't clobber
    // the user's comments / quoted strings / anchor references. The call
    // is idempotent: running it twice does not duplicate the entry.
    use std::process::Command;
    let mut cmd = Command::new("hermes");
    cmd.args(["plugins", "enable", HERMES_PLUGIN_NAME]);
    // CREATE_NO_WINDOW (0x08000000): install_all() runs in Tauri's setup hook
    // every launch, so without this flag spawning the `hermes` CLI flashes a
    // console window on Windows at startup. No-op on other platforms.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match cmd.output()
    {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            eprintln!(
                "[hook-installer] `hermes plugins enable {}` exited {} — \
                 user may need to enable it manually via `hermes plugins`",
                HERMES_PLUGIN_NAME,
                out.status,
            );
        }
        Err(e) => {
            eprintln!(
                "[hook-installer] failed to run `hermes plugins enable`: {} \
                 — user may need to enable it manually via `hermes plugins`",
                e,
            );
        }
    }
}

/// Ensure ~/.config/<config_subdir>/tui.json has `"theme": "lucent-orng"` so
/// the OpenCode-family TUI's four bg slots resolve to "transparent" — which is
/// what actually lets Coffee CLI's terminal bg (and the Glass theme's wallpaper
/// blur) show through. Without this the TUI picks its bundled opaque theme that
/// paints a #000 canvas no terminal setting can override. Shared by OpenCode
/// (`opencode`) and its Xiaomi fork MiMo Code (`mimocode`).
///
/// Policy:
///   - File missing                              → create with default theme.
///   - File exists, no `theme`                   → add default theme.
///   - File exists, `theme = "system"`           → migrate (we wrote that
///                                                 ourselves before realising
///                                                 it doesn't actually deliver
///                                                 transparency in practice).
///   - File exists, `theme = anything else`      → leave alone.
///   - File unparseable                          → leave alone.
///
/// All failures are logged, never fatal.
fn ensure_opencode_tui_theme_default(home: &Path, config_subdir: &str) {
    let config_dir = home.join(".config").join(config_subdir);
    let tui_path = config_dir.join("tui.json");

    if let Err(e) = fs::create_dir_all(&config_dir) {
        eprintln!(
            "[hook-installer] failed to create {}: {}",
            config_dir.display(),
            e
        );
        return;
    }

    if !tui_path.exists() {
        let initial = json!({
            "$schema": "https://opencode.ai/tui.json",
            "theme": OPENCODE_DEFAULT_THEME,
        });
        let body = match serde_json::to_string_pretty(&initial) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[hook-installer] tui.json serialize failed: {}", e);
                return;
            }
        };
        if let Err(e) = fs::write(&tui_path, body) {
            eprintln!(
                "[hook-installer] failed to write {}: {}",
                tui_path.display(),
                e
            );
        }
        return;
    }

    let text = match fs::read_to_string(&tui_path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[hook-installer] read {} failed: {}", tui_path.display(), e);
            return;
        }
    };

    let mut root: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return, // malformed user file — don't touch
    };
    let Some(obj) = root.as_object_mut() else { return };
    let needs_write = match obj.get("theme") {
        None => true,
        Some(Value::String(s)) if s == OPENCODE_LEGACY_THEME => true,
        _ => false, // user (or our new default) has a non-legacy theme set — respect it
    };
    if !needs_write {
        return;
    }
    obj.insert(
        "theme".to_string(),
        Value::String(OPENCODE_DEFAULT_THEME.to_string()),
    );
    if !obj.contains_key("$schema") {
        obj.insert(
            "$schema".to_string(),
            Value::String("https://opencode.ai/tui.json".to_string()),
        );
    }

    let body = match serde_json::to_string_pretty(&root) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[hook-installer] tui.json reserialize failed: {}", e);
            return;
        }
    };
    if let Err(e) = fs::write(&tui_path, body) {
        eprintln!(
            "[hook-installer] failed to update {}: {}",
            tui_path.display(),
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

/// Add a `notify = ["<exe>", "__codex-notify"]` line to ~/.codex/config.toml
/// when safe. Three cases, matched in order:
///   1. File doesn't exist or is empty → create it with our notify line.
///   2. File contains a top-level notify already pointing at our forwarder
///      (the native subcommand, or the legacy Python script) → rewrite it to
///      the current absolute exe path so an upgrade or moved $HOME doesn't
///      break the hook, and migrate the legacy Python form in place.
///   3. File contains a top-level notify pointing elsewhere → leave it alone
///      and log a warning. Never overwrite a user's custom notify command.
///
/// "Top-level" means before the first `[section]` header. A `notify` entry
/// inside a `[section]` is a different key entirely (e.g. `[mcp.notify]`)
/// and we don't touch it.
fn patch_codex_config(path: &Path, exe: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let exe_str = exe.display().to_string();
    // Codex execs the notify argv directly (no shell), so the raw path is
    // correct. TOML strings escape backslashes and quotes — Windows paths
    // have plenty of backslashes, so escape them to parse cleanly.
    let escaped = exe_str.replace('\\', "\\\\").replace('"', "\\\"");
    let new_line = format!("notify = [\"{}\", \"{}\"]", escaped, CODEX_NOTIFY_SUBCOMMAND);

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
            // Is the existing notify pointing at us? Match either the native
            // subcommand (current form) or the legacy Python filename (so we
            // migrate old installs in place), independent of $HOME / casing.
            let points_at_us = top_level_notify_value.contains(CODEX_NOTIFY_SUBCOMMAND)
                || top_level_notify_value.contains(CODEX_NOTIFY_FILENAME);
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

fn patch_settings(path: &Path, hook_cmd: &Value) -> anyhow::Result<()> {
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

    // The handler entry (command + shell) is built by claude_hook_entry —
    // bash or powershell depending on whether Git Bash is detectable.
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
                    // Match the legacy Python command (so old entries get
                    // migrated in place) and the native command, which is
                    // `"<exe>" __hook` — i.e. `__hook` is the final argv
                    // token. We check the LAST whitespace-delimited token
                    // rather than a bare `contains("__hook")` so a user's own
                    // hook whose command path merely *contains* "__hook"
                    // (e.g. /home/u/.__hooks/lint.sh) is never misclassified
                    // as ours and stripped.
                    .map(|s| {
                        s.contains(SCRIPT_FILENAME)
                            || s.split_whitespace().last() == Some(HOOK_SUBCOMMAND)
                    })
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Build the Claude Code hook command: `"<exe>" __hook`. Claude runs
/// shell-form hooks via Git Bash on Windows, where backslash paths are
/// fragile — emit forward slashes there (Git Bash and CreateProcess both
/// accept `C:/...`). Returns None only if `current_exe()` fails.
/// Build a Coffee CLI hook command: `"<exe>" <subcommand>`. The agent runs
/// shell-form hooks via Git Bash on Windows, where backslash paths are
/// fragile — emit forward slashes there (Git Bash and CreateProcess both
/// accept `C:/...`). Returns None only if `current_exe()` fails.
fn hook_command(subcommand: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let p = exe.display().to_string();
    let p = if cfg!(target_os = "windows") {
        p.replace('\\', "/")
    } else {
        p
    };
    Some(format!("\"{}\" {}", p, subcommand))
}

fn claude_hook_command() -> Option<String> {
    hook_command(HOOK_SUBCOMMAND)
}

/// Build the Claude Code hook handler entry (`{"type","command","shell"}`).
/// Two shapes, chosen by whether Git Bash is detectable on this machine:
///
///   - Git Bash present → `{"command": "\"<exe>\" __hook", "shell": "bash"}`.
///     Pinning "shell": "bash" defeats Claude Code's PowerShell fallback
///     (used on Windows when Git Bash isn't detected): under PowerShell a
///     leading-quoted command is a parse error — PowerShell needs the `&`
///     call operator — so the hook dies with exit 1 before our binary even
///     starts. On macOS/Linux "bash" is already the default, no-op there.
///   - No Git Bash → `{"command": "& \"<exe>\" __hook", "shell": "powershell"}`.
///     The `&`-prefixed form parses and runs under PowerShell (verified:
///     exit 0), so the hook keeps working on machines where Claude would
///     otherwise run it through the PowerShell fallback.
///
/// Both forms end with the bare `__hook` token, so is_coffee_entry's
/// last-token match migrates older entries in place either way.
fn claude_hook_entry() -> Option<Value> {
    #[cfg(target_os = "windows")]
    if !git_bash_available() {
        let command = claude_hook_command()?;
        // `"<exe>" __hook` → `& "<exe>" __hook`
        return Some(json!({
            "type": "command",
            "command": format!("& {}", command),
            "shell": "powershell",
        }));
    }
    let command = claude_hook_command()?;
    Some(json!({
        "type": "command",
        "command": command,
        "shell": "bash",
    }))
}

/// Mirror of Claude Code's Git Bash probe (Windows): CLAUDE_CODE_GIT_BASH_PATH,
/// the two fixed Program Files install paths, then PATH. Used to decide which
/// shell Claude will run hooks through — when this returns false, Claude
/// falls back to PowerShell and our hook entry must use the `&`-form command.
#[cfg(target_os = "windows")]
fn git_bash_available() -> bool {
    if let Some(p) = std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH") {
        if PathBuf::from(p).is_file() {
            return true;
        }
    }
    for fixed in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ] {
        if Path::new(fixed).is_file() {
            return true;
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if dir.join("bash.exe").is_file() {
                return true;
            }
        }
    }
    false
}

/// Codex hooks subcommand — stdin protocol (like Claude's __hook), installed
/// into ~/.codex/hooks.json. Distinct from the legacy `__codex-notify` argv
/// protocol that rides the global `notify` line.
const CODEX_HOOK_SUBCOMMAND: &str = "__codex-hook";

// ─── Codex hooks.json installation ──────────────────────────────────────────
//
// Codex's hooks system (distinct from the legacy `notify` line) reads a JSON
// file at ~/.codex/hooks.json. Shape (mirrors Claude's settings.json hooks
// block, but a top-level file):
//   {
//     "hooks": {
//       "SessionStart": [{"matcher": "startup|resume", "hooks": [{...}]}],
//       "UserPromptSubmit":     [{"hooks": [{...}]}],
//       "PermissionRequest":    [{"hooks": [{...}]}],
//       "Stop":                 [{"hooks": [{...}]}]
//     }
//   }
// Each hook entry: {"type":"command","command":"<exe> __codex-hook","timeout":N}.
//
// Install is MERGE-only: we touch just the 4 managed event slots, and within
// each slot we strip our own prior entries (is_coffee_codex_entry) before
// re-adding one fresh entry — so re-installs don't accumulate. A user's own
// hooks in other events, or extra groups in our events, are preserved.
//
// (Protocol learned from reference/open-vibe-island's CodexHookInstaller.)

/// The 4 events we install, with their matcher (only SessionStart has one,
/// matching codex's startup|resume session kinds) and timeout. PermissionRequest
/// gets a long timeout because it awaits human approval; the others are quick.
const CODEX_HOOK_EVENTS: &[(&str, Option<&str>, u64)] = &[
    ("SessionStart", Some("startup|resume"), 45),
    ("UserPromptSubmit", None, 45),
    ("PermissionRequest", None, 3600),
    ("Stop", None, 45),
];

fn install_codex_hooks(path: &Path, hook_cmd: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Load existing root (or start fresh). A malformed file is left untouched
    // — we won't clobber a user's hand-edited config over a parse error.
    let mut root: Value = if path.exists() {
        let text = fs::read_to_string(path).unwrap_or_default();
        match serde_json::from_str::<Value>(&text) {
            Ok(v) if v.is_object() => v,
            _ => {
                eprintln!(
                    "[hook-installer] {} is unparseable — leaving it untouched",
                    path.display()
                );
                return Ok(());
            }
        }
    } else {
        json!({})
    };
    if !root.is_object() {
        root = json!({});
    }

    // Ensure "hooks" is an object.
    let needs_reset = root
        .get("hooks")
        .map(|h| !h.is_object())
        .unwrap_or(true);
    if needs_reset {
        root.as_object_mut()
            .unwrap()
            .insert("hooks".into(), json!({}));
    }
    let hooks = root
        .get_mut("hooks")
        .and_then(|h| h.as_object_mut())
        .expect("hooks is object");

    // For each managed event: take the existing groups, strip our prior
    // entries from each group (so re-install doesn't duplicate), then append
    // one fresh managed group.
    for (event, matcher, timeout) in CODEX_HOOK_EVENTS {
        let slot = hooks
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        if !slot.is_array() {
            *slot = json!([]);
        }
        let arr = slot.as_array_mut().unwrap();

        // Strip our entries from every existing group (a group is our managed
        // entry iff ALL its hooks are ours — matching the install shape).
        for group in arr.iter_mut() {
            if let Some(gs) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                gs.retain(|h| !is_coffee_codex_entry(h));
            }
        }
        // Drop groups left with zero hooks after stripping.
        arr.retain(|g: &Value| {
            g.get("hooks")
                .and_then(|h: &Value| h.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(true)
        });

        // Append our fresh managed group.
        let mut group = json!({
            "hooks": [{
                "type": "command",
                "command": hook_cmd,
                "timeout": timeout,
            }]
        });
        if let Some(m) = matcher {
            group["matcher"] = json!(m);
        }
        arr.push(group);
    }

    fs::write(path, serde_json::to_string_pretty(&root)?)?;
    Ok(())
}

/// A hook entry is ours iff its command's last whitespace-delimited token is
/// `__codex-hook` (the native subcommand). Mirrors is_coffee_entry's
/// last-token match so a user hook whose path merely contains "__codex-hook"
/// is never misclassified as ours.
fn is_coffee_codex_entry(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(|c| c.as_str())
        .map(|s| s.split_whitespace().last() == Some(CODEX_HOOK_SUBCOMMAND))
        .unwrap_or(false)
}

/// Remove the stale Grok hook config that the T1 build (has_hook_surface:
/// true) wrote to ~/.grok/hooks/coffee-cli-status.json. Grok is now T2 (no
/// island) - if this file remains, grok fires `<exe> __grok-hook` on every
/// event, but the forwarder was removed, so grok would spawn the full Coffee
/// CLI GUI and stall its TUI. One-time migration; no-op once the file is gone.
/// Only deletes if it references `__grok-hook` - never clobber a user's
/// same-named file.
fn cleanup_stale_grok_hook(home: &Path) {
    let path = home.join(".grok").join("hooks").join("coffee-cli-status.json");
    if !path.exists() {
        return;
    }
    if let Ok(text) = fs::read_to_string(&path) {
        if text.contains("__grok-hook") {
            let _ = fs::remove_file(&path);
            eprintln!("[hook-installer] removed stale grok hook config: {}", path.display());
        }
    }
}

/// Enable `[features].hooks = true` in ~/.codex/config.toml. Newer Codex uses
/// the `hooks` key; older builds used `codex_hooks`. The two are mutually
/// exclusive in practice — setting the new key and stripping the legacy one
/// keeps Codex from seeing conflicting flags. Idempotent; leaves all other
/// keys (model, providers, user features) untouched.
///
/// TOML is line-edited here (not parsed) for the same reason patch_codex_config
/// line-edits: we must preserve comments, key order, and the user's hand-
/// formatted sections verbatim. A full TOML round-trip would reorder/drop
/// comments.
fn patch_codex_features(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let existing = if path.exists() {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };

    // Walk lines, locate the [features] section, and within it manage the
    // `hooks` / `codex_hooks` keys. Everything outside [features] is copied
    // verbatim.
    let mut out: Vec<String> = Vec::new();
    let mut in_features = false;
    let mut features_idx: Option<usize> = None; // where [features] header landed in `out`
    let mut saw_hooks_true = false;

    for line in existing.lines() {
        let trimmed = line.trim_start();
        let is_section = trimmed.starts_with('[') && !trimmed.starts_with("[[");
        if is_section {
            in_features = trimmed == "[features]";
        }
        if in_features {
            // Drop any legacy `codex_hooks = ...` line (we manage the new key).
            if trimmed.starts_with("codex_hooks") {
                let rest = trimmed["codex_hooks".len()..].trim_start();
                if rest.starts_with('=') {
                    continue; // skip — don't emit
                }
            }
            // If `hooks = true` already present, keep it; any other value
            // (false / garbage) → drop and emit our own below.
            if trimmed.starts_with("hooks") {
                let rest = trimmed["hooks".len()..].trim_start();
                if rest.starts_with('=') {
                    let val = rest.trim_start_matches('=').trim();
                    if val == "true" {
                        saw_hooks_true = true;
                        out.push(line.to_string());
                        continue;
                    }
                    continue;
                }
            }
        }
        out.push(line.to_string());
        if is_section && in_features && features_idx.is_none() {
            features_idx = Some(out.len() - 1);
        }
    }

    if !saw_hooks_true {
        let our_line = "hooks = true";
        match features_idx {
            Some(idx) => {
                // Insert right after the [features] header.
                out.insert(idx + 1, our_line.to_string());
            }
            None => {
                // No [features] section — append one.
                if !out.is_empty() && !out.last().map(|s| s.is_empty()).unwrap_or(false) {
                    out.push(String::new());
                }
                out.push("[features]".to_string());
                out.push(our_line.to_string());
            }
        }
    }

    let mut joined = out.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }
    if joined != existing || !path.exists() {
        fs::write(path, joined)?;
    }
    Ok(())
}

// ─── Kimi Code hooks (config.toml [[hooks]]) ─────────────────────────────────
//
// Kimi Code reads `[[hooks]]` array-of-tables entries from
// ~/.kimi-code/config.toml and pipes a Claude-shaped JSON payload
// (`hook_event_name`, `session_id`, `cwd`, …) to the hook command's stdin —
// so the forwarder is the same native-subcommand pattern as Claude/Codex:
// `<exe> __kimi-hook` (hook_forwarder.rs::run_kimi_hook).
//
// STRICT config constraint (high risk): Kimi Code rejects the *entire*
// config.toml if a `[[hooks]]` table carries any key other than
// event / matcher / command / timeout. We therefore emit exactly
// event + command + timeout per block (matcher omitted = match all) and
// nothing else — no extra keys, ever.
//
// Merge discipline mirrors patch_codex_config: line-edited (not parsed) so
// the user's comments, key order, and [providers.*] / [models.*] tables
// survive verbatim. `[[hooks]]` blocks append cleanly at EOF in TOML
// array-of-tables syntax, so appending ours after user content is safe.

/// Kimi hooks subcommand — stdin protocol (Claude-shaped JSON), installed
/// into ~/.kimi-code/config.toml `[[hooks]]` entries.
const KIMI_HOOK_SUBCOMMAND: &str = "__kimi-hook";

/// The 9 Kimi events we register — all matcher-less (match every tool) with
/// the default 30s timeout. SessionStart / Subagent* / Notification /
/// PreCompact / PostCompact are deliberately excluded: pure status noise for
/// the tab dot, and the frontend's 30s auto-idle covers a missed Stop.
const KIMI_HOOK_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "PermissionResult",
    "Stop",
    "StopFailure",
    "Interrupt",
    "SessionEnd",
];

/// Kimi Code hooks — merge our `[[hooks]]` entries into
/// ~/.kimi-code/config.toml. Errors are logged, never fatal.
fn install_kimi(home: &Path) {
    let cmd = match hook_command(KIMI_HOOK_SUBCOMMAND) {
        Some(c) => c,
        None => {
            eprintln!("[hook-installer] current_exe() failed — cannot install kimi hooks");
            return;
        }
    };
    let config_path = home.join(".kimi-code").join("config.toml");
    if let Err(e) = patch_kimi_config(&config_path, &cmd) {
        eprintln!(
            "[hook-installer] failed to patch {}: {}",
            config_path.display(),
            e
        );
    }
}

/// Merge our 9 `[[hooks]]` entries into ~/.kimi-code/config.toml. Creates the
/// file (and parent dir) if missing; preserves all existing content verbatim
/// otherwise. Idempotent: any prior `[[hooks]]` block whose command ends in
/// our `__kimi-hook` token (stale exe paths included) is stripped — header
/// and its field lines together — before the fresh set is appended. User-
/// written `[[hooks]]` entries (other commands, any event) are kept.
fn patch_kimi_config(path: &Path, command: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let existing = if path.exists() {
        fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };

    // Strip our prior entries. A "block" is a `[[...]]` array-of-tables
    // header line plus the lines up to (not including) the next table
    // header; it's ours iff it contains a `command` line whose last token
    // is `__kimi-hook` (same last-token discipline as is_coffee_entry, so a
    // user hook whose path merely *contains* the token is never stripped).
    let lines: Vec<&str> = existing.lines().collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim_start().starts_with("[[") {
            let mut j = i + 1;
            while j < lines.len() && !lines[j].trim_start().starts_with('[') {
                j += 1;
            }
            if !lines[i..j].iter().any(|l| is_coffee_kimi_command_line(l)) {
                kept.extend(&lines[i..j]);
            }
            i = j;
        } else {
            kept.push(lines[i]);
            i += 1;
        }
    }
    // Drop trailing blank lines left behind by the strip so the re-appended
    // block doesn't drift further down the file on every reinstall.
    while kept.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        kept.pop();
    }

    // TOML basic strings escape backslashes and quotes — the hook command is
    // `"<exe>" __kimi-hook` with literal quotes around the exe path.
    let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");

    let mut out = String::new();
    if existing.trim().is_empty() {
        out.push_str("# Coffee CLI registered these hooks for the dynamic-island status\n# indicator. Safe to remove if you don't use Coffee CLI — the command\n# no-ops when COFFEE_CLI_* env vars aren't set.\n");
    } else {
        for l in &kept {
            out.push_str(l);
            out.push('\n');
        }
        out.push('\n');
    }
    for (idx, event) in KIMI_HOOK_EVENTS.iter().enumerate() {
        if idx > 0 {
            out.push('\n');
        }
        out.push_str("[[hooks]]\n");
        out.push_str(&format!("event = \"{}\"\n", event));
        out.push_str(&format!("command = \"{}\"\n", escaped));
        out.push_str("timeout = 30\n");
    }

    fs::write(path, out)?;
    Ok(())
}

/// Text-level sentinel for patch_kimi_config: a `command = "..."` line is
/// ours iff the last whitespace-delimited token inside the quotes is
/// `__kimi-hook`. Mirrors is_coffee_entry's last-token discipline so a user
/// hook whose path merely *contains* "__kimi-hook" (e.g.
/// /home/u/.__kimi-hooks/lint.sh) is never misclassified as ours.
fn is_coffee_kimi_command_line(line: &str) -> bool {
    let t = line.trim();
    let Some(rest) = t.strip_prefix("command") else {
        return false;
    };
    let Some(value) = rest.trim_start().strip_prefix('=') else {
        return false;
    };
    let value = value.trim().trim_end_matches('"');
    value.split_whitespace().last() == Some(KIMI_HOOK_SUBCOMMAND)
}

// ─── Broken-bin repair (Windows) ────────────────────────────────────────────
//
// `opencode upgrade` re-runs `npm install -g opencode-ai` to rewrite the
// global bin. On Windows, if an opencode process is running (e.g. the one
// Coffee CLI launched), cmd.exe holds a lock on opencode.cmd — npm renames
// it to .opencode.cmd-<rand> as the first step of the rewrite, then fails
// to write the new file, leaving the orphan AND no usable bin. `where
// opencode` then fails with "not found".
//
// We can't prevent the upgrade (the user runs it themselves, outside our
// process). But at Coffee CLI launch — when opencode is almost certainly
// NOT running (the user just opened the app) — we can detect the broken
// state and re-run the install to rebuild the links. Idempotent and safe:
// if the bin is fine, we do nothing; if the package isn't npm-installed,
// we do nothing; if the binary is currently running, we skip (can't fix
// under the lock anyway — next launch will catch it).

#[cfg(target_os = "windows")]
const NPM_REPAIR_TARGETS: &[(&str, &str)] = &[
    // (binary_name we look for on PATH, npm global package that provides it)
    ("opencode", "opencode-ai"),
    // MiMo Code is an OpenCode fork with the same upgrade/bin-rewrite shape.
    // Its npm package name isn't confirmed across installs, so this entry is
    // best-effort — add the correct name here once verified.
    // ("mimo", "@mimo-ai/cli"),
];

#[cfg(target_os = "windows")]
pub fn repair_broken_npm_bins() {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    for (bin, pkg) in NPM_REPAIR_TARGETS {
        // Bin still resolves? Nothing to do.
        if crate::server::binary_on_path(bin) {
            continue;
        }
        // FAST PATH — detect the breakage WITHOUT spawning npm. The signature
        // of a shattered bin is orphan files in npm's global bin dir: npm
        // renames `opencode.cmd` → `.opencode.cmd-<rand>` as the first step of
        // a rewrite, then fails to write the new file, leaving the orphan AND
        // no usable bin. If no such orphan exists, either the user never had
        // this tool, or the bin is gone for an unrelated reason — in both
        // cases an `npm install -g` won't help and would just waste ~1-2s of
        // boot time spawning npm for users who never installed opencode.
        let Some(npm_bin_dir) = npm_global_bin_dir() else { continue };
        if !has_shattered_orphans(&npm_bin_dir, bin) {
            continue;
        }
        // Is the binary currently running? If so, a repair now would hit the
        // same file lock that broke it. tasklist /fi over the image name,
        // CREATE_NO_WINDOW. Skip on any error (better to try the repair than
        // to skip it because tasklist itself failed).
        if process_is_running(bin) {
            eprintln!(
                "[hook-installer] {} bin is broken but the process is running — \
                 skipping npm repair (would hit the file lock). It'll repair on a \
                 next launch where {} isn't running.",
                bin, bin
            );
            continue;
        }
        eprintln!(
            "[hook-installer] {} bin missing with orphan files in {} — repairing \
             the bin links with `npm install -g {}`",
            bin, npm_bin_dir.display(), pkg
        );
        // Re-run the install to rebuild the bin links. 120s timeout — npm
        // global install can be slow on a cold cache, but we don't want to
        // hang the app boot forever if something's wrong. cmd /c for the
        // same .cmd-shim reason as the ls above.
        let mut repair = Command::new("cmd");
        repair
            .args(["/c", "npm", "install", "-g", pkg])
            .creation_flags(0x08000000);
        match run_with_timeout(&mut repair, std::time::Duration::from_secs(120)) {
            Ok(true) => {
                eprintln!("[hook-installer] {} repair install finished", bin);
            }
            Ok(false) => {
                eprintln!("[hook-installer] {} repair install timed out", bin);
            }
            Err(e) => {
                eprintln!("[hook-installer] {} repair install failed: {}", bin, e);
            }
        }
    }
}

/// npm's global bin dir on Windows. npm prefix -g is normally
/// `%APPDATA%\npm` (where .cmd shims live). Derived from APPDATA rather than
/// spawning `npm prefix -g` so the orphan-check fast path stays spawn-free.
#[cfg(target_os = "windows")]
fn npm_global_bin_dir() -> Option<std::path::PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(std::path::PathBuf::from(appdata).join("npm"))
}

/// True iff npm's global bin dir contains a shattered-orphan file for `bin`:
/// a file named `.{bin}.cmd-<suffix>`, `.{bin}.ps1-<suffix>`, or
/// `.{bin}-<suffix>` (the temp-rename residue npm leaves when a bin rewrite
/// is interrupted). These only exist when a real install was shattered —
/// users who never installed the tool have no such files, so this is the
/// zero-spawn signal to skip the repair entirely.
#[cfg(target_os = "windows")]
fn has_shattered_orphans(npm_bin_dir: &std::path::Path, bin: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(npm_bin_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // Orphans look like ".opencode.cmd-S0tGGhyQ", ".opencode.ps1-f0SU9OXr",
        // ".opencode-TbIJLj3H" — a leading dot, the bin name, then a suffix
        // after a '-' (the random rename token). The real bin has no leading
        // dot and no '-' suffix.
        if name.starts_with(&format!(".{}", bin)) && name.contains('-') {
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn process_is_running(image_name: &str) -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // tasklist filters by image name; the exe may be opencode.exe or
    // mimo.exe. Match the bare name (tasklist matches case-insensitively
    // and accepts with/without .exe).
    let filter = format!("imagename eq {}*", image_name);
    match Command::new("tasklist")
        .args(["/fi", &filter, "/nh", "/fo", "csv"])
        .creation_flags(0x08000000)
        .output()
    {
        Ok(o) => {
            let out = String::from_utf8_lossy(&o.stdout);
            // CSV rows for running processes start with the quoted image name.
            // No header (/nh), so any non-empty output line mentioning the
            // name means it's running.
            out.lines().any(|l| l.to_lowercase().contains(image_name))
        }
        Err(_) => false, // tasklist failed — assume not running so we still try
    }
}

#[cfg(target_os = "windows")]
fn run_with_timeout(cmd: &mut std::process::Command, dur: std::time::Duration) -> std::io::Result<bool> {
    // std::process::Command has no blocking-with-timeout; spawn and poll
    // try_wait until the deadline. On timeout, kill the child so a hung npm
    // doesn't stall boot. Returns Ok(true) if it exited, Ok(false) if killed.
    use std::time::Instant;
    let mut child = cmd.spawn()?;
    let deadline = Instant::now() + dur;
    loop {
        if let Some(_status) = child.try_wait()? {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(false);
        }
        // Short sleep so we don't busy-wait; npm install is seconds-to-minutes,
        // a 100ms poll is fine-grained enough.
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fresh_codex_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("coffee-codex-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn codex_hooks_json_creates_with_4_events() {
        let dir = fresh_codex_dir("create");
        let hooks_path = dir.join("hooks.json");
        let cmd = "\"/fake/exe\" __codex-hook";
        install_codex_hooks(&hooks_path, cmd).unwrap();

        let text = fs::read_to_string(&hooks_path).unwrap();
        let root: Value = serde_json::from_str(&text).unwrap();
        let hooks = root.get("hooks").and_then(|h| h.as_object()).unwrap();
        assert!(hooks.contains_key("SessionStart"));
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("PermissionRequest"));
        assert!(hooks.contains_key("Stop"));

        // SessionStart has the startup|resume matcher.
        let ss = hooks.get("SessionStart").unwrap().as_array().unwrap();
        assert!(ss.iter().any(|g| g.get("matcher").and_then(|m| m.as_str()) == Some("startup|resume")));

        // Each managed event has exactly one group whose single hook command
        // is ours.
        for ev in ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"] {
            let groups = hooks.get(ev).unwrap().as_array().unwrap();
            let ours: Vec<_> = groups.iter().filter(|g| {
                g.get("hooks").and_then(|h| h.as_array())
                    .map(|hs| hs.iter().any(is_coffee_codex_entry))
                    .unwrap_or(false)
            }).collect();
            assert_eq!(ours.len(), 1, "event {} should have exactly one managed group", ev);
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_hooks_json_idempotent_no_accumulation() {
        let dir = fresh_codex_dir("idempotent");
        let hooks_path = dir.join("hooks.json");
        let cmd = "\"/fake/exe\" __codex-hook";
        // Install 3x — each should strip the prior managed entry and add one
        // fresh, never accumulating duplicates.
        for _ in 0..3 {
            install_codex_hooks(&hooks_path, cmd).unwrap();
        }
        let root: Value = serde_json::from_str(&fs::read_to_string(&hooks_path).unwrap()).unwrap();
        let hooks = root.get("hooks").and_then(|h| h.as_object()).unwrap();
        for ev in ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop"] {
            let groups = hooks.get(ev).unwrap().as_array().unwrap();
            let ours: Vec<_> = groups.iter().filter(|g| {
                g.get("hooks").and_then(|h| h.as_array())
                    .map(|hs| hs.iter().any(is_coffee_codex_entry))
                    .unwrap_or(false)
            }).collect();
            assert_eq!(ours.len(), 1, "event {} accumulated {} managed groups", ev, ours.len());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_hooks_json_preserves_user_hooks() {
        let dir = fresh_codex_dir("preserve");
        let hooks_path = dir.join("hooks.json");
        // User has their own Stop hook + a custom event we don't manage.
        // Built with serde so there's no hand-written JSON to get wrong.
        let initial = serde_json::json!({
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "echo user"}]}],
                "MyCustomEvent": [{"hooks": [{"type": "command", "command": "echo custom"}]}]
            }
        });
        fs::write(&hooks_path, serde_json::to_string_pretty(&initial).unwrap()).unwrap();
        install_codex_hooks(&hooks_path, "\"/fake/exe\" __codex-hook").unwrap();
        let root: Value = serde_json::from_str(&fs::read_to_string(&hooks_path).unwrap()).unwrap();
        let hooks = root.get("hooks").and_then(|h| h.as_object()).unwrap();
        // Custom event preserved untouched.
        assert!(hooks.contains_key("MyCustomEvent"));
        // Stop now has the user's group + our managed group.
        let stop = hooks.get("Stop").unwrap().as_array().unwrap();
        assert!(stop.iter().any(|g| {
            g.get("hooks").and_then(|h| h.as_array())
                .map(|hs| hs.iter().any(|h| h.get("command").and_then(|c| c.as_str()) == Some("echo user")))
                .unwrap_or(false)
        }), "user's Stop hook should be preserved");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_hooks_json_unparseable_left_untouched() {
        let dir = fresh_codex_dir("unparseable");
        let hooks_path = dir.join("hooks.json");
        let garbage = "{ this is not valid json";
        fs::write(&hooks_path, garbage).unwrap();
        // Should return Ok (not error) and leave the file as-is.
        install_codex_hooks(&hooks_path, "\"/fake/exe\" __codex-hook").unwrap();
        assert_eq!(fs::read_to_string(&hooks_path).unwrap(), garbage);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_features_enables_hooks_and_strips_legacy() {
        let dir = fresh_codex_dir("features");
        let cfg = dir.join("config.toml");
        fs::write(&cfg, "[features]\ncodex_hooks = true\njs_repl = false\n").unwrap();
        patch_codex_features(&cfg).unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(after.contains("hooks = true"), "should add hooks=true: {}", after);
        assert!(!after.contains("codex_hooks"), "should strip legacy key: {}", after);
        assert!(after.contains("js_repl = false"), "should preserve other keys: {}", after);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_features_creates_section_if_missing() {
        let dir = fresh_codex_dir("no-features");
        let cfg = dir.join("config.toml");
        fs::write(&cfg, "model = \"gpt-5\"\n").unwrap();
        patch_codex_features(&cfg).unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(after.contains("[features]"), "should create [features] section: {}", after);
        assert!(after.contains("hooks = true"));
        assert!(after.contains("model = \"gpt-5\""), "should preserve existing content: {}", after);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_features_idempotent() {
        let dir = fresh_codex_dir("feat-idempotent");
        let cfg = dir.join("config.toml");
        fs::write(&cfg, "[features]\n").unwrap();
        for _ in 0..3 {
            patch_codex_features(&cfg).unwrap();
        }
        let after = fs::read_to_string(&cfg).unwrap();
        let count = after.matches("hooks = true").count();
        assert_eq!(count, 1, "should not duplicate hooks=true line: {}", after);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_features_preserves_user_hooks_false_overwrites() {
        // If the user has `hooks = false` explicitly, we DO overwrite to true
        // (we manage this key). This verifies the "any value other than true
        // → drop and emit our own" branch.
        let dir = fresh_codex_dir("feat-overwrite");
        let cfg = dir.join("config.toml");
        fs::write(&cfg, "[features]\nhooks = false\n").unwrap();
        patch_codex_features(&cfg).unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(!after.contains("hooks = false"));
        assert!(after.contains("hooks = true"));
        let _ = fs::remove_dir_all(&dir);
    }

    // ─── Kimi Code config.toml `[[hooks]]` ──────────────────────────────────
    // Cargo.toml has no toml/toml_edit dependency, so these are text-level
    // assertions (per the line-editing design — a parsed round-trip would
    // defeat the comment-preservation goal anyway).

    fn fresh_kimi_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("coffee-kimi-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn kimi_config_creates_with_9_events() {
        let dir = fresh_kimi_dir("create");
        let cfg = dir.join("config.toml");
        patch_kimi_config(&cfg, "\"/fake/exe\" __kimi-hook").unwrap();

        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(text.matches("[[hooks]]").count(), 9, "one block per event: {}", text);
        assert_eq!(text.matches("__kimi-hook").count(), 9, "one command per block: {}", text);
        for ev in [
            "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
            "PermissionResult", "Stop", "StopFailure", "Interrupt", "SessionEnd",
        ] {
            assert!(text.contains(&format!("event = \"{}\"", ev)), "missing event {}: {}", ev, text);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kimi_config_preserves_existing_content() {
        let dir = fresh_kimi_dir("preserve");
        let cfg = dir.join("config.toml");
        // User config: comments, a top-level key, a regular table, and their
        // own hand-written [[hooks]] entry — all must survive verbatim.
        let original = "# my kimi config\nmodel = \"k2\"\n\n[providers.foo]\nbase_url = \"https://x\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"echo user\"\ntimeout = 5\n";
        fs::write(&cfg, original).unwrap();
        patch_kimi_config(&cfg, "\"/fake/exe\" __kimi-hook").unwrap();

        let after = fs::read_to_string(&cfg).unwrap();
        assert!(after.contains("# my kimi config"), "comment preserved: {}", after);
        assert!(after.contains("model = \"k2\""), "top-level key preserved: {}", after);
        assert!(after.contains("[providers.foo]\nbase_url = \"https://x\""), "user table preserved: {}", after);
        assert!(after.contains("command = \"echo user\""), "user's own hook preserved: {}", after);
        assert!(after.contains("timeout = 5"), "user hook fields preserved: {}", after);
        // Our blocks append AFTER the user's content.
        let pos_user = after.find("command = \"echo user\"").unwrap();
        let pos_ours = after.find("__kimi-hook").unwrap();
        assert!(pos_user < pos_ours, "ours appended at end: {}", after);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kimi_config_idempotent_no_duplicates() {
        let dir = fresh_kimi_dir("idempotent");
        let cfg = dir.join("config.toml");
        // Install 3x — each should strip the prior entries and add one fresh
        // set, never accumulating duplicates.
        for _ in 0..3 {
            patch_kimi_config(&cfg, "\"/fake/exe\" __kimi-hook").unwrap();
        }
        let text = fs::read_to_string(&cfg).unwrap();
        assert_eq!(text.matches("[[hooks]]").count(), 9, "reinstall accumulated blocks: {}", text);
        assert_eq!(text.matches("__kimi-hook").count(), 9, "reinstall accumulated commands: {}", text);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kimi_config_reinstall_strips_stale_keeps_user_hooks() {
        let dir = fresh_kimi_dir("stale");
        let cfg = dir.join("config.toml");
        // Seed a stale coffee entry (old exe path — e.g. pre-upgrade) next to
        // a user's own hook on the same event.
        let seeded = "[[hooks]]\nevent = \"Stop\"\ncommand = \"\\\"/old/path/coffee-cli.exe\\\" __kimi-hook\"\ntimeout = 30\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"echo user\"\ntimeout = 5\n";
        fs::write(&cfg, seeded).unwrap();
        patch_kimi_config(&cfg, "\"/new/exe\" __kimi-hook").unwrap();

        let after = fs::read_to_string(&cfg).unwrap();
        assert!(!after.contains("/old/path"), "stale coffee entry stripped: {}", after);
        assert_eq!(after.matches("__kimi-hook").count(), 9, "exactly one fresh set: {}", after);
        assert!(after.contains("command = \"echo user\""), "user hook kept: {}", after);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kimi_config_blocks_have_only_allowed_fields() {
        // Kimi rejects the ENTIRE config.toml if a [[hooks]] table carries
        // any key beyond event/matcher/command/timeout. Verify every line
        // inside our generated blocks is one of the three we intend (matcher
        // omitted by design) — no stray keys can sneak in.
        let dir = fresh_kimi_dir("fields");
        let cfg = dir.join("config.toml");
        patch_kimi_config(&cfg, "\"/fake/exe\" __kimi-hook").unwrap();

        let text = fs::read_to_string(&cfg).unwrap();
        assert!(!text.contains("matcher"), "no matcher keys: {}", text);
        let mut in_block = false;
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with("[[hooks]]") {
                in_block = true;
                continue;
            }
            if t.starts_with('[') {
                in_block = false;
                continue;
            }
            if !in_block || t.is_empty() || t.starts_with('#') {
                continue;
            }
            assert!(
                t.starts_with("event = ") || t.starts_with("command = ") || t.starts_with("timeout = "),
                "unexpected field in [[hooks]] block: {:?}",
                line
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
