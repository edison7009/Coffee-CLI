// Coffee CLI legacy hook cleanup
//
// Coffee no longer installs status hooks or plugins into third-party tools.
// At app launch this module removes artifacts written by older releases while
// preserving user-owned hooks and unrelated configuration.
//
//   Claude Code
//     1. No hook install. TierTerminal reads Claude's native OSC title.
//     2. Prior Coffee entries are stripped from settings.json and
//        settings.local.json while user-owned hooks remain untouched.
//     3. The obsolete ~/.coffee-cli/hooks/coffee-cli-hook.py copy is removed.
//
//   Codex
//     1. No hook install. TierTerminal reads Codex's native OSC terminal title.
//     2. Prior Coffee hook / notify / trust entries are removed at app launch.
//     3. Remove the obsolete ~/.coffee-cli/hooks notify script copy.
//
//   OpenCode / MiMo Code
//     1. Remove coffee-cli-island.js from each tool's plugin directory.
//     2. Remove the old debug copy and diagnostic log.
//     3. Keep the unrelated transparent TUI theme migration.
//
//   Hermes Agent
//     1. Remove Coffee's plugin files from <HERMES_HOME>/plugins/.
//     2. Remove coffee-cli-status from plugins.enabled/disabled in config.yaml.
//
//   Kimi Code
//     1. Remove only `[[hooks]]` blocks whose command ends in __kimi-hook.
//
//   Grok Build
//     1. Remove every Coffee-owned JSON hook file containing __grok-hook.
//
// Errors are logged, never fatal — a broken installer must not prevent
// Coffee CLI from starting.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const SCRIPT_FILENAME: &str = "coffee-cli-hook.py";

const CODEX_NOTIFY_FILENAME: &str = "coffee-cli-codex-notify.py";

/// Tokens used only to recognize entries written by older Coffee releases.
const HOOK_SUBCOMMAND: &str = "__hook";
const CODEX_NOTIFY_SUBCOMMAND: &str = "__codex-notify";

const OPENCODE_PLUGIN_FILENAME: &str = "coffee-cli-island.js";

const HERMES_PLUGIN_NAME: &str = "coffee-cli-status";

pub fn cleanup_all() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            eprintln!("[hook-installer] no home dir — skipping");
            return;
        }
    };

    for tool in crate::tools::TOOLS {
        if tool.has_legacy_hook_artifacts {
            cleanup_tool(tool, &home);
        }
    }

    // Orca (stablyai/orca) injects agent-status hooks into many CLIs and
    // leaves the residue behind after uninstall; strip its fingerprint
    // everywhere and delete its own directories. Gated on the Orca process
    // not running (see cleanup_orca).
    cleanup_orca(&home);

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

/// Re-run cleanup for one tool after the launchpad's PATH rescan. This also
/// applies the OpenCode-family transparent theme when a CLI is newly installed.
pub fn maintain_for_tool(tool: &str) {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let Some(descriptor) = crate::tools::find(tool) else {
        return;
    };
    if !descriptor.has_legacy_hook_artifacts {
        return;
    }
    cleanup_tool(descriptor, &home);
}

/// Per-tool legacy cleanup dispatch. Cleanup runs without a PATH gate so an
/// uninstalled CLI cannot strand Coffee's old entries in user configuration.
fn cleanup_tool(tool: &crate::tools::ToolDescriptor, home: &Path) {
    match tool.id {
        "claude" => {
            cleanup_claude(home);
            return;
        }
        "codex" => {
            cleanup_codex(home);
            return;
        }
        "opencode" => {
            cleanup_opencode_plugin(home, "opencode");
            if crate::server::binary_on_path(tool.binary_name) {
                ensure_opencode_tui_theme_default(home, "opencode");
            }
        }
        "mimocode" => {
            cleanup_opencode_plugin(home, "mimocode");
            if crate::server::binary_on_path(tool.binary_name) {
                ensure_opencode_tui_theme_default(home, "mimocode");
            }
        }
        "kilo" => {
            cleanup_opencode_plugin(home, "kilo");
            if crate::server::binary_on_path(tool.binary_name) {
                ensure_opencode_tui_theme_default(home, "kilo");
            }
        }
        "hermes" => cleanup_hermes_plugin(home),
        "kimicode" => cleanup_kimi_hooks(home),
        "grok" => cleanup_grok_hooks(home),
        other => {
            eprintln!(
                "[hook-installer] tool '{}' declares legacy hook artifacts but has no cleanup arm",
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

fn cleanup_claude(home: &Path) {
    // Claude's native title now drives Coffee's working/idle state. Remove
    // every Coffee-installed handler from both historical config locations;
    // malformed files and user-owned hooks are deliberately left untouched.
    for path in [
        home.join(".claude").join("settings.json"),
        home.join(".claude").join("settings.local.json"),
    ] {
        if !path.exists() {
            continue;
        }
        if let Err(e) = strip_coffee_hooks(&path) {
            eprintln!("[hook-installer] failed to clean {}: {}", path.display(), e);
        }
    }

    // This fixed path was created only by Coffee CLI. It is not executable
    // configuration anymore, so remove it as part of the same migration.
    let legacy_script = home.join(".coffee-cli").join("hooks").join(SCRIPT_FILENAME);
    if legacy_script.exists() {
        if let Err(e) = fs::remove_file(&legacy_script) {
            eprintln!(
                "[hook-installer] failed to remove {}: {}",
                legacy_script.display(),
                e
            );
        }
    }
}

/// Codex hook-driven dynamic-island support has been removed. Coffee reads
/// Codex's native OSC terminal-title activity directly in TierTerminal instead,
/// avoiding hook trust churn while still receiving working / input / idle.
/// Any prior Coffee CLI codex hook / notify / trust install is stripped so existing setups
/// stop firing the broken hooks and stop hitting codex's "hooks need review"
/// prompt.
fn cleanup_codex(home: &Path) {
    cleanup_codex_island_install(home);
    let script = home
        .join(".coffee-cli")
        .join("hooks")
        .join(CODEX_NOTIFY_FILENAME);
    remove_marked_file(&script, &["Coffee CLI", "Codex Notify Forwarder"]);
}

/// Remove every Coffee CLI codex dynamic-island artifact from ~/.codex so a
/// prior install (hooks.json entries, the `notify` line, `[hooks.state]` trust
/// blocks) stops firing the broken/renamed hooks. Idempotent; preserves
/// user-owned codex hooks and all other config. Errors are logged, not fatal.
fn cleanup_codex_island_install(home: &Path) {
    let hooks_path = home.join(".codex").join("hooks.json");
    let config_path = home.join(".codex").join("config.toml");
    if let Err(e) = strip_codex_hook_trust(&config_path, &hooks_path, None, is_coffee_codex_entry) {
        eprintln!(
            "[hook-installer] failed to strip codex managed trust: {}",
            e
        );
        return;
    }
    if let Err(e) = strip_codex_managed_hooks(&hooks_path) {
        eprintln!(
            "[hook-installer] failed to strip codex managed hooks: {}",
            e
        );
    }
    if let Err(e) = strip_codex_notify(&config_path) {
        eprintln!("[hook-installer] failed to strip codex notify line: {}", e);
    }
}

/// Remove our `__codex-hook` entries from the 4 managed events in
/// ~/.codex/hooks.json, dropping events left empty. A malformed or user-owned
/// file is left untouched.
fn strip_codex_managed_hooks(hooks_path: &Path) -> anyhow::Result<()> {
    if !hooks_path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(hooks_path).unwrap_or_default();
    let mut root: Value = jsonc_parser::parse_to_serde_value(
        text.trim_start_matches('\u{feff}'),
        &orca_json_parse_options(),
    )
    .unwrap_or_else(|_| json!({}));
    if !root.is_object() {
        return Ok(()); // malformed — don't touch
    }
    let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(());
    };
    let mut changed = false;
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PermissionRequest",
        "Stop",
    ] {
        let Some(arr) = hooks.get_mut(event).and_then(|e| e.as_array_mut()) else {
            continue;
        };
        let mut event_changed = false;
        arr.retain_mut(|group| {
            let Some(entries) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) else {
                return true;
            };
            let before = entries.len();
            entries.retain(|entry| !is_coffee_codex_entry(entry));
            let group_changed = entries.len() != before;
            changed |= group_changed;
            event_changed |= group_changed;
            !group_changed || !entries.is_empty()
        });
        if event_changed && arr.is_empty() {
            hooks.remove(event);
        }
    }
    if !changed {
        return Ok(());
    }
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
    let out = serde_json::to_string_pretty(&root)?;
    fs::write(hooks_path, out)?;
    Ok(())
}

/// Remove our top-level `notify = ["<exe>", "__codex-notify"]` line from
/// ~/.codex/config.toml (only the top-level one — a notify inside a [section]
/// is a different key we don't touch). Byte-preserving line edit.
fn strip_codex_notify(config_path: &Path) -> anyhow::Result<()> {
    if !config_path.exists() {
        return Ok(());
    }
    let existing = fs::read_to_string(config_path).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    let mut seen_section = false;
    let mut changed = false;
    for line in existing.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') && !trimmed.starts_with("[[") {
            seen_section = true;
        }
        if !seen_section && is_our_notify_line(trimmed) {
            changed = true;
            continue;
        }
        out.push(line.to_string());
    }
    if changed {
        let mut joined = out.join("\n");
        if !joined.ends_with('\n') {
            joined.push('\n');
        }
        fs::write(config_path, joined)?;
    }
    Ok(())
}

fn is_our_notify_line(trimmed: &str) -> bool {
    let Some(rest) = trimmed.strip_prefix("notify") else {
        return false;
    };
    let rest = rest.trim_start();
    if !rest.starts_with('=') {
        return false;
    }
    rest.contains(CODEX_NOTIFY_SUBCOMMAND) || rest.contains(CODEX_NOTIFY_FILENAME)
}

/// Remove the OpenCode-family plugin written by older Coffee releases. The
/// fixed filename is only deleted when its contents carry Coffee's marker, so
/// a user replacement with the same name survives.
fn cleanup_opencode_plugin(home: &Path, config_subdir: &str) {
    let plugin_path = home
        .join(".config")
        .join(config_subdir)
        .join("plugins")
        .join(OPENCODE_PLUGIN_FILENAME);
    remove_marked_file(
        &plugin_path,
        &["Coffee CLI", "CoffeeCliIslandPlugin"],
    );

    let debug_copy = home
        .join(".coffee-cli")
        .join("hooks")
        .join(OPENCODE_PLUGIN_FILENAME);
    remove_marked_file(
        &debug_copy,
        &["Coffee CLI", "CoffeeCliIslandPlugin"],
    );

    // This log name was hardcoded by Coffee's old plugin and has no other
    // producer. It may contain prompt/event diagnostics, so remove it too.
    let _ = fs::remove_file(home.join("coffee-cli-opencode.log"));
}

/// Remove Coffee's Hermes plugin files and allow-list entry without invoking
/// Hermes or reserializing the user's YAML. Block-list and flow-list forms are
/// both handled; comments and unrelated formatting remain intact.
fn cleanup_hermes_plugin(home: &Path) {
    let hermes_home = crate::tools::hermes::hermes_home();
    let plugin_dir = hermes_home.join("plugins").join(HERMES_PLUGIN_NAME);
    let init_path = plugin_dir.join("__init__.py");
    let manifest_path = plugin_dir.join("plugin.yaml");

    remove_marked_file(
        &init_path,
        &["Coffee CLI status forwarder", "pre_approval_request"],
    );
    remove_marked_file(&manifest_path, &["name: coffee-cli-status", "Coffee CLI"]);
    let _ = fs::remove_dir(&plugin_dir);

    if let Err(e) = strip_hermes_plugin_from_yaml(&hermes_home.join("config.yaml")) {
        eprintln!("[hook-installer] failed to clean Hermes config: {}", e);
    }

    let debug_copy = home
        .join(".coffee-cli")
        .join("hooks")
        .join("coffee-cli-hermes-plugin.py");
    remove_marked_file(
        &debug_copy,
        &["Coffee CLI status forwarder", "pre_approval_request"],
    );
}

