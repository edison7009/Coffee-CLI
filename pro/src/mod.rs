//! Coffee CLI Pro: tool integrations, desktop conversations, usage and the app's own features built on them.
//! Compiled into the app with `--features pro`; the public core builds and runs without it.
pub mod acp_session;
pub mod claude_session;
pub mod codex_session;
pub mod opencode_session;
pub mod dsh_session;
pub mod pi_session;
pub mod opencode_island;
pub mod skill_catalog;
pub mod hook_installer;
pub mod tool_config;
pub mod cli_updates;
pub mod tool_memory;
pub mod tool_skills;
pub mod tool_control;
pub mod computer_control;
pub mod orchestration;
pub mod worker_worktree;
pub mod window_control;
pub mod tools;
pub mod usage_stats;
pub mod usage_quota;
pub mod voice_input;
pub mod history;
pub mod agent_presets;
pub mod tool_launch;
pub mod session_git_context;
pub mod git_project_status;

/// The helper subcommands Pro tools run inside a Coffee terminal (team coordinator, window control, UI
/// control), before any GUI starts. Returns whether one ran.
pub fn run_helper(helper_args: &[String]) -> bool {
    if matches!(helper_args.get(1).map(String::as_str), Some("__team_mcp" | "__team_worker")) {
        #[cfg(windows)]
        if helper_args[1] == "__team_worker" {
            use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
            let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
        }
        let result = (|| {
            let port = helper_args.get(2).and_then(|value| value.parse::<u16>().ok()).ok_or("Invalid local coordinator port")?;
            let token = helper_args.get(3).ok_or("Coordinator token missing")?;
            if helper_args[1] == "__team_mcp" { crate::orchestration::mcp(port, token) }
            else { crate::orchestration::worker_cli(port, token, &helper_args[4..]) }
        })();
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return true;
    }
    if helper_args.get(1).map(String::as_str) == Some(crate::window_control::SUBCOMMAND) {
        let result = match (helper_args.get(2).and_then(|value| value.parse::<u16>().ok()), helper_args.get(3)) {
            (Some(port), Some(token)) => crate::window_control::mcp(port, token),
            _ => Err("Expected port and token".into()),
        };
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return true;
    }
    if helper_args.get(1).map(String::as_str) == Some("__ui-control") {
        let result = match (helper_args.get(2), helper_args.get(3)) {
            (Some(kind), Some(tool)) => crate::tool_control::serve(kind, tool),
            _ => Err("Expected capability and agent".into()),
        };
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return true;
    }
    false
}

/// App state for the desktop conversations, registered before the app starts.
pub fn manage(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(claude_session::ClaudeSessions::default())
        .manage(codex_session::CodexSessions::default())
        .manage(dsh_session::DshSessions::default())
        .manage(pi_session::PiSessions::default())
        .manage(acp_session::AcpSessions::default())
        .manage(opencode_session::OpenCodeSessions::default())
}

/// Once the app is up: presentation and npm-bin maintenance for the tools (never touches status hooks).
pub fn on_start() {
    hook_installer::maintain_all();
}

/// When the app exits: stop every desktop conversation's tool process.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    claude_session::shutdown(&app.state::<claude_session::ClaudeSessions>());
    codex_session::shutdown(&app.state::<codex_session::CodexSessions>());
    dsh_session::shutdown(&app.state::<dsh_session::DshSessions>());
    pi_session::shutdown(&app.state::<pi_session::PiSessions>());
    acp_session::shutdown(&app.state::<acp_session::AcpSessions>());
    opencode_session::shutdown(&app.state::<opencode_session::OpenCodeSessions>());
}
