#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod terminal;
mod server;
mod hook_server;
mod hook_forwarder;
mod hook_installer;
mod fonts;
mod fs_watcher;
mod launch;
mod tool_config;
mod tools;
mod skills;
mod marketplace;
mod git;
mod paths;
mod shell_probe;
#[cfg(target_os = "windows")]
mod windows_path;

use anyhow::Result;

fn main() -> Result<()> {
    // ── Native hook forwarder (fast path) ───────────────────────────────
    // Invoked by Claude Code (`<exe> __hook`), Codex hooks (`<exe>
    // __codex-hook`, stdin JSON), Codex legacy notify (`<exe>
    // __codex-notify <json>`), and Kimi Code hooks (`<exe> __kimi-hook`,
    // Claude-shaped stdin JSON) to forward agent status to the dynamic
    // island. This MUST run before any GUI / Linux-backend / PATH-inherit
    // setup below — the PATH fix spawns a login shell, which we don't want
    // firing on every tool-call hook. Each arm calls process::exit and
    // never returns. See hook_forwarder.rs for why this replaced the Python
    // forwarders (no more `python`-not-found errors on Windows).
    {
        let argv: Vec<String> = std::env::args().collect();
        match argv.get(1).map(|s| s.as_str()) {
            Some("__hook") => hook_forwarder::run_claude_hook(),
            Some("__codex-hook") => hook_forwarder::run_codex_hook(),
            Some("__codex-notify") => hook_forwarder::run_codex_notify(&argv),
            Some("__kimi-hook") => hook_forwarder::run_kimi_hook(),
            // Unknown `__`-prefixed subcommand: a hook config written by a
            // NEWER build (or another install) pointing at an OLDER exe that
            // doesn't know it yet (downgrade, dual install). Exit 0 quietly
            // instead of falling through to a GUI launch inside the agent's
            // hook spawn — a hanging/failing GUI there surfaces as
            // "hook exited with code 1" in the agent's transcript.
            Some(other) if other.starts_with("__") => std::process::exit(0),
            _ => {}
        }
    }

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

    // ── Raise fd soft limit (macOS / Linux) ─────────────────────────────
    // macOS defaults RLIMIT_NOFILE soft to 256; a process hosting many PTY
    // tabs (each = master+slave fds, plus git subprocesses) hits EMFILE fast,
    // surfacing as portable-pty spawn failures. Raise the soft limit to
    // min(hard, 1<<20) once at startup — never exceeds the hard limit, best-
    // effort (errors ignored). Windows has no equivalent.
    #[cfg(unix)]
    unsafe {
        let mut rlim: libc::rlimit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut rlim) == 0 {
            let target = std::cmp::min(rlim.rlim_max, (1 << 20) as libc::rlim_t);
            if target > rlim.rlim_cur {
                let _ = libc::setrlimit(
                    libc::RLIMIT_NOFILE,
                    &libc::rlimit { rlim_cur: target, rlim_max: rlim.rlim_max },
                );
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

    // ── PATH inheritance fix (Windows) ──────────────────────────────────
    // Windows has no login-shell rc to source, but the same class of problem
    // exists as on macOS/Linux: a GUI-launched process can inherit a PATH
    // that is MISSING the per-user dirs where CLI agents install — npm global
    // (%APPDATA%\npm), pnpm, bun, cargo, AND scoop shims, volta, nvm-windows,
    // mise, the Anthropic native installer in ~/.local/bin, … The old fix
    // hardcoded 5 dirs — a guessing treadmill (every new install method needed
    // another entry, and we still missed scoop/volta/nvm). The registry is
    // the source of truth a fresh `cmd.exe` sees, so we read HKCU + HKLM
    // `Path` (auto-expanded) and merge those dirs into the process PATH.
    // Append-only + existence-gated: it can only make more tools resolvable,
    // never removes or shadows anything — a harmless no-op when PATH is
    // already complete. GUI launch only — hook subcommands exit far above.
    #[cfg(target_os = "windows")]
    {
        windows_path::hydrate();
    }

    // CLI subcommand dispatch — short-circuit GUI launch when invoked
    // with a known subcommand. This is opt-in; double-clicking the
    // executable still gets the GUI (no argv).
    let args: Vec<String> = std::env::args().collect();
    // `launch --tool <id> [--cwd <dir>]` doesn't short-circuit: the GUI
    // starts as usual, but the request rides along and the frontend drains
    // it on mount (see launch.rs for the cold/warm delivery paths).
    let pending_launch = launch::parse_launch_args(&args);
    if let Some(sub) = args.get(1) {
        match sub.as_str() {
            // Forward-compatible: unknown subcommands fall through
            // to the GUI rather than failing, so users who type
            // garbage still get a working app.
            _ => {}
        }
    }

    // Default: launch the GUI. Each tab picks its own CWD at
    // launch time — no initial directory needed.
    server::start_ui(pending_launch)
}

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
