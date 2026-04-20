// terminal.rs — Tier Terminal PTY backend
// Uses portable-pty (WezTerm's cross-platform PTY library) for reliable
// ConPTY support on Windows and native PTY on Unix.
// Streams raw PTY bytes to xterm.js verbatim; only OSC 7 (cwd change) is
// extracted server-side for the workspace tree.

use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

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

/// Agent working status emitted to the frontend every second
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AgentStatusEvent {
    pub id: String,
    /// "working" | "idle" | "wait_input"
    pub status: String,
    /// Milliseconds since last PTY output
    pub silence_ms: u64,
    /// The specific AI tool backing this session
    pub tool: Option<String>,
}

// ─── Agent Presets for Session Resume ─────────────────────

pub struct AgentPreset {
    pub tool_name: &'static str,
    /// Program name for resume (e.g. "claude")
    pub resume_program: Option<&'static str>,
    /// Args inserted BEFORE the session token (e.g. &["--resume"])
    pub resume_args_before: &'static [&'static str],
    /// Args inserted AFTER the session token (e.g. &["--no-alt-screen"])
    pub resume_args_after: &'static [&'static str],
    /// Regex matched against PTY output to *capture* the session token.
    pub session_id_pattern: Option<&'static str>,
    /// Anchored regex that validates a standalone token string before use in
    /// a resume command.  Prevents flag injection (e.g. "id --skip-permissions").
    pub token_format: Option<&'static str>,
    /// Characters that indicate the agent is waiting for user input
    pub prompt_markers: &'static [&'static str],
}

