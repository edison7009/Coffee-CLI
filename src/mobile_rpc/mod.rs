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
mod upload;
mod web;

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
/// Paired devices connected at once.
const MAX_CLIENTS: usize = 8;
/// Open sockets of any kind (page loads, handshakes in progress, devices); each must say what it is within `HELLO_TIMEOUT`.
const MAX_CONNECTIONS: usize = 64;
const CLIENT_QUEUE: usize = 1024;
const MAX_FRAME: usize = 1 << 20;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const GUI_TIMEOUT: Duration = Duration::from_secs(30);
const PAIRING_TTL: Duration = Duration::from_secs(300);
/// Starting a tool session can take a while (process launch, resume).
const INVOKE_TIMEOUT: Duration = Duration::from_secs(120);
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
    /// Files this browser is sending (Web 端 uploads).
    uploads: Mutex<upload::Uploads>,
    /// The folder this browser's file tree shows, watched for changes; dropped with the connection.
    watcher: Mutex<Option<crate::fs_watcher::FsWatcher>>,
}

#[derive(Default)]
struct Hub {
    app: Mutex<Option<AppHandle>>,
    enabled: AtomicBool,
    listening: AtomicBool,
    /// Which accept loop is current; a loop that was told to stop must not mark a newer one stopped.
    generation: AtomicU64,
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
        // Nothing to do (and nothing worth parsing) while no device may connect.
        if !active() { return; }
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
            if !active() { return; }
            let Ok(payload) = serde_json::from_str::<Value>(event.payload()) else { return };
            record_conversation(kind, payload);
        });
    }
    for name in remote_ui::FORWARDED_EVENTS {
        app.listen_any(name, move |event| {
            if !active() { return; }
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
    // Held across delivery so a snapshot and the live chunks after it never overlap or leave a hole.
    let mut buffers = hub().buffers.lock().unwrap();
    let (start, end) = buffers.push_terminal(id, data);
    deliver(id, json!({"event":"terminal.output","params":{"id":id,"data":data}}));
    deliver_ui("tier-terminal-output", json!({"id":id,"data":data,"start":start,"end":end}));
}

const WALLPAPER_MAX: u64 = 64 * 1024 * 1024;
const WALLPAPER_CHUNK: usize = 2 * 1024 * 1024;

fn wallpaper_chunk(path: &str, offset: u64) -> Result<Value, RpcError> {
    use base64::Engine;
    use std::io::{Read, Seek, SeekFrom};
    if path.is_empty() { return Err(("not_found", "no wallpaper".into())); }
    // Only an image or video: the setting names a wallpaper, not any file on this computer.
    let mime = match std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png", Some("jpg" | "jpeg") => "image/jpeg", Some("gif") => "image/gif", Some("webp") => "image/webp",
        Some("bmp") => "image/bmp", Some("svg") => "image/svg+xml", Some("avif") => "image/avif",
        Some("mp4" | "m4v") => "video/mp4", Some("webm") => "video/webm", Some("mov") => "video/quicktime",
        _ => return Err(("unsupported", "not an image or video".into())),
    };
    let mut file = std::fs::File::open(path).map_err(|e| ("not_found", e.to_string()))?;
    let size = file.metadata().map_err(|e| ("internal", e.to_string()))?.len();
    if size > WALLPAPER_MAX { return Err(("unsupported", "wallpaper too large".into())); }
    let mut data = vec![0; WALLPAPER_CHUNK.min(size.saturating_sub(offset) as usize)];
    file.seek(SeekFrom::Start(offset)).and_then(|_| file.read_exact(&mut data)).map_err(|e| ("internal", e.to_string()))?;
    Ok(json!({"path": path, "size": size, "mime": mime, "data": base64::engine::general_purpose::STANDARD.encode(&data)}))
}

/// A browser mirroring one of the desktop's terminals: its recent output, where that ends, and its size.
fn terminal_attach(id: &str) -> Result<Value, RpcError> {
    let app = hub().app.lock().unwrap().clone().ok_or(("internal", "app unavailable".to_string()))?;
    // A terminal whose process has ended still shows its last output; size 0 keeps the browser's grid.
    let size = crate::server::terminal_size(&app, id);
    let log = hub().buffers.lock().unwrap().terminal(id);
    if size.is_none() && log.is_none() { return Err(("not_found", "no terminal session".into())); }
    let (snapshot, end) = log.unwrap_or_default();
    let (cols, rows) = size.unwrap_or((0, 0));
    Ok(json!({"snapshot": snapshot, "end": end, "cols": cols, "rows": rows}))
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
    // A loop that was just told to stop may still hold the port for a moment.
    let mut bound = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, settings.port)));
    for _ in 0..20 {
        if bound.is_ok() { break; }
        std::thread::sleep(Duration::from_millis(50));
        bound = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, settings.port)));
    }
    let std_listener = bound.map_err(|e| { h.listening.store(false, Ordering::SeqCst); format!("Port {} unavailable: {e}", settings.port) })?;
    std_listener.set_nonblocking(true).map_err(|e| { h.listening.store(false, Ordering::SeqCst); e.to_string() })?;
    let generation = h.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let (stop_tx, mut stop_rx) = oneshot::channel();
    *h.stop.lock().unwrap() = Some(stop_tx);
    h.enabled.store(true, Ordering::SeqCst);
    let current = move || hub().generation.load(Ordering::SeqCst) == generation;
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(std_listener) { Ok(l) => l, Err(e) => { log::warn!("[mobile_rpc] {e}"); if current() { hub().listening.store(false, Ordering::SeqCst); } return } };
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { continue };
                    if hub().connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS { hub().connections.fetch_sub(1, Ordering::SeqCst); continue; }
                    tauri::async_runtime::spawn(async move {
                        serve(stream).await;
                        hub().connections.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            }
        }
        if current() { hub().listening.store(false, Ordering::SeqCst); }
    });
    Ok(())
}

