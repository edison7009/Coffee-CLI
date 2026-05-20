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
mod agent_mcp_config;
mod tool_config;
mod tools;
mod skills;

use anyhow::Result;

fn main() -> Result<()> {
    // ── Linux GUI backend selection ─────────────────────────────────────
    // Older WebKit2GTK (≤ 2.44) had a Wayland blank-window bug on
    // Ubuntu 24.04: WebView never paints, so the original workaround
    // unconditionally forced GDK_BACKEND=x11 (XWayland path).
    //
    // On WebKit ≥ 2.46 that workaround backfires badly. Measured on
    // an AMD Lucienne iGPU + WebKit 2.50.4 (Ubuntu 24.04, Wayland
    // session): X11 path makes WebKit's GPU detection silently fail,
    // Skia falls back to CPU software rasterization, and four
    // SkiaCPUWorker threads peg ~19% CPU at idle — fan spins up
    // continuously even with no user input. WebKitWebProcess goes
    // from 47% (X11) down to 8% (native Wayland) just by removing
    // the workaround on this WebKit version, because Skia uses
    // DMABUF + Mesa for GPU paint instead.
    //
    // Strategy: detect installed WebKit minor version from the .so
    // file. ≥ 2.46 → leave GDK_BACKEND unset and let GTK pick the
    // session-native backend (Wayland on Wayland sessions, X11 on
    // X11 sessions). Older / undetectable → keep the safe X11
    // fallback so 22.04 / Debian stable users don't regress.
    //
    // Escape hatch: COFFEE_FORCE_X11=1 forces X11 unconditionally,
    // for users who hit a render bug on a specific driver/compositor
    // combo on the modern path.
    //
    // set_var is `unsafe` in recent Rust because of cross-thread
    // races; we're in single-threaded main() before any thread
    // spawns, so it's safe.
    #[cfg(target_os = "linux")]
    unsafe {
        if std::env::var_os("GDK_BACKEND").is_none() {
            let force_x11 = std::env::var_os("COFFEE_FORCE_X11").is_some();
            let needs_x11 = force_x11 || webkit_minor_version().map_or(true, |m| m < 46);
            if needs_x11 {
                std::env::set_var("GDK_BACKEND", "x11");
            }
        }
    }

    // ── PATH inheritance fix (macOS / Linux) ────────────────────────────
    // GUI apps on macOS / Linux launched from Dock / Finder / .desktop
    // entries get a minimal PATH (typically /usr/bin:/bin:/usr/sbin:/sbin)
    // — they do NOT source the user's interactive shell rc files. So tools
    // installed via Homebrew, nvm, volta, asdf, npm-global, cargo, bun,
    // ~/.local/bin, etc. are invisible to every Command::new() in the
    // process. Symptom: tool-detection cards stay greyed out even though
    // `claude` / `codex` / `agy` / `hermes` are clearly installed.
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

/// Query the installed WebKit2GTK 4.1 minor version via dlopen +
/// `webkit_get_minor_version()` — WebKit's public C API. Returns
/// e.g. `Some(50)` for WebKit 2.50.x, `Some(46)` for 2.46.x, or
/// `None` if WebKit isn't installed or the symbol can't be resolved.
///
/// We deliberately do NOT parse the `.so` filename: the soversion
/// suffix uses libtool's `current.revision.age` triplet which has
/// no fixed relationship to WebKit's `MAJOR.MINOR.PATCH` (e.g. on
/// Ubuntu 24.04 WebKit 2.50.4 ships as `.so.0.19.7`).
///
/// `dlopen` / `dlsym` are exposed by libc on every glibc system
/// (and merged into libc proper since glibc 2.34), so no extra
/// link flags are required.
#[cfg(target_os = "linux")]
fn webkit_minor_version() -> Option<u32> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint, c_void};

    extern "C" {
        fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn dlclose(handle: *mut c_void) -> c_int;
    }
    const RTLD_LAZY: c_int = 1;
    const RTLD_LOCAL: c_int = 0;

    let lib = CString::new("libwebkit2gtk-4.1.so.0").ok()?;
    let sym = CString::new("webkit_get_minor_version").ok()?;

    unsafe {
        let handle = dlopen(lib.as_ptr(), RTLD_LAZY | RTLD_LOCAL);
        if handle.is_null() {
            return None;
        }
        let func_ptr = dlsym(handle, sym.as_ptr());
        if func_ptr.is_null() {
            dlclose(handle);
            return None;
        }
        let func: extern "C" fn() -> c_uint = std::mem::transmute(func_ptr);
        let minor = func();
        dlclose(handle);
        Some(minor)
    }
}