pub const AGENT_PRESETS: &[AgentPreset] = &[
    AgentPreset {
        tool_name: "claude",
        resume_program: Some("claude"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: Some(r"Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"),
        token_format: Some(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
        prompt_markers: &["❯", "> "],
    },
    AgentPreset {
        tool_name: "gemini",
        resume_program: Some("gemini"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: Some(r"Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"),
        token_format: Some(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
        prompt_markers: &["✦"],
    },
    AgentPreset {
        tool_name: "hermes",
        resume_program: Some("hermes"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: Some(r"(\d{8}_\d{6}_[0-9a-f]{6})"),
        token_format: Some(r"^\d{8}_\d{6}_[0-9a-f]{6}$"),
        prompt_markers: &["❯"],
    },
];

pub fn find_preset(tool_name: &str) -> Option<&'static AgentPreset> {
    AGENT_PRESETS.iter().find(|p| p.tool_name == tool_name)
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
    /// Shared activity state for status detection.
    pub activity: Arc<Mutex<SessionActivity>>,
    /// Ring buffer of recent base64-encoded output chunks for history replay
    /// (detached windows call get_terminal_buffer to receive this)
    pub output_buffer: Arc<Mutex<Vec<String>>>,
}

pub type SharedSession = Arc<Mutex<std::collections::HashMap<String, TerminalSession>>>;

/// Per-session I/O tracking for status detection.
/// Shared between the reader thread, ticker thread, and the input handler
/// so that user-submitted-Enter can immediately signal "working".
pub struct SessionActivity {
    /// Set to false by the reader thread after EOF cleanup; ticker exits on next check.
    pub alive: bool,
    pub last_output_at: Instant,
    pub burst_start: Option<Instant>,
    pub last_status: String,
    /// Rolling buffer of recent stripped output for prompt marker detection
    pub recent_text: String,
    /// Tracks when user last pressed Enter → immediate "working" signal.
    /// Cleared when a prompt marker is detected (agent finished & is idle).
    pub user_submitted_at: Option<Instant>,
}


// ─── Spawn ────────────────────────────────────────────────

/// Spawns `program` with `args` inside a PTY via portable-pty.
/// On Windows this uses ConPTY, on Unix it uses native PTYs.
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
    theme_mode: Option<String>,
    locale: Option<String>,
) -> anyhow::Result<()> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};

    // Default to at least 120 cols so wide terminal output (help screens,
    // table output, etc.) doesn't wrap aggressively in small windows.
    let cols = initial_cols.max(120);
    let rows = initial_rows.max(24);
    eprintln!("[Tier Terminal] Spawning '{}' args={:?}", program, args);
    eprintln!("[Tier Terminal] Size: {}x{}", cols, rows);

    // ── Build command ──────────────────────────────────────────────────────
    // On Windows: npm-installed tools are .cmd scripts, not real .exe files.
    // CreateProcessW cannot run .cmd → always go through cmd.exe /c.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = CommandBuilder::new("cmd.exe");
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

    // Terminal capability: all tools get xterm-256color for rich rendering.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // ── AI CLI environment hints ───────────────────────────────────────────
    // These fixes target pain points Claude / Qwen / OpenCode / Hermes hit
    // when running as subprocesses: color stripped, Node heap too small, git
    // waiting for credential input, Unicode corruption, Homebrew tools not
    // in PATH, etc. Every env var is a no-op for tools that don't recognize
    // it — maximum benefit, zero risk for those that do.
    let is_ai_cli = matches!(
        tool_name.as_deref(),
        Some("claude") | Some("qwen") | Some("opencode") | Some("hermes") | Some("codex") | Some("gemini")
    );

    if is_ai_cli {
        // Cross-platform: most CLIs auto-disable ANSI color when they detect
        // a subprocess / non-TTY context. Force color so Claude's status
        // highlights, diff colors, error markers stay visible.
        cmd.env("FORCE_COLOR", "1");

        // Node-based agents (Claude Code, OpenCode CLI) default to ~1.7GB
        // heap. Large monorepos trip this during big refactors / tree scans;
        // 8GB is safe on any dev machine and ignored by non-Node tools.
        cmd.env("NODE_OPTIONS", "--max-old-space-size=8192");

        // Without this, `git push` / `git pull` / `git fetch` block waiting
        // for interactive credential input if no credential helper is
        // configured — PTY readers just see a silent hang. Fail loudly
        // instead and let the user see the real error.
        cmd.env("GIT_TERMINAL_PROMPT", "0");

        // ── Windows-specific fixes ────────────────────────────────────────
        #[cfg(target_os = "windows")]
        {
            // Git BASH SHELL hint — unlocks grep / sed / awk / find / ssh /
            // POSIX pipes when Claude etc. shell out. Only set if the user
            // hasn't defined SHELL themselves (respect explicit choice).
            if std::env::var_os("SHELL").is_none() {
                let candidates: [&str; 2] = [
                    r"C:\Program Files\Git\bin\bash.exe",
                    r"C:\Program Files (x86)\Git\bin\bash.exe",
                ];
                let found = candidates
                    .iter()
                    .find(|p| std::path::Path::new(p).exists())
                    .map(|p| p.to_string())
                    .or_else(|| {
                        std::env::var("LOCALAPPDATA").ok().and_then(|la| {
                            let p = format!(r"{}\Programs\Git\bin\bash.exe", la);
                            std::path::Path::new(&p).exists().then_some(p)
                        })
                    });
                if let Some(bash) = found {
                    eprintln!("[Tier Terminal] SHELL={} (Git BASH for {})", bash, program);
                    cmd.env("SHELL", &bash);
                }
            }

            // Windows Python on CJK locales defaults I/O to cp936 / GBK,
            // which corrupts UTF-8 files when Claude reads or writes them.
            // Force utf-8 regardless of system locale.
            cmd.env("PYTHONIOENCODING", "utf-8");

            // Set POSIX locale vars if the user hasn't — keeps shell tools
            // emitting UTF-8 output and avoids locale-specific sort orders.
            if std::env::var_os("LANG").is_none() {
                cmd.env("LANG", "en_US.UTF-8");
            }
            if std::env::var_os("LC_ALL").is_none() {
                cmd.env("LC_ALL", "en_US.UTF-8");
            }
        }

        // ── macOS-specific fixes ──────────────────────────────────────────
        // Tauri launches subprocesses from a GUI context that doesn't source
        // the user's interactive shell profile. If Claude / node / npm were
        // installed via Homebrew and Homebrew's bin dir is only exported in
        // ~/.zshrc, we won't find them. Prepend the common Homebrew bin
        // paths that exist so the spawned shell can resolve these tools.
        #[cfg(target_os = "macos")]
        {
            let brew_candidates = ["/opt/homebrew/bin", "/usr/local/bin"];
            let mut prepend = Vec::new();
            for p in brew_candidates {
                if std::path::Path::new(p).is_dir() {
                    prepend.push(p.to_string());
                }
            }
            if !prepend.is_empty() {
                let current = std::env::var("PATH").unwrap_or_default();
                // Only add paths that aren't already present.
                let existing: Vec<&str> = current.split(':').collect();
                let needs_prepend: Vec<&String> = prepend
                    .iter()
                    .filter(|p| !existing.contains(&p.as_str()))
                    .collect();
                if !needs_prepend.is_empty() {
                    let joined: Vec<String> = needs_prepend.iter().map(|s| (*s).clone()).collect();
                    let new_path = format!("{}:{}", joined.join(":"), current);
                    eprintln!("[Tier Terminal] PATH prepended with Homebrew dirs for {}", program);
                    cmd.env("PATH", new_path);
                }
            }
        }
    }

    // Pass theme mode to Coffee Code so it knows dark vs light at startup
    if let Some(ref mode) = theme_mode {
        cmd.env("COFFEE_CODE_THEME_MODE", mode);
    }

    // Pass locale to tool for i18n
    if let Some(ref loc) = locale {
        cmd.env("COFFEE_CODE_LOCALE", loc);
    }

    // ── Hook status injection (Claude Code / Qwen Code) ────────────────────
    // The Coffee CLI hook script (installed into ~/.claude/settings.json and
    // ~/.qwen/settings.json at startup) reads these env vars to identify which
    // tab a hook fired from and where to forward the event.
    if let Some(tname) = tool_name.as_deref() {
        if tname == "claude" || tname == "qwen" {
            use tauri::Manager;
            let port = app
                .state::<crate::server::AppState>()
                .hook_port
                .load(std::sync::atomic::Ordering::SeqCst);
            if port != 0 {
                cmd.env("COFFEE_CLI_TAB_ID", &session_id);
                cmd.env("COFFEE_CLI_HOOK_PORT", port.to_string());
                cmd.env("COFFEE_CLI_TOOL", tname);
            }
        }
    }

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

    // ── Open PTY pair ──────────────────────────────────────────────────────
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Spawn command into the PTY slave.
    // `child` is owned by a dedicated watcher thread (see below) which blocks
    // on child.wait() to detect process death — Coffee CLI's long-standing
    // "terminal looks frozen after a while" bug was caused by not monitoring
    // the child at all; if the child crashed but the PTY slave stayed open
    // (via an intermediate cmd.exe on Windows, or grandchild process on any
    // OS), reader.read() would block forever and the UI had no way to know.
    let child = pair.slave.spawn_command(cmd)?;
    eprintln!("[Tier Terminal] PTY process spawned OK (portable-pty)");

    // Get reader/writer from the PTY master
    let mut reader = pair.master.try_clone_reader()?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pair.master.take_writer()?));

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

    // Shared activity state for status detection across threads
    // Initialize last_output_at in the past so the first ticker check doesn't
    // falsely report "working" (silence_ms starts > 800ms).
    let activity = Arc::new(Mutex::new(SessionActivity {
        alive: true,
        last_output_at: Instant::now() - std::time::Duration::from_secs(2),
        burst_start: None,
        last_status: "wait_input".to_string(),
        recent_text: String::new(),
        user_submitted_at: None,
    }));

    // Store session (with shared writer reference + master kept alive + activity)
    let output_buffer: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let writer_clone = writer.clone();
        let master_clone = master_arc.clone();
        let activity_clone = activity.clone();
        let buffer_clone = output_buffer.clone();
        let mut map = session.lock().unwrap();
        map.insert(session_id.clone(), TerminalSession {
            writer_lock: writer_clone,
            kill_tx,
            tool_name: tool_name.clone(),
            session_token: Mutex::new(None),
            _master: master_clone,
            activity: activity_clone,
            output_buffer: buffer_clone,
        });
    }

    // Build session ID regex if this tool supports resume
    let session_id_regex = tool_name.as_deref()
        .and_then(find_preset)
        .and_then(|p| p.session_id_pattern)
        .and_then(|pat| regex::Regex::new(pat).ok());

    // Get prompt markers for wait_input detection
    let prompt_markers: Vec<String> = tool_name.as_deref()
        .and_then(find_preset)
        .map(|p| p.prompt_markers.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default();

    // ── PTY output reader thread ─────────────────────────────────────────────
    // This is the SOLE lifecycle manager. When the reader gets EOF (process tree
    // fully exited), it cleans up the session and notifies the frontend.
    let app_out = app.clone();
    let session_id_out = session_id.clone();
    let session_for_token = session.clone();
    let session_for_cleanup = session.clone();
    let sid_cleanup = session_id.clone();
    
    // ── Agent Status Ticker Thread ───────────────────────────────────────────
    // Dual-signal detection: combines PTY output timing with user-input tracking.
    // When user presses Enter (detected by tier_terminal_input), we immediately
    // know the agent is "working" — no need to wait for PTY output to start.
    // This eliminates the "thinking gap" where silence was misclassified as idle.
    let activity_for_ticker = activity.clone();
    let app_for_ticker = app.clone();
    let sid_for_ticker = session_id.clone();
    let markers_for_ticker = prompt_markers.clone();
    let tool_name_for_ticker = tool_name.clone();

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let mut act = match activity_for_ticker.lock() {
                Ok(a) => a,
                Err(_) => break,
            };
            if !act.alive { break; } // session cleaned up, stop ticker

            let now = Instant::now();
            let silence_ms = now.duration_since(act.last_output_at).as_millis() as u64;

            // Check prompt markers in the recent output buffer.
            // Use a safe char-boundary check to avoid panicking on multi-byte
            // UTF-8 characters (e.g. '─' is 3 bytes, '❯' is 3 bytes).
            let tail = if act.recent_text.len() > 150 {
                let start = act.recent_text.len() - 150;
                // Walk forward to find a valid UTF-8 char boundary
                let safe_start = (start..act.recent_text.len())
                    .find(|&i| act.recent_text.is_char_boundary(i))
                    .unwrap_or(act.recent_text.len());
                &act.recent_text[safe_start..]
            } else {
                &act.recent_text
            };
            
            let is_at_prompt = markers_for_ticker.iter().any(|m| {
                tail.contains(m.as_str()) || act.recent_text.trim_end().ends_with(m.as_str())
            });

            // ── 2-State Agent Status Detection ──────────────────────────
            //
            // Two states: "working" and "wait_input".
            // "working" = agent is processing the user's request.
            // "wait_input" = agent is at its prompt, waiting for input.
            //
            // Detection rules:
            //
            // 1. WAIT_INPUT: Prompt marker detected + silence > 1200ms
            //    → Agent finished responding and shows its prompt.
            //    → Clear user_submitted_at (request cycle complete).
            //
            // 2. WORKING: User submitted (pressed Enter at prompt) AND
            //    no prompt marker has appeared since.
            //    → This covers: thinking silence, streaming output, tool use.
            //    → Also covers output flowing (silence < 800ms) after submission.
            //    → 120s timeout as safety net for stuck sessions.
            //
            // 3. WAIT_INPUT (default): No user submission pending.
            //    → Agent startup output, initialization, idle = all "wait_input".
            //    → Output flowing without prior user input is just agent booting.

            let user_submitted_recently = act.user_submitted_at
                .map(|t| now.duration_since(t).as_secs() < 120)
                .unwrap_or(false);

            let new_status = if is_at_prompt && silence_ms > 1200 {
                // Agent is at the prompt — request cycle complete
                act.user_submitted_at = None;
                "wait_input".to_string()
            } else if user_submitted_recently {
                // User submitted a prompt and agent hasn't returned to prompt yet
                "working".to_string()
            } else {
                // No pending submission — agent is at prompt or booting up
                "wait_input".to_string()
            };

            if new_status != act.last_status {
                act.last_status = new_status.clone();
                let _ = app_for_ticker.emit("agent-status", AgentStatusEvent {
                    id: sid_for_ticker.clone(),
                    status: new_status,
                    silence_ms,
                    tool: tool_name_for_ticker.clone(),
                });
            }
        }
    });

    let output_buffer_for_reader = output_buffer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];

        let ansi_re = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.").unwrap();
        let mut token_captured = false;

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    eprintln!("[Tier Terminal] PTY reader: EOF");
                    break;
                }
                Ok(n) => {
                    // Pure passthrough: raw PTY bytes go straight to xterm.js.
                    let chunk = &buf[..n];
                    let cwd_change = extract_osc7_cwd(chunk);
                    let data = String::from_utf8_lossy(chunk).to_string();
                    let stripped = ansi_re.replace_all(&data, "").to_string();


                    // Update shared activity state & recent text buffer ONLY if actual characters were printed
                    // This prevents invisible background PTY chatter (like cursor polling) from resetting the silence timer
                    if !stripped.is_empty() {
                        let now = Instant::now();
                        if let Ok(mut act) = activity.lock() {
                            let silence = now.duration_since(act.last_output_at).as_millis() as u64;
                            if silence > 2000 {
                                act.burst_start = Some(now);
                            }
                            act.last_output_at = now;
                            
                            act.recent_text.push_str(&stripped);
                            let char_count = act.recent_text.chars().count();
                            if char_count > 200 {
                                if let Some((start_idx, _)) = act.recent_text.char_indices().nth(char_count - 200) {
                                    act.recent_text = act.recent_text[start_idx..].to_string();
                                }
                            }
                        }
                    }

                    // Session ID capture (for resume)
                    if !token_captured {
                        if let Some(ref re) = session_id_regex {
                            if let Some(caps) = re.captures(&stripped) {
                                if let Some(token) = caps.get(1) {
                                    let token_str = token.as_str().to_string();
                                    eprintln!("[Tier Terminal] Captured session token: {}...", &token_str[..token_str.len().min(12)]);
                                    if let Ok(map) = session_for_token.lock() {
                                        if let Some(sess) = map.get(&session_id_out) {
                                            if let Ok(mut t) = sess.session_token.lock() {
                                                *t = Some(token_str);
                                            }
                                        }
                                    }
                                    token_captured = true;
                                }
                            }
                        }
                    }

                    // Send raw ANSI stream to xterm.js
                    let data_clone = data.clone();
                    let _ = app_out.emit(
                        "tier-terminal-output",
                        TerminalOutput { id: session_id_out.clone(), data },
                    );

                    // Append to ring buffer for detached window history replay
                    if let Ok(mut buf) = output_buffer_for_reader.lock() {
                        buf.push(data_clone);
                        // Cap at 2000 chunks (~8MB) to bound memory
                        if buf.len() > 2000 {
                            let drain = buf.len() - 2000;
                            buf.drain(..drain);
                        }
                    }

                    // CWD change notification (OSC 7)
                    if let Some(new_cwd) = cwd_change {
                        eprintln!("[Tier Terminal] CWD changed: {}", new_cwd);
                        #[derive(Serialize, Clone)]
                        struct CwdPayload { id: String, cwd: String }
                        let _ = app_out.emit("tier-terminal-cwd", CwdPayload { id: session_id_out.clone(), cwd: new_cwd });
                    }
                }
                Err(e) => {
                    let msg = format!("{}", e);
                    if !msg.contains("BrokenPipe") && !msg.contains("broken pipe") && !msg.contains("管道") {
                        eprintln!("[Tier Terminal] PTY reader error: {}", e);
                    }
                    break;
                }
            }
        }

        // ── Reader EOF = process tree fully exited → cleanup ──────────────
        eprintln!("[Tier Terminal] Reader thread exiting, cleaning up session");

        // Signal ticker thread to stop on its next iteration
        if let Ok(mut act) = activity.lock() {
            act.alive = false;
        }

        // Emit final idle status
        let _ = app_out.emit("agent-status", AgentStatusEvent {
            id: session_id_out.clone(),
            status: "idle".to_string(),
            silence_ms: 0,
            tool: None,
        });

        // Remove session from map (this drops the master Arc ref)
        {
            let mut map = session_for_cleanup.lock().unwrap();
            map.remove(&sid_cleanup);
        }

        // Notify frontend
        let _ = app_out.emit(
            "tier-terminal-status",
            TerminalStatus { id: session_id_out, running: false, exit_code: Some(0) },
        );
    });

    Ok(())
}