fn remove_marked_file(path: &Path, markers: &[&str]) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    if !markers.iter().all(|marker| text.contains(marker)) {
        return;
    }
    if let Err(e) = fs::remove_file(path) {
        eprintln!(
            "[hook-installer] failed to remove {}: {}",
            path.display(),
            e
        );
    }
}

fn strip_hermes_plugin_from_yaml(path: &Path) -> anyhow::Result<()> {
    strip_hermes_plugin_from_yaml_named(path, HERMES_PLUGIN_NAME)
}

/// Shared YAML allow-list stripper: removes `plugin_name` from plugins.enabled
/// / plugins.disabled (block-list and flow-list forms), preserving comments and
/// unrelated formatting byte-for-byte. Used for Coffee's own plugin and for
/// Orca's residue (orca-status).
fn strip_hermes_plugin_from_yaml_named(path: &Path, plugin_name: &str) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(path)?;
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::with_capacity(lines.len());
    let mut plugins_indent: Option<usize> = None;
    let mut list_indent: Option<usize> = None;
    let mut changed = false;

    for line in lines {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        let structural = !trimmed.is_empty() && !trimmed.starts_with('#');

        if structural {
            if let Some(base) = plugins_indent {
                if indent <= base && !trimmed.starts_with("plugins:") {
                    plugins_indent = None;
                    list_indent = None;
                }
            }
            if trimmed
                .strip_prefix("plugins:")
                .map(|rest| rest.trim().is_empty() || rest.trim_start().starts_with('#'))
                .unwrap_or(false)
            {
                plugins_indent = Some(indent);
                list_indent = None;
            } else if plugins_indent.is_some() {
                if let Some(base) = list_indent {
                    if indent <= base {
                        list_indent = None;
                    }
                }
                if let Some(rewritten) = strip_hermes_flow_list(line, "enabled", plugin_name)
                    .or_else(|| strip_hermes_flow_list(line, "disabled", plugin_name))
                {
                    changed |= rewritten != line;
                    out.push(rewritten);
                    continue;
                }
                if ["enabled:", "disabled:"].iter().any(|key| {
                    trimmed
                        .strip_prefix(key)
                        .map(|rest| rest.trim().is_empty() || rest.trim_start().starts_with('#'))
                        .unwrap_or(false)
                }) {
                    list_indent = Some(indent);
                } else if list_indent.is_some() && is_hermes_plugin_list_item(trimmed, plugin_name)
                {
                    changed = true;
                    continue;
                }
            }
        }
        out.push(line.to_string());
    }

    if changed {
        let mut joined = out.join("\n");
        if text.ends_with('\n') {
            joined.push('\n');
        }
        fs::write(path, joined)?;
    }
    Ok(())
}

fn is_hermes_plugin_list_item(trimmed: &str, plugin_name: &str) -> bool {
    let Some(value) = trimmed.strip_prefix('-') else {
        return false;
    };
    yaml_scalar_without_comment(value) == plugin_name
}

fn strip_hermes_flow_list(line: &str, key: &str, plugin_name: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let rest = trimmed
        .strip_prefix(key)?
        .trim_start()
        .strip_prefix(':')?
        .trim_start();
    let open = rest.find('[')?;
    let close = rest[open + 1..].find(']')? + open + 1;
    let values = &rest[open + 1..close];
    let kept: Vec<&str> = values
        .split(',')
        .filter(|value| yaml_scalar_without_comment(value) != plugin_name)
        .collect();
    if kept.len() == values.split(',').count() {
        return Some(line.to_string());
    }
    let prefix_len = line.len() - trimmed.len();
    let suffix = &rest[close + 1..];
    Some(format!(
        "{}{}: [{}]{}",
        &line[..prefix_len],
        key,
        kept.iter().map(|v| v.trim()).collect::<Vec<_>>().join(", "),
        suffix
    ))
}

fn yaml_scalar_without_comment(value: &str) -> &str {
    value
        .split('#')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_matches(['\'', '"'])
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
    let Some(obj) = root.as_object_mut() else {
        return;
    };
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

/// Remove every Coffee CLI hook handler from `path` without touching any
/// user-owned key or sibling handler in the same hook group.
fn strip_coffee_hooks(path: &Path) -> anyhow::Result<()> {
    let text = fs::read_to_string(path)?;
    let mut root: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(()), // unparseable user file — leave it alone
    };
    let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(());
    };

    let mut changed = false;
    let mut empty_events = Vec::new();
    for (event, slot) in hooks.iter_mut() {
        if let Some(arr) = slot.as_array_mut() {
            let mut emptied_groups = Vec::new();
            for (index, group) in arr.iter_mut().enumerate() {
                let Some(handlers) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) else {
                    continue;
                };
                let before = handlers.len();
                handlers.retain(|handler| !is_coffee_handler(handler));
                if handlers.len() != before {
                    changed = true;
                    if handlers.is_empty() {
                        emptied_groups.push(index);
                    }
                }
            }
            for index in emptied_groups.into_iter().rev() {
                arr.remove(index);
            }
            if arr.is_empty() {
                empty_events.push(event.clone());
            }
        }
    }
    for k in empty_events {
        hooks.remove(&k);
        changed = true;
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

    if changed {
        fs::write(path, serde_json::to_string_pretty(&root)?)?;
    }
    Ok(())
}

fn is_coffee_handler(handler: &Value) -> bool {
    handler
        .get("command")
        .and_then(|c| c.as_str())
        // Match the legacy Python command and the native `<exe> __hook`
        // command. Last-token matching avoids deleting a user command whose
        // path merely contains "__hook" (for example .__hooks/lint.sh).
        .map(|command| {
            command.contains(SCRIPT_FILENAME)
                || command.split_whitespace().last() == Some(HOOK_SUBCOMMAND)
        })
        .unwrap_or(false)
}

/// Token used by old Coffee entries in ~/.codex/hooks.json.
const CODEX_HOOK_SUBCOMMAND: &str = "__codex-hook";

/// A hook entry is ours iff its command's last whitespace-delimited token is
/// `__codex-hook` (the native subcommand). Uses the same last-token
/// match so a user hook whose path merely contains "__codex-hook"
/// is never misclassified as ours.
fn is_coffee_codex_entry(entry: &Value) -> bool {
    entry
        .get("command")
        .and_then(|c| c.as_str())
        .map(|s| s.split_whitespace().last() == Some(CODEX_HOOK_SUBCOMMAND))
        .unwrap_or(false)
}

/// Parse a `[hooks.state.'<key>']` / `[hooks.state."<key>"]` header line,
/// returning the raw key string. Returns None for the bare `[hooks.state]`
/// parent table or any other header.
fn parse_codex_state_header(line: &str) -> Option<String> {
    let t = line.trim();
    let rest = t.strip_prefix("[hooks.state.")?;
    if let Some(r) = rest.strip_prefix('\'') {
        // literal string — read until the next single quote
        let end = r.find('\'')?;
        let after = r[end + 1..].trim_start();
        if after.starts_with(']') {
            Some(r[..end].to_string())
        } else {
            None
        }
    } else if let Some(r) = rest.strip_prefix('"') {
        // basic string — read until an unescaped double quote
        let mut key = String::new();
        let mut chars = r.chars().peekable();
        let mut closed = false;
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(&n) = chars.peek() {
                    key.push(n);
                    chars.next();
                }
                continue;
            }
            if c == '"' {
                closed = true;
                break;
            }
            key.push(c);
        }
        if closed {
            Some(key)
        } else {
            None
        }
    } else {
        None
    }
}

fn is_toml_table_header(line: &str) -> bool {
    line.trim_start().starts_with('[')
}

// ─── Kimi Code legacy hook cleanup ───────────────────────────────────────────

const KIMI_HOOK_SUBCOMMAND: &str = "__kimi-hook";

fn cleanup_kimi_hooks(home: &Path) {
    let config_path = home.join(".kimi-code").join("config.toml");
    if let Err(e) = strip_kimi_hooks(&config_path) {
        eprintln!(
            "[hook-installer] failed to clean {}: {}",
            config_path.display(),
            e
        );
    }
}

/// Remove Coffee-owned `[[hooks]]` tables while preserving all user TOML
/// byte-for-byte apart from blank lines adjacent to removed blocks.
fn strip_kimi_hooks(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let existing = fs::read_to_string(path)?;

    // Strip our prior entries. A "block" is a `[[...]]` array-of-tables
    // header line plus the lines up to (not including) the next table
    // header; it's ours iff it contains a `command` line whose last token
    // is `__kimi-hook` (the same last-token discipline as the Claude cleanup,
    // user hook whose path merely *contains* the token is never stripped).
    let lines: Vec<&str> = existing.lines().collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut changed = false;
    let mut i = 0;
    while i < lines.len() {
        if lines[i].trim_start().starts_with("[[") {
            let mut j = i + 1;
            while j < lines.len() && !lines[j].trim_start().starts_with('[') {
                j += 1;
            }
            if lines[i..j].iter().any(|l| is_coffee_kimi_command_line(l)) {
                changed = true;
            } else {
                kept.extend(&lines[i..j]);
            }
            i = j;
        } else {
            kept.push(lines[i]);
            i += 1;
        }
    }
    if !changed {
        return Ok(());
    }

    const COFFEE_HEADER: [&str; 3] = [
        "# Coffee CLI registered these hooks for the dynamic-island status",
        "# indicator. Safe to remove if you don't use Coffee CLI — the command",
        "# no-ops when COFFEE_CLI_* env vars aren't set.",
    ];
    kept.retain(|line| !COFFEE_HEADER.contains(&line.trim_end()));
    while kept
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        kept.pop();
    }

    if kept.is_empty() {
        fs::remove_file(path)?;
    } else {
        let mut out = kept.join("\n");
        out.push('\n');
        fs::write(path, out)?;
    }
    Ok(())
}

