//! What Coffee CLI knows about each tool it runs in a terminal: resume presets, native session ids,
//! the environment AI CLIs need, and Claude Code's theme preflight. The terminal engine stays generic.

// ─── Claude Code preflight ────────────────────────────────
//
// Why: Claude Code's `/theme auto` queries the host terminal via OSC 11 and
// renders light- or dark-theme based on the response. xterm.js answers OSC 11
// with whatever we set on `theme.background`, which Coffee CLI flips between
// `#1a1917` (dark) and `#eeebe2` (light) when the user changes themes —
// wiring is already in place. The only missing piece is that Claude Code
// defaults to `theme: "dark"` when settings.json has no theme key, so users
// don't get the auto-follow behavior unless they manually `/theme auto` once.
//
// We bridge that gap on every Claude Code launch: if `~/.claude/settings.json`
// has no explicit `theme` key, we add `theme: "auto"`. Existing values are
// always preserved — once a user runs `/theme dark` (or any other choice),
// Claude Code writes that key and we never touch it again.
fn ensure_claude_theme_auto() {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let dir = home.join(".claude");
    let path = dir.join("settings.json");

    // Don't auto-create the .claude/ directory — Claude Code itself creates
    // it on first run with proper permissions / contents. We only edit if
    // it's already there.
    if !dir.is_dir() {
        return;
    }

    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // Empty / missing file: write a minimal one.
    if existing.trim().is_empty() {
        let body = "{\n  \"theme\": \"auto\"\n}\n";
        if let Err(e) = std::fs::write(&path, body) {
            eprintln!("[Coffee] could not seed claude theme=auto: {}", e);
        } else {
            eprintln!("[Coffee] seeded ~/.claude/settings.json with theme=auto");
        }
        return;
    }

    // Non-empty: parse, only insert `theme` if absent. Anything else (invalid
    // JSON, non-object root) we leave alone — never corrupt user config.
    let mut value: serde_json::Value = match serde_json::from_str(&existing) {
        Ok(v) => v,
        Err(_) => return,
    };
    let serde_json::Value::Object(ref mut map) = value else {
        return;
    };
    if map.contains_key("theme") {
        return;
    }
    map.insert(
        "theme".to_string(),
        serde_json::Value::String("auto".to_string()),
    );

    match serde_json::to_string_pretty(&value) {
        Ok(s) => {
            if let Err(e) = std::fs::write(&path, format!("{}\n", s)) {
                eprintln!("[Coffee] could not write claude theme=auto: {}", e);
            } else {
                eprintln!("[Coffee] added theme=auto to ~/.claude/settings.json");
            }
        }
        Err(_) => {}
    }
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
}

