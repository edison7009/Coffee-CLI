//! What the desktop UI may do when it runs in a browser (Web 端).
//!
//! The browser runs the full desktop front-end. Its Tauri commands arrive
//! here and, when allowed, are run by the desktop window on its behalf, so
//! every desktop feature works without per-command code. Two rules guard it:
//!
//! - A deny-list keeps the desktop window, the host's own devices and dialogs,
//!   credentials, pairing, installers and the desktop's background agent out
//!   of reach.
//! - A paired browser mirrors the desktop's terminals: it may type into any
//!   of them, but only resizes or closes the ones it started itself, so the
//!   desktop's tabs keep their size and stay open.

use serde_json::Value;
use std::collections::HashSet;

/// Desktop events the browser UI listens to. Requests the desktop window
/// answers itself (orchestration, agent tools, launch) are not forwarded, or
/// both sides would act on them.
/// Terminal output is not here: it goes out numbered, with the replay buffer (see `record_terminal`).
pub const FORWARDED_EVENTS: [&str; 16] = [
    "claude-session-event", "codex-session-event", "opencode-session-event", "pi-session-event", "dsh-session-event",
    "tier-terminal-size", "tier-terminal-status", "tier-terminal-exit", "tier-terminal-cwd", "tier-terminal-token",
    "fs-refresh", "tasks-changed", "agent-conversations-changed", "agent-work-modes", "channel-status", "orchestration-updated",
];

const DENIED: [&str; 33] = [
    // The desktop window and the host's own devices, dialogs and speakers.
    "window_minimize", "window_maximize", "window_close", "show_main_window", "set_frosted_backdrop", "set_background_mode",
    "pick_folder", "notify_sound_choose", "show_in_folder", "read_clipboard_image", "save_clipboard_image", "play_notify_sound",
    // One global watcher: a browser switching folders would move the desktop's.
    "start_fs_watcher", "stop_fs_watcher",
    // Credentials, installers and account binding stay on the desktop.
    "save_password", "load_password", "delete_password", "download_and_install_update", "update_cli", "install_browser_control",
    "maintain_tool_integration", "channel_connect_telegram", "channel_disconnect", "channel_weixin_start", "channel_weixin_poll",
    // The desktop's background agent and orchestration hub.
    "agent_bridge_ready", "take_pending_launch", "agent_tool_is_pending", "agent_resolve_tool", "agent_sentinel_report",
    "orchestration_sync", "orchestration_pending", "orchestration_resolve",
];
const DENIED_PREFIXES: [&str; 3] = ["mobile_rpc_", "voice_", "plugin:"];

const TOOLS: [&str; 5] = ["claude", "codex", "opencode", "pi", "dsh"];

pub fn allowed(cmd: &str) -> bool {
    !cmd.is_empty() && cmd.len() <= 64 && cmd.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !DENIED.contains(&cmd) && !DENIED_PREFIXES.iter().any(|p| cmd.starts_with(p))
}

/// The session a command acts on, when it acts on one.
fn session_of(cmd: &str, args: &Value) -> Option<(bool, String)> {
    let starts = |id: &Value| id.as_str().map(str::to_owned);
    if cmd == "tier_terminal_start" { return starts(&args["sessionId"]).map(|id| (true, id)); }
    // Typing reaches any terminal the desktop shows; that is what mirroring means.
    if matches!(cmd, "tier_terminal_input" | "tier_terminal_raw_write" | "get_terminal_session_token") { return None; }
    if matches!(cmd, "tier_terminal_kill" | "tier_terminal_resize" | "set_session_active") {
        return Some((false, starts(&args["sessionId"]).unwrap_or_default()));
    }
    let tool = cmd.split_once("_session_")?;
    if !TOOLS.contains(&tool.0) { return None; }
    // Reading saved history needs no running session.
    if tool.1 == "history" && cmd == "dsh_session_history" { return None; }
    if tool.1 == "preview" { return None; }
    Some((tool.1 == "start", starts(&args["id"]).unwrap_or_default()))
}

/// Checks a browser command; `owned` holds the sessions this browser started.
/// Returns an error message when it must not run.
pub fn check(cmd: &str, args: &Value, owned: &mut HashSet<String>) -> Result<(), String> {
    if !allowed(cmd) { return Err(format!("{cmd} is not available in the browser")); }
    match session_of(cmd, args) {
        Some((true, id)) if !id.is_empty() => { owned.insert(id); Ok(()) }
        Some((true, _)) => Err("session id required".into()),
        Some((false, id)) if owned.contains(&id) => Ok(()),
        Some((false, _)) => Err("This session belongs to the desktop".into()),
        None => Ok(()),
    }
}
