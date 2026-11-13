//! Mobile companion RPC (protocol v0, see `mobile/PROTOCOL.md`).
//!
//! Off by default. When enabled, a WebSocket listener on the LAN lets a paired
//! phone list sessions, replay and follow terminal output and structured
//! conversation events, and send input. Session listing and conversation sends
//! are delegated to the main window (`mobile-rpc-request`) so they take the
//! exact path the desktop UI uses.
//!
//! Every connection is end-to-end encrypted with Noise `IKpsk2` (see
//! `secure.rs`): phones pair once with a one-time QR code, then reconnect
//! with their own static key.

mod buffers;
mod config;
mod firewall;
mod network;
mod remote_ui;
mod secure;

use buffers::{Buffers, Replay};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
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
const PAIRING_TTL: Duration = Duration::from_secs(300);
/// How long the desktop prompt waits for the person to allow a new phone.
#[cfg_attr(test, allow(dead_code))]
const PAIRING_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// Events forwarded to phones, with the stream kind each one feeds.
const CONVERSATION_EVENTS: [(&str, &str); 5] = [
    ("claude-session-event", "claude"),
    ("codex-session-event", "codex"),
    ("opencode-session-event", "opencode"),
    ("pi-session-event", "pi"),
    ("dsh-session-event", "dsh"),
];

