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
    // ── Linux GUI fixups ────────────────────────────────────────────────
    // Ubuntu 24.04 ships WebKit2GTK 2.42+ (later 2.50.x), which on
    // Wayland sessions renders a blank window in Tauri 2 — the Rust
    // process starts and the hook-server binds, but WebView never
    // shows. Symptoms: user clicks the .desktop entry, nothing
    // happens. Setting these env vars before the Tauri builder runs
    // forces the WebView onto a code path that works:
    //   - GDK_BACKEND=x11 routes GTK through XWayland (avoids the
    //     Wayland-native WebKit rendering bug entirely).
    //   - WEBKIT_DISABLE_COMPOSITING_MODE=1 disables the GPU
    //     compositing path that fails silently on many Wayland +
    //     mesa stacks.
    //   - WEBKIT_DISABLE_DMABUF_RENDERER=1 disables the new dmabuf
    //     renderer introduced in WebKit2GTK 2.42 that misbehaves with
    //     several mesa/intel/nvidia driver combos.
    // Setting these here (rather than in the .desktop file) means
    // they apply equally when the user launches via menu, terminal,
    // or another wrapper. set_var is `unsafe` in recent Rust because
    // of cross-thread races, but we're in single-threaded main()
    // before any thread spawn, so it's safe.
    #[cfg(target_os = "linux")]
    unsafe {
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    // ── PATH inheritance fix (macOS / Linux) ────────────────────────────
    // GUI apps on macOS / Linux launched from Dock / Finder / .desktop
    // entries get a minimal PATH (typically /usr/bin:/bin:/usr/sbin:/sbin)
    // — they do NOT source the user's interactive shell rc files. So tools
    // installed via Homebrew, nvm, volta, asdf, npm-global, cargo, bun,
    // ~/.local/bin, etc. are invisible to every Command::new() in the
    // process. Symptom: tool-detection cards stay greyed out even though
    // `claude` / `codex` / `gemini` / `hermes` are clearly installed.
    //
    // Fix: ask the user's login shell for its real PATH ONCE at startup
    // and replace the process PATH. Every downstream subprocess
    // (tool-detection `which`, PTY spawns, etc.) inherits this and
    // resolves binaries the same way the user's terminal would.
    //
    // We use `-ilc` (interactive + login) so both .zprofile/.bash_profile
    // AND .zshrc/.bashrc are sourced — matches what the user sees when
    // they open a fresh terminal window.
    #[cfg(not(target_os = "windows"))]
    unsafe {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let basename = std::path::Path::new(&shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        // fish prints $PATH space-separated, not colon-separated. Use its
        // string-join builtin to emit the same format as POSIX shells.
        let cmd_str = if basename == "fish" {
            "string join : -- $PATH"
        } else {
            "printf '%s' \"$PATH\""
        };
        if let Ok(out) = std::process::Command::new(&shell)
            .args(["-ilc", cmd_str])
            .output()
        {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                // Sanity guard: a real PATH always contains ':'. If the
                // shell rc errored out and we got garbage / empty, keep
                // whatever PATH the OS gave us rather than nuking it.
                if !path.is_empty() && path.contains(':') {
                    std::env::set_var("PATH", path);
                }
            }
        }
    }

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
