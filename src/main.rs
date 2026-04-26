#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cli;
mod terminal;
mod server;
mod hook_server;
mod hook_installer;
mod fs_watcher;
mod mcp_server;
mod mcp_injector;
mod multi_agent_protocol;

use anyhow::Result;

fn main() -> Result<()> {
    // CLI subcommand dispatch — short-circuit GUI launch when invoked
    // with a known subcommand. This is opt-in; double-clicking the
    // executable still gets the GUI (no argv).
    let args: Vec<String> = std::env::args().collect();
    if let Some(sub) = args.get(1) {
        match sub.as_str() {
            "mcp-status" => {
                attach_terminal_console();
                return cli::mcp_status();
            }
            // Forward-compatible: unknown subcommands fall through
            // to the GUI rather than failing, so users who type
            // garbage still get a working app.
            _ => {}
        }
    }

    // Default: launch the GUI. Each tab picks its own CWD at
    // launch time — no initial directory needed.
    server::start_ui()
}

/// On Windows release builds, the binary is linked with the GUI
/// subsystem (`windows_subsystem = "windows"`) so stdout is detached
/// even when launched from a terminal. For CLI subcommands we
/// re-attach to the parent process's console so users see our output.
/// No-op on Unix and on debug builds.
#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn attach_terminal_console() {
    use windows::Win32::System::Console::{
        AttachConsole, ATTACH_PARENT_PROCESS,
    };
    unsafe {
        // Best-effort: if the parent has no console (e.g. invoked
        // from explorer double-click), AttachConsole returns FALSE
        // and our prints just go nowhere — harmless.
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(all(target_os = "windows", not(debug_assertions))))]
fn attach_terminal_console() {}
