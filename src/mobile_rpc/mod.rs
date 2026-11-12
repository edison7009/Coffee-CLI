//! Mobile companion RPC (protocol v0, see `mobile/PROTOCOL.md`).
//!
//! Off by default. When enabled, a WebSocket listener on the LAN lets a paired
//! phone list sessions, replay and follow terminal output and structured
//! conversation events, and send input. Session listing and conversation sends
//! are delegated to the main window (`mobile-rpc-request`) so they take the
//! exact path the desktop UI uses.
//!
//! v0 authenticates with a shared pairing token over plain WebSocket. The
//! encrypted handshake from the protocol draft replaces it before this ships.

mod buffers;
mod config;

use buffers::{Buffers, Replay};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub const PROTOCOL: u64 = 0;
const MAX_CLIENTS: usize = 8;
const CLIENT_QUEUE: usize = 1024;
const MAX_FRAME: usize = 1 << 20;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const GUI_TIMEOUT: Duration = Duration::from_secs(30);

/// Events forwarded to phones, with the stream kind each one feeds.
const CONVERSATION_EVENTS: [(&str, &str); 5] = [
    ("claude-session-event", "claude"),
    ("codex-session-event", "codex"),
    ("opencode-session-event", "opencode"),
    ("pi-session-event", "pi"),
    ("dsh-session-event", "dsh"),
];

struct Client {
    tx: mpsc::Sender<Value>,
    subscriptions: Mutex<HashSet<String>>,
    /// Set when output was dropped for a session because the queue was full.
    resync: Mutex<HashSet<String>>,
}

#[derive(Default)]
struct Hub {
    app: Mutex<Option<AppHandle>>,
    enabled: AtomicBool,
    listening: AtomicBool,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    buffers: Mutex<Buffers>,
    clients: Mutex<HashMap<u64, Arc<Client>>>,
    next_client: AtomicU64,
    connections: AtomicUsize,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    seq: AtomicU64,
}

fn hub() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(Hub::default)
}

/// Called once from setup: listens to desktop events and starts the server when
/// the user enabled it earlier.
pub fn init(app: &AppHandle) {
    *hub().app.lock().unwrap() = Some(app.clone());
    app.listen_any("tier-terminal-output", |event| {
        let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else { return };
        let (Some(id), Some(data)) = (payload["id"].as_str(), payload["data"].as_str()) else { return };
        record_terminal(id, data);
    });
    for name in ["tier-terminal-status", "tier-terminal-exit"] {
        app.listen_any(name, |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else { return };
            if let Some(id) = payload["id"].as_str() { broadcast_all(json!({"event":"session.changed","params":{"id":id}})); }
        });
    }
    for (name, kind) in CONVERSATION_EVENTS {
        app.listen_any(name, move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else { return };
            record_conversation(kind, payload);
        });
    }
    app.listen_any("agent-conversations-changed", |_| broadcast_all(json!({"event":"session.changed","params":{"kind":"agent"}})));
    let saved = config::load();
    if saved.enabled { let _ = start(saved); }
}

fn active() -> bool { hub().enabled.load(Ordering::Relaxed) }

fn record_terminal(id: &str, data: &str) {
    if !active() { return; }
    hub().buffers.lock().unwrap().push_terminal(id, data);
    deliver(id, json!({"event":"terminal.output","params":{"id":id,"data":data}}));
}

fn record_conversation(kind: &str, payload: Value) {
    if !active() { return; }
    let (Some(id), Some(generation)) = (payload["id"].as_str().map(str::to_owned), payload["generation"].as_str().map(str::to_owned)) else { return };
    let event = payload["event"].clone();
    hub().buffers.lock().unwrap().push_conversation(&id, kind, &generation, event.clone());
    deliver(&id, json!({"event":"conversation.event","params":{"id":id,"kind":kind,"generation":generation,"payload":event}}));
}

fn next_seq(mut frame: Value) -> Value {
    frame["seq"] = json!(hub().seq.fetch_add(1, Ordering::Relaxed));
    frame
}

/// Sends to clients subscribed to `id`. A full queue never blocks the PTY or
/// session reader: the client is told to resubscribe instead.
fn deliver(id: &str, frame: Value) {
    let frame = next_seq(frame);
    for client in hub().clients.lock().unwrap().values() {
        if !client.subscriptions.lock().unwrap().contains(id) { continue; }
        if client.tx.try_send(frame.clone()).is_err() {
            client.resync.lock().unwrap().insert(id.to_owned());
        }
    }
}

fn broadcast_all(frame: Value) {
    if !active() { return; }
    let frame = next_seq(frame);
    for client in hub().clients.lock().unwrap().values() { let _ = client.tx.try_send(frame.clone()); }
}

// ─── Server lifecycle ─────────────────────────────────────