fn stop() {
    let h = hub();
    h.enabled.store(false, Ordering::SeqCst);
    // Stopped now, not when the loop gets round to it: a quick re-enable starts a fresh loop.
    h.generation.fetch_add(1, Ordering::SeqCst);
    h.listening.store(false, Ordering::SeqCst);
    if let Some(stop) = h.stop.lock().unwrap().take() { let _ = stop.send(()); }
    for client in h.clients.lock().unwrap().drain().map(|(_, c)| c) { client.kill.notify_one(); }
    h.buffers.lock().unwrap().clear();
}

/// Requests from one device that must reach the desktop in the order they were sent:
/// keystrokes in one lane, tab, setting and conversation changes in the other.
/// Everything else (reads) runs side by side.
fn lane(request: &Value) -> Option<usize> {
    let method = request["method"].as_str().unwrap_or("");
    if method == "ui.invoke" && matches!(request["params"]["cmd"].as_str(), Some("tier_terminal_input" | "tier_terminal_raw_write")) { return Some(0); }
    if matches!(method, "ui.dispatch" | "ui.storage" | "ui.call" | "ui.watch" | "session.input" | "session.interrupt" | "conversation.send" | "conversation.cancel") || method.starts_with("upload.") { return Some(1); }
    None
}

async fn respond(client: &Client, request: Value) {
    let id = request["id"].clone();
    let frame = match handle(client, &request).await {
        Ok(result) => json!({"id":id,"result":result}),
        Err((code, message)) => json!({"id":id,"error":{"code":code,"message":message}}),
    };
    let _ = client.tx.send(frame).await;
    flush_resync(client).await;
}

