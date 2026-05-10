// Coffee CLI Hook Server
//
// Loopback TCP listener that accepts one JSON line per connection
// from each tool's forwarder script:
//
//   - scripts/coffee-cli-hook.py            — Claude Code stdin hooks
//   - scripts/coffee-cli-codex-notify.py    — Codex `notify` argv-tail
//   - scripts/coffee-cli-opencode-plugin.js — OpenCode plugin events
//
// Two payload kinds, distinguished by which optional fields are
// present (we don't require an explicit `kind` field — keeps backward
// compat with already-deployed forwarder scripts that only know about
// the original status protocol):
//
//   - **Status** payload (status field present):
//       `{tab_id, tool, status, event}` → emit `agent-status` event
//       to the frontend's tab indicators. This is the original
//       protocol, unchanged from v2.6.x.
//
//   - **File-edit** payload (path field present):
//       `{tab_id, tool, path, action}` → look up the file's diff
//       against the global baseline, emit `tool-file-edit` event
//       with `{tab_id, tool, path, action, added, deleted, mtime_ms}`
//       so the frontend can place the row in the audit log.
//
//   - **Turn-snapshot** payload (cwd field present):
//       `{tab_id, tool, status, event, cwd}` (a status payload that
//       also carries the agent's cwd). When `tool=codex` and
//       `event=agent-turn-complete`, walk `cwd`, diff against the
//       global baseline, and emit one `tool-file-edit` per drifted
//       file. This is how Codex (which has no per-call hook)
//       contributes to the audit log.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

/// Wire payload received from a forwarder script. All fields after
/// `tab_id` / `tool` are optional so a single shape accepts both
/// kinds (status and file-edit). Dispatch picks based on which
/// optional fields arrived.
#[derive(Debug, Clone, Deserialize)]
pub struct HookPayload {
    pub tab_id: String,
    pub tool: String,
    // ── Status-event fields ────────────────────────────────────
    /// "idle" | "working" | "wait_input" — drives the tab dot.
    pub status: Option<String>,
    /// Hook event name (Claude: PostToolUse / Notification / Stop;
    /// Codex: agent-turn-complete; OpenCode: session.status / etc.).
    pub event: Option<String>,
    // ── File-edit fields ───────────────────────────────────────
    /// Absolute path the upstream tool just edited. Forward slashes
    /// or backslashes are both fine (we normalize on the way in).
    pub path: Option<String>,
    /// "edit" | "create" | "delete" — used by the audit row to show
    /// the right icon. Optional; defaults to "edit" when missing.
    pub action: Option<String>,
    // ── Turn-snapshot fields ───────────────────────────────────
    /// Working directory of the agent. Codex's notify forwarder
    /// includes this so the hook server can walk it on
    /// agent-turn-complete and emit per-file events.
    pub cwd: Option<String>,
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

/// Frontend payload for the `tool-file-edit` Tauri event. One per
/// reported file edit (or per drifted file in a turn snapshot).
/// Frontend dispatches RECORD_TOOL_FILE_EDIT into globalChangeLog.
#[derive(Debug, Clone, Serialize)]
pub struct ToolFileEditEvent {
    pub tab_id: String,
    pub tool: String,
    pub path: String,
    pub action: String,
    pub added: u32,
    pub deleted: u32,
    pub mtime_ms: i64,
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

/// Pick which Tauri event(s) to emit based on which optional fields
/// the payload populated. Order matters: a single payload may
/// trigger multiple events (e.g. Codex turn-complete is BOTH a
/// status update AND triggers a folder diff).
fn dispatch(app: &AppHandle, payload: HookPayload) {
    let tool_id = payload.tool.clone();

    // 1. Status update (every payload with `status` populated).
    if let Some(status) = payload.status.as_deref() {
        let evt = AgentStatusEvent {
            tab_id: payload.tab_id.clone(),
            tool: tool_id.clone(),
            status: status.to_string(),
            event: payload.event.clone().unwrap_or_default(),
        };
        eprintln!(
            "[hook-server] {} {} → {}",
            evt.tool, evt.event, evt.status
        );
        let _ = app.emit("agent-status", &evt);
    }

    // 2. Per-call file edit (Claude / OpenCode forwarders).
    if let Some(path) = payload.path.as_deref() {
        let action = payload.action.clone().unwrap_or_else(|| "edit".to_string());
        emit_file_edit(app, &payload.tab_id, &tool_id, path, action);
    }

    // 3. Turn-snapshot (Codex `agent-turn-complete` with cwd). One
    //    forwarder payload fans out to N file-edit events.
    if let (Some(cwd), Some(event)) = (payload.cwd.as_deref(), payload.event.as_deref()) {
        if tool_id == "codex" && event == "agent-turn-complete" {
            for (path, added, deleted, mtime_ms) in
                crate::server::diff_folder_against_baseline(cwd)
            {
                let evt = ToolFileEditEvent {
                    tab_id: payload.tab_id.clone(),
                    tool: tool_id.clone(),
                    path,
                    action: "edit".to_string(),
                    added,
                    deleted,
                    mtime_ms,
                };
                let _ = app.emit("tool-file-edit", &evt);
            }
        }
    }
}

/// Emit one `tool-file-edit` event for a per-call hook. Computes
/// the diff stats against the global baseline before emitting; the
/// frontend treats the payload as authoritative.
fn emit_file_edit(
    app: &AppHandle,
    tab_id: &str,
    tool: &str,
    path: &str,
    action: String,
) {
    let normalized = path.replace('\\', "/");
    // Delete events: the file is gone, no diff to compute. Emit a
    // bare event so the frontend can show "deleted" in the row;
    // mtime/added/deleted set to 0.
    if action == "delete" {
        let evt = ToolFileEditEvent {
            tab_id: tab_id.to_string(),
            tool: tool.to_string(),
            path: normalized,
            action,
            added: 0,
            deleted: 0,
            mtime_ms: 0,
        };
        let _ = app.emit("tool-file-edit", &evt);
        return;
    }
    // Edit / create: compute diff against baseline. If the file
    // isn't readable as text or exceeds the cap, skip the event
    // entirely (the audit list never had visibility into binary
    // / huge files anyway).
    if let Some((added, deleted, mtime_ms)) = crate::server::compute_single_file_stats(&normalized)
    {
        let evt = ToolFileEditEvent {
            tab_id: tab_id.to_string(),
            tool: tool.to_string(),
            path: normalized,
            action,
            added,
            deleted,
            mtime_ms,
        };
        let _ = app.emit("tool-file-edit", &evt);
    }
}
