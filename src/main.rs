#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod terminal;
mod claude_session;
mod codex_session;
mod dsh_session;
mod session_directory;
mod opencode_island;
mod server;
mod agent;
mod agent_modes;
mod agent_projects;
mod agent_experts;
mod agent_capabilities;
mod agent_graphify;
mod agent_approvals;
mod agent_sentinel;
mod agent_memory;
mod agent_context;
mod agent_memory_capture;
mod agent_output;
mod agent_workspace;
mod channels;
mod hook_installer;
mod fonts;
mod fs_watcher;
mod launch;
mod tool_config;
mod cli_updates;
mod tool_memory;
mod tool_skills;
mod tool_control;
mod computer_control;
mod orchestration;
mod tools;
mod usage_stats;
mod usage_quota;
mod git;
mod git_project_status;
mod session_git_context;
mod shell_probe;
#[cfg(target_os = "linux")]
mod linux_blur;
#[cfg(target_os = "windows")]
mod windows_path;

use anyhow::Result;

fn main() -> Result<()> {
    // These helpers run inside a visible Coffee Terminal, before single-instance GUI routing.
    let helper_args: Vec<String> = std::env::args().collect();
    if matches!(helper_args.get(1).map(String::as_str), Some("__team_mcp" | "__team_worker")) {
        #[cfg(windows)]
        if helper_args[1] == "__team_worker" {
            use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
            let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
        }
        let result = (|| {
            let port = helper_args.get(2).and_then(|value| value.parse::<u16>().ok()).ok_or("Invalid local coordinator port")?;
            let token = helper_args.get(3).ok_or("Coordinator token missing")?;
            if helper_args[1] == "__team_mcp" { orchestration::mcp(port, token) }
            else { orchestration::worker_cli(port, token, &helper_args[4..]) }
        })();
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return Ok(());
    }
    if helper_args.get(1).map(String::as_str) == Some("__ui-control") {
        let result = match (helper_args.get(2), helper_args.get(3)) {
            (Some(kind), Some(tool)) => tool_control::serve(kind, tool),
            _ => Err("Expected capability and agent".into()),
        };
        if let Err(error) = result { eprintln!("{error}"); std::process::exit(1); }
        return Ok(());
    }
    if matches!(helper_args.get(1).map(String::as_str), Some("__capability-apply" | "__graphify-run")) {
        #[cfg(windows)]
        {
            use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
            let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
            windows_path::hydrate();
        }
        let result = match (helper_args.get(2), helper_args.get(3)) {
            (Some(root), Some(plan_id)) => {
                let root = std::path::Path::new(root);
                if helper_args[1] == "__capability-apply" {
                    tauri::async_runtime::block_on(agent_capabilities::apply_plan(root, plan_id))
                } else { agent_graphify::apply_build(root, plan_id) }
            }
            _ => Err("Expected helper data directory and plan ID".into()),
        };
        match result {
            Ok(value) => {
                println!("Coffee action result: {value}");
                let failed = value["exitCode"].as_i64().is_some_and(|code| code != 0)
                    || !matches!(value["state"].as_str(), Some("ready" | "verified" | "installed"));
                std::process::exit(if failed { 1 } else { 0 });
            }
            Err(error) => { eprintln!("Coffee action failed: {error}"); std::process::exit(1); }
        }
    }
    // ── Legacy hook compatibility (fast path) ────────────────────────────
    // Current builds install no hooks. Keep the historical subcommands as
    // silent exit-0 handlers so a stale config that startup could not rewrite
    // never launches the GUI or blocks its parent CLI.
    {
        let argv: Vec<String> = std::env::args().collect();
        if argv.get(1).map(|arg| arg.starts_with("__")).unwrap_or(false) {
            std::process::exit(0);
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

    // ── Login-shell environment inheritance (macOS / Linux) ─────────────
    // GUI apps on macOS / Linux launched from Dock / Finder / .desktop
    // entries get a minimal environment from launchd — they do NOT source
    // the user's interactive shell rc files. Two consequences we've hit:
    //   1. PATH is typically /usr/bin:/bin:/usr/sbin:/sbin, so tools
    //      installed via Homebrew, nvm, volta, asdf, npm-global, cargo,
    //      bun, ~/.local/bin, etc. are invisible to every Command::new()
    //      in the process. Symptom: tool-detection cards stay greyed out
    //      even though `claude` / `codex` / `agy` / `hermes` are clearly
    //      installed.
    //   2. Every OTHER variable exported in ~/.zshrc / ~/.bashrc is missing
    //      too — API keys (OPENAI_API_KEY / ANTHROPIC_API_KEY / KIMI_API_KEY),
    //      tool feature flags, proxy overrides. AI CLIs then behave
    //      differently inside Coffee CLI than in Terminal.app: Kimi Code's
    //      secondary-model experiment stayed disabled in PTY tabs even
    //      though the user had exported
    //      KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1 in ~/.zshrc — the
    //      toggle worked in Terminal.app (login shell) but not here.
    //
    // Fix: ask the user's login shell for its full environment ONCE at
    // startup via a single `-ilc` probe. The probe prints a sentinel
    // marker line, then `env`; rc-file echo (motd banners, `echo` in
    // .zshrc) lands BEFORE the marker and is discarded, so only the clean
    // `env` output is parsed. PATH replaces the process PATH (with a
    // sanity guard); every other variable is imported ONLY when absent
    // from our process env — the launchd/GUI env always wins, we just fill
    // gaps. PTY spawns inherit the process env (see the `std::env::vars()`
    // loop in terminal.rs), so one probe here fixes every downstream tab
    // and tool-detection `which`.
    //
    // We use `-ilc` (interactive + login) so both .zprofile/.bash_profile
    // AND .zshrc/.bashrc are sourced — matches what the user sees when
    // they open a fresh terminal window. `env` is an external command, so
    // fish works too (its exported PATH arrives colon-joined, no special
    // casing).
    #[cfg(not(target_os = "windows"))]
    unsafe {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        // Sentinel-delimited `env` so rc-file echo (motd banners, `echo`
        // in .zshrc) that lands AFTER the marker doesn't get folded into a
        // previous variable's value. The marker is printed first, then the
        // real `env` output; parse_env_dump slices at the marker.
        let probe = format!("printf '{}\\n'; env", ENV_DUMP_MARKER);
        if let Ok(out) = std::process::Command::new(&shell)
            .args(["-ilc", &probe])
            .output()
        {
            if out.status.success() {
                let dump = String::from_utf8_lossy(&out.stdout);
                // Shell bookkeeping vars that must NOT be imported into a
                // GUI process context (PATH is handled with its own guard).
                const SKIP: &[&str] = &["PATH", "PWD", "OLDPWD", "SHLVL", "_"];
                for (name, value) in parse_env_dump(&dump) {
                    if name == "PATH" {
                        // Sanity guard: a real PATH always contains ':'. If
                        // the shell rc errored out and we got garbage /
                        // empty, keep whatever PATH the OS gave us rather
                        // than nuking it.
                        let path = value.trim();
                        if !path.is_empty() && path.contains(':') {
                            std::env::set_var("PATH", path);
                        }
                        continue;
                    }
                    if SKIP.contains(&name.as_str()) {
                        continue;
                    }
                    // Gap-fill only: a variable the GUI process already has
                    // (from launchd, `launchctl setenv`, or a direct
                    // terminal launch) always wins over the rc value.
                    if std::env::var_os(&name).is_none() {
                        std::env::set_var(&name, &value);
                    }
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

/// Sentinel printed by the login-shell probe before `env` output. The probe
/// is `printf 'MARKER\n'; env`. rc-file echo that lands BEFORE the marker is
/// irrelevant; echo AFTER the marker can't be told apart from a multiline
/// value, so we keep the LAST marker and parse only what follows it.
#[cfg(not(target_os = "windows"))]
const ENV_DUMP_MARKER: &str = "__COFFEE_ENV_DUMP_MARKER__";

/// Parse raw probe stdout into (name, value) pairs.
///
/// The probe prints `ENV_DUMP_MARKER` then `env`. We slice from the LAST
/// marker so trailing rc echo can't extend the final variable's value
/// (the leading-echo case is handled by `is_entry_start` rejecting non-entry
/// lines before the first valid entry). If the marker is absent (shell
/// without `printf`), we fall back to parsing the whole dump.
#[cfg(not(target_os = "windows"))]
fn parse_env_dump(raw: &str) -> Vec<(String, String)> {
    let env_only = match raw.rfind(ENV_DUMP_MARKER) {
        Some(idx) => &raw[idx + ENV_DUMP_MARKER.len()..],
        None => raw,
    };
    parse_env_lines(env_only)
}

/// Parse marker-sliced `env` output into (name, value) pairs.
///
/// An entry line must match `^[A-Za-z_][A-Za-z0-9_]*=`; a line that does
/// NOT start a new entry is treated as a continuation of the previous
/// variable's value (multiline exports). Split at the first '=' so values
/// may themselves contain '=' (base64 blobs, `a=b` pairs).
#[cfg(not(target_os = "windows"))]
fn parse_env_lines(env_only: &str) -> Vec<(String, String)> {
    fn is_entry_start(line: &str) -> bool {
        let bytes = line.as_bytes();
        if bytes.is_empty() {
            return false;
        }
        let first = bytes[0];
        if !(first.is_ascii_alphabetic() || first == b'_') {
            return false;
        }
        let name_len = bytes
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
            .count();
        bytes.get(name_len) == Some(&b'=')
    }

    let mut out: Vec<(String, String)> = Vec::new();
    for line in env_only.lines() {
        if is_entry_start(line) {
            let eq = line.find('=').unwrap();
            out.push((line[..eq].to_string(), line[eq + 1..].to_string()));
        } else if let Some(last) = out.last_mut() {
            last.1.push('\n');
            last.1.push_str(line);
        }
    }
    out
}

#[cfg(all(test, not(target_os = "windows")))]
mod env_parse_tests {
    use super::{parse_env_dump, parse_env_lines, ENV_DUMP_MARKER};

    #[test]
    fn parses_simple_entries() {
        let dump = format!("{}\nPATH=/usr/bin:/bin\nKIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1\nHOME=/Users/x\n", ENV_DUMP_MARKER);
        assert_eq!(
            parse_env_dump(&dump),
            vec![
                ("PATH".to_string(), "/usr/bin:/bin".to_string()),
                ("KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL".to_string(), "1".to_string()),
                ("HOME".to_string(), "/Users/x".to_string()),
            ]
        );
    }

    #[test]
    fn value_may_contain_equals_sign() {
        let dump = format!("{}\nTOKEN=abc=def==\n", ENV_DUMP_MARKER);
        assert_eq!(
            parse_env_dump(&dump),
            vec![("TOKEN".to_string(), "abc=def==".to_string())]
        );
    }

    #[test]
    fn rc_echo_junk_before_first_entry_is_ignored() {
        // Pre-marker junk: parse_env_dump slices past the last marker.
        let dump = format!("Welcome to my shell!\n{}\nFOO=bar\n", ENV_DUMP_MARKER);
        assert_eq!(
            parse_env_dump(&dump),
            vec![("FOO".to_string(), "bar".to_string())]
        );
    }

    #[test]
    fn non_entry_lines_extend_multiline_values() {
        let dump = "MULTI=line1\nline2\nline3\nNEXT=ok\n";
        assert_eq!(
            parse_env_lines(dump),
            vec![
                ("MULTI".to_string(), "line1\nline2\nline3".to_string()),
                ("NEXT".to_string(), "ok".to_string()),
            ]
        );
    }

    #[test]
    fn rejects_malformed_entry_names() {
        // Leading digit / dash / percent (bash exported functions look
        // like `BASH_FUNC_foo%%=...`) must NOT start an entry; with no
        // prior entry to extend, those lines are dropped entirely.
        let dump = "1BAD=x\n-BAD=y\nBASH_FUNC_foo%%=() { :; }\nGOOD=1\n";
        assert_eq!(
            parse_env_lines(dump),
            vec![("GOOD".to_string(), "1".to_string())]
        );
    }

    #[test]
    fn garbage_without_prior_entry_is_dropped() {
        let dump = "garbage\n1BAD=x\nGOOD=1\n";
        assert_eq!(
            parse_env_lines(dump),
            vec![("GOOD".to_string(), "1".to_string())]
        );
    }

    #[test]
    fn rc_echo_looking_like_entry_before_marker_is_ignored() {
        // rc echo that itself looks like NAME=value must NOT be imported.
        // Without the marker, the original parser would wrongly import FAKE.
        let dump = format!("FAKE=notreal\n{}\nREAL=1\n", ENV_DUMP_MARKER);
        assert_eq!(
            parse_env_dump(&dump),
            vec![("REAL".to_string(), "1".to_string())]
        );
    }
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
