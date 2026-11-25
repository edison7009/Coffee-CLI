// terminal.rs — Tier Terminal PTY backend
// Uses portable-pty (WezTerm's cross-platform PTY library) for reliable
// ConPTY support on Windows and native PTY on Unix.
// Streams raw PTY bytes to xterm.js verbatim; only OSC 7 (cwd change) is
// extracted server-side for the workspace tree.

use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

/// Set by the frontend on `document.visibilitychange`. When true, every
/// per-session worker thread (ticker, emitter) widens its sleep / coalesce
/// window so a Coffee CLI window left in the background drops to near-zero
/// CPU instead of paying full 8ms / 500ms cadence forever. Apple Silicon
/// laptops in particular treat this as the difference between fan-on and
/// idle thermal envelope.
pub static BACKGROUND_MODE: AtomicBool = AtomicBool::new(false);

// ── Windows: kill-on-close Job Object for PTY children ─────────────────────
// Every PTY child (cmd.exe → claude.exe → node.exe) gets assigned to a
// process-lifetime Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
// When Coffee CLI's process dies — clean exit, crash, or task-manager kill —
// the kernel closes the job handle and terminates every descendant in the
// job. Without this, orphan `claude.exe` survived past Coffee CLI shutdown
// and held the session lock under `~/.claude/`, so the next launch's Claude
// Code tab failed to start (issue #28).
#[cfg(target_os = "windows")]
pub(crate) mod windows_job {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // Win32 HANDLE is a raw pointer wrapper; not Send/Sync by default. The
    // Job Object handle is a kernel handle, safe to use from any thread —
    // the OS owns serialization. Wrap it so OnceLock can hold it.
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

    fn get_or_create_job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let job = match CreateJobObjectW(None, None) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[Tier Terminal] CreateJobObjectW failed: {:?}", e);
                    return None;
                }
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let info_ptr = &info as *const _ as *const _;
            let info_size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            if let Err(e) =
                SetInformationJobObject(job, JobObjectExtendedLimitInformation, info_ptr, info_size)
            {
                eprintln!("[Tier Terminal] SetInformationJobObject failed: {:?}", e);
                let _ = CloseHandle(job);
                return None;
            }
            Some(JobHandle(job))
        })
        .as_ref()
        .map(|h| h.0)
    }

    pub fn assign_pid(pid: u32) {
        let Some(job) = get_or_create_job() else {
            return;
        };
        unsafe {
            let proc = match OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("[Tier Terminal] OpenProcess(pid={}) failed: {:?}", pid, e);
                    return;
                }
            };
            if let Err(e) = AssignProcessToJobObject(job, proc) {
                // Nested-job conflicts can fail here on older Windows; not
                // fatal — graceful kill_tx path in the exit handler still
                // covers normal shutdowns.
                eprintln!(
                    "[Tier Terminal] AssignProcessToJobObject(pid={}) failed: {:?}",
                    pid, e
                );
            }
            let _ = CloseHandle(proc);
        }
    }
}

/// Extract the path from an OSC 7 cwd notification if present in the chunk.
/// OSC 7 format: ESC ] 7 ; file://<host>/<path> (BEL or ESC \)
/// Returns the percent-decoded `<path>` portion (with leading `/`), or None.
fn extract_osc7_cwd(data: &[u8]) -> Option<String> {
    let prefix = b"\x1b]7;file://";
    let start = data.windows(prefix.len()).position(|w| w == prefix)? + prefix.len();
    let rest = &data[start..];
    let end = rest.iter().position(|&b| b == 0x07 || b == 0x1b)?;
    let raw = std::str::from_utf8(&rest[..end]).ok()?;
    // Skip hostname: keep everything from the first `/` onward.
    let path_start = raw.find('/')?;
    let path = &raw[path_start..];
    // Percent-decode (basic %XX handling)
    let bytes = path.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(s) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(b) = u8::from_str_radix(s, 16) {
                    decoded.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(decoded).ok()
}


// ─── Public Types ─────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct TerminalOutput {
    pub id: String,
    pub data: String,
}

