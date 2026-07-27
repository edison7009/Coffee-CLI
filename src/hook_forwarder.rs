// Coffee CLI — native hook forwarder
//
// Invoked as a Claude Code hook (`<exe> __hook`, event JSON on stdin), a
// Kimi Code hook (`<exe> __kimi-hook`, same Claude-shaped stdin JSON), a
// Codex hooks-system target (`<exe> __codex-hook`, stdin JSON), or a Codex
// `notify` target (`<exe> __codex-notify <json>`, payload as final
// argv). Maps the event to Coffee CLI's 3-state agent status and forwards a
// compact JSON line to the Rust hook server over loopback TCP.
//
// Replaces the two Python forwarders:
//   - scripts/coffee-cli-hook.py         (Claude, stdin protocol)
//   - scripts/coffee-cli-codex-notify.py (Codex, argv-tail protocol)
// which are now kept only as protocol-reference copies under
// ~/.coffee-cli/hooks/.
//
// Why native: the Python forwarder failed on Windows machines without
// Python — `python` resolved to the Microsoft Store alias stub, which
// prints "Python was not found…" to stderr and exits non-zero, so Claude
// Code surfaced a "UserPromptSubmit hook error" in the transcript on every
// prompt. The shipped binary is always present and needs no interpreter, so
// pointing the hook at ourselves removes the dependency entirely — the same
// "ship a native binary as the hook command" pattern CCometixLine uses for
// its statusline.
//
// Discipline mirrored from the Python scripts: every path exits 0. A flaky
// forwarder must never block the agent.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};

/// Env injected by Coffee CLI when spawning a tool in a tab (see
/// terminal.rs). Without `COFFEE_CLI_TAB_ID` + `COFFEE_CLI_HOOK_PORT` the
/// forwarder no-ops — that's the gate that keeps the globally-registered
/// Codex `notify` silent for sessions started outside Coffee CLI.
struct HookCtx {
    tab_id: String,
    port: u16,
    tool: String,
}

impl HookCtx {
    fn from_env() -> Option<HookCtx> {
        let tab_id = std::env::var("COFFEE_CLI_TAB_ID")
            .ok()
            .filter(|s| !s.is_empty())?;
        let port = std::env::var("COFFEE_CLI_HOOK_PORT")
            .ok()?
            .parse::<u16>()
            .ok()?;
        let tool = std::env::var("COFFEE_CLI_TOOL").unwrap_or_default();
        Some(HookCtx { tab_id, port, tool })
    }
}

/// `<exe> __hook` — Claude Code stdin hook protocol. Never returns.
pub fn run_claude_hook() -> ! {
    let _ = forward_claude();
    std::process::exit(0);
}

/// `<exe> __codex-notify <json>` — Codex `notify` argv-tail protocol.
/// Never returns.
pub fn run_codex_notify(args: &[String]) -> ! {
    let _ = forward_codex(args);
    std::process::exit(0);
}

/// `<exe> __codex-hook` — Codex hooks system (stdin protocol). Codex writes
/// the hook payload JSON to stdin (same shape as Claude's `__hook`), with
/// `hook_event_name` naming the event. Installed by `install_codex` into
/// ~/.codex/hooks.json for SessionStart / UserPromptSubmit / PermissionRequest
/// / Stop. Never returns.
pub fn run_codex_hook() -> ! {
    let _ = forward_codex_hook();
    std::process::exit(0);
}

/// `<exe> __kimi-hook` — Kimi Code hooks (stdin protocol, Claude-shaped JSON
/// with `hook_event_name`). Installed by `install_kimi` as `[[hooks]]`
/// entries in ~/.kimi-code/config.toml. Kimi may append a hook's stdout to
/// the model context, so this path must stay stdout-silent — we only ever
/// write to the loopback socket. Never returns.
pub fn run_kimi_hook() -> ! {
    let _ = forward_kimi();
    std::process::exit(0);
}

