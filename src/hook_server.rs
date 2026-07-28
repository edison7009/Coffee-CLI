// Coffee CLI Hook Server
//
// Loopback TCP listener that accepts one JSON line per connection
// from each tool's forwarder script:
//
//   - scripts/coffee-cli-hook.py            — Claude Code stdin hooks
//   - scripts/coffee-cli-codex-notify.py    — Codex `notify` argv-tail
//   - scripts/coffee-cli-opencode-plugin.js — OpenCode plugin events
//   - `<exe> __kimi-hook` (hook_forwarder.rs) — Kimi Code [[hooks]] events
//
// Single payload kind:
//
//   - **Status** payload (status field present):
//       `{tab_id, tool, status, event}` → emit `agent-status` event
//       to the frontend's tab indicators.
//
// Payloads may also carry `session_id` / `transcript_path` / `cwd` —
// cached per tab in SESSION_META and used by the `get_last_agent_reply`
// command to locate the tab's transcript file.
//
// File-edit attribution per AI tool was removed in v2.7.x —
// ChangesBoard is now sourced from a folder snapshot diff
// (`compute_folder_stats` Tauri command, tool-agnostic by design).
// `path` / `action` fields are kept in the wire payload for
// backward compat with installed hook scripts; they are ignored.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Wire payload received from a forwarder script. Serde ignores
/// unknown fields by default, so stale forwarder scripts left over
/// from v2.6.x that still include `path` / `action` / `cwd` are
/// accepted gracefully — those fields are simply discarded.
#[derive(Debug, Clone, Deserialize)]
pub struct HookPayload {
    pub tab_id: String,
    pub tool: String,
    /// "idle" | "working" | "wait_input" — drives the tab dot.
    pub status: Option<String>,
    /// Hook event name (Claude: PostToolUse / Notification / Stop;
    /// Codex: agent-turn-complete; OpenCode: session.status / etc.).
    pub event: Option<String>,
    /// Session identifier, when the tool's hook payload carries one
    /// (Claude/Codex/Kimi: session_id; Hermes plugin: session token).
    /// Cached in SESSION_META so `get_last_agent_reply` can locate the
    /// tab's transcript without guessing from the cwd.
    pub session_id: Option<String>,
    /// Direct path to the session transcript file (Claude hooks send
    /// `transcript_path` in the stdin JSON). Most precise locator — used
    /// first when present.
    pub transcript_path: Option<String>,
    /// Working directory of the agent session — fallback locator for
    /// tools whose transcripts are found by cwd match (Codex rollouts).
    pub cwd: Option<String>,
}

/// Per-tab session metadata, upserted from hook payloads that carry it.
/// Read by the `get_last_agent_reply` Tauri command (src/server.rs) to
/// find the tab's transcript file / session token.
#[derive(Debug, Clone, Default)]
pub struct SessionMeta {
    pub tool: String,
    pub session_id: Option<String>,
    pub transcript_path: Option<String>,
    pub cwd: Option<String>,
}

static SESSION_META: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, SessionMeta>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Snapshot the session metadata for a tab. None when no hook carrying
/// metadata has fired for this tab yet.
pub fn session_meta(tab_id: &str) -> Option<SessionMeta> {
    SESSION_META.lock().ok()?.get(tab_id).cloned()
}

/// Upsert metadata from a payload — any field present overwrites, absent
/// fields keep their previous value (hooks don't all carry the same keys).
fn update_session_meta(payload: &HookPayload) {
    if payload.session_id.is_none() && payload.transcript_path.is_none() && payload.cwd.is_none() {
        return;
    }
    let Ok(mut map) = SESSION_META.lock() else { return };
    let meta = map.entry(payload.tab_id.clone()).or_insert_with(|| SessionMeta {
        tool: payload.tool.clone(),
        ..Default::default()
    });
    meta.tool = payload.tool.clone();
    if payload.session_id.is_some() {
        meta.session_id = payload.session_id.clone();
    }
    if payload.transcript_path.is_some() {
        meta.transcript_path = payload.transcript_path.clone();
    }
    if payload.cwd.is_some() {
        meta.cwd = payload.cwd.clone();
    }
}

/// Frontend payload for the `agent-status` Tauri event — unchanged
/// shape from v2.6.x so existing TS subscribers keep working.
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusEvent {
    pub tab_id: String,
    pub tool: String,
    pub status: String,
    pub event: String,
}

/// Bind a loopback TCP listener on an OS-assigned port, return the port, and
/// hand the listener off to an async accept loop.
pub fn start(app: AppHandle) -> anyhow::Result<u16> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    std_listener.set_nonblocking(true)?;
    let port = std_listener.local_addr()?.port();
    eprintln!("[hook-server] listening on 127.0.0.1:{}", port);

    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[hook-server] from_std failed: {}", e);
                return;
            }
        };
        loop {
            match listener.accept().await {
                Ok((socket, _)) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_conn(app, socket).await;
                    });
                }
                Err(e) => {
                    eprintln!("[hook-server] accept error: {}", e);
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    });

    Ok(port)
}

async fn handle_conn(app: AppHandle, socket: tokio::net::TcpStream) {
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    if let Err(e) = reader.read_line(&mut line).await {
        eprintln!("[hook-server] read error: {}", e);
        return;
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    match serde_json::from_str::<HookPayload>(trimmed) {
        Ok(payload) => dispatch(&app, payload),
        Err(e) => {
            eprintln!("[hook-server] bad JSON ({}): {}", e, trimmed);
        }
    }
    let _ = reader.into_inner().write_all(b"{}\n").await;
}

/// Translate a hook payload into a Tauri event. Only the `status`
/// path remains — see file-level doc for why per-tool file-edit
/// attribution was removed.
fn dispatch(app: &AppHandle, payload: HookPayload) {
    update_session_meta(&payload);
    if let Some(status) = payload.status.as_deref() {
        let evt = AgentStatusEvent {
            tab_id: payload.tab_id.clone(),
            tool: payload.tool.clone(),
            status: status.to_string(),
            event: payload.event.clone().unwrap_or_default(),
        };
        eprintln!(
            "[hook-server] {} {} → {}",
            evt.tool, evt.event, evt.status
        );
        let _ = app.emit("agent-status", &evt);
    }
}