#[derive(Serialize, Clone)]
pub struct TerminalStatus {
    pub id: String,
    pub running: bool,
    pub exit_code: Option<i32>,
}

/// Fired when the spawned child process terminates (detected via child.wait()
/// in a dedicated watcher thread). This is the explicit "process is dead"
/// signal the frontend needs to render a recovery overlay, instead of the
/// terminal looking frozen because the reader is still blocked waiting for
/// bytes that will never come (Windows ConPTY / intermediate cmd.exe keeps
/// the PTY slave open past the child's actual death).
#[derive(Serialize, Clone)]
pub struct TerminalExitEvent {
    pub id: String,
    pub exit_code: i32,
}

// ─── Shared Session State ─────────────────────────────────

pub struct TerminalSession {
    /// Cloneable Arc for write operations — lets callers release the session map
    /// lock before doing PTY I/O, preventing multi-tab starvation.
    pub writer_lock: Arc<Mutex<Box<dyn Write + Send>>>,
    pub kill_tx: std::sync::mpsc::Sender<()>,
    /// The tool name (e.g. "claude", "qwen") for this session
    #[allow(dead_code)]
    pub tool_name: Option<String>,
    /// Captured session token for resume (e.g. Claude Session ID)
    pub session_token: Mutex<Option<String>>,
    /// Hold PTY master alive — dropping this kills the terminal pipe
    pub(crate) _master: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>>,
    /// True when this session's terminal is actually on-screen — its tab is
    /// the active center-panel tab, or (for split panes) its parent tab is
    /// active. Flipped by `set_session_active`, called from a frontend
    /// IntersectionObserver on the terminal's DOM element. This is narrower
    /// than `BACKGROUND_MODE`: a tab can be backgrounded this way while the
    /// Coffee CLI window itself is still focused and foreground. Defaults
    /// FALSE so a freshly-spawned session throttles to the 200ms background
    /// cadence until the frontend's first visibility report lands — prevents
    /// a new tab (especially one opened in the background) from blasting
    /// ~125 emits/sec at the 8ms foreground cadence before visibility is
    /// confirmed. The observer fires within a frame or two for a genuinely
    /// visible tab, so the visible-tab throttled window is tiny.
    pub is_tab_active: Arc<AtomicBool>,
}

pub type SharedSession = Arc<Mutex<std::collections::HashMap<String, TerminalSession>>>;

#[derive(Serialize, Clone)]
pub(crate) struct SessionTokenPayload {
    pub id: String,
    pub token: String,
}


// ─── Spawn ────────────────────────────────────────────────

pub(crate) fn shell_working_directory(path: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    let path = dunce::simplified(path);
    #[cfg(windows)]
    anyhow::ensure!(
        !path.as_os_str().as_encoded_bytes().starts_with(b"\\\\"),
        "Windows CMD cannot use this UNC or extended working directory; choose a local drive path"
    );
    Ok(path.to_path_buf())
}