fn forward_claude() -> Option<()> {
    let Some(ctx) = HookCtx::from_env() else {
        debug_log("__hook: no COFFEE_CLI_TAB_ID/PORT env — no-op");
        return None;
    };

    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).ok()?;
    // Tolerate a leading UTF-8 BOM — some shells/redirects prepend one and it
    // would otherwise break JSON parsing.
    let buf = buf.trim_start_matches('\u{feff}');
    let data: Value = match serde_json::from_str(buf) {
        Ok(d) => d,
        Err(_) => {
            debug_log("__hook: stdin JSON parse failed — no-op");
            return None;
        }
    };

    let event = data
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let status = map_claude_status(&data, &event)?;

    let ok = post(ctx.port, &ctx.tab_id, &ctx.tool, &status, &event);
    debug_log(&format!(
        "__hook: event={} status={} post={}",
        event,
        status,
        if ok { "ok" } else { "fail" }
    ));
    Some(())
}

/// Debug trace, gated on COFFEE_HOOK_DEBUG=1. When set, appends one line per
/// invocation to ~/.coffee-cli/hooks/hook-debug.log — agents surface hook
/// failures as a bare "hook exited with code N" with no stderr, so this is
/// the only way to see what the forwarder actually did. Off by default: the
/// hot path stays silent and does zero file I/O.
fn debug_log(msg: &str) {
    if std::env::var_os("COFFEE_HOOK_DEBUG").is_none() {
        return;
    }
    let Some(home) = dirs::home_dir() else { return };
    let dir = home.join(".coffee-cli").join("hooks");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] {}\n", ts, msg);
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("hook-debug.log"))
        .and_then(|mut f| f.write_all(line.as_bytes()));
}

fn forward_codex(args: &[String]) -> Option<()> {
    // Codex appends the event JSON as the FINAL argv argument
    // (codex-rs/hooks/src/legacy_notify.rs). With our registered
    // `notify = ["<exe>", "__codex-notify"]`, argv is
    // [exe, "__codex-notify", "<json>"] so the payload is the last arg.
    // A malformed/absent payload simply fails to parse → no-op.
    let payload = args.last()?;
    let data: Value = serde_json::from_str(payload.trim_start_matches('\u{feff}')).ok()?;

    let ctx = HookCtx::from_env()?;
    // `notify` is global Codex config and fires for sessions started
    // outside Coffee CLI too — gate strictly on the tool tag.
    if ctx.tool != "codex" {
        return None;
    }

    let event = data
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let status = map_codex_status(&event)?;

    post(ctx.port, &ctx.tab_id, &ctx.tool, &status, &event);
    Some(())
}

/// stdin hook path for Codex's hooks system (SessionStart / UserPromptSubmit
/// / PermissionRequest / Stop, installed in ~/.codex/hooks.json). Reads the
/// payload the same way Claude's `__hook` does — Codex writes the event JSON
/// to stdin. `hook_event_name` names the event (same key name as Claude, by
/// coincidence). Gated on COFFEE_CLI_TOOL=codex so a globally-installed hook
/// stays silent for Codex sessions started outside Coffee CLI.
fn forward_codex_hook() -> Option<()> {
    let ctx = HookCtx::from_env()?;
    if ctx.tool != "codex" {
        return None;
    }

    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).ok()?;
    let buf = buf.trim_start_matches('\u{feff}');
    let data: Value = serde_json::from_str(buf).ok()?;

    let event = data
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let status = map_codex_hook_status(&event)?;

    post(ctx.port, &ctx.tab_id, &ctx.tool, &status, &event);
    Some(())
}

/// stdin hook path for Kimi Code (9 events installed as `[[hooks]]` in
/// ~/.kimi-code/config.toml). Reads the payload the same way Claude's
/// `__hook` does — Kimi's hook JSON is Claude-shaped, with
/// `hook_event_name` naming the event. No tool gate needed beyond
/// HookCtx::from_env: kimi sessions started outside Coffee CLI don't carry
/// the COFFEE_CLI_* env vars, so the forwarder no-ops there (same as
/// Claude).
fn forward_kimi() -> Option<()> {
    let ctx = HookCtx::from_env()?;

    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).ok()?;
    // Tolerate a leading UTF-8 BOM (see forward_claude).
    let buf = buf.trim_start_matches('\u{feff}');
    let data: Value = serde_json::from_str(buf).ok()?;

    let event = data
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Stop is step-level in Kimi, not turn-level: the loop fires `Stop` on
    // any step whose finishReason isn't tool_calls/filtered with no pending
    // request — i.e. the model produced plain text and isn't calling another
    // tool *this step*, but the turn may well continue. Mapping Stop→idle
    // here lit the dot green mid-turn (visible as "Using Write" → green).
    // v2 doesn't fire SessionStart/SessionEnd, so there is no reliable
    // turn-end idle signal — we keep the dot on its last known status when
    // Stop/StopFailure fire, and let the frontend 30s auto-idle cover a
    // real turn end. mid-turn green is worse than a late green.
    if let Some(status) = map_kimi_status(&event) {
        post(ctx.port, &ctx.tab_id, &ctx.tool, status, &event);
    }
    Some(())
}

