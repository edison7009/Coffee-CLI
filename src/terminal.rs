// terminal.rs — Tier Terminal PTY backend
// Uses portable-pty (WezTerm's cross-platform PTY library) for reliable
// ConPTY support on Windows and native PTY on Unix.
// Streams raw PTY output through translation engine to frontend via Tauri events.

use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use crate::translation;

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

/// Agent working status emitted to the frontend every second
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AgentStatusEvent {
    pub id: String,
    /// "working" | "idle" | "wait_input"
    pub status: String,
    /// Milliseconds since last PTY output
    pub silence_ms: u64,
}

// ─── Agent Presets for Session Resume ─────────────────────

pub struct AgentPreset {
    pub tool_name: &'static str,
    pub resume_command: Option<&'static str>,
    pub session_id_pattern: Option<&'static str>,
    /// Characters that indicate the agent is waiting for user input
    pub prompt_markers: &'static [&'static str],
}

pub const AGENT_PRESETS: &[AgentPreset] = &[
    AgentPreset {
        tool_name: "claude",
        resume_command: Some("claude --resume {{sessionId}}"),
        session_id_pattern: Some(r"Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"),
        prompt_markers: &["❯", "> "],
    },
    AgentPreset {
        tool_name: "codex",
        resume_command: Some("codex resume {{sessionId}} --no-alt-screen"),
        session_id_pattern: Some(r"Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"),
        prompt_markers: &["•"],
    },
    AgentPreset {
        tool_name: "gemini",
        resume_command: Some("gemini --resume {{sessionId}}"),
        session_id_pattern: Some(r"Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"),
        prompt_markers: &["✦"],
    },
    AgentPreset {
        tool_name: "openclaw",
        resume_command: None,
        session_id_pattern: None,
        prompt_markers: &[">"],
    },
    AgentPreset {
        tool_name: "coffeecode",
        resume_command: Some("coffeecode --resume {{sessionId}}"),
        session_id_pattern: Some(r"Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"),
        prompt_markers: &["❯", "> "],
    },
];

pub fn find_preset(tool_name: &str) -> Option<&'static AgentPreset> {
    AGENT_PRESETS.iter().find(|p| p.tool_name == tool_name)
}

// ─── Shared Session State ─────────────────────────────────

pub struct TerminalSession {
    pub writer: Box<dyn Write + Send>,
    pub kill_tx: std::sync::mpsc::Sender<()>,
    /// The tool name (e.g. "claude", "codex") for this session
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
    pub last_output_at: Instant,
    pub burst_start: Option<Instant>,
    pub last_status: String,
    /// Rolling buffer of recent stripped output for prompt marker detection
    pub recent_text: String,
    /// Tracks when user last pressed Enter → immediate "working" signal.
    /// Cleared when a prompt marker is detected (agent finished & is idle).
    pub user_submitted_at: Option<Instant>,
}

/// Thread-safe Write wrapper so multiple threads can write to the PTY
struct SharedWriter(Arc<Mutex<Box<dyn Write + Send>>>);

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?.flush()
    }
}

// ─── Spawn ────────────────────────────────────────────────

/// Spawns `program` with `args` inside a PTY via portable-pty.
/// On Windows this uses ConPTY, on Unix it uses native PTYs.
pub fn spawn(
    app: AppHandle,
    session_id: String,
    session: SharedSession,
    translation_engine: Arc<translation::TranslationEngine>,
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

    let cols = initial_cols.max(80);
    let rows = initial_rows.max(24);
    eprintln!("[Tier Terminal] Spawning '{}' args={:?}", program, args);
    eprintln!("[Tier Terminal] Size: {}x{}", cols, rows);

    // ── Build command ──────────────────────────────────────────────────────
    // On Windows: npm-installed tools are .cmd scripts, not real .exe files.
    // CreateProcessW cannot run .cmd → always go through cmd.exe /c.
    // This matches CLIDeck/node-pty's approach.
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

    // Inherit full parent environment + overlay terminal capability vars
    for (key, val) in std::env::vars() {
        cmd.env(key, val);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    // Pass theme mode to CoffeeCode so it knows dark vs light at startup
    if let Some(ref mode) = theme_mode {
        cmd.env("COFFEECODE_THEME_MODE", mode);
    }

    // Pass locale to CoffeeCode for TUI i18n
    if let Some(ref loc) = locale {
        cmd.env("COFFEECODE_LOCALE", loc);
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

    // Spawn command into the PTY slave
    let _child = pair.slave.spawn_command(cmd)?;
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

    let (kill_tx, _kill_rx) = std::sync::mpsc::channel::<()>();

    // Shared activity state for status detection across threads
    // Initialize last_output_at in the past so the first ticker check doesn't
    // falsely report "working" (silence_ms starts > 800ms).
    let activity = Arc::new(Mutex::new(SessionActivity {
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
            writer: Box::new(SharedWriter(writer_clone)),
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

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let mut act = match activity_for_ticker.lock() {
                Ok(a) => a,
                Err(_) => break, // session dropped
            };

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

            // ── 2-State Detection for Dynamic Island ─────────────────────
            //
            // The island only shows two states: "working" and "wait_input".
            // "working" = agent is processing YOUR request (you pressed Enter).
            // "wait_input" = agent is at its prompt, waiting for you.
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
                });
            }
        }
    });

    let output_buffer_for_reader = output_buffer.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut vt = translation::VtProcessor::new(translation_engine);

        let ansi_re = regex::Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.").unwrap();
        let mut token_captured = false;

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    eprintln!("[Tier Terminal] PTY reader: EOF");
                    break;
                }
                Ok(n) => {
                    // Process raw PTY output through VT parser + translation engine
                    let (processed, cwd_change) = vt.process(&buf[..n]);
                    let data = String::from_utf8_lossy(&processed).to_string();
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

                    // Send translated ANSI stream to xterm.js
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

        // Emit final idle status
        let _ = app_out.emit("agent-status", AgentStatusEvent {
            id: session_id_out.clone(),
            status: "idle".to_string(),
            silence_ms: 0,
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
