//! What the desktop UI may do when it runs in a browser (Web 端).
//!
//! The browser runs the full desktop front-end, but holds nothing of its own:
//! every session lives on the desktop. Its Tauri commands arrive here and,
//! when allowed, are run by the desktop window on its behalf.
//!
//! Pairing a device trusts it with this computer, like an SSH login: it can
//! type into the desktop's terminals, so it can already read files and run
//! programs. The rules here keep the desktop app itself in one piece rather
//! than fence a hostile device in:
//!
//! - A deny-list keeps the desktop window, the host's dialogs and speakers,
//!   pairing, installers, the desktop's background agent and anything that
//!   opens programs on the desktop's screen (the browser opens links itself)
//!   out of reach, and passwords stay where they are.
//! - Sessions are started, closed and sized only by the desktop. The browser
//!   asks for those through `ui.dispatch` and `ui.call`; directly it may only
//!   type into a terminal it shows.

use serde_json::Value;

/// Desktop events the browser UI listens to. Requests the desktop window
/// answers itself (orchestration, agent tools, launch) are not forwarded, or
/// both sides would act on them.
/// Not here: terminal output (numbered, see `record_terminal`) and conversation
/// events (the desktop sends its state instead, see `mobile_rpc_mirror`).
pub const FORWARDED_EVENTS: [&str; 11] = [
    "tier-terminal-size", "tier-terminal-status", "tier-terminal-exit", "tier-terminal-cwd", "tier-terminal-token",
    "fs-refresh", "tasks-changed", "agent-conversations-changed", "agent-work-modes", "channel-status", "orchestration-updated",
];

const DENIED: [&str; 34] = [
    // The desktop window and the host's own devices, dialogs and speakers.
    "window_minimize", "window_maximize", "window_close", "show_main_window", "set_frosted_backdrop", "set_background_mode",
    "pick_folder", "notify_sound_choose", "show_in_folder", "open_url", "read_clipboard_image", "save_clipboard_image", "play_notify_sound",
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

/// Whether a command acts on a session; `true` for the ones a browser may send
/// to directly (typing into a terminal it mirrors).
fn session_command(cmd: &str) -> Option<bool> {
    if matches!(cmd, "tier_terminal_input" | "tier_terminal_raw_write" | "get_terminal_session_token") { return Some(true); }
    if matches!(cmd, "tier_terminal_start" | "tier_terminal_kill" | "tier_terminal_resize" | "set_session_active") { return Some(false); }
    let (tool, action) = cmd.split_once("_session_")?;
    if !TOOLS.contains(&tool) { return None; }
    // Reading saved history needs no running session.
    if action == "preview" || cmd == "dsh_session_history" { return None; }
    Some(false)
}

/// Checks a browser command; returns an error message when it must not run.
pub fn check(cmd: &str, _args: &Value) -> Result<(), String> {
    if !allowed(cmd) { return Err(format!("{cmd} is not available in the browser")); }
    match session_command(cmd) {
        Some(false) => Err("Sessions are run by the desktop".into()),
        _ => Ok(()),
    }
}