/// Map a Kimi Code hook event to a tab status. Same bucketing strategy as
/// map_claude_status, except `Stop`/`StopFailure` map to None (no update):
/// Kimi fires Stop per step, not per turn, so it is NOT a reliable turn-end
/// idle signal (see forward_kimi). `Interrupt` (user Ctrl-C) and `SessionEnd`
/// are real terminations → idle. PermissionRequest → wait_input; everything
/// else, including unknown/missing event names, is busy (working). Returns
/// None to mean "don't post — keep the last status".
fn map_kimi_status(event: &str) -> Option<&'static str> {
    match event {
        "Interrupt" | "SessionEnd" => Some("idle"),
        "Stop" | "StopFailure" => None,
        "PermissionRequest" => Some("wait_input"),
        // UserPromptSubmit / PreToolUse / PostToolUse / PermissionResult,
        // plus anything unrecognized → busy.
        _ => Some("working"),
    }
}

/// Map a Codex hooks-system event to a tab status. Covers the 4 events we
/// install (SessionStart / UserPromptSubmit / PermissionRequest / Stop) plus
/// the optional PreToolUse/PostToolUse (mapped to working if the user adds
/// them manually). Unknown events → None (no-op, don't guess).
fn map_codex_hook_status(event: &str) -> Option<String> {
    match event {
        "SessionStart" | "Stop" => Some("idle".to_string()),
        "PermissionRequest" => Some("wait_input".to_string()),
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => Some("working".to_string()),
        _ => None,
    }
}

/// Map a Claude Code hook event to a tab status. Mirrors
/// coffee-cli-hook.py exactly: Stop → idle, permission_prompt → wait_input,
/// idle_prompt → idle, everything else busy (working).
fn map_claude_status(data: &Value, event: &str) -> Option<String> {
    match event {
        "Stop" | "StopFailure" => Some("idle".to_string()),
        "Notification" => {
            // Claude has exposed the subtype under different keys across
            // versions — check all three the Python script checked.
            let ntype = data
                .get("notification_type")
                .and_then(|v| v.as_str())
                .or_else(|| data.get("type").and_then(|v| v.as_str()))
                .or_else(|| {
                    data.get("notification")
                        .and_then(|n| n.get("type"))
                        .and_then(|v| v.as_str())
                });
            match ntype {
                Some("permission_prompt") => Some("wait_input".to_string()),
                Some("idle_prompt") => Some("idle".to_string()),
                _ => None,
            }
        }
        // UserPromptSubmit / PreToolUse / PostToolUse / SubagentStart /
        // PreCompact / etc. (and a missing event name) → busy. One bucket,
        // one color.
        _ => Some("working".to_string()),
    }
}

/// Map a Codex `notify` event to a tab status. Codex only signals turn
/// completion (never turn start); unknown types are ignored, not guessed.
fn map_codex_status(event: &str) -> Option<String> {
    match event {
        "agent-turn-complete" => Some("idle".to_string()),
        _ => None,
    }
}

/// One TCP connection per event to the loopback hook server. Every error is
/// swallowed — the forwarder must never block the agent. Returns whether the
/// send succeeded (for the COFFEE_HOOK_DEBUG trace only).
fn post(port: u16, tab_id: &str, tool: &str, status: &str, event: &str) -> bool {
    let payload = json!({
        "tab_id": tab_id,
        "tool": tool,
        "status": status,
        "event": event,
    });
    send(port, &payload).is_ok()
}

fn send(port: u16, payload: &Value) -> std::io::Result<()> {
    let addr = format!("127.0.0.1:{}", port)
        .parse()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "addr"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(1))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.write_all(format!("{}\n", payload).as_bytes())?;
    // Drain the server's tiny ack so it can close cleanly; ignore content.
    let mut ack = [0u8; 256];
    let _ = stream.read(&mut ack);
    Ok(())
}