struct Client {
    /// Hex public key of the paired phone, so revocation can drop it.
    device: String,
    /// Fired on revocation or shutdown to close the socket immediately.
    kill: tokio::sync::Notify,
    tx: mpsc::Sender<Value>,
    subscriptions: Mutex<HashSet<String>>,
    /// Set when output was dropped for a session because the queue was full.
    resync: Mutex<HashSet<String>>,
    /// Runs the desktop UI (`?remote`): receives raw desktop events.
    ui: AtomicBool,
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
    /// One active pairing code and its expiry; consumed by the first attempt.
    pairing: Mutex<Option<(String, Instant)>>,
    /// Serialises config writes from pairing and revocation.
    config_lock: Mutex<()>,
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
    for name in remote_ui::FORWARDED_EVENTS {
        app.listen_any(name, move |event| {
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else { return };
            deliver_ui(name, payload);
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

/// Raw desktop events for phones running the desktop UI. Dropped (not
/// queued) when a phone falls behind; its reducers resync on reconnect.
fn deliver_ui(name: &str, payload: Value) {
    if !active() { return; }
    let frame = next_seq(json!({"event":"tauri.event","params":{"event":name,"payload":payload}}));
    for client in hub().clients.lock().unwrap().values() {
        if client.ui.load(Ordering::Relaxed) { let _ = client.tx.try_send(frame.clone()); }
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
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(std_listener) { Ok(l) => l, Err(e) => { log::warn!("[mobile_rpc] {e}"); hub().listening.store(false, Ordering::SeqCst); return } };
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    if hub().connections.fetch_add(1, Ordering::SeqCst) >= MAX_CLIENTS { hub().connections.fetch_sub(1, Ordering::SeqCst); continue; }
                    tauri::async_runtime::spawn(async move {
                        serve(stream).await;
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
    for client in h.clients.lock().unwrap().drain().map(|(_, c)| c) { client.kill.notify_one(); }
    h.buffers.lock().unwrap().clear();
}

async fn serve(stream: TcpStream) {
    let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
    let (mut sink, mut source) = socket.split();
    let Some((client_device, channel)) = handshake(&mut sink, &mut source).await else { return };
    let channel = Arc::new(channel);

    let (tx, mut rx) = mpsc::channel::<Value>(CLIENT_QUEUE);
    let client = Arc::new(Client { device: client_device, kill: tokio::sync::Notify::new(), tx, subscriptions: Mutex::default(), resync: Mutex::default(), ui: AtomicBool::new(false) });
    let client_id = hub().next_client.fetch_add(1, Ordering::SeqCst);
    hub().clients.lock().unwrap().insert(client_id, client.clone());
    let writer_channel = channel.clone();
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let Ok(sealed) = writer_channel.encrypt(frame.to_string().as_bytes()) else { break };
            if sink.send(Message::binary(sealed)).await.is_err() { break; }
        }
        let _ = sink.close().await;
    });
    loop {
        let message = tokio::select! {
            _ = client.kill.notified() => break,
            message = source.next() => match message { Some(Ok(message)) => message, _ => break },
        };
        let sealed = match message { Message::Binary(bytes) => bytes, Message::Close(_) => break, Message::Ping(_) | Message::Pong(_) => continue, _ => break };
        if sealed.len() > MAX_FRAME * 2 { break; }
        // A frame that fails to decrypt means tampering or desync: drop the connection.
        let Ok(plain) = channel.decrypt(&sealed) else { break };
        if plain.len() > MAX_FRAME { break; }
        let Ok(request) = serde_json::from_slice::<Value>(&plain) else { continue };
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
    // Aborting the writer drops the socket sink, which closes the connection.
    writer.abort();
}

type Sink = futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<TcpStream>, Message>;
type Source = futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<TcpStream>>;

async fn next_binary(source: &mut Source) -> Option<Vec<u8>> {
    match tokio::time::timeout(HELLO_TIMEOUT, source.next()).await {
        Ok(Some(Ok(Message::Binary(bytes)))) if bytes.len() <= MAX_FRAME => Some(bytes.to_vec()),
        _ => None,
    }
}

/// Noise handshake, then an encrypted `hello`. Unknown phones and wrong
/// pairing codes are dropped without an explanation.
async fn handshake(sink: &mut Sink, source: &mut Source) -> Option<(String, secure::Channel)> {
    let first = next_binary(source).await?;
    let (&mode, msg1) = first.split_first()?;
    let psk = match mode {
        secure::MODE_RESUME => [0u8; 32],
        // Any pairing attempt consumes the code, so it cannot be guessed repeatedly.
        secure::MODE_PAIR => {
            let (code, expires) = hub().pairing.lock().unwrap().take()?;
            if Instant::now() > expires { return None; }
            secure::pairing_psk(&code)
        }
        _ => return None,
    };
    let settings = config::load();
    let (msg2, remote, channel) = secure::respond(&settings.private_bytes(), msg1, &psk).ok()?;
    if mode == secure::MODE_RESUME && !settings.knows(&remote) { return None; }
    sink.send(Message::binary(msg2)).await.ok()?;

    // The phone's first encrypted frame proves it completed the handshake
    // (and, when pairing, that it knew the code).
    let plain = channel.decrypt(&next_binary(source).await?).ok()?;
    let request: Value = serde_json::from_slice(&plain).ok()?;
    let reply = match check_hello(&request) {
        Ok(result) => json!({"id":request["id"],"result":result}),
        Err(error) => {
            if let Ok(sealed) = channel.encrypt(json!({"id":request["id"],"error":error}).to_string().as_bytes()) { let _ = sink.send(Message::binary(sealed)).await; }
            return None;
        }
    };
    let device = hex::encode(&remote);
    if mode == secure::MODE_PAIR {
        let name = request["params"]["deviceName"].as_str().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Phone").chars().filter(|c| !c.is_control()).take(64).collect::<String>();
        // The person at the desktop confirms the phone by name before it is trusted.
        let accepted = confirm_pairing(&name).await;
        if !accepted {
            if let Ok(sealed) = channel.encrypt(json!({"id":request["id"],"error":{"code":"unauthorized","message":"pairing declined"}}).to_string().as_bytes()) { let _ = sink.send(Message::binary(sealed)).await; }
            return None;
        }
        register_device(&device, &name).ok()?;
    }
    sink.send(Message::binary(channel.encrypt(reply.to_string().as_bytes()).ok()?)).await.ok()?;
    Some((device, channel))
}

#[cfg(not(test))]
async fn confirm_pairing(name: &str) -> bool {
    gui_with_timeout("pair.confirm", json!({"name": name}), PAIRING_CONFIRM_TIMEOUT).await.is_ok_and(|result| result["accepted"] == true)
}

/// Tests have no window; they decide through `TEST_PAIRING_ANSWER`.
#[cfg(test)]
async fn confirm_pairing(_name: &str) -> bool { tests::TEST_PAIRING_ANSWER.load(Ordering::SeqCst) }

fn register_device(public_key: &str, name: &str) -> Result<(), String> {
    let _guard = hub().config_lock.lock().unwrap();
    let mut settings = config::load();
    settings.devices.retain(|d| d.public_key != public_key);
    settings.devices.push(config::Device { public_key: public_key.into(), name: name.into(), paired_at: chrono::Utc::now().timestamp_millis() });
    config::save(&settings)?;
    broadcast_desktop_devices();
    Ok(())
}

fn broadcast_desktop_devices() {
    if let Some(app) = hub().app.lock().unwrap().clone() { let _ = app.emit_to("main", "mobile-rpc-devices", status_value()); }
}

async fn flush_resync(client: &Client) {
    let ids: Vec<String> = client.resync.lock().unwrap().drain().collect();
    for id in ids { let _ = client.tx.send(next_seq(json!({"event":"terminal.resync","params":{"id":id}}))).await; }
}

fn check_hello(request: &Value) -> Result<Value, Value> {
    if request["method"] != "hello" { return Err(json!({"code":"unauthorized","message":"hello required"})); }
    let params = &request["params"];
    if params["protocol"].as_u64() != Some(PROTOCOL) {
        return Err(json!({"code":"unsupported","message":"protocol mismatch","minProtocol":PROTOCOL}));
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
        "ui.subscribe" => { client.ui.store(true, Ordering::Relaxed); Ok(json!({"events": remote_ui::FORWARDED_EVENTS})) }
        "ui.invoke" => {
            let app = hub().app.lock().unwrap().clone().ok_or(("internal", "app unavailable".to_string()))?;
            let cmd = params["cmd"].as_str().ok_or(("invalid_params", "cmd required".to_string()))?;
            remote_ui::invoke(&app, cmd, &params["args"]).await
        }
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
async fn gui(method: &str, params: Value) -> Result<Value, RpcError> { gui_with_timeout(method, params, GUI_TIMEOUT).await }

async fn gui_with_timeout(method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
    let app = hub().app.lock().unwrap().clone().ok_or(("internal", "app unavailable".to_string()))?;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    hub().pending.lock().unwrap().insert(request_id.clone(), tx);
    if app.emit_to("main", "mobile-rpc-request", json!({"requestId":request_id,"method":method,"params":params})).is_err() {
        hub().pending.lock().unwrap().remove(&request_id);
        return Err(("internal", "Coffee window unavailable".into()));
    }
    let result = tokio::time::timeout(timeout, rx).await;
    hub().pending.lock().unwrap().remove(&request_id);
    let value = result.map_err(|_| ("busy", "desktop did not answer".to_string()))?.map_err(|_| ("internal", "request dropped".to_string()))?;
    if value["ok"] == true { Ok(value["result"].clone()) } else {
        let code = match value["code"].as_str() { Some("not_found") => "not_found", Some("busy") => "busy", _ => "internal" };
        Err((code, value["error"].as_str().unwrap_or("failed").to_owned()))
    }
}

// ─── Tauri commands ───────────────────────────────────────

fn advertised(settings: &config::Settings) -> (Vec<network::Candidate>, Vec<String>) {
    let candidates = network::candidates();
    let hosts = network::advertised_hosts(&candidates, settings.preferred_address.as_deref(), network::local_name().as_deref());
    (candidates, hosts)
}

fn status_value() -> Value {
    let settings = config::load();
    let (candidates, hosts) = advertised(&settings);
    json!({
        "enabled": active(),
        "port": settings.port,
        "publicKey": settings.public_key,
        "devices": settings.devices,
        "connected": hub().clients.lock().unwrap().values().map(|c| c.device.clone()).collect::<HashSet<_>>(),
        "host": hosts.first(),
        "hosts": hosts,
        "addresses": candidates,
        "preferredAddress": settings.preferred_address,
        "clients": hub().clients.lock().unwrap().len(),
        "protocol": PROTOCOL,
    })
}

#[tauri::command]
pub fn mobile_rpc_status() -> Value { status_value() }

#[tauri::command]
pub fn mobile_rpc_set_enabled(enabled: bool) -> Result<Value, String> {
    {
        let _guard = hub().config_lock.lock().unwrap();
        let mut settings = config::load();
        if enabled { start(settings.clone())?; } else { stop(); *hub().pairing.lock().unwrap() = None; }
        settings.enabled = enabled;
        config::save(&settings)?;
    }
    Ok(status_value())
}

/// Starts a five-minute pairing window. The returned URI is what the desktop
/// renders as a QR code; it is never logged or sent anywhere else.
#[tauri::command]
pub fn mobile_rpc_begin_pairing() -> Result<Value, String> {
    if !active() { return Err("Enable mobile access first".into()); }
    let settings = config::load();
    let (_, hosts) = advertised(&settings);
    if hosts.is_empty() { return Err("No network connection".into()); }
    let code = config::new_pairing_code();
    *hub().pairing.lock().unwrap() = Some((code.clone(), Instant::now() + PAIRING_TTL));
    let expires_at = chrono::Utc::now().timestamp_millis() + PAIRING_TTL.as_millis() as i64;
    Ok(json!({
        "uri": format!("coffee://pair?v={PROTOCOL}&hosts={}&port={}&pk={}&code={code}", hosts.join(","), settings.port, settings.public_key),
        "host": hosts[0],
        "hosts": hosts,
        "port": settings.port,
        "publicKey": settings.public_key,
        "code": code,
        "expiresAt": expires_at,
    }))
}

/// Pins the address pairing advertises first; `None` returns to the automatic choice.
#[tauri::command]
pub fn mobile_rpc_set_address(address: Option<String>) -> Result<Value, String> {
    {
        let _guard = hub().config_lock.lock().unwrap();
        let mut settings = config::load();
        if let Some(address) = &address {
            if !network::candidates().iter().any(|c| &c.address == address) { return Err("That address is no longer available".into()); }
        }
        settings.preferred_address = address;
        config::save(&settings)?;
    }
    Ok(status_value())
}

/// Whether Windows Firewall lets phones in. Slow on Windows (PowerShell), so
/// the settings page asks for it separately from the status poll.
#[tauri::command]
pub async fn mobile_rpc_firewall_status() -> Value {
    let state = tauri::async_runtime::spawn_blocking(firewall::status).await.unwrap_or(firewall::State::Unknown);
    json!({ "state": state })
}

/// Opens the mobile port for private networks after the person's UAC consent.
#[tauri::command]
pub async fn mobile_rpc_firewall_allow() -> Result<Value, String> {
    let port = config::load().port;
    tauri::async_runtime::spawn_blocking(move || firewall::allow(port)).await.map_err(|e| e.to_string())??;
    Ok(mobile_rpc_firewall_status().await)
}

/// The main window reports that its tab list changed (opened, closed, renamed,
/// status), so phones re-read `session.list`.
#[tauri::command]
pub fn mobile_rpc_sessions_changed() { broadcast_all(json!({"event":"session.changed","params":{}})); }

#[tauri::command]
pub fn mobile_rpc_cancel_pairing() { *hub().pairing.lock().unwrap() = None; }

/// Unpairs a phone and drops its open connections immediately.
#[tauri::command]
pub fn mobile_rpc_revoke_device(public_key: String) -> Result<Value, String> {
    {
        let _guard = hub().config_lock.lock().unwrap();
        let mut settings = config::load();
        settings.devices.retain(|d| d.public_key != public_key);
        config::save(&settings)?;
    }
    hub().clients.lock().unwrap().retain(|_, client| {
        let keep = client.device != public_key;
        if !keep { client.kill.notify_one(); }
        keep
    });
    broadcast_desktop_devices();
    Ok(status_value())
}

#[tauri::command]
pub fn mobile_rpc_resolve(request_id: String, result: Value) -> Result<(), String> {
    let sender = hub().pending.lock().unwrap().remove(&request_id).ok_or("Request expired")?;
    sender.send(result).map_err(|_| "Request expired".into())
}

#[cfg(test)]
mod tests;