async fn serve(stream: TcpStream) {
    // One port: a WebSocket upgrade is a paired device, a plain GET is a browser loading the UI.
    // A socket that never says what it wants is closed rather than holding a slot.
    match tokio::time::timeout(HELLO_TIMEOUT, web::peek(&stream)).await.ok().flatten() {
        Some(web::Request::Upgrade) => {}
        Some(web::Request::Get(target)) => {
            // Take the handle first so the lock is not held across the await.
            let app = hub().app.lock().unwrap().clone();
            if let Some(app) = app { web::respond(&app, stream, &target, false).await; }
            return;
        }
        _ => return,
    }
    let Ok(Ok(socket)) = tokio::time::timeout(HELLO_TIMEOUT, tokio_tungstenite::accept_async(stream)).await else { return };
    let (mut sink, mut source) = socket.split();
    let Some((client_device, channel)) = handshake(&mut sink, &mut source).await else { return };
    let channel = Arc::new(channel);

    let (tx, mut rx) = mpsc::channel::<Value>(CLIENT_QUEUE);
    let client = Arc::new(Client { device: client_device, kill: tokio::sync::Notify::new(), tx, subscriptions: Mutex::default(), resync: Mutex::default(), ui: AtomicBool::new(false), uploads: Mutex::default(), watcher: Mutex::default() });
    let client_id = hub().next_client.fetch_add(1, Ordering::SeqCst);
    {
        let mut clients = hub().clients.lock().unwrap();
        if clients.len() >= MAX_CLIENTS { return; }
        clients.insert(client_id, client.clone());
    }
    // The sidebar and the desktop's mirrors learn at once that a device came or went.
    broadcast_desktop_devices();
    let lanes: Vec<mpsc::UnboundedSender<Value>> = (0..2).map(|_| {
        let (lane_tx, mut lane_rx) = mpsc::unbounded_channel::<Value>();
        let client = client.clone();
        tauri::async_runtime::spawn(async move { while let Some(request) = lane_rx.recv().await { respond(&client, request).await; } });
        lane_tx
    }).collect();
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
        match lane(&request) {
            Some(index) => { let _ = lanes[index].send(request); }
            None => { let client = client.clone(); tauri::async_runtime::spawn(async move { respond(&client, request).await; }); }
        }
        if !active() { break; }
    }
    hub().clients.lock().unwrap().remove(&client_id);
    drop(lanes);
    client.uploads.lock().unwrap().abort_all();
    *client.watcher.lock().unwrap() = None;
    broadcast_desktop_devices();
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
    // A device that was removed (or never paired) is told so over the encrypted channel, so it can tell
    // "removed" from a dropped network and stop retrying; hanging up here would look like a network drop.
    let unknown = mode == secure::MODE_RESUME && !settings.knows(&remote);
    sink.send(Message::binary(msg2)).await.ok()?;

    // The phone's first encrypted frame proves it completed the handshake
    // (and, when pairing, that it knew the code).
    let plain = channel.decrypt(&next_binary(source).await?).ok()?;
    let request: Value = serde_json::from_slice(&plain).ok()?;
    if unknown {
        if let Ok(sealed) = channel.encrypt(json!({"id":request["id"],"error":{"code":"unauthorized","message":"device not paired"}}).to_string().as_bytes()) { let _ = sink.send(Message::binary(sealed)).await; }
        return None;
    }
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
        let platform = request["params"]["platform"].as_str().unwrap_or("").chars().filter(char::is_ascii_alphanumeric).take(16).collect::<String>();
        register_device(&device, &name, &platform).ok()?;
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