fn start(settings: config::Settings) -> Result<(), String> {
    let h = hub();
    if h.listening.swap(true, Ordering::SeqCst) { h.enabled.store(true, Ordering::SeqCst); return Ok(()); }
    let std_listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, settings.port)))
        .map_err(|e| { h.listening.store(false, Ordering::SeqCst); format!("Port {} unavailable: {e}", settings.port) })?;
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let (stop_tx, mut stop_rx) = oneshot::channel();
    *h.stop.lock().unwrap() = Some(stop_tx);
    h.enabled.store(true, Ordering::SeqCst);
    let token = Arc::new(settings.token);
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(std_listener) { Ok(l) => l, Err(e) => { log::warn!("[mobile_rpc] {e}"); hub().listening.store(false, Ordering::SeqCst); return } };
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    if hub().connections.fetch_add(1, Ordering::SeqCst) >= MAX_CLIENTS { hub().connections.fetch_sub(1, Ordering::SeqCst); continue; }
                    let token = token.clone();
                    tauri::async_runtime::spawn(async move {
                        serve(stream, &token).await;
                        hub().connections.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
        }
        hub().listening.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn stop() {
    let h = hub();
    h.enabled.store(false, Ordering::SeqCst);
    if let Some(stop) = h.stop.lock().unwrap().take() { let _ = stop.send(()); }
    // Dropping senders ends every client's writer, which closes its socket.
    h.clients.lock().unwrap().clear();
    h.buffers.lock().unwrap().clear();
}

async fn serve(stream: TcpStream, token: &str) {
    let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
    let (mut sink, mut source) = socket.split();
    // The first frame must be a hello carrying the pairing token.
    let hello = tokio::time::timeout(HELLO_TIMEOUT, source.next()).await;
    let Ok(Some(Ok(Message::Text(text)))) = hello else { return };
    let Ok(request) = serde_json::from_str::<Value>(&text) else { return };
    let reply = match check_hello(&request, token) {
        Ok(result) => json!({"id":request["id"],"result":result}),
        Err(error) => { let _ = sink.send(Message::text(json!({"id":request["id"],"error":error}).to_string())).await; return }
    };
    if sink.send(Message::text(reply.to_string())).await.is_err() { return }

    let (tx, mut rx) = mpsc::channel::<Value>(CLIENT_QUEUE);
    let client = Arc::new(Client { tx, subscriptions: Mutex::default(), resync: Mutex::default() });
    let client_id = hub().next_client.fetch_add(1, Ordering::SeqCst);
    hub().clients.lock().unwrap().insert(client_id, client.clone());
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink.send(Message::text(frame.to_string())).await.is_err() { break; }
        }
        let _ = sink.close().await;
    });
    while let Some(Ok(message)) = source.next().await {
        let text = match message { Message::Text(text) => text, Message::Close(_) => break, _ => continue };
        if text.len() > MAX_FRAME { break; }
        let Ok(request) = serde_json::from_str::<Value>(&text) else { continue };
        let client = client.clone();
        tauri::async_runtime::spawn(async move {
            let id = request["id"].clone();
            let frame = match handle(&client, &request).await {
                Ok(result) => json!({"id":id,"result":result}),
                Err((code, message)) => json!({"id":id,"error":{"code":code,"message":message}}),
            };
            let _ = client.tx.send(frame).await;
            flush_resync(&client).await;
        });
        if !active() { break; }
    }
    hub().clients.lock().unwrap().remove(&client_id);
    drop(client);
    writer.abort();
}

async fn flush_resync(client: &Client) {
    let ids: Vec<String> = client.resync.lock().unwrap().drain().collect();
    for id in ids { let _ = client.tx.send(next_seq(json!({"event":"terminal.resync","params":{"id":id}}))).await; }
}

fn check_hello(request: &Value, token: &str) -> Result<Value, Value> {
    if request["method"] != "hello" { return Err(json!({"code":"unauthorized","message":"hello required"})); }
    let params = &request["params"];
    if params["protocol"].as_u64() != Some(PROTOCOL) {
        return Err(json!({"code":"unsupported","message":"protocol mismatch","minProtocol":PROTOCOL}));
    }
    if !config::token_matches(params["token"].as_str().unwrap_or(""), token) {
        return Err(json!({"code":"unauthorized","message":"pairing token rejected"}));
    }
    Ok(json!({
        "protocol": PROTOCOL,
        "desktopVersion": env!("CARGO_PKG_VERSION"),
        "computerName": crate::server::computer_name_value(),
        "capabilities": ["terminal", "conversation"],
    }))
}

