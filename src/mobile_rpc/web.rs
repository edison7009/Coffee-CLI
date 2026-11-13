//! Serves the desktop UI's files to browsers on the mobile port (Web 端).
//!
//! The same port carries the encrypted WebSocket; a plain GET gets a file.
//! Release builds serve the assets embedded in the app; development builds
//! (which load the UI from the Vite dev server) read `src-ui/dist` from disk.
//! The files are public front-end code; everything private stays behind the
//! paired, encrypted connection.

use tauri::AppHandle;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const MAX_HEAD: usize = 8192;

pub enum Request { Upgrade, Get(String), Other }

/// Reads the request head without consuming it, so a WebSocket handshake can
/// still read the whole request afterwards.
pub async fn peek(stream: &TcpStream) -> Option<Request> {
    let mut buf = vec![0u8; MAX_HEAD];
    for _ in 0..50 {
        let n = stream.peek(&mut buf).await.ok()?;
        if n == 0 { return None; }
        let head = &buf[..n];
        if let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") { return Some(classify(&head[..end])); }
        if n == MAX_HEAD { return Some(Request::Other); }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    None
}

pub fn classify(head: &[u8]) -> Request {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (method, target) = (first.next().unwrap_or_default(), first.next().unwrap_or_default());
    let upgrade = lines.any(|l| l.split_once(':').is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("upgrade") && v.trim().eq_ignore_ascii_case("websocket")));
    if upgrade { return Request::Upgrade; }
    if method == "GET" || method == "HEAD" { Request::Get(target.to_owned()) } else { Request::Other }
}

/// Maps a request target to an asset path, or `None` when it must be refused.
/// The bare root redirects to `/?remote`, which switches the UI to Web 端 mode.
pub enum Route { Redirect(&'static str), File(String) }
pub fn route(target: &str) -> Option<Route> {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let path = path.split('#').next().unwrap_or_default();
    if path == "/" || path.is_empty() {
        return Some(if query.split('&').any(|p| p == "remote" || p.starts_with("remote=")) { Route::File("index.html".into()) } else { Route::Redirect("/?remote") });
    }
    let rel = path.trim_start_matches('/');
    if rel.split('/').any(|seg| seg.is_empty() || seg == "." || seg == ".." || seg.contains('\\')) || rel.contains('%') { return None; }
    Some(Route::File(rel.to_owned()))
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8", "js" | "mjs" => "text/javascript; charset=utf-8", "css" => "text/css; charset=utf-8",
        "json" => "application/json", "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif",
        "webp" => "image/webp", "webm" => "video/webm", "mov" => "video/quicktime", "mp3" => "audio/mpeg", "wav" => "audio/wav",
        "woff2" => "font/woff2", "woff" => "font/woff", "ttf" => "font/ttf", "ico" => "image/x-icon", "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn load(app: &AppHandle, path: &str) -> Option<Vec<u8>> {
    if let Some(asset) = app.asset_resolver().get(path.to_owned()) { return Some(asset.bytes().to_vec()); }
    // Development: the UI comes from the Vite server, so nothing is embedded.
    #[cfg(debug_assertions)]
    { return std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src-ui").join("dist").join(path)).ok(); }
    #[allow(unreachable_code)]
    None
}

pub async fn respond(app: &AppHandle, mut stream: TcpStream, target: &str, head_only: bool) {
    // The request head is still in the socket; drain it before answering.
    let mut sink = vec![0u8; MAX_HEAD];
    let _ = tokio::io::AsyncReadExt::read(&mut stream, &mut sink).await;
    let response = match route(target) {
        Some(Route::Redirect(to)) => format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(),
        Some(Route::File(path)) => match load(app, &path) {
            Some(body) => {
                // The page itself must update with the app; hashed assets may be cached.
                let cache = if path == "index.html" { "no-store" } else { "max-age=3600" };
                let mut out = format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n", mime(&path), body.len()).into_bytes();
                if !head_only { out.extend_from_slice(&body); }
                out
            }
            None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        },
        None => b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    };
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
}
