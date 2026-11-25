// Non-hook CLI integration maintenance.
// Status hooks and plugins belonging to Coffee CLI, Orca or users are never
// installed, migrated or removed here. Only presentation and npm-bin repairs
// remain from the former hook installer.

use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub fn maintain_all() {
    if let Some(home) = dirs::home_dir() {
        for tool in crate::tools::TOOLS {
            maintain_tool(tool, &home);
        }
    }
    #[cfg(target_os = "windows")]
    repair_broken_npm_bins();
}

/// Apply non-hook presentation maintenance after the launchpad's PATH rescan.
pub fn maintain_for_tool(tool: &str) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let Some(descriptor) = crate::tools::find(tool) else {
        return;
    };
    maintain_tool(descriptor, &home);
}

fn maintain_tool(tool: &crate::tools::ToolDescriptor, home: &Path) {
    if tool.has_legacy_hook_artifacts
        && matches!(tool.id, "opencode" | "mimocode" | "kilo")
        && crate::server::binary_on_path(tool.binary_name)
    {
        ensure_opencode_tui_theme_default(home, tool.id);
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
    use std::path::PathBuf;

    fn test_home() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("coffee-maintenance-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn maintenance_preserves_coffee_orca_and_user_hooks() {
        let home = test_home();
        let files = [
            (
                ".claude/settings.json",
                r#"{"hooks":{"Stop":[{"hooks":[{"command":"coffee-cli __hook"},{"command":"~/.orca/agent-hooks/claude-hook.sh"},{"command":"echo user"}]}]}}"#,
            ),
            (
                ".claude/settings.local.json",
                r#"{"hooks":{"Stop":[{"command":"coffee-cli __hook"}]}}"#,
            ),
            (
                ".codex/config.toml",
                "notify = ['coffee-cli', '__codex-notify']\n",
            ),
            (
                ".codex/hooks.json",
                r#"{"hooks":{"Stop":[{"command":"coffee-cli __codex-hook"},{"command":"~/.orca/agent-hooks/codex-hook.sh"}]}}"#,
            ),
            (
                ".codex/hooks.state.toml",
                "[hooks.state.user]\ntrusted_hash = 'user'\n",
            ),
            (
                ".kimi-code/config.toml",
                "[[hooks]]\ncommand = 'coffee-cli __kimi-hook'\n",
            ),
            (
                ".grok/hooks/coffee.json",
                r#"{"command":"coffee-cli __grok-hook"}"#,
            ),
            (
                ".config/opencode/plugins/coffee-cli-island.js",
                "// Coffee CLI status plugin\n",
            ),
            (
                ".config/mimocode/plugins/orca-status.js",
                "// ORCA_AGENT_HOOK_ENDPOINT\n",
            ),
            (
                ".hermes/plugins/coffee-cli-status/__init__.py",
                "# Coffee CLI status plugin\n",
            ),
            (
                ".hermes/config.yaml",
                "plugins:\n  enabled: [coffee-cli-status, orca-status, user-plugin]\n",
            ),
            (
                ".coffee-cli/hooks/coffee-cli-hook.py",
                "# legacy Coffee hook\n",
            ),
            (
                ".coffee-cli/hooks/coffee-cli-codex-notify.py",
                "# legacy Codex notify\n",
            ),
            (".orca/agent-hooks/claude-hook.sh", "#!/bin/sh\n"),
            (".orca/managed-hook-install.lock", "lock"),
        ];
        for (relative, content) in &files {
            let path = home.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        // Startup and installed-tool rescans share this exact dispatch.
        for _ in 0..2 {
            for tool in crate::tools::TOOLS {
                maintain_tool(tool, &home);
            }
        }
        for (relative, content) in files {
            assert_eq!(
                fs::read_to_string(home.join(relative)).unwrap(),
                content,
                "{relative}"
            );
        }
    }

    #[test]
    fn transparent_theme_default_and_legacy_migration_still_work() {
        let home = test_home();
        ensure_opencode_tui_theme_default(&home, "opencode");
        let path = home.join(".config/opencode/tui.json");
        let created: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(created["theme"], OPENCODE_DEFAULT_THEME);
        fs::write(&path, r#"{"theme":"system","keybinds":{"quit":"ctrl+q"}}"#).unwrap();
        ensure_opencode_tui_theme_default(&home, "opencode");
        let migrated: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(migrated["theme"], OPENCODE_DEFAULT_THEME);
        assert_eq!(migrated["keybinds"]["quit"], "ctrl+q");
    }

    #[test]
    fn custom_and_malformed_theme_files_are_untouched() {
        let home = test_home();
        let config = home.join(".config/opencode");
        fs::create_dir_all(&config).unwrap();
        let path = config.join("tui.json");
        for original in ["{\"theme\":\"custom\"}\n", "{ malformed"] {
            fs::write(&path, original).unwrap();
            ensure_opencode_tui_theme_default(&home, "opencode");
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
    }
}