fn register_device(public_key: &str, name: &str, platform: &str) -> Result<(), String> {
    let _guard = hub().config_lock.lock().unwrap();
    let mut settings = config::load();
    settings.devices.retain(|d| d.public_key != public_key);
    settings.devices.push(config::Device { public_key: public_key.into(), name: name.into(), paired_at: chrono::Utc::now().timestamp_millis(), platform: platform.into() });
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
        // The desktop's recent project folders: a browser picks from these instead of a folder dialog.
        "ui.projects" => gui("projects.list", json!({})).await,
        // Files sent from the browser's device, in chunks; the result is a path on this computer.
        "upload.begin" => {
            let name = params["name"].as_str().ok_or(("invalid_params", "name required".to_string()))?;
            let size = params["size"].as_u64().ok_or(("invalid_params", "size required".to_string()))?;
            client.uploads.lock().unwrap().begin(name, size).map(|id| json!({"id": id})).map_err(|e| ("invalid_params", e))
        }
        "upload.chunk" => {
            let id = params["id"].as_u64().ok_or(("invalid_params", "id required".to_string()))?;
            let data = params["data"].as_str().ok_or(("invalid_params", "data required".to_string()))?;
            client.uploads.lock().unwrap().chunk(id, data).map(|written| json!({"written": written})).map_err(|e| ("invalid_params", e))
        }
        "upload.finish" => {
            let id = params["id"].as_u64().ok_or(("invalid_params", "id required".to_string()))?;
            client.uploads.lock().unwrap().finish(id).map(|path| json!({"path": path})).map_err(|e| ("invalid_params", e))
        }
        "ui.terminal.attach" => terminal_attach(&id()?),
        // The browser's file tree: its own watcher, so the desktop's (one per window) is left alone.
        "ui.watch" => {
            let path = params["path"].as_str().map(str::to_owned);
            let app = hub().app.lock().unwrap().clone().ok_or(("internal", "app unavailable".to_string()))?;
            let watcher = match path {
                Some(path) => Some(tauri::async_runtime::spawn_blocking(move || crate::fs_watcher::FsWatcher::start(app, path.into())).await
                    .map_err(|e| ("internal", e.to_string()))?.map_err(|e| ("invalid_params", e))?),
                None => None,
            };
            let old = std::mem::replace(&mut *client.watcher.lock().unwrap(), watcher);
            drop(old);
            Ok(json!({}))
        }
        // The browser keeps no sessions of its own. Conversations: the desktop's state, then patches
        // (`mobile_rpc_mirror`); actions and tab changes run on the desktop.
        "mirror.snapshot" => gui("mirror.snapshot", json!({"kind": params["kind"], "id": params["id"]})).await,
        "ui.call" => gui_with_timeout("ui.call", json!({"kind": params["kind"], "name": params["name"], "args": params["args"]}), INVOKE_TIMEOUT).await,
        "ui.dispatch" => gui("ui.dispatch", json!({"action": params["action"]})).await,
        // A browser saving one of the desktop's records; the desktop checks the key.
        "ui.storage" => gui("storage.set", json!({"key": params["key"], "value": params["value"]})).await,
        // The desktop's wallpaper, in pieces: only the file the desktop currently shows is ever read.
        "ui.wallpaper" => {
            let path = gui("wallpaper.path", json!({})).await?["path"].as_str().unwrap_or("").to_owned();
            wallpaper_chunk(&path, params["offset"].as_u64().unwrap_or(0))
        }
        "ui.subscribe" => { client.ui.store(true, Ordering::Relaxed); Ok(json!({"events": remote_ui::FORWARDED_EVENTS})) }
        // The desktop window runs the command, so the browser gets exactly what the desktop UI would.
        "ui.invoke" => {
            let cmd = params["cmd"].as_str().ok_or(("invalid_params", "cmd required".to_string()))?;
            remote_ui::check(cmd, &params["args"]).map_err(|e| ("unsupported", e))?;
            gui_with_timeout("invoke", json!({"cmd": cmd, "args": params["args"]}), INVOKE_TIMEOUT).await
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

/// The pairing addresses, and the one that works away from home.
fn advertised() -> (Vec<String>, Option<String>) {
    let candidates = network::candidates();
    (network::advertised_hosts(&candidates, network::local_name().as_deref()), network::remote_host(&candidates))
}

fn status_value() -> Value {
    let settings = config::load();
    let (hosts, remote) = advertised();
    json!({
        "enabled": active(),
        "port": settings.port,
        "publicKey": settings.public_key,
        "devices": settings.devices,
        "connected": hub().clients.lock().unwrap().values().map(|c| c.device.clone()).collect::<HashSet<_>>(),
        "host": hosts.first(),
        "hosts": hosts,
        "remoteHost": remote,
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
    // The sidebar status follows the switch wherever it was flipped.
    broadcast_desktop_devices();
    Ok(status_value())
}

/// Starts a five-minute pairing window. The returned URI is what the desktop
/// renders as a QR code; it is never logged or sent anywhere else.
#[tauri::command]
pub fn mobile_rpc_begin_pairing() -> Result<Value, String> {
    if !active() { return Err("Enable mobile access first".into()); }
    let settings = config::load();
    let (hosts, remote) = advertised();
    if hosts.is_empty() { return Err("No network connection".into()); }
    let code = config::new_pairing_code();
    *hub().pairing.lock().unwrap() = Some((code.clone(), Instant::now() + PAIRING_TTL));
    let expires_at = chrono::Utc::now().timestamp_millis() + PAIRING_TTL.as_millis() as i64;
    Ok(json!({
        "uri": format!("coffeecli://pair?v={PROTOCOL}&hosts={}&port={}&pk={}&code={code}", hosts.join(","), settings.port, settings.public_key),
        "host": hosts[0],
        "hosts": hosts,
        "remoteHost": remote,
        "port": settings.port,
        "publicKey": settings.public_key,
        "code": code,
        "expiresAt": expires_at,
    }))
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

/// A conversation changed on the desktop; browsers following it apply the patch.
#[tauri::command]
pub fn mobile_rpc_mirror(kind: String, id: String, patch: Value) {
    let mut payload = patch;
    if let Some(map) = payload.as_object_mut() { map.insert("kind".into(), kind.into()); map.insert("id".into(), id.into()); }
    deliver_ui("session-mirror", payload);
}

#[tauri::command]
pub fn mobile_rpc_resolve(request_id: String, result: Value) -> Result<(), String> {
    let sender = hub().pending.lock().unwrap().remove(&request_id).ok_or("Request expired")?;
    sender.send(result).map_err(|_| "Request expired".into())
}

#[cfg(test)]
mod tests;