type RpcError = (&'static str, String);

async fn handle(client: &Client, request: &Value) -> Result<Value, RpcError> {
    let params = &request["params"];
    let id = || params["id"].as_str().map(str::to_owned).ok_or(("invalid_params", "id required".to_string()));
    match request["method"].as_str().unwrap_or("") {
        "ping" => Ok(json!({"t": chrono::Utc::now().timestamp_millis()})),
        "session.list" => gui("session.list", json!({})).await,
        "session.subscribe" => {
            let id = id()?;
            client.subscriptions.lock().unwrap().insert(id.clone());
            client.resync.lock().unwrap().remove(&id);
            let replay = hub().buffers.lock().unwrap().replay(&id);
            Ok(match replay {
                Replay::Terminal(snapshot) => json!({"view":"terminal","snapshot":snapshot}),
                Replay::Conversation { kind, generation, events } => json!({"view":"conversation","kind":kind,"generation":generation,"events":events}),
                Replay::Empty => json!({"view":null}),
            })
        }
        "session.unsubscribe" => { client.subscriptions.lock().unwrap().remove(&id()?); Ok(json!({})) }
        "session.input" => {
            let data = params["data"].as_str().ok_or(("invalid_params", "data required".to_string()))?;
            write_terminal(&id()?, data).map(|_| json!({}))
        }
        "session.interrupt" => {
            let id = id()?;
            if write_terminal(&id, "\u{3}").is_ok() { return Ok(json!({})); }
            gui("conversation.cancel", json!({"id":id})).await
        }
        "conversation.send" => {
            let text = params["text"].as_str().filter(|t| !t.trim().is_empty() && t.len() <= 100_000).ok_or(("invalid_params", "text required".to_string()))?;
            gui("conversation.send", json!({"id":id()?,"text":text})).await
        }
        "conversation.cancel" => gui("conversation.cancel", json!({"id":id()?})).await,
        _ => Err(("unsupported", "unknown method".into())),
    }
}

fn write_terminal(id: &str, data: &str) -> Result<(), RpcError> {
    let app = hub().app.lock().unwrap().clone().ok_or(("internal", "app unavailable".to_string()))?;
    let writer = {
        let state = app.state::<crate::server::AppState>();
        let map = state.terminal_session.lock().unwrap();
        map.get(id).map(|s| s.writer_lock.clone()).ok_or(("not_found", "no terminal session".to_string()))?
    };
    use std::io::Write;
    let mut w = writer.lock().map_err(|_| ("internal", "writer poisoned".to_string()))?;
    w.write_all(data.as_bytes()).and_then(|_| w.flush()).map_err(|e| ("internal", e.to_string()))
}

/// Asks the main window to run `method` and waits for `mobile_rpc_resolve`.
async fn gui(method: &str, params: Value) -> Result<Value, RpcError> {
    let app = hub().app.lock().unwrap().clone().ok_or(("internal", "app unavailable".to_string()))?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    hub().pending.lock().unwrap().insert(request_id.clone(), tx);
    if app.emit_to("main", "mobile-rpc-request", json!({"requestId":request_id,"method":method,"params":params})).is_err() {
        hub().pending.lock().unwrap().remove(&request_id);
        return Err(("internal", "Coffee window unavailable".into()));
    }
    let result = tokio::time::timeout(GUI_TIMEOUT, rx).await;
    hub().pending.lock().unwrap().remove(&request_id);
    let value = result.map_err(|_| ("busy", "desktop did not answer".to_string()))?.map_err(|_| ("internal", "request dropped".to_string()))?;
    if value["ok"] == true { Ok(value["result"].clone()) } else {
        let code = match value["code"].as_str() { Some("not_found") => "not_found", Some("busy") => "busy", _ => "internal" };
        Err((code, value["error"].as_str().unwrap_or("failed").to_owned()))
    }
}

// ─── Tauri commands ───────────────────────────────────────

fn status_value() -> Value {
    let settings = config::load();
    json!({
        "enabled": active(),
        "port": settings.port,
        "token": settings.token,
        "clients": hub().clients.lock().unwrap().len(),
        "protocol": PROTOCOL,
    })
}

#[tauri::command]
pub fn mobile_rpc_status() -> Value { status_value() }

#[tauri::command]
pub fn mobile_rpc_set_enabled(enabled: bool) -> Result<Value, String> {
    let mut settings = config::load();
    if enabled { start(settings.clone())?; } else { stop(); }
    settings.enabled = enabled;
    config::save(&settings)?;
    Ok(status_value())
}

#[tauri::command]
pub fn mobile_rpc_rotate_token() -> Result<Value, String> {
    let mut settings = config::load();
    settings.token = config::new_token();
    config::save(&settings)?;
    // Paired phones must reconnect with the new token; restart drops them.
    if active() { stop(); start(settings)?; }
    Ok(status_value())
}

#[tauri::command]
pub fn mobile_rpc_resolve(request_id: String, result: Value) -> Result<(), String> {
    let sender = hub().pending.lock().unwrap().remove(&request_id).ok_or("Request expired")?;
    sender.send(result).map_err(|_| "Request expired".into())
}

#[cfg(test)]
mod tests;