pub const AGENT_PRESETS: &[AgentPreset] = &[
    AgentPreset {
        tool_name: "claude",
        resume_program: Some("claude"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: Some(
            r"Session ID:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        ),
        token_format: Some(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    },
    AgentPreset {
        tool_name: "hermes",
        resume_program: Some("hermes"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        // Hermes prints `Resume this session with: hermes --resume
        // <YYYYMMDD>_<HHMMSS>_<hex>` on exit. The hex tail length has
        // moved across upstream versions — early Hermes used `[:6]`,
        // current main branch uses `uuid.uuid4().hex[:8]` (gateway/
        // session.py). Accept {4,16} so both legacy sessions on disk
        // and freshly-minted ones validate. Alnum + underscore only,
        // so the flag-injection guard at server.rs:2786 still bites.
        session_id_pattern: Some(r"(\d{8}_\d{6}_[0-9a-f]{4,16})"),
        token_format: Some(r"^\d{8}_\d{6}_[0-9a-f]{4,16}$"),
    },
    // OpenCode 1.14+ resume: `opencode --session ses_<25-alnum>`. The TUI
    // does not echo the session id to stdout (verified live on 1.14.32),
    // so `session_id_pattern` is None — the resume token is sourced from
    // the existing OpenCode history reader in server.rs (which parses
    // `~/.local/share/opencode/storage/session/<projectID>/*.json`),
    // not from PTY scraping. Prompt marker `┃` (U+2503 HEAVY VERTICAL)
    // is the left border of OpenCode's input box, persistently rendered
    // in idle state; combined with the >1.2s silence rule in the status
    // ticker this reliably maps to "idle" only after the agent has finished
    // streaming.
    AgentPreset {
        tool_name: "opencode",
        resume_program: Some("opencode"),
        resume_args_before: &["--session"],
        resume_args_after: &[],
        session_id_pattern: None,
        // Observed token shape: `ses_` + 26 alnum (verified against 3
        // real sessions, all 26 chars). A previous {25} guess was based
        // on eyeballing length and rejected every real token — the
        // history-list "resume" button silently failed for OpenCode
        // from v2.5.x through v2.7.7. The {20,40} band leaves headroom
        // if OpenCode ever shifts the token length, while still preventing
        // whitespace/flag injection (alnum-only character class).
        token_format: Some(r"^ses_[A-Za-z0-9]{20,40}$"),
    },
    // MiMo Code — Xiaomi's OpenCode fork. Same resume contract as OpenCode
    // (`<bin> --session ses_<...>`), same `ses_` token shape and idle prompt
    // border. Only the binary differs; `resume_program: "mimo"` is the
    // best-guess command name — correct it here AND in tools/mimocode.rs
    // (binary_name) if MiMo Code actually ships as `mimocode`.
    AgentPreset {
        tool_name: "mimocode",
        resume_program: Some("mimo"),
        resume_args_before: &["--session"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^ses_[A-Za-z0-9]{20,40}$"),
    },
    // Kilo Code — an OpenCode fork (`kilo` binary, github.com/Kilo-Org/kilocode).
    // Same resume contract as OpenCode/MiMo Code (`<bin> --session ses_<...>`);
    // binary_name + token shape are best-guess pending a real-install verify,
    // mirroring MiMo Code's initial integration.
    AgentPreset {
        tool_name: "kilo",
        resume_program: Some("kilo"),
        resume_args_before: &["--session"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^ses_[A-Za-z0-9]{20,40}$"),
    },
    // Codex CLI resume: `codex resume <id>` is a positional subcommand,
    // not a `--resume` flag. Token is the rollout filename stem (UUID).
    AgentPreset {
        tool_name: "codex",
        resume_program: Some("codex"),
        resume_args_before: &["resume"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    },
    // Grok Build (xAI) - `grok` binary. Resume via `grok --resume <uuid>`
    // (verified against `grok --help`: `-r, --resume <ID>` resumes by ID,
    // errors if not found). Token is the UUIDv7 session id from summary.json
    // (`info.id`), sourced by find_grok_sessions (Grok doesn't echo the id to
    // stdout on launch, so session_id_pattern is None). Grok's native OSC title
    // provides spinner/activity/action-required/idle state; no hook or PTY
    // status inference is needed. Coffee CLI launches grok raw (native OAuth
    // via ~/.grok/auth.json, no auth injection).
    AgentPreset {
        tool_name: "grok",
        resume_program: Some("grok"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    },
    // Qwen Code is a Gemini-CLI fork — same `--resume <uuid>` flag and
    // UUID token format inherited from upstream. Upstream Gemini CLI
    // is retired (Google transitioned consumers to Antigravity CLI on
    // 2026-05-19) but Qwen has not followed that change; the preset
    // below still reflects what the Qwen binary accepts.
    AgentPreset {
        tool_name: "qwen",
        resume_program: Some("qwen"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    },
    // OpenClaw exposes no CLI resume entry point. Verified against
    // upstream `openclaw/openclaw` (TypeScript, registered command
    // groups in `src/cli/program/core-command-descriptors.ts`): the
    // top-level command set is `sessions` (list only — subcommands
    // are `cleanup` and `export-trajectory --session-key`), `agent`,
    // `status`, etc. There is no `openclaw resume <id>`, no
    // `--resume` flag, no `sessions resume`. OpenClaw is a
    // multi-channel gateway that orchestrates other CLIs (claude,
    // anthropic backends, etc.) as workers; resuming an OpenClaw "session"
    // is something OpenClaw does internally when you re-launch it,
    // not something invokable via argv. So the resume button must be
    // a no-op at the CLI level. Setting `resume_program: None` makes
    // tier_terminal_resume return a clean
    // "Tool 'openclaw' does not support resume" Err instead of
    // spawning a `openclaw resume <token>` invocation that OpenClaw
    // itself would reject as an unknown command. Frontend UX (hiding
    // the resume action entirely for OpenClaw history rows) is handled
    // separately by HistoryBoard.
    AgentPreset {
        tool_name: "openclaw",
        resume_program: None,
        resume_args_before: &[],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: None,
    },
    // Pi (earendil-works `pi` binary). Resume via `pi --session <id>` —
    // also accepts a partial UUID / file path (pi.dev/docs sessions). Token
    // is the session UUID (v7) from the JSONL header `id` field, sourced by
    // parse_pi_session_jsonl (Pi doesn't echo the id to stdout on launch, so
    // session_id_pattern is None).
    AgentPreset {
        tool_name: "pi",
        resume_program: Some("pi"),
        resume_args_before: &["--session"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
    },
    AgentPreset {
        tool_name: "omp",
        resume_program: Some("omp"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$"),
    },
    // CodeBuddy Code (Tencent `codebuddy` binary). Resume via
    // `codebuddy --resume <session-id>` (canonical `-r, --resume <session-id>`,
    // per the CLI reference). Token is the transcript file stem, a UUID
    // verified against the bundle's own session-id guard
    // (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`,
    // which is how it decides a file in `~/.codebuddy/projects/<key>/` is a
    // main session rather than a sub-agent). Sourced by
    // `parse_codebuddy_session_jsonl`; CodeBuddy doesn't echo the id to stdout,
    // so session_id_pattern is None.
    AgentPreset {
        tool_name: "codebuddy",
        resume_program: Some("codebuddy"),
        resume_args_before: &["--resume"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    },
    // Kimi Code (Moonshot `kimi` binary). Resume via `kimi --session <id>`
    // (canonical `-S, --session`, verified against `kimi --help`). Token is
    // `session_<uuid>` from session_index.jsonl, sourced by find_kimi_sessions
    // (Kimi doesn't echo the id to stdout, so session_id_pattern is None).
    AgentPreset {
        tool_name: "kimicode",
        resume_program: Some("kimi"),
        resume_args_before: &["--session"],
        resume_args_after: &[],
        session_id_pattern: None,
        // `session_` + UUID, verified against real session_index.jsonl entries.
        // Permissive alnum/underscore/hyphen/dot band mirrors OpenCode's `ses_`
        // band — leaves headroom if Kimi ever shifts the id shape, while still
        // preventing whitespace/flag injection.
        token_format: Some(r"^session_[A-Za-z0-9._-]+$"),
    },
    // Antigravity CLI (`agy`). Resume via `agy --conversation <id>` (verified against
    // `agy --help`, 1.4.12). The id is the UUID primary key of its
    // conversation_summaries.db, sourced by find_antigravity_sessions.
    AgentPreset {
        tool_name: "antigravity",
        resume_program: Some("agy"),
        resume_args_before: &["--conversation"],
        resume_args_after: &[],
        session_id_pattern: None,
        token_format: Some(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    },
];

pub fn find_preset(tool_name: &str) -> Option<&'static AgentPreset> {
    AGENT_PRESETS.iter().find(|p| p.tool_name == tool_name)
}


// Claude supports assigning a native ID before launch. This gives fresh tabs
// the same exact history identity as resumed tabs, without hooks or cwd guesses.
pub(crate) fn claude_launch_token(args: &mut Vec<String>, assign_new: bool) -> Option<String> {
    let mut token = None;
    let mut has_selector = false;
    for (index, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--session-id" | "--resume" | "-r") {
            has_selector = true;
            token = args.get(index + 1).filter(|value| uuid::Uuid::parse_str(value).is_ok()).cloned();
        } else if let Some(value) = arg.strip_prefix("--session-id=").or_else(|| arg.strip_prefix("--resume=")) {
            has_selector = true;
            token = uuid::Uuid::parse_str(value).ok().map(|_| value.to_string());
        } else if matches!(arg.as_str(), "--continue" | "-c" | "--fork-session") {
            // These flags can select/create a different native conversation.
            return None;
        }
    }
    if !has_selector && assign_new {
        let id = uuid::Uuid::new_v4().to_string();
        args.extend(["--session-id".to_string(), id.clone()]);
        token = Some(id);
    }
    token
}

/// Pi 0.76+ accepts `--session-id <id>` (opens that project session, creating
/// it when missing), so a fresh tab owns its native id from launch and the
/// history row merges with the live tab instead of duplicating it (#180).
/// Older Pi swallows the unknown `--flag value` pair as an extension flag.
pub(crate) fn pi_launch_token(args: &mut Vec<String>, assign_new: bool) -> Option<String> {
    let mut token = None;
    let mut has_selector = false;
    for (index, arg) in args.iter().enumerate() {
        if matches!(arg.as_str(), "--session" | "--session-id") {
            has_selector = true;
            // `--session` also takes a path or partial id; only a full UUID is a usable identity.
            token = args.get(index + 1).filter(|value| uuid::Uuid::parse_str(value).is_ok()).cloned();
        } else if matches!(arg.as_str(), "--continue" | "-c" | "--resume" | "-r" | "--fork" | "--no-session") {
            // These pick another conversation, or none; `--session-id` conflicts with them.
            return None;
        }
    }
    if !has_selector && assign_new {
        let id = uuid::Uuid::new_v4().to_string();
        args.extend(["--session-id".to_string(), id.clone()]);
        token = Some(id);
    }
    token
}

/// Oh-My-Pi has no way to pick a new session's id at launch, but it records
/// each terminal's current session in a breadcrumb keyed by the TTY
/// (`<agent state>/terminal-sessions/<tty>`, `/dev/ttys012` → `ttys012`):
/// line 1 the cwd, line 2 the session file (possibly relative to that cwd,
/// and possibly not written yet). Once that file exists, reading it for the tab's own PTY gives the
/// native id without guessing by cwd. Windows PTYs have no TTY path, so omp
/// keeps no breadcrumb there and this stays None.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn omp_breadcrumb_token(content: &str) -> Option<String> {
    let mut lines = content.lines();
    let cwd = std::path::Path::new(lines.next()?.trim());
    let file = lines.next()?.trim();
    if file.is_empty() { return None; }
    // Only a session omp has written resumes; a fresh crumb names a file that
    // may never appear, and reporting it would make a restart resume nothing.
    let file = std::fs::File::open(cwd.join(file)).ok()?;
    use std::io::BufRead;
    std::io::BufReader::new(file).lines().map_while(Result::ok).take(4).find_map(|line| {
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if value.get("type")?.as_str()? != "session" { return None; }
        let id = value.get("id")?.as_str()?;
        uuid::Uuid::parse_str(id).is_ok().then(|| id.to_string())
    })
}

#[cfg_attr(not(unix), allow(dead_code))]
fn omp_breadcrumb_dir() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|v| !v.is_empty()) {
        return Some(std::path::PathBuf::from(dir).join("terminal-sessions"));
    }
    #[cfg(target_os = "linux")]
    if let Some(state) = std::env::var_os("XDG_STATE_HOME").filter(|v| !v.is_empty()) {
        let root = std::path::PathBuf::from(state).join("omp");
        if root.is_dir() { return Some(root.join("terminal-sessions")); }
    }
    Some(dirs::home_dir()?.join(".omp").join("agent").join("terminal-sessions"))
}

/// The session omp currently runs in this PTY, from a breadcrumb written after
/// `since` (TTY names are reused, so an older crumb belongs to a previous process).
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn omp_terminal_token(tty: &std::path::Path, since: std::time::SystemTime) -> Option<String> {
    let name = tty.to_string_lossy();
    let id = name.strip_prefix("/dev/")?.replace('/', "-");
    let crumb = omp_breadcrumb_dir()?.join(id);
    if std::fs::metadata(&crumb).ok()?.modified().ok()? < since { return None; }
    omp_breadcrumb_token(&std::fs::read_to_string(crumb).ok()?)
}

/// The environment an AI CLI gets in a Coffee terminal (color, heap, git prompts and per-OS fixes), applied
/// before the launch's own variables. Claude Code also gets its `theme: auto` preflight here.
pub fn ai_cli_env(tool: Option<&str>, program: &str) -> Vec<(String, String)> {
    let mut env = Vec::new();
    let _ = program;
    // ── AI CLI environment hints ───────────────────────────────────────────
    // These fixes target pain points Claude / Qwen / OpenCode / Hermes hit
    // when running as subprocesses: color stripped, Node heap too small, git
    // waiting for credential input, Unicode corruption, Homebrew tools not
    // in PATH, etc. Every env var is a no-op for tools that don't recognize
    // it — maximum benefit, zero risk for those that do.
    let is_ai_cli = matches!(
        tool,
        Some("claude")
            | Some("qwen")
            | Some("opencode")
            | Some("mimocode")
            | Some("hermes")
            | Some("codex")
            | Some("grok")
            | Some("antigravity")
    );

    if is_ai_cli {
        // Claude Code only: seed `theme: "auto"` in ~/.claude/settings.json
        // if no theme is set yet. xterm.js answers OSC 11 with our terminal
        // background, and Claude Code's `auto` preset uses that to follow
        // Coffee CLI's light/dark switch automatically. A no-op once the user
        // has any `theme` value (including "auto" or a custom theme).
        if matches!(tool, Some("claude")) {
            ensure_claude_theme_auto();
        }

        // Cross-platform: most CLIs auto-disable ANSI color when they detect
        // a subprocess / non-TTY context. Force color so Claude's status
        // highlights, diff colors, error markers stay visible.
        env.push(("FORCE_COLOR".to_string(), "1".to_string()));

        // Node-based agents (Claude Code, OpenCode CLI) default to ~1.7GB
        // heap. Large monorepos trip this during big refactors / tree scans;
        // 8GB is safe on any dev machine and ignored by non-Node tools.
        env.push(("NODE_OPTIONS".to_string(), "--max-old-space-size=8192".to_string()));

        // Without this, `git push` / `git pull` / `git fetch` block waiting
        // for interactive credential input if no credential helper is
        // configured — PTY readers just see a silent hang. Fail loudly
        // instead and let the user see the real error.
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));

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
                    env.push(("SHELL".to_string(), bash.to_string()));
                }
            }

            // Windows Python on CJK locales defaults I/O to cp936 / GBK,
            // which corrupts UTF-8 files when Claude reads or writes them.
            // Force utf-8 regardless of system locale.
            env.push(("PYTHONIOENCODING".to_string(), "utf-8".to_string()));

            // Set POSIX locale vars if the user hasn't — keeps shell tools
            // emitting UTF-8 output and avoids locale-specific sort orders.
            if std::env::var_os("LANG").is_none() {
                env.push(("LANG".to_string(), "en_US.UTF-8".to_string()));
            }
            if std::env::var_os("LC_ALL").is_none() {
                env.push(("LC_ALL".to_string(), "en_US.UTF-8".to_string()));
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
                    eprintln!(
                        "[Tier Terminal] PATH prepended with Homebrew dirs for {}",
                        program
                    );
                    env.push(("PATH".to_string(), new_path.to_string()));
                }
            }
        }
    }

    env
}

/// OpenCode's status integration for a local OpenCode binary, layered over the launch's own configuration.
pub fn opencode_island_env(tool: Option<&str>, program: &str, extra_env: &[(String, String)]) -> Option<(String, String)> {
    let local_opencode = std::path::Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            matches!(name.to_ascii_lowercase().as_str(),
                "opencode" | "opencode.exe" | "opencode.cmd" | "opencode.ps1" | "opencode2" | "opencode2.exe")
        });
    if tool != Some("opencode") || !local_opencode { return None; }
    match crate::opencode_island::environment(extra_env) {
        Ok(content) => Some(("OPENCODE_CLI_CONFIG_CONTENT".to_string(), content)),
        Err(error) => { eprintln!("[OpenCode island] integration unavailable: {error}"); None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_history_identity_respects_existing_launch_selectors() {
        let mut fresh = Vec::new();
        let id = claude_launch_token(&mut fresh, true).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_eq!(fresh, vec!["--session-id".to_string(), id.clone()]);
        assert_eq!(claude_launch_token(&mut fresh, true), Some(id.clone()));
        assert_ne!(claude_launch_token(&mut Vec::new(), true), Some(id.clone()));
        for flag in ["--resume", "-r", "--session-id"] {
            let mut args = vec![flag.to_string(), id.clone()];
            let original = args.clone();
            assert_eq!(claude_launch_token(&mut args, true), Some(id.clone()));
            assert_eq!(args, original);
        }
        for flags in [vec!["--continue"], vec!["-c"], vec!["--resume"], vec!["--resume", "named-session"], vec!["--fork-session"]] {
            let mut args: Vec<String> = flags.iter().map(|value| value.to_string()).collect();
            let original = args.clone();
            assert_eq!(claude_launch_token(&mut args, true), None);
            assert_eq!(args, original);
        }
        let mut custom = vec!["wrapper-arg".to_string()];
        assert_eq!(claude_launch_token(&mut custom, false), None);
        assert_eq!(custom, vec!["wrapper-arg".to_string()]);
    }

    #[test]
    fn omp_breadcrumb_names_the_tab_session() {
        let dir = std::env::temp_dir().join(format!("coffee-omp-crumb-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("s")).unwrap();
        let id = "01900000-0000-7000-8000-000000000000";
        let cwd = dir.to_string_lossy();
        // Fresh session: nothing written yet, so there is nothing to resume.
        assert_eq!(omp_breadcrumb_token(&format!("{cwd}\ns/2026-11-03T01-02-03-000Z_{id}.jsonl\nfresh\n")), None);
        // Written session: the header id wins, relative paths resolve against the cwd line.
        let other = "01900000-0000-7000-8000-000000000001";
        std::fs::write(dir.join("s/x_y.jsonl"), format!("{{\"type\":\"session\",\"id\":\"{other}\"}}\n")).unwrap();
        assert_eq!(omp_breadcrumb_token(&format!("{cwd}\ns/x_y.jsonl\n")), Some(other.to_string()));
        assert_eq!(omp_breadcrumb_token(&format!("{cwd}\ns/not-an-id.jsonl\n")), None);
        assert_eq!(omp_breadcrumb_token(&format!("{cwd}\n")), None);
        // A crumb older than the PTY belongs to a previous process on a reused TTY.
        assert_eq!(omp_terminal_token(std::path::Path::new("/dev/ttys999"), std::time::SystemTime::now() + std::time::Duration::from_secs(3600)), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pi_fresh_launch_owns_its_history_identity() {
        let mut fresh = Vec::new();
        let id = pi_launch_token(&mut fresh, true).unwrap();
        assert_eq!(fresh, vec!["--session-id".to_string(), id.clone()]);
        assert_eq!(pi_launch_token(&mut fresh, true), Some(id.clone()));
        for flag in ["--session", "--session-id"] {
            let mut args = vec![flag.to_string(), id.clone()];
            let original = args.clone();
            assert_eq!(pi_launch_token(&mut args, true), Some(id.clone()));
            assert_eq!(args, original);
        }
        for flags in [vec!["--session", "/tmp/a.jsonl"], vec!["--continue"], vec!["-c"], vec!["--resume"], vec!["--fork", "abc"], vec!["--no-session"]] {
            let mut args: Vec<String> = flags.iter().map(|value| value.to_string()).collect();
            let original = args.clone();
            assert_eq!(pi_launch_token(&mut args, true), None);
            assert_eq!(args, original);
        }
        let mut custom = Vec::new();
        assert_eq!(pi_launch_token(&mut custom, false), None);
        assert!(custom.is_empty());
    }


    // ── find_preset ───────────────────────────────────────────────────────────

    #[test]
    fn find_preset_known_tools() {
        for tool in &["claude", "hermes", "pi", "kimicode", "antigravity"] {
            assert!(find_preset(tool).is_some(), "preset not found for {tool}");
        }
    }

    #[test]
    fn find_preset_unknown_returns_none() {
        // Use truly unknown names — "codex" was added to AGENT_PRESETS
        // when codex CLI gained first-class support, so it can't be a
        // negative test case anymore. Pick names guaranteed to never
        // become real tools.
        assert!(find_preset("definitely_not_a_tool").is_none());
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

    #[test]
    fn omp_resume_native_ids_without_accepting_flags() {
        for (tool, flag, token) in [
            ("omp", "--resume", "01900000-0000-7000-8000-000000000000"),
            ("codebuddy", "--resume", "0f0f0f0f-1111-2222-3333-444444444444"),
        ] {
            let preset = find_preset(tool).unwrap();
            assert_eq!(preset.resume_program, Some(tool));
            assert_eq!(preset.resume_args_before, &[flag]);
            assert!(token_matches(tool, token));
            for bad in ["", "--help", "../../file", "id --extra", "id;echo"] {
                assert!(!token_matches(tool, bad));
            }
        }
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
        assert!(token_matches(
            "claude",
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        ));
    }

    #[test]
    fn claude_token_rejects_injection() {
        // Attacker appends extra flag — must be rejected
        assert!(!token_matches(
            "claude",
            "a1b2c3d4-e5f6-7890-abcd-ef1234567890 --dangerously-skip-permissions"
        ));
        assert!(!token_matches("claude", ""));
        assert!(!token_matches("claude", "../../etc/passwd"));
    }

    #[test]
    fn hermes_token_valid_format() {
        // 6-hex tail — legacy Hermes (older `uuid.hex[:6]` slice).
        assert!(token_matches("hermes", "20240115_143022_a1b2c3"));
        // 6-hex tail — real token observed in the wild today.
        assert!(token_matches("hermes", "20260516_025413_d06297"));
        // 8-hex tail — current upstream main (`uuid.hex[:8]`).
        assert!(token_matches("hermes", "20260516_025413_d062979a"));
    }

    #[test]
    fn hermes_token_rejects_invalid() {
        assert!(!token_matches("hermes", "not-a-hermes-token"));
        assert!(!token_matches("hermes", "20240115_143022_a1b2c3 --extra"));
        // Hex too short / too long sits outside the {4,16} band.
        assert!(!token_matches("hermes", "20240115_143022_abc"));
        assert!(!token_matches(
            "hermes",
            &format!("20240115_143022_{}", "a".repeat(20))
        ));
        // Legacy `session_` filename prefix must not slip through — the
        // server-side parser strips it; the regex would reject it anyway.
        assert!(!token_matches("hermes", "session_20240115_143022_a1b2c3"));
    }

    #[test]
    fn opencode_token_valid_format() {
        // Real session ids observed in `~/.local/share/opencode/storage/session/`
        // and reported by `opencode -s <id>` — all 26 alnum chars after `ses_`.
        assert!(token_matches("opencode", "ses_1d3161926ffeffCy3Y6l14Ezoy"));
        assert!(token_matches("opencode", "ses_3a54b4f8affeiVHxL6g6ykOVUv"));
        assert!(token_matches("opencode", "ses_3a99935beffeYEMwfzPtyxsFdT"));
    }

    #[test]
    fn opencode_token_rejects_invalid() {
        // Wrong prefix
        assert!(!token_matches("opencode", "1d3161926ffeffCy3Y6l14Ezoy"));
        // Flag injection
        assert!(!token_matches(
            "opencode",
            "ses_1d3161926ffeffCy3Y6l14Ezoy --pure"
        ));
        // Empty
        assert!(!token_matches("opencode", ""));
        assert!(!token_matches("opencode", "ses_"));
        // Length outside the 20-40 band
        assert!(!token_matches("opencode", "ses_short"));
        assert!(!token_matches(
            "opencode",
            &format!("ses_{}", "a".repeat(50))
        ));
        // Disallowed chars
        assert!(!token_matches("opencode", "ses_1d3161926ffeffCy3Y6l14Ezo-"));
        assert!(!token_matches("opencode", "ses_1d3161926ffeffCy3Y6l14Ezo "));
    }
}