// ─── Path resolution (Unix only) ─────────────────────────────────────────────

/// Resolve a program name to a full path.
#[cfg(not(target_os = "windows"))]
fn resolve_program(name: &str) -> String {
    if let Ok(output) = std::process::Command::new("which")
        .arg(name)
        .output()
    {
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
        assert_eq!(extract_osc7_cwd(&data), Some("/home/user/projects".to_string()));
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
        assert_eq!(extract_osc7_cwd(&data), Some("/home/user/my project".to_string()));
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
        assert_eq!(extract_osc7_cwd(&data), Some("/C:/Users/foo/project".to_string()));
    }

    // ── find_preset ───────────────────────────────────────────────────────────

    #[test]
    fn find_preset_known_tools() {
        for tool in &["claude", "gemini", "hermes"] {
            assert!(find_preset(tool).is_some(), "preset not found for {tool}");
        }
    }

    #[test]
    fn find_preset_unknown_returns_none() {
        assert!(find_preset("codex").is_none());
        assert!(find_preset("").is_none());
        assert!(find_preset("gpt").is_none());
    }

    #[test]
    fn find_preset_resume_program_matches_tool() {
        let p = find_preset("claude").unwrap();
        assert_eq!(p.resume_program, Some("claude"));
        assert_eq!(p.resume_args_before, &["--resume"]);
        assert!(p.resume_args_after.is_empty());
    }

    // ── session_id_pattern (injection guard) ──────────────────────────────────

    /// Confirm that valid tokens are accepted and injected flag strings are rejected.
    /// Mirrors the validation logic in tier_terminal_resume.
    fn token_matches(tool: &str, token: &str) -> bool {
        let preset = find_preset(tool).unwrap();
        match preset.token_format {
            Some(fmt) => regex::Regex::new(fmt).unwrap().is_match(token),
            None => false,
        }
    }

    #[test]
    fn claude_token_valid_uuid() {
        assert!(token_matches("claude", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
    }

    #[test]
    fn claude_token_rejects_injection() {
        // Attacker appends extra flag — must be rejected
        assert!(!token_matches("claude", "a1b2c3d4-e5f6-7890-abcd-ef1234567890 --dangerously-skip-permissions"));
        assert!(!token_matches("claude", ""));
        assert!(!token_matches("claude", "../../etc/passwd"));
    }

    #[test]
    fn hermes_token_valid_format() {
        assert!(token_matches("hermes", "20240115_143022_a1b2c3"));
    }

    #[test]
    fn hermes_token_rejects_invalid() {
        assert!(!token_matches("hermes", "not-a-hermes-token"));
        assert!(!token_matches("hermes", "20240115_143022_a1b2c3 --extra"));
    }
}