fn initial_pty_size(cols: u16, rows: u16) -> anyhow::Result<portable_pty::PtySize> {
    anyhow::ensure!(cols > 0 && rows > 0, "PTY size must be non-zero");
    Ok(portable_pty::PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

/// Spawns `program` with `args` inside a PTY via portable-pty.
/// On Windows this uses ConPTY, on Unix it uses native PTYs.
///
/// `extra_env` is applied AFTER parent-env inheritance and the standard
/// AI-CLI env hints (TERM/FORCE_COLOR/NODE_OPTIONS/…) so its entries win.
/// Used for per-pane config injection where the env var must differ across
/// concurrent panes (e.g. `OPENCODE_CONFIG` points at a per-pane JSON file).
/// `std::env::set_var` would race across panes; this is the race-free path.
pub fn spawn(
    app: AppHandle,
    session_id: String,
    session: SharedSession,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    _lang: String,
    initial_cols: u16,
    initial_rows: u16,
    tool_name: Option<String>,
    // Where the tool prints its native session id, for resume (the caller's preset knows it).
    session_id_pattern: Option<&str>,
    theme_mode: Option<String>,
    locale: Option<String>,
    extra_env: Vec<(String, String)>,
) -> anyhow::Result<()> {
    use portable_pty::{native_pty_system, CommandBuilder};

    let initial_size = initial_pty_size(initial_cols, initial_rows)?;
    eprintln!("[Tier Terminal] Spawning '{}' args={:?}", program, log_args(&args));
    eprintln!(
        "[Tier Terminal] Size: {}x{}",
        initial_size.cols, initial_size.rows
    );

    // ── Build command ──────────────────────────────────────────────────────
    // On Windows: npm-installed tools are .cmd scripts, not real .exe files.
    // CreateProcessW cannot run .cmd → always go through cmd.exe /c.
    //
    // Resolve cmd.exe explicitly instead of relying on PATH lookup. When a
    // user's PATH is missing System32 (corrupted profile, AV interference,
    // managed devices), bare "cmd.exe" returns os error 2 and the whole app
    // stops working — see issue #30. %COMSPEC% is set on every Windows install
    // and matches what WezTerm / VS Code / Hyper do internally.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let comspec = std::env::var("COMSPEC")
            .ok()
            .filter(|p| std::path::Path::new(p).exists())
            .or_else(|| {
                let sysroot =
                    std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
                let p = format!(r"{}\System32\cmd.exe", sysroot);
                std::path::Path::new(&p).exists().then_some(p)
            })
            .unwrap_or_else(|| "cmd.exe".to_string());
        let mut c = CommandBuilder::new(&comspec);
        c.arg("/c");
        c.arg(&program);
        for a in &args {
            c.arg(a);
        }
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let resolved = resolve_program(&program);
        let mut c = CommandBuilder::new(&resolved);
        for a in &args {
            c.arg(a);
        }
        c
    };
    // Inherit full parent environment
    for (key, val) in std::env::vars() {
        cmd.env(key, val);
    }

    // Refresh only this child: IDE-private PATH entries must not shadow installed CLIs.
    #[cfg(target_os = "windows")]
    cmd.env("PATH", crate::windows_path::terminal_path());

    // Terminal capability: all tools get xterm-256color for rich rendering.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Pass theme mode to Coffee Code so it knows dark vs light at startup
    if let Some(ref mode) = theme_mode {
        cmd.env("COFFEE_CODE_THEME_MODE", mode);
    }

    // Pass locale to tool for i18n
    if let Some(ref loc) = locale {
        cmd.env("COFFEE_CODE_LOCALE", loc);
    }

    // Status integrations are read-only. Never inject Coffee hook routing
    // variables into third-party CLIs; startup removes artifacts from older
    // releases and the PTY/title parsers below drive the tab state directly.

    // ── Linux/macOS: Enable OSC 7 CWD reporting ────────────────────────────
    // Unlike Windows PowerShell which natively emits OSC 7, bash/zsh on Linux
    // do NOT send CWD change notifications by default. Without this, the left
    // panel workspace tree cannot track directory changes after startup.
    // We inject PROMPT_COMMAND (bash) to emit OSC 7 on every prompt cycle.
    // Zsh uses precmd_functions instead, configured via ZDOTDIR or direct hook.
    #[cfg(not(target_os = "windows"))]
    {
        // For bash: PROMPT_COMMAND runs before each prompt display
        // Append (don't overwrite) to preserve user's existing PROMPT_COMMAND
        let osc7_cmd = r#"printf "\033]7;file://%s%s\033\\" "$(hostname)" "$(pwd)""#;
        let existing_prompt_cmd = std::env::var("PROMPT_COMMAND").unwrap_or_default();
        let new_prompt_cmd = if existing_prompt_cmd.is_empty() {
            osc7_cmd.to_string()
        } else {
            format!("{};{}", existing_prompt_cmd, osc7_cmd)
        };
        cmd.env("PROMPT_COMMAND", &new_prompt_cmd);
    }

    // Set working directory
    if let Some(dir) = &cwd {
        let path = std::path::Path::new(dir);
        if path.exists() && path.is_dir() {
            eprintln!("[Tier Terminal] CWD: {}", dir);
            cmd.cwd(dir);
            cmd.env("COFFEE_MODE_CWD", dir);
        }
    }

    // ── Per-spawn env overrides ────────────────────────────────────────────
    // Applied last so they win over inherited parent env, the AI-CLI hint
    // block, theme/locale, and OSC 7 PROMPT_COMMAND. The race-free path for
    // per-pane config when multiple panes spawn concurrently — each gets its
    // own env block (e.g. OPENCODE_CONFIG=<unique-pane-temp-path>) without
    // mutating Coffee CLI's own process-wide env.
    for (k, v) in &extra_env {
        cmd.env(k, v);
    }
    // ── Open PTY pair ──────────────────────────────────────────────────────
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(initial_size)?;

    // Spawn command into the PTY slave.
    // `child` is owned by a dedicated watcher thread (see below) which blocks
    // on child.wait() to detect process death — Coffee CLI's long-standing
    // "terminal looks frozen after a while" bug was caused by not monitoring
    // the child at all; if the child crashed but the PTY slave stayed open
    // (via an intermediate cmd.exe on Windows, or grandchild process on any
    // OS), reader.read() would block forever and the UI had no way to know.
    let child = pair.slave.spawn_command(cmd)?;
    eprintln!("[Tier Terminal] PTY process spawned OK (portable-pty)");

    // Bind the new child to the kill-on-close Job Object so it can't outlive
    // Coffee CLI's process. Belt-and-suspenders with the ExitRequested
    // handler in server.rs: the handler does graceful kill_tx on clean
    // shutdown; the Job Object catches crashes / force-quits / OOMs.
    #[cfg(target_os = "windows")]
    if let Some(pid) = child.process_id() {
        windows_job::assign_pid(pid);
    }

    // Get reader/writer from the PTY master
    let mut reader = pair.master.try_clone_reader()?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> =
        Arc::new(Mutex::new(pair.master.take_writer()?));

    // Drop the slave side — only the master is needed from here
    drop(pair.slave);

    // ── CRITICAL: Keep master alive in Arc ─────────────────────────────────
    // The master must stay alive as long as the session exists.
    // If the master is dropped, the PTY pipe closes and the reader gets EOF.
    // Previous bug: master was held in a wait thread that could drop it early
    // when cmd.exe (the direct child) exits — even if the real tool (e.g. node.js)
    // is still running as a grandchild process.
    let master_arc: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>> =
        Arc::new(Mutex::new(Some(pair.master)));

    let (kill_tx, kill_rx) = std::sync::mpsc::channel::<()>();

    // ── Kill thread: drop PTY master on signal → reader gets EOF → cleanup runs
    let master_for_kill = master_arc.clone();
    std::thread::spawn(move || {
        let _ = kill_rx.recv(); // block until kill_tx.send(()) or sender dropped
        if let Ok(mut guard) = master_for_kill.lock() {
            *guard = None; // drop PTY master → pipe closes
        }
    });

    // ── Child exit watcher ─────────────────────────────────────────────────
    // Coffee CLI's primary "terminal locks up after a while" failure mode:
    // the child process (claude / node.js / etc.) dies, but an intermediate
    // cmd.exe parent or grandchild process keeps the PTY slave open, so the
    // reader thread never sees EOF — it blocks on read() forever and the
    // frontend sees a frozen terminal with no explanation.
    //
    // Fix: own the Child handle in a dedicated thread that blocks on
    // child.wait(). When wait() returns, we KNOW the process is dead.
    // Actions on exit:
    //   1. Emit "tier-terminal-exit" with the real exit code — the frontend
    //      shows a "process exited — click to restart" overlay instead of a
    //      frozen-looking terminal.
    //   2. Force-drop the PTY master → reader thread gets EOF → normal
    //      cleanup path runs (ticker stops, session removed from map,
    //      tier-terminal-status fires).
    //
    // This is the SOLE new lifecycle signal; the existing reader-EOF cleanup
    // path remains the one place that removes the session from the map.
    let master_for_watcher = master_arc.clone();
    let app_for_watcher = app.clone();
    let sid_for_watcher = session_id.clone();
    std::thread::spawn(move || {
        let mut child = child;
        let exit_code = match child.wait() {
            Ok(status) => {
                let code = status.exit_code() as i32;
                eprintln!("[Tier Terminal] Child exited with code {}", code);
                code
            }
            Err(e) => {
                eprintln!("[Tier Terminal] child.wait() failed: {}", e);
                -1
            }
        };
        let _ = app_for_watcher.emit(
            "tier-terminal-exit",
            TerminalExitEvent {
                id: sid_for_watcher.clone(),
                exit_code,
            },
        );
        // Force PTY master drop → reader thread gets EOF → cleanup path runs.
        // Safe even if already dropped by the kill thread (guard just goes
        // from None to None).
        if let Ok(mut guard) = master_for_watcher.lock() {
            *guard = None;
        }
    });

    // Defaults INACTIVE: a freshly-spawned tab emits at the 200ms background
    // cadence until the frontend's IntersectionObserver confirms it's visible
    // (set_session_active(true)). Prevents a new tab from blasting ~125
    // emits/sec at the 8ms foreground cadence before visibility is confirmed —
    // the observer fires within a frame or two for a genuinely visible tab, so
    // the visible-tab window is tiny, but a tab opened in the background stays
    // safely throttled instead of defaulting into the fg cadence. See
    // `TerminalSession::is_tab_active`.
    let is_tab_active: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));

    // Store session with shared writer reference and master kept alive.
    {
        let writer_clone = writer.clone();
        let master_clone = master_arc.clone();
        let mut map = session.lock().unwrap();
        map.insert(
            session_id.clone(),
            TerminalSession {
                writer_lock: writer_clone,
                kill_tx,
                tool_name: tool_name.clone(),
                session_token: Mutex::new(None),
                _master: master_clone,
                is_tab_active: is_tab_active.clone(),
            },
        );
    }

    // Build session ID regex if this tool supports resume
    let session_id_regex = session_id_pattern.and_then(|pat| regex::Regex::new(pat).ok());

    // ── Handles shared with the emitter thread (below) ───────────────────────
    // The emitter is the sole lifecycle manager now; these clones are consumed
    // by its `move` closure.
    let session_for_token = session.clone();
    let session_for_cleanup = session.clone();
    let sid_cleanup = session_id.clone();

    // ── PTY reader + emitter (zellij-inspired split) ─────────────────────────
    //
    // Why split what used to be a single thread:
    //
    // The former design read 4 KB at a time, then on the same thread did ANSI
    // strip + ring-buffer push + synchronous `app.emit()`
    // before looping back to `reader.read()`. When the frontend stalled (slow
    // xterm.js write, WebView IPC backlog), emit latency reflected directly
    // into the PTY read cadence — the child process's write-end of the PTY
    // would fill, blocking it in its own `write()` syscall. That is the
    // structural cause of "root cause #2" (emit/channel backpressure) logged
    // in CLAUDE memory.
    //
    // Zellij's `terminal_bytes.rs` decouples read from render via an async
    // channel and explicitly comments on coalescing render under back-pressure.
    // We mirror the idea with two std threads and a coalescing window:
    //
    //   Reader   : reads up to 64 KB (matches zellij) → mpsc::send(Vec<u8>).
    //              Zero mutexes on the hot loop. EOF/error drops tx, which
    //              signals the emitter to drain + clean up.
    //
    //   Emitter  : pulls from the channel, accumulates up to an ~8 ms window
    //              (imperceptible to users, collapses AI-CLI token bursts),
    //              then runs ANSI strip + OSC 7 detect +
    //              session-token capture + IPC emit + ring-buffer push
    //              ONCE per window. Single lock per batch, single IPC per
    //              batch.
    //
    // Cleanup (ticker stop + status emit + session map removal) is the
    // emitter's responsibility, so the order is deterministic: final flush
    // → alive flag off → idle status → map remove → final status event.

    let (bytes_tx, bytes_rx) = std::sync::mpsc::channel::<Vec<u8>>();

    // ── Reader thread ───────────────────────────────────────────────────────
    let reader_log_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536]; // 64 KB — matches zellij; 16× the former 4 KB.
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    eprintln!("[Tier Terminal] PTY reader: EOF ({})", reader_log_id);
                    break;
                }
                Ok(n) => {
                    // Forward raw bytes only — all processing lives in the emitter.
                    if bytes_tx.send(buf[..n].to_vec()).is_err() {
                        // Emitter has already exited; nothing left to do.
                        break;
                    }
                }
                Err(e) => {
                    let msg = format!("{}", e);
                    if !msg.contains("BrokenPipe")
                        && !msg.contains("broken pipe")
                        && !msg.contains("管道")
                    {
                        eprintln!("[Tier Terminal] PTY reader error: {}", e);
                    }
                    break;
                }
            }
        }
        // Dropping bytes_tx here signals the emitter's recv loop to drain and
        // then transition to cleanup.
    });

    // ── Emitter thread ──────────────────────────────────────────────────────
    let app_out = app.clone();
    let session_id_out = session_id.clone();
    let is_active_for_emitter = is_tab_active.clone();

    std::thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::Duration as StdDuration;

        // 8 ms is below human-perceptible latency (~16 ms frame) but large
        // enough to collapse a typical AI-CLI token-stream burst (hundreds of
        // small writes) into a single emit. Widen to 200 ms whenever nobody
        // can see this output right now — either the whole Coffee CLI window
        // is hidden (BACKGROUND_MODE), or this session's own tab isn't the
        // one on screen (is_tab_active, e.g. a background tab while the
        // window itself stays focused). Both cases stop paying full 8 ms
        // parse+emit cadence for a stream nobody is watching.
        const FLUSH_INTERVAL_FG: StdDuration = StdDuration::from_millis(8);
        const FLUSH_INTERVAL_BG: StdDuration = StdDuration::from_millis(200);
        let flush_interval = || {
            if BACKGROUND_MODE.load(Ordering::Relaxed)
                || !is_active_for_emitter.load(Ordering::Relaxed)
            {
                FLUSH_INTERVAL_BG
            } else {
                FLUSH_INTERVAL_FG
            }
        };
        // Hard ceiling on the accumulation buffer so that a wedged frontend
        // cannot drive unbounded memory growth in this thread.
        const MAX_PENDING: usize = 1024 * 1024; // 1 MB

        #[derive(Serialize, Clone)]
        struct CwdPayload {
            id: String,
            cwd: String,
        }

        let ansi_re =
            regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.").unwrap();

        let mut pending: Vec<u8> = Vec::with_capacity(131072);
        let mut token_captured = false;
        let mut last_flush = Instant::now();

        loop {
            let interval = flush_interval();
            let wait = interval
                .checked_sub(last_flush.elapsed())
                .unwrap_or(StdDuration::ZERO);

            let recv_result = bytes_rx.recv_timeout(wait);
            let disconnected = matches!(recv_result, Err(RecvTimeoutError::Disconnected));

            if let Ok(chunk) = recv_result {
                pending.extend_from_slice(&chunk);
            }

            // Idle reset: with pending empty, last_flush never advances, so
            // wait decays to 0 and recv_timeout(0) becomes a non-blocking
            // try_recv — pinning a CPU core per tab. Reset the clock here so
            // the next recv_timeout blocks for a full interval.
            if pending.is_empty() {
                last_flush = Instant::now();
            }

            let should_flush = !pending.is_empty()
                && (disconnected
                    || pending.len() >= MAX_PENDING
                    || last_flush.elapsed() >= interval);

            if should_flush {
                // PTY reads don't respect UTF-8 char boundaries: a 3-byte
                // CJK char ('中' E4 B8 AD), a 3-byte box-draw char ('─' E2 94 80),
                // or a 4-byte emoji can be split across two read() calls. If
                // the flush boundary lands inside a multi-byte sequence,
                // from_utf8_lossy turns the trailing fragment into U+FFFD (�)
                // and pending.clear() then drops the bytes the next chunk's
                // continuation needs — both halves render as 乱码.
                //
                // Fix: emit only bytes through the last *complete* UTF-8 char;
                // carry any incomplete trailing sequence forward to the next
                // flush. Genuine mid-buffer invalid bytes (error_len = Some)
                // still fall through to lossy conversion as before.
                let valid_end = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) => match e.error_len() {
                        // Incomplete trailing sequence — defer the tail.
                        None => e.valid_up_to(),
                        // Genuine garbage mid-stream — let lossy handle it.
                        Some(_) => pending.len(),
                    },
                };

                // OSC 7 runs on raw bytes before UTF-8 lossy conversion.
                // Use the validated prefix only — OSC sequences are ASCII so
                // they can never legitimately span past valid_end.
                let cwd_change = extract_osc7_cwd(&pending[..valid_end]);

                let data = String::from_utf8_lossy(&pending[..valid_end]).to_string();

                // Session token capture (once per session, for `--resume`).
                if !token_captured {
                    if let Some(ref re) = session_id_regex {
                        let stripped = ansi_re.replace_all(&data, "");
                        if let Some(caps) = re.captures(&stripped) {
                            if let Some(token) = caps.get(1) {
                                let token_str = token.as_str().to_string();
                                eprintln!(
                                    "[Tier Terminal] Captured session token: {}...",
                                    &token_str[..token_str.len().min(12)]
                                );
                                if let Ok(map) = session_for_token.lock() {
                                    if let Some(sess) = map.get(&session_id_out) {
                                        if let Ok(mut t) = sess.session_token.lock() {
                                            *t = Some(token_str.clone());
                                        }
                                    }
                                }
                                token_captured = true;
                                let _ = app_out.emit("tier-terminal-token", SessionTokenPayload {
                                    id: session_id_out.clone(), token: token_str,
                                });
                            }
                        }
                    }
                }

                // Single coalesced IPC emit — replaces what used to be
                // N × small emits per burst.
                let _ = app_out.emit(
                    "tier-terminal-output",
                    TerminalOutput {
                        id: session_id_out.clone(),
                        data,
                    },
                );

                if let Some(new_cwd) = cwd_change {
                    eprintln!("[Tier Terminal] CWD changed: {}", new_cwd);
                    let _ = app_out.emit(
                        "tier-terminal-cwd",
                        CwdPayload {
                            id: session_id_out.clone(),
                            cwd: new_cwd,
                        },
                    );
                }

                // Drain only what we emitted; preserve any deferred trailing
                // bytes for the next flush so split multi-byte chars resolve
                // correctly when the rest arrives.
                pending.drain(..valid_end);
                last_flush = Instant::now();
            }

            if disconnected {
                break;
            }
        }

        // ── Cleanup (single authoritative path) ─────────────────────────────
        eprintln!(
            "[Tier Terminal] Emitter: cleaning up session {}",
            session_id_out
        );

        // Drop the master Arc ref by removing the session from the map.
        {
            let mut map = session_for_cleanup.lock().unwrap();
            map.remove(&sid_cleanup);
        }

        let _ = app_out.emit(
            "tier-terminal-status",
            TerminalStatus {
                id: session_id_out,
                running: false,
                exit_code: Some(0),
            },
        );
    });

    Ok(())
}