/// A `command = "..."` line is
/// ours iff the last whitespace-delimited token inside the quotes is
/// `__kimi-hook`. Uses last-token matching so a user
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
        let Some(npm_bin_dir) = npm_global_bin_dir() else {
            continue;
        };
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
            bin,
            npm_bin_dir.display(),
            pkg
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
fn run_with_timeout(
    cmd: &mut std::process::Command,
    dur: std::time::Duration,
) -> std::io::Result<bool> {
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
    fn claude_migration_removes_only_coffee_hooks_and_legacy_script() {
        let home = fresh_codex_dir("claude-title-migration");
        let claude_dir = home.join(".claude");
        let hook_dir = home.join(".coffee-cli").join("hooks");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::create_dir_all(&hook_dir).unwrap();

        let settings = json!({
            "theme": "dark",
            "hooks": {
                "UserPromptSubmit": [{
                    "hooks": [
                        { "type": "command", "command": "& \"C:/Coffee CLI/coffee-cli.exe\" __hook" },
                        { "type": "command", "command": "/home/user/my-hook.sh" }
                    ]
                }],
                "Stop": [{
                    "hooks": [{ "type": "command", "command": "/home/user/stop.sh" }]
                }]
            }
        });
        let local_settings = json!({
            "hooks": {
                "Notification": [{
                    "hooks": [{ "type": "command", "command": "python ~/.coffee-cli/hooks/coffee-cli-hook.py" }]
                }]
            }
        });
        let settings_path = claude_dir.join("settings.json");
        let local_path = claude_dir.join("settings.local.json");
        let legacy_script = hook_dir.join(SCRIPT_FILENAME);
        fs::write(
            &settings_path,
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .unwrap();
        fs::write(
            &local_path,
            serde_json::to_string_pretty(&local_settings).unwrap(),
        )
        .unwrap();
        fs::write(&legacy_script, "legacy").unwrap();

        cleanup_claude(&home);

        let cleaned: Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        let prompt_handlers = cleaned["hooks"]["UserPromptSubmit"][0]["hooks"]
            .as_array()
            .unwrap();
        assert_eq!(prompt_handlers.len(), 1);
        assert_eq!(prompt_handlers[0]["command"], "/home/user/my-hook.sh");
        assert_eq!(
            cleaned["hooks"]["Stop"][0]["hooks"][0]["command"],
            "/home/user/stop.sh"
        );
        assert_eq!(cleaned["theme"], "dark");

        let cleaned_local: Value =
            serde_json::from_str(&fs::read_to_string(&local_path).unwrap()).unwrap();
        assert!(cleaned_local.get("hooks").is_none());
        assert!(!legacy_script.exists());

        let first_cleanup = fs::read_to_string(&settings_path).unwrap();
        cleanup_claude(&home);
        assert_eq!(fs::read_to_string(&settings_path).unwrap(), first_cleanup);

        let _ = fs::remove_dir_all(&home);
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
    fn kimi_cleanup_removes_coffee_blocks_and_keeps_user_content() {
        let dir = fresh_kimi_dir("cleanup");
        let cfg = dir.join("config.toml");
        let seeded = "# my kimi config\nmodel = \"k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"\\\"/old/path/coffee-cli.exe\\\" __kimi-hook\"\ntimeout = 30\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"echo user\"\ntimeout = 5\n";
        fs::write(&cfg, seeded).unwrap();

        strip_kimi_hooks(&cfg).unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(
            !after.contains("__kimi-hook"),
            "Coffee hook removed: {}",
            after
        );
        assert!(
            after.contains("# my kimi config"),
            "comment preserved: {}",
            after
        );
        assert!(
            after.contains("model = \"k2\""),
            "config preserved: {}",
            after
        );
        assert!(
            after.contains("command = \"echo user\""),
            "user hook preserved: {}",
            after
        );

        let first = after.clone();
        strip_kimi_hooks(&cfg).unwrap();
        assert_eq!(fs::read_to_string(&cfg).unwrap(), first);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kimi_cleanup_deletes_coffee_only_config() {
        let dir = fresh_kimi_dir("only-coffee");
        let cfg = dir.join("config.toml");
        let seeded = "# Coffee CLI registered these hooks for the dynamic-island status\n# indicator. Safe to remove if you don't use Coffee CLI — the command\n# no-ops when COFFEE_CLI_* env vars aren't set.\n[[hooks]]\nevent = \"Stop\"\ncommand = \"\\\"/old/coffee-cli.exe\\\" __kimi-hook\"\ntimeout = 30\n";
        fs::write(&cfg, seeded).unwrap();
        strip_kimi_hooks(&cfg).unwrap();
        assert!(!cfg.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hermes_yaml_cleanup_preserves_other_plugins() {
        let dir = fresh_kimi_dir("hermes-yaml");
        let cfg = dir.join("config.yaml");
        let seeded = "model: test\nplugins:\n  enabled:\n    - user-plugin\n    - coffee-cli-status # old Coffee plugin\n  disabled: [quiet-plugin, \"coffee-cli-status\"]\nother: true\n";
        fs::write(&cfg, seeded).unwrap();
        strip_hermes_plugin_from_yaml(&cfg).unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(
            !after.contains("coffee-cli-status"),
            "Coffee plugin removed: {}",
            after
        );
        assert!(after.contains("user-plugin"));
        assert!(after.contains("quiet-plugin"));
        assert!(after.contains("model: test"));
        assert!(after.contains("other: true"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_cleanup_removes_only_coffee_artifacts() {
        let home = fresh_codex_dir("codex-cleanup");
        let codex = home.join(".codex");
        let hook_dir = home.join(".coffee-cli").join("hooks");
        fs::create_dir_all(&codex).unwrap();
        fs::create_dir_all(&hook_dir).unwrap();
        let hooks_path = codex.join("hooks.json");
        let config_path = codex.join("config.toml");
        fs::write(
            &hooks_path,
            serde_json::to_string_pretty(&json!({
                "hooks": {
                    "Stop": [{ "hooks": [
                        { "type": "command", "command": "C:/Coffee/coffee-cli.exe __codex-hook" },
                        { "type": "command", "command": "echo user" }
                    ] }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let source = hooks_path.to_string_lossy();
        fs::write(
            &config_path,
            format!(
                "notify = [\"python\", \"coffee-cli-codex-notify.py\"]\nmodel = \"gpt-5\"\n\n[hooks.state.'{}:stop:0:0']\nenabled = true\n\n[hooks.state.'C:/user/hooks.json:stop:0:0']\nenabled = true\n",
                source
            ),
        )
        .unwrap();
        let script = hook_dir.join(CODEX_NOTIFY_FILENAME);
        fs::write(&script, "# Coffee CLI — Codex Notify Forwarder\n").unwrap();

        cleanup_codex(&home);

        let hooks: Value = serde_json::from_str(&fs::read_to_string(&hooks_path).unwrap()).unwrap();
        let handlers = hooks["hooks"]["Stop"][0]["hooks"].as_array().unwrap();
        assert_eq!(handlers.len(), 1);
        assert_eq!(handlers[0]["command"], "echo user");
        let config = fs::read_to_string(&config_path).unwrap();
        assert!(!config.contains(CODEX_NOTIFY_FILENAME));
        assert!(!config.contains(&format!("{}:stop", source)));
        assert!(config.contains("C:/user/hooks.json:stop"));
        assert!(config.contains("model = \"gpt-5\""));
        assert!(!script.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn codex_cleanup_does_not_rewrite_user_only_hooks() {
        let home = fresh_codex_dir("codex-user-only");
        let codex = home.join(".codex");
        fs::create_dir_all(&codex).unwrap();
        let hooks_path = codex.join("hooks.json");
        let original = "{\n  \"hooks\": {\"Stop\": [{\"hooks\": [{\"command\": \"echo user\"}]}]}\n}\n";
        fs::write(&hooks_path, original).unwrap();

        strip_codex_managed_hooks(&hooks_path).unwrap();

        assert_eq!(fs::read_to_string(&hooks_path).unwrap(), original);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_cleanup_preserves_user_replacement() {
        let home = fresh_codex_dir("opencode-cleanup");
        let plugins = home.join(".config").join("opencode").join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        let plugin = plugins.join(OPENCODE_PLUGIN_FILENAME);
        fs::write(
            &plugin,
            "// Coffee CLI\nexport const CoffeeCliIslandPlugin = 1;",
        )
        .unwrap();
        cleanup_opencode_plugin(&home, "opencode");
        assert!(!plugin.exists());

        fs::write(&plugin, "export const userPlugin = true;").unwrap();
        cleanup_opencode_plugin(&home, "opencode");
        assert!(plugin.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn grok_cleanup_removes_all_coffee_json_and_keeps_user_hooks() {
        let dir = fresh_codex_dir("grok-cleanup");
        let hooks = dir.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        fs::write(
            hooks.join("coffee-cli-stop.json"),
            "{\"command\":\"coffee __grok-hook\"}",
        )
        .unwrap();
        fs::write(
            hooks.join("coffee-cli-user.json"),
            "{\"command\":\"echo user\"}",
        )
        .unwrap();
        fs::write(
            hooks.join("my-hook.json"),
            "{\"command\":\"coffee __grok-hook\"}",
        )
        .unwrap();

        cleanup_grok_hook_dir(&hooks);
        assert!(!hooks.join("coffee-cli-stop.json").exists());
        assert!(hooks.join("coffee-cli-user.json").exists());
        assert!(hooks.join("my-hook.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Grok Build legacy hook cleanup
// ──────────────────────────────────────────────────────────────────────────────

fn cleanup_grok_hooks(home: &Path) {
    let grok_home = std::env::var("GROK_HOME")
        .ok()
        .and_then(|s| {
            if s.is_empty() {
                None
            } else {
                Some(PathBuf::from(s))
            }
        })
        .unwrap_or_else(|| home.join(".grok"));
    let hooks_dir = grok_home.join("hooks");
    cleanup_grok_hook_dir(&hooks_dir);
}

fn cleanup_grok_hook_dir(hooks_dir: &Path) {
    let Ok(entries) = fs::read_dir(&hooks_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_json = path.extension().and_then(|ext| ext.to_str()) == Some("json");
        let coffee_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("coffee-cli-") || name == "coffee-cli-status.json")
            .unwrap_or(false);
        if is_json && coffee_name {
            remove_marked_file(&path, &["__grok-hook"]);
        }
    }
    let _ = fs::remove_dir(&hooks_dir);
}

// ──────────────────────────────────────────────────────────────────────────────
// Orca (stablyai/orca) residue cleanup
// ──────────────────────────────────────────────────────────────────────────────
//
// Orca is an agent orchestrator that injects status hooks into a dozen+ CLI
// agents (Claude, Codex, Gemini, Grok, Kimi, Cursor, Copilot, Devin, Droid,
// Antigravity, Command Code, Amp, Hermes, OpenCode). Its hooks are a known
// source of breakage — post-update hook failures (upstream #8645/#8110),
// duplicated `[hooks.state]` blocks that make Codex's config.toml unparseable
// (#3190), and config dirs created for agents the user never installed
// (#11641/#9963). Once Orca is uninstalled the residue stays behind and keeps
// firing broken hooks into every agent session.
//
// We clean it the way Orca's own installer identifies its entries, reversed:
// every managed command carries `agent-hooks/<name>` under `~/.orca` or the
// `ORCA_AGENT_HOOK_*` env tokens its curl/PowerShell launchers use, so
// stripping is deterministic and user-owned hooks are never matched. Only
// generated hook directories are deleted whole; agent configs and overlays
// are stripped in place. Orca's session/auth stores are not hook residue.
// The whole arm is skipped while an Orca process is running — Orca re-installs
// its hooks on every launch (#2623), so cleaning then would fight it.
// Errors are logged, never fatal; everything is idempotent.

const ORCA_AGENT_HOOKS_FINGERPRINT: &str = ".orca/agent-hooks/";
const ORCA_HOOK_ENV_FINGERPRINT: &str = "ORCA_AGENT_HOOK_";
const ORCA_PLUGIN_MARKER: &str =
    "Managed by Orca. Do not edit; changes may be overwritten.";

/// True iff a hook command/arg carries Orca's fingerprint. Backslashes are
/// normalized so Windows `%USERPROFILE%\.orca\agent-hooks\…` matches, and the
/// PowerShell `-EncodedCommand` payload is decoded (utf16le base64) the same
/// way Orca's own matcher does — covering users whose home path is not
/// cmd-safe (e.g. CJK usernames), where Orca hides the script path inside the
/// encoded blob.
fn is_orca_marked_command(text: &str) -> bool {
    let normalized = text.replace('\\', "/");
    let path_text = normalized.to_ascii_lowercase();
    if path_text.contains(ORCA_AGENT_HOOKS_FINGERPRINT)
        || path_text.contains(".orca-wsl/agent-hooks/")
        || path_text.contains("/orca/agent-hooks/")
        || path_text.contains("/orca-dev/agent-hooks/")
        || normalized.contains(ORCA_HOOK_ENV_FINGERPRINT)
    {
        return true;
    }
    if let Some(encoded) = encoded_command_payload(&normalized) {
        if let Ok(decoded) = decode_utf16le_base64(encoded) {
            let decoded_normalized = decoded.replace('\\', "/");
            return is_orca_marked_command(&decoded_normalized);
        }
    }
    false
}

/// The base64 blob following `-EncodedCommand` in a PowerShell invocation
/// (case-insensitive), mirroring Orca's decodePowerShellEncodedCommand.
fn encoded_command_payload(command: &str) -> Option<&str> {
    let mut tokens = command.split_whitespace();
    while let Some(token) = tokens.next() {
        if token.eq_ignore_ascii_case("-EncodedCommand") {
            return tokens.next();
        }
    }
    None
}

fn decode_utf16le_base64(encoded: &str) -> Result<String, base64::DecodeError> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    let bytes = STANDARD.decode(encoded.trim())?;
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    Ok(String::from_utf16_lossy(&units))
}

/// True iff a hook entry's command or any arg carries the fingerprint — args
/// matter because Orca's Windows launchers put the script path there
/// (conhost.exe/curl wrappers), not in `command`.
fn orca_entry_has_marker(entry: &Value) -> bool {
    if entry
        .get("command")
        .and_then(|v| v.as_str())
        .map(is_orca_marked_command)
        .unwrap_or(false)
    {
        return true;
    }
    entry
        .get("args")
        .and_then(|a| a.as_array())
        .map(|args| {
            args.iter()
                .any(|a| a.as_str().map(is_orca_marked_command).unwrap_or(false))
        })
        .unwrap_or(false)
}

/// Orca's removeManagedCommands semantics: strip managed direct
/// command/bash/powershell keys and nested `hooks[]` entries, then drop the
/// group entirely when no command survives. User entries inside a mixed group
/// and their JSONC comments are preserved. Returns whether anything changed.
fn clean_orca_group(node: jsonc_parser::cst::CstNode) -> bool {
    let Some(obj) = node.as_object() else {
        return false;
    };
    let Some(value) = obj.to_serde_value() else {
        return false;
    };
    let mut changed = false;
    let managed_command = orca_entry_has_marker(&value);
    for key in ["command", "args", "bash", "powershell"] {
        let managed = if key == "command" || key == "args" {
            managed_command
        } else {
            value
                .get(key)
                .and_then(Value::as_str)
                .map(is_orca_marked_command)
                .unwrap_or(false)
        };
        if managed {
            if let Some(prop) = obj.get(key) {
                prop.remove();
                changed = true;
            }
        }
    }
    if let Some(hooks) = obj.array_value("hooks") {
        let mut hooks_changed = false;
        for hook in hooks.elements() {
            hooks_changed |= clean_orca_group(hook);
        }
        if hooks_changed && hooks.elements().is_empty() {
            if let Some(prop) = obj.get("hooks") {
                prop.remove();
            }
        }
        changed |= hooks_changed;
    }
    if changed {
        let remaining = obj.to_serde_value().unwrap_or_default();
        let has_command = ["command", "bash", "powershell"]
            .iter()
            .any(|key| remaining.get(*key).map(Value::is_string).unwrap_or(false));
        let has_hooks = obj
            .array_value("hooks")
            .map(|hooks| !hooks.elements().is_empty())
            .unwrap_or(false);
        if !has_command && !has_hooks && obj.get("prompt").is_none() {
            node.remove();
        }
    }
    changed
}

/// Accept JSONC comments/trailing commas without repairing malformed configs.
fn orca_json_parse_options() -> jsonc_parser::ParseOptions {
    jsonc_parser::ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
    }
}

/// Strip marked hook commands and statusLine entries, preserving user JSONC.
/// Delete empty Orca-created shells; leave malformed files untouched.
fn strip_orca_json_hooks(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(path)?;
    let root = match jsonc_parser::cst::CstRootNode::parse(
        text.trim_start_matches('\u{feff}'),
        &orca_json_parse_options(),
    ) {
        Ok(root) => root,
        Err(_) => return Ok(()),
    };
    let Some(obj) = root.object_value() else {
        return Ok(());
    };
    let mut changed = false;
    for key in ["hooks", "orca-status"] {
        let Some(bundle) = obj.object_value(key) else {
            continue;
        };
        let mut bundle_changed = false;
        for event in bundle.properties() {
            let Some(groups) = event.array_value() else {
                continue;
            };
            let mut event_changed = false;
            for group in groups.elements() {
                event_changed |= clean_orca_group(group);
            }
            if event_changed && groups.elements().is_empty() {
                event.remove();
            }
            bundle_changed |= event_changed;
        }
        if bundle_changed && bundle.properties().is_empty() {
            if let Some(prop) = obj.get(key) {
                prop.remove();
            }
        }
        changed |= bundle_changed;
    }
    if let Some(status_line) = obj.get("statusLine") {
        if status_line
            .to_serde_value()
            .as_ref()
            .map(orca_entry_has_marker)
            .unwrap_or(false)
        {
            status_line.remove();
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    if obj.properties().is_empty() {
        fs::remove_file(path)?;
    } else {
        let bom = if text.starts_with('\u{feff}') {
            "\u{feff}"
        } else {
            ""
        };
        fs::write(path, format!("{bom}{root}"))?;
    }
    Ok(())
}

/// Remove Orca-owned `[[hooks]]` tables from a TOML config (Kimi), preserving
/// all user TOML byte-for-byte apart from blank lines adjacent to removed
/// blocks. A block is Orca's iff its command carries the fingerprint. The file is
/// deleted when nothing but Orca blocks remain. Idempotent.
fn strip_orca_toml_hooks(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let existing = fs::read_to_string(path)?;
    let lines: Vec<&str> = existing.split_inclusive('\n').collect();
    let code_lines = toml_code_lines(&lines);
    let mut kept: Vec<&str> = Vec::new();
    let mut changed = false;
    let mut i = 0;
    let command = regex::Regex::new(r#"^\s*command\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')"#)?;
    while i < lines.len() {
        if code_lines[i] && lines[i].trim().split('#').next().unwrap_or("").trim() == "[[hooks]]" {
            let mut j = i + 1;
            while j < lines.len() && !(code_lines[j] && is_toml_table_header(lines[j])) {
                j += 1;
            }
            if (i..j).any(|line| {
                code_lines[line]
                    && command
                        .captures(lines[line])
                        .and_then(|captures| {
                            if let Some(value) = captures.get(1) {
                                serde_json::from_str::<String>(&format!("\"{}\"", value.as_str()))
                                    .ok()
                            } else {
                                captures.get(2).map(|value| value.as_str().to_string())
                            }
                        })
                        .map(|value| is_orca_marked_command(&value))
                        .unwrap_or(false)
            }) {
                changed = true;
            } else {
                kept.extend(&lines[i..j]);
            }
            i = j;
        } else {
            kept.push(lines[i]);
            i += 1;
        }
    }
    if !changed {
        return Ok(());
    }
    while kept
        .last()
        .map(|line| line.trim().is_empty())
        .unwrap_or(false)
    {
        kept.pop();
    }
    if kept.is_empty() {
        fs::remove_file(path)?;
    } else {
        fs::write(path, kept.concat())?;
    }
    Ok(())
}

/// Delete a known plugin file only when it still carries Orca's fingerprint.
fn remove_orca_marked_file(path: &Path) {
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    if !is_orca_marked_command(&text)
        && !text.contains(ORCA_PLUGIN_MARKER)
        && !text.contains("OrcaOpenCodeStatusPlugin")
    {
        return;
    }
    if let Err(e) = fs::remove_file(path) {
        eprintln!(
            "[hook-installer] failed to remove {}: {}",
            path.display(),
            e
        );
    }
}

/// Orca's writeHooksJson leaves a rolling `<config>.bak` next to every file it
/// rewrites; clean its hooks too while retaining recoverable user settings.
fn remove_orca_backup(config: &Path) {
    let mut backup = config.as_os_str().to_os_string();
    backup.push(".bak");
    let backup = PathBuf::from(backup);
    if !backup.exists() {
        return;
    }
    let result = match config.extension().and_then(|ext| ext.to_str()) {
        Some("toml") => strip_orca_toml_hooks(&backup),
        Some("yaml") => strip_hermes_plugin_from_yaml_named(&backup, "orca-status"),
        _ => strip_orca_json_hooks(&backup),
    };
    if let Err(e) = result {
        eprintln!("[hook-installer] failed to clean {}: {}", backup.display(), e);
    }
}

/// Remove Orca's Hermes plugin dir and its config.yaml allow-list entry,
/// mirroring cleanup_hermes_plugin for Orca's own plugin name.
fn cleanup_orca_hermes(hermes_home: &Path) {
    let plugin_dir = hermes_home.join("plugins").join("orca-status");
    if plugin_dir.exists() && !is_orca_cleanup_directory(&plugin_dir) {
        return;
    }
    let init_path = plugin_dir.join("__init__.py");
    let manifest_path = plugin_dir.join("plugin.yaml");

    if [&init_path, &manifest_path].iter().any(|path| {
        path.exists()
            && !fs::read_to_string(path)
                .map(|text| text.contains(ORCA_PLUGIN_MARKER))
                .unwrap_or(false)
    }) {
        return;
    }
    let cache = plugin_dir.join("__pycache__");
    if (init_path.exists() || manifest_path.exists()) && is_orca_cleanup_directory(&cache) {
        if let Ok(entries) = fs::read_dir(&cache) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("__init__.")
                    && name.ends_with(".pyc")
                    && entry
                        .file_type()
                        .map(|kind| kind.is_file())
                        .unwrap_or(false)
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
            let _ = fs::remove_dir(cache);
        }
    }
    remove_marked_file(&init_path, &[ORCA_PLUGIN_MARKER]);
    remove_marked_file(&manifest_path, &[ORCA_PLUGIN_MARKER]);
    let _ = fs::remove_dir(&plugin_dir);

    if let Err(e) =
        strip_hermes_plugin_from_yaml_named(&hermes_home.join("config.yaml"), "orca-status")
    {
        eprintln!("[hook-installer] failed to clean Orca Hermes config: {}", e);
    }
    remove_orca_backup(&hermes_home.join("config.yaml"));
}

/// Pi/OMP/Prime auto-load these global extensions with their own ownership marker.
fn cleanup_orca_pi_extensions(home: &Path, agent_dir: Option<&Path>) {
    let defaults = [
        home.join(".pi").join("agent"),
        home.join(".omp").join("agent"),
        home.join(".prime").join("agent"),
    ];
    for agent in defaults.iter().map(PathBuf::as_path).chain(agent_dir) {
        let extensions = agent.join("extensions");
        for name in [
            "orca-agent-status.ts",
            "orca-prefill.ts",
            "orca-titlebar-spinner.ts",
        ] {
            remove_marked_file(&extensions.join(name), &["@orca-managed-pi-extension"]);
        }
    }
}

fn orca_agent_homes(home: &Path, default_dir: &str, env_key: &str) -> Vec<PathBuf> {
    let mut homes = vec![home.join(default_dir)];
    if let Some(path) = std::env::var_os(env_key).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        if !homes.contains(&path) {
            homes.push(path);
        }
    }
    homes
}

fn cleanup_orca_json_config(path: &Path) {
    if let Err(e) = strip_orca_json_hooks(path) {
        eprintln!("[hook-installer] failed to clean {}: {}", path.display(), e);
    }
    remove_orca_backup(path);
}

fn cleanup_orca_plugin_files(dir: &Path) {
    for name in ["orca-opencode-status.js", "orca-mimocode-status.js"] {
        remove_orca_marked_file(&dir.join(name));
    }
    for name in [
        "orca-agent-status.ts",
        "orca-prefill.ts",
        "orca-titlebar-spinner.ts",
    ] {
        remove_marked_file(&dir.join(name), &["@orca-managed-pi-extension"]);
    }
}

/// Do not descend through symlinks or Windows junctions into user data.
fn is_orca_cleanup_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// Overlays can contain new sessions/auth or links to user data; remove only plugins.
fn cleanup_orca_plugin_overlay(root: &Path) {
    if !is_orca_cleanup_directory(root) {
        return;
    }
    let mut dirs = vec![root.to_path_buf()];
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if is_orca_cleanup_directory(&entry.path()) {
                dirs.push(entry.path());
            }
        }
    }
    for dir in dirs {
        for base in [&dir, &dir.join("config")] {
            if !is_orca_cleanup_directory(base) {
                continue;
            }
            cleanup_orca_plugin_files(base);
            for child in ["plugins", "extensions"] {
                let child = base.join(child);
                if is_orca_cleanup_directory(&child) {
                    cleanup_orca_plugin_files(&child);
                    let _ = fs::remove_dir(&child);
                }
            }
            let _ = fs::remove_dir(base);
        }
        let _ = fs::remove_dir(&dir);
    }
    let _ = fs::remove_dir(root);
}

/// Distinguish TOML code from multiline string contents (e.g. instructions).
fn toml_code_lines(lines: &[&str]) -> Vec<bool> {
    let mut quote = None;
    let mut multiline = false;
    lines
        .iter()
        .map(|line| {
            let is_code = quote.is_none();
            let bytes = line.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                let ch = bytes[i];
                if let Some(delimiter) = quote {
                    if delimiter == b'"' && ch == b'\\' {
                        i += 2;
                        continue;
                    }
                    if ch == delimiter {
                        if !multiline {
                            quote = None;
                        } else if bytes.get(i..i + 3) == Some(&[delimiter; 3]) {
                            quote = None;
                            multiline = false;
                            i += 2;
                        }
                    }
                } else if ch == b'#' {
                    break;
                } else if ch == b'"' || ch == b'\'' {
                    quote = Some(ch);
                    multiline = bytes.get(i..i + 3) == Some(&[ch; 3]);
                    if multiline {
                        i += 2;
                    }
                }
                i += 1;
            }
            if !multiline {
                quote = None;
            }
            is_code
        })
        .collect()
}

fn normalized_orca_trust_key(key: &str) -> String {
    let key = key.replace('\\', "/");
    let key = key.strip_prefix("//?/").unwrap_or(&key);
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key.to_string()
    }
}

/// Read identities before removing hooks; a user hook can share the same source file.
fn strip_orca_codex_trust(home: &Path, ledger: Option<&Path>) -> anyhow::Result<()> {
    strip_codex_hook_trust(
        &home.join("config.toml"),
        &home.join("hooks.json"),
        ledger,
        orca_entry_has_marker,
    )
}

/// Match ownership before hook removal and move surviving identities with their
/// array indices. Hashes cover the hook content, so they survive index changes.
fn strip_codex_hook_trust(
    config_path: &Path,
    hooks_path: &Path,
    ledger: Option<&Path>,
    is_owned: fn(&Value) -> bool,
) -> anyhow::Result<()> {
    let text = match fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut owned = std::collections::HashSet::new();
    let mut moved = std::collections::HashMap::new();
    if let Ok(hooks) = fs::read_to_string(hooks_path) {
        if let Ok(root) = jsonc_parser::parse_to_serde_value::<Value>(
            hooks.trim_start_matches('\u{feff}'),
            &orca_json_parse_options(),
        ) {
            if let Some(events) = root.get("hooks").and_then(Value::as_object) {
                for (event, groups) in events {
                    let label =
                        event
                            .chars()
                            .enumerate()
                            .fold(String::new(), |mut label, (i, ch)| {
                                if i > 0 && ch.is_uppercase() {
                                    label.push('_');
                                }
                                label.extend(ch.to_lowercase());
                                label
                            });
                    let mut new_g = 0;
                    for (g, group) in groups.as_array().into_iter().flatten().enumerate() {
                        let mut new_h = 0;
                        let mut removed = false;
                        for (h, hook) in group
                            .get("hooks")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .enumerate()
                        {
                            let key = normalized_orca_trust_key(&format!(
                                "{}:{label}:{g}:{h}",
                                hooks_path.display()
                            ));
                            if is_owned(hook) {
                                owned.insert(key);
                                removed = true;
                            } else {
                                if g != new_g || h != new_h {
                                    moved.insert(key, format!("{label}:{new_g}:{new_h}"));
                                }
                                new_h += 1;
                            }
                        }
                        if !removed || new_h > 0 {
                            new_g += 1;
                        }
                    }
                }
            }
        }
    }
    let mut recorded = std::collections::HashMap::new();
    if let Some(ledger) = ledger.and_then(|path| fs::read_to_string(path).ok()) {
        if let Ok(root) = serde_json::from_str::<Value>(&ledger) {
            for home in root
                .get("homes")
                .and_then(Value::as_object)
                .into_iter()
                .flat_map(|homes| homes.values())
            {
                for (key, entry) in home
                    .get("entries")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                {
                    let signature = entry
                        .get("signature")
                        .and_then(Value::as_str)
                        .and_then(|text| serde_json::from_str::<Value>(text).ok());
                    if signature.as_ref().map(is_owned).unwrap_or(false) {
                        if let Some(hash) = entry.get("trustedHash").and_then(Value::as_str) {
                            recorded.insert(normalized_orca_trust_key(key), hash.to_string());
                        }
                    }
                }
            }
        }
    }
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let code_lines = toml_code_lines(&lines);
    let mut kept = String::new();
    let mut changed = false;
    let mut i = 0;
    while i < lines.len() {
        let mut end = i + 1;
        if let Some(key) = code_lines[i]
            .then(|| parse_codex_state_header(lines[i]))
            .flatten()
        {
            while end < lines.len() && !(code_lines[end] && is_toml_table_header(lines[end])) {
                end += 1;
            }
            let original_key = key;
            let key = normalized_orca_trust_key(&original_key);
            let recorded_hash_matches = recorded
                .get(&key)
                .map(|hash| {
                    lines[i + 1..end].iter().any(|line| {
                        line.split_once('=')
                            .map(|(key, value)| {
                                key.trim() == "trusted_hash"
                                    && value.trim().trim_matches(['\'', '"']) == hash
                            })
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);
            if owned.contains(&key) || recorded_hash_matches {
                changed = true;
                i = end;
                continue;
            }
            if let Some(suffix) = moved.get(&key) {
                let source = original_key.rsplitn(4, ':').nth(3).unwrap();
                let new_key = serde_json::to_string(&format!("{source}:{suffix}"))?;
                let ending = if lines[i].ends_with("\r\n") {
                    "\r\n"
                } else if lines[i].ends_with('\n') {
                    "\n"
                } else {
                    ""
                };
                kept.push_str(&format!("[hooks.state.{new_key}]{ending}"));
                kept.extend(lines[i + 1..end].iter().copied());
                changed = true;
                i = end;
                continue;
            }
        }
        kept.extend(lines[i..end].iter().copied());
        i = end;
    }
    if changed {
        fs::write(config_path, kept)?;
    }
    Ok(())
}

fn cleanup_orca_codex_home(home: &Path, ledger: Option<&Path>) {
    if let Err(e) = strip_orca_codex_trust(home, ledger) {
        eprintln!("[hook-installer] failed to clean Orca Codex trust: {}", e);
        return;
    }
    cleanup_orca_json_config(&home.join("hooks.json"));
    let profile = home.join("orca-agent-status.config.toml");
    let Ok(text) = fs::read_to_string(&profile) else {
        return;
    };
    let start_marker = "# BEGIN ORCA AGENT STATUS HOOKS";
    let end_marker = "# END ORCA AGENT STATUS HOOKS";
    let Some(start) = text.find(start_marker) else {
        return;
    };
    let Some(end) = text[start..].find(end_marker) else {
        return;
    };
    let mut kept = text[..start].to_string();
    kept.push_str(&text[start + end + end_marker.len()..]);
    let result = if kept.trim().is_empty() {
        fs::remove_file(&profile)
    } else {
        fs::write(&profile, kept)
    };
    if let Err(e) = result {
        eprintln!(
            "[hook-installer] failed to clean {}: {}",
            profile.display(),
            e
        );
    }
}

/// Inspect the legacy ~/.opencode location for known managed plugins, retaining
/// all other files and removing directories only when they become empty.
fn cleanup_legacy_opencode_dir(dir: &Path) {
    cleanup_orca_plugin_overlay(dir);
}

/// True iff an Orca process is running. Orca re-installs its hooks on every
/// launch (upstream #2623), so cleaning while it is alive would fight it.
fn orca_process_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        process_is_running("orca")
    }
    #[cfg(not(target_os = "windows"))]
    {
        pgrep_exact("orca") || pgrep_exact("Orca")
    }
}

#[cfg(not(target_os = "windows"))]
fn pgrep_exact(name: &str) -> bool {
    std::process::Command::new("pgrep")
        .arg("-x")
        .arg(name)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn orca_user_data_dirs(home: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        paths.push(appdata.join("orca"));
    }
    #[cfg(target_os = "macos")]
    {
        // Electron userData on macOS: ~/Library/Application Support/<name>.
        let user_data = home
            .join("Library")
            .join("Application Support")
            .join("orca");
        paths.push(user_data);
    }
    #[cfg(target_os = "linux")]
    {
        paths.push(home.join(".config").join("orca"));
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
            paths.push(PathBuf::from(xdg).join("orca"));
        }
    }

    if let Some(path) = std::env::var_os("ORCA_USER_DATA_PATH").filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(path));
    }
    paths.sort();
    paths.dedup();
    paths
}

fn cleanup_orca_user_data(user_data: &Path) {
    for name in [
        "opencode-hooks",
        "opencode-config-overlays",
        "mimocode-hooks",
        "pi-agent-overlays",
        "omp-agent-overlays",
        "omp-managed-status-extension",
    ] {
        cleanup_orca_plugin_overlay(&user_data.join(name));
    }
    let ledger = user_data
        .join("codex-runtime-home")
        .join("trust-grant-ledger.json");
    cleanup_orca_codex_home(
        &user_data.join("codex-runtime-home").join("home"),
        Some(&ledger),
    );
    if let Ok(accounts) = fs::read_dir(user_data.join("codex-accounts")) {
        for account in accounts.flatten() {
            if account
                .file_type()
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                cleanup_orca_codex_home(&account.path().join("home"), Some(&ledger));
            }
        }
    }
    remove_orca_owned_paths(vec![user_data.join("agent-hooks")]);
}

/// ~/.orca/sessions and legacy overlays can hold the user's only session/auth copy.
fn cleanup_orca_dirs(home: &Path) {
    for name in [
        "opencode-overlays",
        "pi-overlays",
        "omp-overlays",
        "omp-managed-status-extension",
    ] {
        cleanup_orca_plugin_overlay(&home.join(".orca-relay").join(name));
    }
    remove_orca_owned_paths(vec![
        home.join(".orca").join("agent-hooks"),
        home.join(".orca").join("managed-hook-install.lock"),
        home.join(".orca-wsl").join("agent-hooks"),
        home.join(".orca-wsl").join("hook-relay"),
        home.join(".orca-managed-home"),
    ]);
}

/// Delete the given Orca-owned paths (dirs recursively, files otherwise).
/// Extracted from cleanup_orca_dirs so tests can drive the deletion without
/// the process gate.
fn remove_orca_owned_paths(present: Vec<PathBuf>) {
    for path in present {
        if !path.exists() {
            continue;
        }
        let result = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(e) = result {
            eprintln!(
                "[hook-installer] failed to remove {}: {}",
                path.display(),
                e
            );
        }
    }
}

/// Remove Orca-managed agent hooks and residue left by stablyai/orca. The
/// fingerprint match means user hooks survive; only Orca-owned directories
/// and Orca-created empty shells are deleted. Skipped while Orca is running.
/// Called from cleanup_all() at app launch.
fn cleanup_orca(home: &Path) {
    if orca_process_running() {
        eprintln!("[hook-installer] Orca is running — skipping Orca residue cleanup");
        return;
    }
    let user_data_dirs = orca_user_data_dirs(home);
    for codex_home in orca_agent_homes(home, ".codex", "CODEX_HOME") {
        // Use Orca's ledger before dropping a hook that identifies a trust entry.
        for user_data in &user_data_dirs {
            let ledger = user_data
                .join("codex-runtime-home")
                .join("trust-grant-ledger.json");
            cleanup_orca_codex_home(&codex_home, Some(&ledger));
        }
        cleanup_orca_codex_home(&codex_home, None);
    }
    // Claude-shaped JSON hook configs. Antigravity shares .gemini with Gemini
    // (its own hooks.json under config/); Droid keeps its config in .factory.
    let mut configs: Vec<PathBuf> = vec![
        home.join(".claude").join("settings.json"),
        home.join(".openclaude").join("settings.json"),
        home.join(".gemini").join("settings.json"),
        home.join(".gemini").join("config").join("hooks.json"),
        home.join(".factory").join("settings.json"),
        home.join(".commandcode").join("settings.json"),
        home.join(".cursor").join("hooks.json"),
    ];
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        configs.push(appdata.join("devin").join("config.json"));
    }
    #[cfg(not(target_os = "windows"))]
    configs.push(home.join(".config").join("devin").join("config.json"));

    for config in &configs {
        cleanup_orca_json_config(config);
    }

    // Kimi: KIMI_CODE_HOME or ~/.kimi-code/config.toml.
    for kimi_home in orca_agent_homes(home, ".kimi-code", "KIMI_CODE_HOME") {
        let kimi_config = kimi_home.join("config.toml");
        if let Err(e) = strip_orca_toml_hooks(&kimi_config) {
            eprintln!(
                "[hook-installer] failed to clean {}: {}",
                kimi_config.display(),
                e
            );
        }
        remove_orca_backup(&kimi_config);
    }

    // Dedicated filenames can still contain user-added hooks.
    for (default_dir, env_key, filename) in [
        (".copilot", "COPILOT_HOME", "orca.json"),
        (".grok", "GROK_HOME", "orca-status.json"),
    ] {
        for agent_home in orca_agent_homes(home, default_dir, env_key) {
            cleanup_orca_json_config(&agent_home.join("hooks").join(filename));
        }
    }

    // Provider-native plugins and Pi-compatible global extensions.
    remove_marked_file(
        &home
            .join(".config")
            .join("amp")
            .join("plugins")
            .join("orca-agent-status.ts"),
        &[ORCA_PLUGIN_MARKER],
    );
    for hermes_home in orca_agent_homes(home, ".hermes", "HERMES_HOME") {
        cleanup_orca_hermes(&hermes_home);
    }
    let pi_agent_dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);
    cleanup_orca_pi_extensions(home, pi_agent_dir.as_deref());
    if let Some(prime_home) =
        std::env::var_os("PRIME_AGENT_CODING_AGENT_DIR").filter(|value| !value.is_empty())
    {
        cleanup_orca_plugin_files(&PathBuf::from(prime_home).join("extensions"));
    }
    for tool in ["opencode", "mimocode"] {
        for folder in ["plugins", "plugin"] {
            cleanup_orca_plugin_files(&home.join(".config").join(tool).join(folder));
        }
    }
    if let Some(config) = std::env::var_os("OPENCODE_CONFIG_DIR").filter(|value| !value.is_empty())
    {
        cleanup_orca_plugin_files(&PathBuf::from(config).join("plugins"));
    }
    if let Some(config) = std::env::var_os("MIMOCODE_HOME").filter(|value| !value.is_empty()) {
        cleanup_orca_plugin_files(&PathBuf::from(config).join("config").join("plugins"));
    }

    // ~/.opencode — legacy Orca builds only; deleted only when entirely Orca's.
    cleanup_legacy_opencode_dir(&home.join(".opencode"));
    for user_data in &user_data_dirs {
        cleanup_orca_user_data(user_data);
    }

    // Orca-owned directories, gated on the process not running.
    cleanup_orca_dirs(home);
}

#[cfg(test)]
mod orca_cleanup_tests {
    use super::*;
    use std::fs;

    fn fresh_dir(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("coffee-orca-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// The Windows conhost launcher Orca writes for Claude hooks — the script
    /// path lives in `args`, not `command`.
    fn orca_windows_claude_hook() -> Value {
        json!({
            "type": "command",
            "command": "C:\\Windows\\System32\\conhost.exe",
            "args": [
                "--headless",
                "C:\\Windows\\System32\\cmd.exe",
                "/d", "/c",
                "%USERPROFILE%\\.orca\\agent-hooks\\claude-hook.cmd"
            ],
            "timeout": 10
        })
    }

    #[test]
    fn claude_settings_strips_windows_and_posix_keeps_user() {
        let dir = fresh_dir("claude-settings");
        let settings = dir.join(".claude").join("settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            &settings,
            serde_json::to_string_pretty(&json!({
                "theme": "dark",
                "hooks": {
                    "UserPromptSubmit": [{
                        "hooks": [
                            orca_windows_claude_hook(),
                            { "type": "command", "command": "/home/user/my-hook.sh" }
                        ]
                    }],
                    "Stop": [{
                        "hooks": [{
                            "type": "command",
                            "command": "if [ -f \"$HOME/.orca/agent-hooks/claude-hook.sh\" ] && [ -r \"$HOME/.orca/agent-hooks/claude-hook.sh\" ]; then /bin/sh \"$HOME/.orca/agent-hooks/claude-hook.sh\"; fi"
                        }]
                    }],
                    "PreToolUse": [{
                        "matcher": "*",
                        "hooks": [orca_windows_claude_hook()]
                    }]
                },
                "statusLine": {
                    "type": "command",
                    "command": "if [ -f \"$HOME/.orca/agent-hooks/claude-statusline.sh\" ]; then /bin/sh \"$HOME/.orca/agent-hooks/claude-statusline.sh\"; fi"
                }
            }))
            .unwrap(),
        )
        .unwrap();

        strip_orca_json_hooks(&settings).unwrap();

        let cleaned: Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        let prompt_handlers = cleaned["hooks"]["UserPromptSubmit"][0]["hooks"]
            .as_array()
            .unwrap();
        assert_eq!(prompt_handlers.len(), 1);
        assert_eq!(prompt_handlers[0]["command"], "/home/user/my-hook.sh");
        assert!(
            cleaned.get("hooks").and_then(|h| h.get("Stop")).is_none(),
            "Orca-only Stop event removed"
        );
        assert!(
            cleaned
                .get("hooks")
                .and_then(|h| h.get("PreToolUse"))
                .is_none(),
            "Orca-only PreToolUse event removed"
        );
        assert!(cleaned.get("statusLine").is_none(), "Orca statusLine removed");
        assert_eq!(cleaned["theme"], "dark", "user settings preserved");

        let first = fs::read_to_string(&settings).unwrap();
        strip_orca_json_hooks(&settings).unwrap();
        assert_eq!(fs::read_to_string(&settings).unwrap(), first);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_hooks_curl_form_removed_and_empty_file_deleted() {
        let dir = fresh_dir("codex-hooks");
        let hooks_path = dir.join(".codex").join("hooks.json");
        fs::create_dir_all(hooks_path.parent().unwrap()).unwrap();
        fs::write(
            &hooks_path,
            serde_json::to_string_pretty(&json!({
                "hooks": {
                    "Stop": [{
                        "hooks": [{
                            "type": "command",
                            "command": "\"%SystemRoot%\\System32\\curl.exe\" -sS -X POST \"http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/codex\" --connect-timeout 0.5 --max-time 1.5 -H \"Content-Type: application/x-www-form-urlencoded\" -H \"X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%\" --data-urlencode \"env=%ORCA_AGENT_HOOK_ENV%\" --data-urlencode \"payload@-\" >nul 2>&1"
                        }]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();

        strip_orca_json_hooks(&hooks_path).unwrap();

        assert!(
            !hooks_path.exists(),
            "file with only Orca entries is deleted (Orca-created shell)"
        );

        // A user-owned entry keeps the file.
        fs::write(
            &hooks_path,
            serde_json::to_string_pretty(&json!({
                "hooks": {
                    "Stop": [{
                        "hooks": [
                            { "type": "command", "command": "echo user-hook" },
                            { "type": "command", "command": "curl -s http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/codex >nul" }
                        ]
                    }]
                }
            }))
            .unwrap(),
        )
        .unwrap();
        strip_orca_json_hooks(&hooks_path).unwrap();
        let cleaned: Value =
            serde_json::from_str(&fs::read_to_string(&hooks_path).unwrap()).unwrap();
        let handlers = cleaned["hooks"]["Stop"][0]["hooks"].as_array().unwrap();
        assert_eq!(handlers.len(), 1);
        assert_eq!(handlers[0]["command"], "echo user-hook");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn encoded_command_payload_is_decoded() {
        // PowerShell -EncodedCommand payloads (utf16le base64) hide the script
        // path — used by Orca when the home path is not cmd-safe (CJK users).
        let payload =
            "$homePath = $env:HOME; $scriptPath = Join-Path $homePath '.orca\\agent-hooks\\codex-hook.cmd'";
        let mut bytes: Vec<u8> = Vec::new();
        for unit in payload.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let encoded = STANDARD.encode(&bytes);
        let command = format!(
            "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
            encoded
        );
        assert!(is_orca_marked_command(&command));
        assert!(!is_orca_marked_command("C:/tools/my-hook.sh"));
    }

    #[test]
    fn kimi_toml_strips_orca_blocks_keeps_user_content() {
        let dir = fresh_dir("kimi-toml");
        let cfg = dir.join(".kimi-code").join("config.toml");
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        fs::write(
            &cfg,
            "# my kimi config\nmodel = \"k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"~/.orca/agent-hooks/kimi-hook.sh\"\ntimeout = 30\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"echo user\"\ntimeout = 5\n",
        )
        .unwrap();

        strip_orca_toml_hooks(&cfg).unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(!after.contains(".orca/agent-hooks"), "Orca block removed: {}", after);
        assert!(after.contains("# my kimi config"), "comment preserved");
        assert!(after.contains("model = \"k2\""), "config preserved");
        assert!(after.contains("command = \"echo user\""), "user hook preserved");

        let first = after.clone();
        strip_orca_toml_hooks(&cfg).unwrap();
        assert_eq!(fs::read_to_string(&cfg).unwrap(), first);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn kimi_windows_escaped_command_cleanup_preserves_crlf() {
        let dir = fresh_dir("kimi-windows-escaped");
        let path = dir.join("config.toml");
        let user = "# user config\r\nmodel = 'user'\r\n";
        let command = serde_json::to_string(r#""C:\Users\u\.orca\agent-hooks\kimi-hook.cmd""#).unwrap();
        fs::write(&path, format!("{user}[[hooks]]\r\ncommand = {command}\r\n")).unwrap();
        strip_orca_toml_hooks(&path).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), user);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn kimi_toml_deleted_when_only_orca() {
        let dir = fresh_dir("kimi-only-orca");
        let cfg = dir.join(".kimi-code").join("config.toml");
        fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        fs::write(
            &cfg,
            "[[hooks]]\nevent = \"Stop\"\ncommand = \"~/.orca/agent-hooks/kimi-hook.sh\"\ntimeout = 30\n",
        )
        .unwrap();
        strip_orca_toml_hooks(&cfg).unwrap();
        assert!(!cfg.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dedicated_files_removed_only_when_marked() {
        let dir = fresh_dir("dedicated");
        let copilot = dir.join(".copilot").join("hooks").join("orca.json");
        fs::create_dir_all(copilot.parent().unwrap()).unwrap();
        fs::write(
            &copilot,
            r#"{"command": "~/.orca/agent-hooks/copilot-hook.sh", "timeout": 10}"#,
        )
        .unwrap();
        remove_orca_marked_file(&copilot);
        assert!(!copilot.exists(), "Orca-dedicated file with marker removed");

        // A user replacement with the same name survives.
        fs::create_dir_all(copilot.parent().unwrap()).unwrap();
        fs::write(&copilot, r#"{"command": "echo user", "timeout": 5}"#).unwrap();
        remove_orca_marked_file(&copilot);
        assert!(copilot.exists(), "user replacement kept");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pi_extensions_removed_from_default_and_custom_agent_dirs() {
        let dir = fresh_dir("pi-extensions");
        let custom = dir.join("custom-agent");
        let agents = [
            dir.join(".pi").join("agent"),
            dir.join(".omp").join("agent"),
            dir.join(".prime").join("agent"),
            custom.clone(),
        ];
        for agent in &agents {
            let extensions = agent.join("extensions");
            fs::create_dir_all(&extensions).unwrap();
            for name in [
                "orca-agent-status.ts",
                "orca-prefill.ts",
                "orca-titlebar-spinner.ts",
            ] {
                fs::write(
                    extensions.join(name),
                    "// @orca-managed-pi-extension\nexport default function (pi) {}\n",
                )
                .unwrap();
            }
            fs::write(agent.join("settings.json"), "{\"theme\":\"dark\"}\n").unwrap();
        }

        cleanup_orca_pi_extensions(&dir, Some(&custom));
        cleanup_orca_pi_extensions(&dir, Some(&custom));

        for agent in &agents {
            assert_eq!(fs::read_dir(agent.join("extensions")).unwrap().count(), 0);
            assert_eq!(
                fs::read_to_string(agent.join("settings.json")).unwrap(),
                "{\"theme\":\"dark\"}\n",
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pi_extensions_keep_user_owned_files() {
        let dir = fresh_dir("pi-user-extensions");
        let custom = dir.join("custom-agent");
        for agent in [
            dir.join(".pi").join("agent"),
            dir.join(".omp").join("agent"),
            custom.clone(),
        ] {
            let extensions = agent.join("extensions");
            fs::create_dir_all(&extensions).unwrap();
            let files: [(&str, &[u8]); 5] = [
                ("orca-agent-status.ts", b"// user replacement\n"),
                ("orca-prefill.ts", b"// user prefill\n"),
                ("orca-titlebar-spinner.ts", b"\xff\xfe"),
                ("perm-test.ts", b"// permission test\n"),
                ("user-extension.ts", b"// @orca-managed-pi-extension\n"),
            ];
            for (name, contents) in files {
                fs::write(extensions.join(name), contents).unwrap();
            }

            cleanup_orca_pi_extensions(&dir, Some(&custom));

            for (name, contents) in files {
                assert_eq!(fs::read(extensions.join(name)).unwrap(), contents);
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pi_extensions_missing_dirs_are_not_created() {
        let dir = fresh_dir("pi-missing-extensions");
        cleanup_orca_pi_extensions(&dir, Some(&dir.join("missing-agent")));
        cleanup_orca_pi_extensions(&dir, None);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn antigravity_bundle_and_platform_commands_preserve_user_hooks() {
        let dir = fresh_dir("antigravity-bundle");
        let path = dir.join("hooks.json");
        let user_prompt = json!({"type": "prompt", "prompt": "Check the result"});
        fs::write(&path, serde_json::to_vec(&json!({
                "orca-status": {
                    "BeforeAgent": [{"command": "~/.orca/agent-hooks/antigravity-hook.sh"}],
                    "BeforeTool": [{"hooks": [
                        {"bash": "~/.orca/agent-hooks/antigravity-hook.sh", "powershell": "echo user"},
                        user_prompt.clone()
                    ]}]
                },
                "user-bundle": {"BeforeAgent": [{"command": "echo user"}]},
                "hooks": {"Stop": [
                    {"command": "conhost.exe", "args": ["--headless", "C:\\Users\\u\\.orca\\agent-hooks\\codex-hook.cmd"]},
                    user_prompt.clone(),
                    {"hooks": []}
                ]}
            })).unwrap()).unwrap();
        strip_orca_json_hooks(&path).unwrap();
        let cleaned: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(cleaned["orca-status"].get("BeforeAgent").is_none());
        assert_eq!(
            cleaned["orca-status"]["BeforeTool"][0]["hooks"],
            json!([
                {"powershell": "echo user"}, user_prompt.clone()
            ])
        );
        assert_eq!(
            cleaned["hooks"]["Stop"],
            json!([user_prompt, {"hooks": []}])
        );
        assert_eq!(
            cleaned["user-bundle"]["BeforeAgent"][0]["command"],
            "echo user"
        );
        let before = fs::read(&path).unwrap();
        strip_orca_json_hooks(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), before);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn mixed_backup_preserves_user_configuration() {
        let dir = fresh_dir("mixed-backup");
        let path = dir.join("settings.json");
        let backup = dir.join("settings.json.bak");
        fs::write(
            &backup,
            serde_json::to_vec(&json!({
                "theme": "user-theme",
                "hooks": {"Stop": [
                    {"command": "~/.orca/agent-hooks/claude-hook.sh"},
                    {"command": "echo user"}
                ]}
            }))
            .unwrap(),
        )
        .unwrap();
        remove_orca_backup(&path);
        let cleaned: Value = serde_json::from_slice(&fs::read(&backup).unwrap()).unwrap();
        assert_eq!(cleaned["theme"], "user-theme");
        assert_eq!(cleaned["hooks"]["Stop"], json!([{"command": "echo user"}]));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn devin_jsonc_cleanup_preserves_comments_formatting_and_bom() {
        let dir = fresh_dir("devin-jsonc");
        let path = dir.join("config.json");
        let user = "      // my user hook\n      { \"command\": \"echo user\" },";
        fs::write(&path, format!(
                "\u{feff}{{\n  // my endpoint\n  \"endpoint\": \"https://example.test/a//b\",\n  \"hooks\": {{\n    \"Stop\": [\n      {{\"command\":\"C:/Users/u/AppData/Roaming/Orca/agent-hooks/devin-hook.cmd\"}},\n{user}\n    ],\n  }},\n}}\n"
            )).unwrap();
        strip_orca_json_hooks(&path).unwrap();
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with('\u{feff}'));
        assert!(after.contains("// my endpoint"));
        assert!(after.contains("https://example.test/a//b"));
        assert!(after.contains(user));
        assert!(!after.contains("devin-hook.cmd"));
        strip_orca_json_hooks(&path).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), after);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn kimi_cleanup_ignores_marker_mentions_in_comments_and_other_tables() {
        let dir = fresh_dir("kimi-user-comments");
        let path = dir.join("config.toml");
        let user = "[[hooks]]\ncommand = 'echo user' # .orca/agent-hooks/kimi-hook.sh\n\n[[tools]]\ncommand = '~/.orca/agent-hooks/kimi-hook.sh'\n";
        fs::write(
            &path,
            format!("{user}\n[[hooks]]\ncommand = '~/.orca/agent-hooks/kimi-hook.sh'\n"),
        )
        .unwrap();
        strip_orca_toml_hooks(&path).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), user);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn user_data_plugins_removed_without_deleting_sessions_or_auth() {
        let dir = fresh_dir("user-data-plugins");
        let user_data = dir.join("app-data");
        let files = [
            (
                "opencode-hooks/shared/plugins/orca-opencode-status.js",
                "// OrcaOpenCodeStatusPlugin",
            ),
            (
                "opencode-config-overlays/source/plugins/orca-opencode-status.js",
                "// ORCA_AGENT_HOOK_ENDPOINT",
            ),
            (
                "mimocode-hooks/shared/config/plugins/orca-mimocode-status.js",
                "// ORCA_AGENT_HOOK_ENDPOINT",
            ),
            (
                "pi-agent-overlays/source/extensions/orca-prefill.ts",
                "// @orca-managed-pi-extension",
            ),
            (
                "omp-agent-overlays/source/extensions/orca-titlebar-spinner.ts",
                "// @orca-managed-pi-extension",
            ),
            (
                "omp-managed-status-extension/orca-agent-status.ts",
                "// @orca-managed-pi-extension",
            ),
        ];
        for (path, marker) in files {
            let path = user_data.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, marker).unwrap();
        }
        let retained = [
            user_data.join("mimocode-hooks/shared/data/auth.json"),
            user_data.join("omp-agent-overlays/source/sessions/history.jsonl"),
            user_data.join("opencode-config-overlays/source/plugins/user.js"),
            dir.join(".orca/sessions/workspace/state.json"),
            dir.join(".orca-relay/omp-overlays/source/auth.json"),
        ];
        for path in &retained {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "user data").unwrap();
        }
        let hook = dir.join(".orca/agent-hooks/claude-hook.sh");
        fs::create_dir_all(hook.parent().unwrap()).unwrap();
        fs::write(&hook, "generated hook").unwrap();
        cleanup_orca_user_data(&user_data);
        cleanup_orca_dirs(&dir);
        cleanup_orca_user_data(&user_data);
        for (path, _) in files {
            assert!(!user_data.join(path).exists(), "{}", path);
        }
        assert!(!hook.exists());
        for path in retained {
            assert_eq!(fs::read_to_string(path).unwrap(), "user data");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_and_legacy_profile_cleanup_preserves_user_entries() {
        let dir = fresh_dir("codex-orca-trust");
        let hooks = dir.join("hooks.json");
        let config = dir.join("config.toml");
        let ledger = dir.join("ledger.json");
        let profile = dir.join("orca-agent-status.config.toml");
        let source = hooks.to_string_lossy();
        fs::write(
            &hooks,
            serde_json::to_vec(&json!({"hooks": {"PreToolUse": [{"hooks": [
                {"command": "~/.orca/agent-hooks/codex-hook.sh"}, {"command": "echo user"}
            ]}]}}))
            .unwrap(),
        )
        .unwrap();
        fs::write(&config, format!(
                    "model = 'user-model'\r\n[hooks.state.'{source}:pre_tool_use:0:0']\r\ntrusted_hash = 'orca-current'\r\n[hooks.state.'{source}:pre_tool_use:0:1']\r\ntrusted_hash = 'user'\r\n[hooks.state.'{source}:stop:0:0']\r\ntrusted_hash = 'orca-recorded'\r\n[hooks.state.'{source}:stop:1:0']\r\ntrusted_hash = 'user-replacement'\r\n"
                )).unwrap();
        let signature = json!({"command": "~/.orca/agent-hooks/codex-hook.sh"}).to_string();
        fs::write(
            &ledger,
            serde_json::to_vec(&json!({"homes": {"runtime": {"entries": {
                format!("{source}:stop:0:0"): {"signature": signature, "trustedHash": "orca-recorded"},
                format!("{source}:stop:1:0"): {"signature": signature, "trustedHash": "old-orca-hash"}
            }}}}))
            .unwrap(),
        )
        .unwrap();
        fs::write(&profile, "# my profile\n# BEGIN ORCA AGENT STATUS HOOKS\n[hooks]\n# END ORCA AGENT STATUS HOOKS\nmodel = 'user-model'\n").unwrap();
        cleanup_orca_codex_home(&dir, Some(&ledger));
        let after = fs::read_to_string(&config).unwrap();
        assert!(!after.contains("orca-current"));
        assert!(!after.contains("orca-recorded"));
        assert!(after.contains("trusted_hash = 'user'\r\n"));
        assert!(after
            .lines()
            .filter_map(parse_codex_state_header)
            .any(|key| key == format!("{source}:pre_tool_use:0:0")));
        assert!(!after
            .lines()
            .filter_map(parse_codex_state_header)
            .any(|key| key == format!("{source}:pre_tool_use:0:1")));
        assert!(after.contains("trusted_hash = 'user-replacement'\r\n"));
        assert_eq!(
            fs::read_to_string(&profile).unwrap(),
            "# my profile\n\nmodel = 'user-model'\n"
        );
        let cleaned: Value = serde_json::from_slice(&fs::read(&hooks).unwrap()).unwrap();
        assert_eq!(
            cleaned["hooks"]["PreToolUse"][0]["hooks"],
            json!([{"command": "echo user"}])
        );
        cleanup_orca_codex_home(&dir, Some(&ledger));
        assert_eq!(fs::read_to_string(config).unwrap(), after);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn dedicated_hook_configs_keep_user_hooks_and_malformed_backups() {
        let dir = fresh_dir("mixed-dedicated-configs");
        for name in ["orca.json", "orca-status.json"] {
            let path = dir.join(name);
            let backup = dir.join(format!("{name}.bak"));
            let malformed = "{ invalid JSON: .orca/agent-hooks/grok-hook.sh";
            fs::write(
                &path,
                serde_json::to_vec(&json!({"hooks": {"Stop": [
                    {"command": "~/.orca/agent-hooks/grok-hook.sh"}, {"command": "echo user"}
                ]}}))
                .unwrap(),
            )
            .unwrap();
            fs::write(&backup, malformed).unwrap();
            cleanup_orca_json_config(&path);
            let cleaned: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(cleaned["hooks"]["Stop"], json!([{"command": "echo user"}]));
            assert_eq!(fs::read_to_string(backup).unwrap(), malformed);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn hermes_cleanup_removes_generated_cache_but_preserves_user_replacement() {
        let dir = fresh_dir("hermes-cache");
        let plugin = dir.join("plugins/orca-status");
        let cache = plugin.join("__pycache__");
        fs::create_dir_all(&cache).unwrap();
        fs::write(plugin.join("__init__.py"), ORCA_PLUGIN_MARKER).unwrap();
        fs::write(plugin.join("plugin.yaml"), ORCA_PLUGIN_MARKER).unwrap();
        fs::write(cache.join("__init__.cpython-313.pyc"), [0, 1, 2]).unwrap();
        fs::write(
            dir.join("config.yaml"),
            "plugins:\n  enabled: [orca-status, user-plugin]\n",
        )
        .unwrap();
        cleanup_orca_hermes(&dir);
        assert!(!plugin.exists());
        assert!(fs::read_to_string(dir.join("config.yaml"))
            .unwrap()
            .contains("user-plugin"));
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("__init__.py"), "# user replacement").unwrap();
        fs::write(
            plugin.join("plugin.yaml"),
            "name: orca-status\nauthor: user\n",
        )
        .unwrap();
        let user_config = "plugins:\n  enabled: [orca-status]\n";
        fs::write(dir.join("config.yaml"), user_config).unwrap();
        cleanup_orca_hermes(&dir);
        assert!(plugin.join("__init__.py").exists());
        assert_eq!(
            fs::read_to_string(dir.join("config.yaml")).unwrap(),
            user_config
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn coffee_then_orca_cleanup_preserves_user_codex_trust_at_new_indices() {
        let dir = fresh_dir("codex-trust-reindex");
        let codex = dir.join(".codex");
        fs::create_dir_all(&codex).unwrap();
        let hooks = codex.join("hooks.json");
        let config = codex.join("config.toml");
        let source = hooks.to_string_lossy();
        let value = json!({"hooks": {"Stop": [
            {"hooks": [{"command": "coffee-cli __codex-hook"}]},
            {"hooks": [{"command": "~/.orca/agent-hooks/codex-hook.sh"}]},
            {"hooks": [
                {"command": "~/.orca/agent-hooks/codex-hook.sh"},
                {"command": "echo user"}
            ]}
        ]}});
        fs::write(&hooks, format!("// user JSONC\n{value}\n")).unwrap();
        fs::write(
            &config,
            format!(
                "[hooks.state.'{source}:stop:0:0']\ntrusted_hash = 'coffee'\n\
                 [hooks.state.'{source}:stop:1:0']\ntrusted_hash = 'orca'\n\
                 [hooks.state.'{source}:stop:2:0']\ntrusted_hash = 'orca2'\n\
                 [hooks.state.'{source}:stop:2:1']\ntrusted_hash = 'user'\nenabled = false\n"
            ),
        )
        .unwrap();
        cleanup_codex_island_install(&dir);
        cleanup_orca_codex_home(&codex, None);
        let after = fs::read_to_string(&config).unwrap();
        assert!(after.contains("trusted_hash = 'user'\nenabled = false"));
        assert!(!after.contains("'orca"));
        assert!(!after.contains("'coffee'"));
        let keys: Vec<_> = after.lines().filter_map(parse_codex_state_header).collect();
        assert_eq!(keys, vec![format!("{source}:stop:0:0")]);
        cleanup_codex_island_install(&dir);
        cleanup_orca_codex_home(&codex, None);
        assert_eq!(fs::read_to_string(&config).unwrap(), after);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn toml_cleanup_preserves_hook_examples_in_multiline_instructions() {
        let dir = fresh_dir("toml-multiline-examples");
        let hooks = dir.join("hooks.json");
        let config = dir.join("config.toml");
        let source = hooks.to_string_lossy();
        fs::write(
            &hooks,
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"~/.orca/agent-hooks/codex-hook.sh"}]}]}}"#,
        )
        .unwrap();
        for delimiter in ["\"\"\"", "'''"] {
            let user = format!("# {delimiter} in a comment\ninstructions = {delimiter}\n[hooks.state.'{source}:stop:0:0']\ntrusted_hash = 'example'\n[[hooks]]\ncommand = '~/.orca/agent-hooks/kimi-hook.sh'\n{delimiter}\n");
            fs::write(&config, format!("{user}[hooks.state.'{source}:stop:0:0']\ntrusted_hash = 'orca'\n[[hooks]]\ncommand = '~/.orca/agent-hooks/kimi-hook.sh'\n")).unwrap();
            strip_orca_codex_trust(&dir, None).unwrap();
            strip_orca_toml_hooks(&config).unwrap();
            assert_eq!(fs::read_to_string(&config).unwrap(), user);
            let hook_example = format!("[[hooks]]\ncommand = 'echo user'\nnote = {delimiter}\ncommand = '~/.orca/agent-hooks/kimi-hook.sh'\n{delimiter}\n");
            fs::write(&config, &hook_example).unwrap();
            strip_orca_toml_hooks(&config).unwrap();
            assert_eq!(fs::read_to_string(&config).unwrap(), hook_example);
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn hermes_cache_without_ownership_and_directories_are_preserved() {
        let dir = fresh_dir("hermes-cache-ownership");
        let plugin = dir.join("plugins/orca-status");
        let cache = plugin.join("__pycache__");
        fs::create_dir_all(&cache).unwrap();
        let pyc = cache.join("__init__.cpython-313.pyc");
        fs::write(&pyc, "user bytecode").unwrap();
        cleanup_orca_hermes(&dir);
        assert!(pyc.exists(), "no marked source, no ownership proof");
        fs::write(plugin.join("__init__.py"), ORCA_PLUGIN_MARKER).unwrap();
        let user_dir = cache.join("__init__.custom.pyc");
        fs::create_dir_all(&user_dir).unwrap();
        fs::write(user_dir.join("user.txt"), "user data").unwrap();
        cleanup_orca_hermes(&dir);
        assert!(!pyc.exists());
        assert!(user_dir.join("user.txt").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn overlay_cleanup_does_not_follow_directory_links() {
        let dir = fresh_dir("overlay-links");
        let external = dir.join("user-config");
        let root = dir.join("mimocode-hooks");
        fs::create_dir_all(external.join("plugins")).unwrap();
        fs::create_dir_all(root.join("shared")).unwrap();
        let plugin = external.join("plugins/orca-mimocode-status.js");
        fs::write(&plugin, "// ORCA_AGENT_HOOK_ENDPOINT").unwrap();
        let links = [
            root.join("shared").join("config"),
            root.join("source"),
            dir.join("plugins").join("orca-status").join("__pycache__"),
        ];
        fs::create_dir_all(external.join("config/plugins")).unwrap();
        let nested_plugin = external.join("config/plugins/orca-opencode-status.js");
        fs::write(&nested_plugin, "// OrcaOpenCodeStatusPlugin").unwrap();
        let pyc = external.join("__init__.cpython-313.pyc");
        fs::write(&pyc, "user bytecode").unwrap();
        fs::create_dir_all(links[2].parent().unwrap()).unwrap();
        fs::write(
            links[2].parent().unwrap().join("__init__.py"),
            ORCA_PLUGIN_MARKER,
        )
        .unwrap();
        for link in &links {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let output = std::process::Command::new("cmd")
                    .args(["/D", "/C", "mklink", "/J"])
                    .arg(&link)
                    .arg(&external)
                    .creation_flags(0x08000000)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(&external, &link).unwrap();
        }
        cleanup_orca_plugin_overlay(&root);
        cleanup_orca_hermes(&dir);
        assert!(plugin.exists());
        assert!(nested_plugin.exists());
        assert!(pyc.exists());
        assert!(links.iter().all(|link| link.exists()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn orca_owned_paths_removed() {
        let dir = fresh_dir("owned-dirs");
        let orca_dir = dir.join(".orca");
        fs::create_dir_all(orca_dir.join("agent-hooks")).unwrap();
        fs::write(orca_dir.join("agent-hooks").join("claude-hook.sh"), "#!/bin/sh").unwrap();
        fs::write(orca_dir.join("managed-hook-install.lock"), "lock").unwrap();
        let relay = dir.join(".orca-relay");
        fs::create_dir_all(relay.join("opencode-overlays").join("abc")).unwrap();
        let marker = dir.join(".orca-managed-home");
        fs::write(&marker, "home-id\n").unwrap();

        remove_orca_owned_paths(vec![orca_dir, relay, marker.clone()]);
        assert!(!dir.join(".orca").exists());
        assert!(!dir.join(".orca-relay").exists());
        assert!(!marker.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_config_left_untouched() {
        let dir = fresh_dir("malformed");
        let settings = dir.join(".claude").join("settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "{ not json at all [").unwrap();
        strip_orca_json_hooks(&settings).unwrap();
        assert_eq!(fs::read_to_string(&settings).unwrap(), "{ not json at all [");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backup_removed_only_when_marked() {
        let dir = fresh_dir("backup");
        let settings = dir.join("settings.json");
        let marked_backup = dir.join("settings.json.bak");
        fs::write(
            &marked_backup,
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"%USERPROFILE%\\.orca\\agent-hooks\\claude-hook.cmd"}]}]}}"#,
        )
        .unwrap();
        remove_orca_backup(&settings);
        assert!(!marked_backup.exists(), "Orca backup removed");

        let user_backup = dir.join("user-backup.json.bak");
        fs::write(&user_backup, r#"{"theme": "dark"}"#).unwrap();
        remove_orca_backup(&PathBuf::from(dir.join("user-backup.json")));
        assert!(user_backup.exists(), "user backup kept");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_opencode_dir_deleted_only_when_entirely_orca() {
        let dir = fresh_dir("opencode-legacy");
        let opencode = dir.join(".opencode");
        fs::create_dir_all(&opencode).unwrap();
        fs::write(
            opencode.join("orca-opencode-status.js"),
            "// OrcaOpenCodeStatusPlugin\nconst x = process.env.ORCA_AGENT_HOOK_ENDPOINT;",
        )
        .unwrap();
        cleanup_legacy_opencode_dir(&opencode);
        assert!(!opencode.exists(), "all-Orca folder deleted");

        // Mixed content keeps the folder and drops only marked files.
        fs::create_dir_all(&opencode).unwrap();
        fs::write(
            opencode.join("orca-opencode-status.js"),
            "// OrcaOpenCodeStatusPlugin",
        )
        .unwrap();
        fs::write(opencode.join("user.json"), r#"{"provider": "custom"}"#).unwrap();
        cleanup_legacy_opencode_dir(&opencode);
        assert!(opencode.exists(), "mixed folder kept");
        assert!(!opencode.join("orca-opencode-status.js").exists());
        assert!(opencode.join("user.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hermes_yaml_strips_orca_plugin_entry() {
        let dir = fresh_dir("hermes-orca-yaml");
        let cfg = dir.join("config.yaml");
        fs::write(
            &cfg,
            "model: test\nplugins:\n  enabled:\n    - user-plugin\n    - orca-status # Orca plugin\n  disabled: [quiet-plugin, \"orca-status\"]\nother: true\n",
        )
        .unwrap();
        strip_hermes_plugin_from_yaml_named(&cfg, "orca-status").unwrap();
        let after = fs::read_to_string(&cfg).unwrap();
        assert!(!after.contains("orca-status"), "Orca plugin removed: {}", after);
        assert!(after.contains("user-plugin"));
        assert!(after.contains("quiet-plugin"));
        assert!(after.contains("model: test"));
        assert!(after.contains("other: true"));
        let _ = fs::remove_dir_all(&dir);
    }
}
