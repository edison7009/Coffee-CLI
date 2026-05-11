// Coffee CLI Hook Server
//
// Loopback TCP listener that accepts one JSON line per connection
// from each tool's forwarder script:
//
//   - scripts/coffee-cli-hook.py            — Claude Code stdin hooks
//   - scripts/coffee-cli-codex-notify.py    — Codex `notify` argv-tail
//   - scripts/coffee-cli-opencode-plugin.js — OpenCode plugin events
//
// Single payload kind:
//
//   - **Status** payload (status field present):
//       `{tab_id, tool, status, event}` → emit `agent-status` event
//       to the frontend's tab indicators.
//
// File-edit attribution per AI tool was removed in v2.7.x —
// ChangesBoard is now sourced from a folder snapshot diff
// (`compute_folder_stats` Tauri command, tool-agnostic by design).
// `path` / `action` / `cwd` fields are kept in the wire payload for
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