// ─── Path resolution (Unix only) ─────────────────────────────────────────────

/// Resolve a program name to a full path.
#[cfg(not(target_os = "windows"))]
fn resolve_program(name: &str) -> String {
    if let Ok(output) = std::process::Command::new("which").arg(name).output() {
        if output.status.success() {
            let resolved = String::from_utf8_lossy(&output.stdout);
            if let Some(first_line) = resolved.lines().next() {
                let p = first_line.trim();
                if !p.is_empty() {
                    return p.to_string();
                }
            }
        }
    }
    name.to_string()
}

// ─── Unit Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn shell_directories_use_drive_paths_and_reject_cmd_fallback() {
        for path in [r"E:\tmp", r"\\?\E:\tmp", r"\\?\E:\Coffee 中文项目"] {
            let compatible = shell_working_directory(std::path::Path::new(path)).unwrap();
            assert!(!compatible.as_os_str().as_encoded_bytes().starts_with(b"\\\\"));
            assert!(compatible.is_absolute());
        }
        for path in [r"\\server\share\project", r"\\?\UNC\server\share\project", r"\\?\E:\project."] {
            assert!(shell_working_directory(std::path::Path::new(path)).is_err());
        }
    }

    #[test]
    fn initial_pty_size_preserves_the_frontend_grid() {
        let size = initial_pty_size(10, 4).unwrap();
        assert_eq!(size.cols, 10);
        assert_eq!(size.rows, 4);
        assert!(initial_pty_size(0, 4).is_err());
        assert!(initial_pty_size(10, 0).is_err());
    }

    // ── extract_osc7_cwd ──────────────────────────────────────────────────────

    /// Helper: wrap a path string in OSC 7 with BEL terminator
    fn osc7_bel(host: &str, path: &str) -> Vec<u8> {
        format!("\x1b]7;file://{}{}\x07", host, path).into_bytes()
    }

    /// Helper: wrap a path string in OSC 7 with ST (ESC \) terminator
    fn osc7_st(host: &str, path: &str) -> Vec<u8> {
        format!("\x1b]7;file://{}{}\x1b\\", host, path).into_bytes()
    }

    #[test]
    fn osc7_basic_with_hostname() {
        let data = osc7_bel("myhost", "/home/user/projects");
        assert_eq!(
            extract_osc7_cwd(&data),
            Some("/home/user/projects".to_string())
        );
    }

    #[test]
    fn osc7_no_hostname() {
        // file:///path — hostname omitted, first `/` is the path start
        let data = osc7_bel("", "/tmp/workspace");
        assert_eq!(extract_osc7_cwd(&data), Some("/tmp/workspace".to_string()));
    }

    #[test]
    fn osc7_st_terminator() {
        let data = osc7_st("host", "/var/log");
        assert_eq!(extract_osc7_cwd(&data), Some("/var/log".to_string()));
    }

    #[test]
    fn osc7_percent_encoded_space() {
        let data = osc7_bel("host", "/home/user/my%20project");
        assert_eq!(
            extract_osc7_cwd(&data),
            Some("/home/user/my project".to_string())
        );
    }

    #[test]
    fn osc7_percent_encoded_chinese() {
        // "咖啡" percent-encoded UTF-8
        let data = osc7_bel("host", "/%E5%92%96%E5%95%A1");
        assert_eq!(extract_osc7_cwd(&data), Some("/咖啡".to_string()));
    }

    #[test]
    fn osc7_embedded_in_larger_buffer() {
        let mut data = b"some output before\r\n".to_vec();
        data.extend(osc7_bel("host", "/some/dir"));
        data.extend(b"\r\nmore output after");
        assert_eq!(extract_osc7_cwd(&data), Some("/some/dir".to_string()));
    }

    #[test]
    fn osc7_absent_returns_none() {
        let data = b"ordinary terminal output\r\n$ ls";
        assert_eq!(extract_osc7_cwd(data), None);
    }

    #[test]
    fn osc7_windows_style_path() {
        // PowerShell emits file:///C:/Users/foo
        let data = osc7_bel("", "/C:/Users/foo/project");
        assert_eq!(
            extract_osc7_cwd(&data),
            Some("/C:/Users/foo/project".to_string())
        );
    }
}

/// Arguments as the spawn log shows them: Pro hides its coordination helpers' tokens.
fn log_args(args: &[String]) -> Vec<String> {
    #[cfg(feature = "pro")]
    return crate::orchestration::log_args(args);
    #[cfg(not(feature = "pro"))]
    args.to_vec()
}
