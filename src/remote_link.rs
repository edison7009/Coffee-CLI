//! The connection of a window controlling another computer (src/remote_window.rs), opened by this
//! computer on the window's behalf. The page cannot reliably open sockets to the LAN itself (WebView
//! security rules differ per platform), so it asks here: this module dials the other computer's
//! WebSocket and passes frames through unchanged in both directions. They are already encrypted end
//! to end by the page (Noise, src-ui/src/remote/protocol.ts); nothing here can read them.
//!
//! Frames reach the page as `remote-link` events `{ id, kind: "open" | "message" | "close", data }`,
//! with binary data in base64. Only `remote-…` windows may open links, and only to `ws://host:port`.

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, EventTarget, Manager, WebviewWindow};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// The other computer's own frame cap (src/mobile_rpc) is far below this; anything bigger is not ours.
const MAX_FRAME: usize = 8 * 1024 * 1024;

enum Out {
    Frame(Vec<u8>),
    Close,
}

type Key = (String, String); // (window label, link id)

fn links() -> &'static Mutex<HashMap<Key, mpsc::UnboundedSender<Out>>> {
    static LINKS: OnceLock<Mutex<HashMap<Key, mpsc::UnboundedSender<Out>>>> = OnceLock::new();
    LINKS.get_or_init(Default::default)
}

fn control_window(window: &WebviewWindow) -> Result<String, String> {
    let label = window.label().to_string();
    if label.starts_with(crate::remote_window::LABEL_PREFIX) {
        Ok(label)
    } else {
        Err("only a window controlling another computer opens remote links".into())
    }
}

/// `ws://host:port` with nothing else: the other computer's Web 端 endpoint.
pub fn link_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|_| "bad link address".to_string())?;
    let bare = parsed.path() == "/" && parsed.query().is_none() && parsed.fragment().is_none();
    if parsed.scheme() != "ws" || parsed.host_str().is_none() || parsed.port().is_none() || !bare || !parsed.username().is_empty() {
        return Err("bad link address".into());
    }
    Ok(parsed.to_string())
}

#[tauri::command]
pub async fn remote_link_open(window: WebviewWindow, id: String, url: String) -> Result<(), String> {
    let label = control_window(&window)?;
    let url = link_url(&url)?;
    if id.is_empty() || id.len() > 64 {
        return Err("bad link id".into());
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    links().lock().map_err(|e| e.to_string())?.insert((label.clone(), id.clone()), tx);
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        let emit = |kind: &str, data: Option<String>| {
            let _ = app.emit_to(EventTarget::webview_window(label.as_str()), "remote-link", json!({ "id": id, "kind": kind, "data": data }));
        };
        if let Ok(Ok((stream, _))) = tokio::time::timeout(DIAL_TIMEOUT, tokio_tungstenite::connect_async(url.as_str())).await {
            emit("open", None);
            let (mut sink, mut source) = stream.split();
            loop {
                tokio::select! {
                    out = rx.recv() => match out {
                        Some(Out::Frame(bytes)) => if sink.send(Message::binary(bytes)).await.is_err() { break },
                        Some(Out::Close) | None => { let _ = sink.close().await; break }
                    },
                    message = source.next() => match message {
                        Some(Ok(Message::Binary(bytes))) if bytes.len() <= MAX_FRAME => {
                            emit("message", Some(base64::engine::general_purpose::STANDARD.encode(&bytes)));
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                        _ => break,
                    },
                }
            }
        }
        if let Ok(mut map) = links().lock() {
            map.remove(&(label.clone(), id.clone()));
        }
        emit("close", None);
    });
    Ok(())
}

#[tauri::command]
pub fn remote_link_send(window: WebviewWindow, id: String, data: String) -> Result<(), String> {
    let label = control_window(&window)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|_| "bad frame".to_string())?;
    if bytes.len() > MAX_FRAME {
        return Err("frame too large".into());
    }
    let map = links().lock().map_err(|e| e.to_string())?;
    let link = map.get(&(label, id)).ok_or("link closed")?;
    link.send(Out::Frame(bytes)).map_err(|_| "link closed".to_string())
}

#[tauri::command]
pub fn remote_link_close(window: WebviewWindow, id: String) -> Result<(), String> {
    let label = control_window(&window)?;
    if let Some(link) = links().lock().map_err(|e| e.to_string())?.get(&(label, id)) {
        let _ = link.send(Out::Close);
    }
    Ok(())
}

/// A control window went away: end its connections.
pub fn close_window(label: &str) {
    if let Ok(map) = links().lock() {
        for ((owner, _), link) in map.iter() {
            if owner == label {
                let _ = link.send(Out::Close);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bare_websocket_addresses_are_dialed() {
        assert_eq!(link_url("ws://192.168.1.20:47321").unwrap(), "ws://192.168.1.20:47321/");
        assert_eq!(link_url("ws://[fd7a::1]:8080").unwrap(), "ws://[fd7a::1]:8080/");
        for bad in ["", "wss://a:1", "http://a:1", "ws://a", "ws://a:1/path", "ws://a:1/?x=1", "ws://user@a:1", "file:///x"] {
            assert!(link_url(bad).is_err(), "{bad}");
        }
    }
}
