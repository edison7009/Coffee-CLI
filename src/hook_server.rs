// Coffee CLI Hook Server
//
// Accepts connections from coffee-cli-hook.py on a loopback-only TCP port,
// parses one JSON line per connection, and forwards the payload to the
// frontend as a Tauri `agent-status` event. The frontend maps tab_id back
// to a terminal session and dispatches the tab-indicator state change.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookPayload {
    pub tab_id: String,
    pub tool: String,
    pub status: String, // "idle" | "executing" | "wait_input"
    pub event: String,
}

/// Bind a loopback TCP listener on an OS-assigned port, return the port, and
/// hand the listener off to an async accept loop.
pub fn start(app: AppHandle) -> anyhow::Result<u16> {
    // Bind synchronously so the caller can retrieve the port before the
    // first tab ever spawns.
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
        Ok(payload) => {
            eprintln!(
                "[hook-server] {} {} → {}",
                payload.tool, payload.event, payload.status
            );
            let _ = app.emit("agent-status", &payload);
        }
        Err(e) => {
            eprintln!("[hook-server] bad JSON ({}): {}", e, trimmed);
        }
    }
    let _ = reader.into_inner().write_all(b"{}\n").await;
}
