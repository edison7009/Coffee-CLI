//! Controlling another computer from this one. Each paired computer opens in a window of its own,
//! running this app's own UI in remote mode (src-ui/src/remote/bridge.ts, `CONTROL`): nothing is
//! loaded from the other computer, only data passes, over the connection src/remote_link.rs makes.
//! So the other computer only needs a version that runs the desktop UI remotely (v4.0.2+).
//!
//! The window's web storage is private (incognito) so the other computer's settings, which the
//! remote UI mirrors into its storage, never mix with this computer's. The key each window paired
//! with is kept here instead, in `~/.coffee-cli/remote/pairings.json`, so reopening needs no pairing.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Window labels start with this; nothing else uses it.
pub const LABEL_PREFIX: &str = "remote-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWindow {
    pub label: String,
    /// The computer's name once connected, its `host:port` before.
    pub name: String,
    /// The window's title: the localized prefix ("Remote: ") and the name.
    pub title: String,
    /// `http://host:port`, the computer this window controls.
    pub origin: String,
}

/// What a window knows about its computer: title prefix, current name, origin, and the pairing
/// link it was opened with until the page takes it.
#[derive(Clone, Default)]
struct Entry {
    prefix: String,
    name: String,
    origin: String,
    pair_link: Option<String>,
}

fn entries() -> &'static Mutex<HashMap<String, Entry>> {
    static ENTRIES: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    ENTRIES.get_or_init(Default::default)
}

/// Read a pasted address: the other computer's Web 端 address (`http(s)://host:port/?remote`, with
/// `#pair=<coffeecli://pair link>` when pairing). Returns its origin and the pairing link, if any.
pub fn read_address(address: &str) -> Result<(String, Option<String>), String> {
    let invalid = || "not a Coffee CLI address".to_string();
    let url = url::Url::parse(address.trim()).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.query_pairs().any(|(key, _)| key == "remote") {
        return Err(invalid());
    }
    let pair_link = url
        .fragment()
        .and_then(|f| f.strip_prefix("pair="))
        .and_then(urlencoding_decode)
        .filter(|link| link.starts_with("coffeecli://pair?"));
    Ok((origin_of(&url), pair_link))
}

fn urlencoding_decode(text: &str) -> Option<String> {
    url::form_urlencoded::parse(format!("x={}", text.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
}

/// `http://host:port` — what identifies the computer.
pub fn origin_of(url: &url::Url) -> String {
    url.origin().ascii_serialization()
}

/// A window label for an origin: Tauri labels allow `a-zA-Z0-9-/:_`. The readable part loses the
/// scheme and punctuation, so a hash of the whole origin keeps different computers apart
/// (`http://my-mac.local:1` vs `http://my.mac.local:1`, http vs https).
pub fn label_for(origin: &str) -> String {
    let body: String = origin
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // FNV-1a: stable across runs and builds, unlike the std hasher.
    let hash = origin.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    format!("{LABEL_PREFIX}{body}-{:08x}", hash as u32)
}

/// Whether a control window may show `url`: only this app's own pages (the bundled UI, or the dev
/// server while developing), never a page from elsewhere.
fn is_app_page(url: &url::Url, dev_origin: Option<&str>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost") || dev_origin == Some(origin_of(url).as_str()),
        _ => false,
    }
}

/// The window title for a name: "Remote: MacBook Pro".
fn titled(prefix: &str, name: &str) -> String {
    format!("{prefix}{name}").chars().take(120).collect()
}

fn describe(label: &str, entry: &Entry) -> RemoteWindow {
    RemoteWindow { label: label.to_string(), name: entry.name.clone(), title: titled(&entry.prefix, &entry.name), origin: entry.origin.clone() }
}

pub(crate) fn list(app: &AppHandle) -> Vec<RemoteWindow> {
    let entries = entries().lock().map(|map| map.clone()).unwrap_or_default();
    let mut windows: Vec<RemoteWindow> = app
        .webview_windows()
        .into_keys()
        .filter(|label| label.starts_with(LABEL_PREFIX))
        .filter_map(|label| entries.get(&label).map(|entry| describe(&label, entry)))
        .collect();
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    windows
}

fn changed(app: &AppHandle) {
    let _ = app.emit("remote-windows-changed", list(app));
}

fn control_entry(window: &WebviewWindow) -> Result<(String, Entry), String> {
    let label = window.label().to_string();
    if !label.starts_with(LABEL_PREFIX) {
        return Err("not a window controlling another computer".into());
    }
    let entry = entries().lock().map_err(|e| e.to_string())?.get(&label).cloned().ok_or("window closed")?;
    Ok((label, entry))
}

// ─── Saved keys ───────────────────────────────────────────────────────────

fn pairings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".coffee-cli").join("remote").join("pairings.json"))
}

fn load_pairings() -> HashMap<String, Value> {
    pairings_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn store_pairings(pairings: &HashMap<String, Value>) -> Result<(), String> {
    let path = pairings_path().ok_or("no home folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(pairings).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    // The device keys are private: readable by this user only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

// ─── Commands for the main window ─────────────────────────────────────────

/// Open (or bring forward) the window controlling the computer at `address`. `prefix` is the
/// localized title prefix ("Remote: ").
#[tauri::command]
pub async fn remote_window_open(app: AppHandle, address: String, prefix: String) -> Result<RemoteWindow, String> {
    let (origin, pair_link) = read_address(&address)?;
    let label = label_for(&origin);
    if let Some(window) = app.get_webview_window(&label) {
        // A fresh pairing link means pairing again: the page reads its link once when it starts,
        // so it starts over with this one.
        if let Some(link) = pair_link {
            if let Some(entry) = entries().lock().map_err(|e| e.to_string())?.get_mut(&label) {
                entry.pair_link = Some(link);
            }
            window.reload().map_err(|e| e.to_string())?;
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return list(&app).into_iter().find(|w| w.label == label).ok_or_else(|| "window closed".to_string());
    }
    let prefix: String = prefix.chars().take(40).collect();
    let host = origin.trim_start_matches("http://").trim_start_matches("https://").to_string();
    let entry = Entry { prefix, name: host, origin: origin.clone(), pair_link };
    let described = describe(&label, &entry);
    entries().lock().map_err(|e| e.to_string())?.insert(label.clone(), entry);

    // This app's own UI in remote mode; it stays on this app's pages.
    let dev_origin = if tauri::is_dev() { app.config().build.dev_url.as_ref().map(origin_of) } else { None };
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html?remote&control".into()))
        .title(&described.title)
        .inner_size(1150.0, 780.0)
        .min_inner_size(720.0, 480.0)
        .center()
        .incognito(true)
        .on_navigation(move |url| is_app_page(url, dev_origin.as_deref()))
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            if let Ok(mut map) = entries().lock() {
                map.remove(&label);
            }
            return Err(error.to_string());
        }
    };
    let closed = app.clone();
    let closed_label = label.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            crate::remote_link::close_window(&closed_label);
            crate::orchestration::remote_window_gone(&closed_label);
            if let Ok(mut map) = entries().lock() {
                map.remove(&closed_label);
            }
            changed(&closed);
        }
    });
    changed(&app);
    Ok(described)
}

/// The open remote windows, for the sidebar's device menu.
#[tauri::command]
pub fn remote_window_list(app: AppHandle) -> Vec<RemoteWindow> {
    list(&app)
}

#[tauri::command]
pub async fn remote_window_focus(app: AppHandle, label: String) -> Result<(), String> {
    if !label.starts_with(LABEL_PREFIX) {
        return Err("not a remote window".into());
    }
    let window = app.get_webview_window(&label).ok_or("window closed")?;
    let _ = window.unminimize();
    let _ = window.show();
    window.set_focus().map_err(|e| e.to_string())
}

/// Close a remote window: the same as closing it by hand, which ends the connection.
/// Brings a computer's window forward on one of its tabs (work this computer handed over there).
#[tauri::command]
pub async fn remote_window_show_tab(app: AppHandle, label: String, session_id: String) -> Result<(), String> {
    if !label.starts_with(LABEL_PREFIX) || session_id.is_empty() || session_id.len() > 128 { return Err("unknown window".into()); }
    app.emit_to(tauri::EventTarget::webview_window(&label), "remote-show-tab", serde_json::json!({ "sessionId": session_id })).map_err(|e| e.to_string())?;
    remote_window_focus(app, label).await
}

#[tauri::command]
pub async fn remote_window_close(app: AppHandle, label: String) -> Result<(), String> {
    if !label.starts_with(LABEL_PREFIX) {
        return Err("not a remote window".into());
    }
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ─── Commands for the control window itself ───────────────────────────────

/// What a control window starts from: the key it saved for its computer, and the pairing link it
/// was opened with (handed over once).
#[tauri::command]
pub fn remote_control_info(window: WebviewWindow) -> Result<Value, String> {
    let (label, entry) = control_entry(&window)?;
    if let Ok(mut map) = entries().lock() {
        if let Some(entry) = map.get_mut(&label) {
            entry.pair_link = None;
        }
    }
    let pairing = load_pairings().remove(&entry.origin).unwrap_or(Value::Null);
    Ok(serde_json::json!({ "origin": entry.origin, "pairing": pairing, "pairLink": entry.pair_link }))
}

/// Keep (or, with `null`, drop) the key a control window paired with.
#[tauri::command]
pub fn remote_pairing_save(window: WebviewWindow, pairing: Value) -> Result<(), String> {
    let (_, entry) = control_entry(&window)?;
    let mut pairings = load_pairings();
    if pairing.is_null() {
        pairings.remove(&entry.origin);
    } else if pairing.is_object() {
        pairings.insert(entry.origin, pairing);
    } else {
        return Err("bad pairing".into());
    }
    store_pairings(&pairings)
}

/// The control window learned its computer's name.
#[tauri::command]
pub fn remote_window_set_name(window: WebviewWindow, name: String) -> Result<(), String> {
    let (label, _) = control_entry(&window)?;
    let name: String = name.trim().chars().take(80).collect();
    if name.is_empty() {
        return Ok(());
    }
    let title = {
        let mut map = entries().lock().map_err(|e| e.to_string())?;
        let entry = map.get_mut(&label).ok_or("window closed")?;
        entry.name = name;
        titled(&entry.prefix, &entry.name)
    };
    let _ = window.set_title(&title);
    changed(window.app_handle());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_web_address_and_its_pairing_link() {
        let link = "coffeecli://pair?v=0&hosts=192.168.1.20&port=47321&pk=aa&code=bb";
        let encoded: String = url::form_urlencoded::byte_serialize(link.as_bytes()).collect();
        let (origin, pair) = read_address(&format!("  http://192.168.1.20:47321/?remote#pair={encoded} ")).unwrap();
        assert_eq!(origin, "http://192.168.1.20:47321");
        assert_eq!(pair.as_deref(), Some(link));
        let (origin, pair) = read_address("http://[fd7a::1]:8080/some/path?remote&x=1#other").unwrap();
        assert_eq!(origin, "http://[fd7a::1]:8080");
        assert!(pair.is_none());
        assert!(read_address("http://a:1/?remote#pair=javascript%3Aalert(1)").unwrap().1.is_none(), "only pairing links are carried");
    }

    #[test]
    fn refuses_anything_that_is_not_a_web_page_address() {
        for bad in ["", "coffeecli://pair?v=0", "file:///etc/passwd", "javascript:alert(1)", "http://192.168.1.20:47321/", "https://example.com/?q=remote", "not a url"] {
            assert!(read_address(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn titles_are_prefix_and_name_and_stay_short() {
        assert_eq!(titled("远程：", "MacBook Pro"), "远程：MacBook Pro");
        assert_eq!(titled("Remote: ", &"x".repeat(200)).chars().count(), 120);
    }

    #[test]
    fn labels_are_stable_per_computer_and_valid_for_tauri() {
        let a = label_for("http://192.168.1.20:47321");
        assert!(a.starts_with("remote-192-168-1-20-47321-"), "{a}");
        assert_eq!(a, label_for("http://192.168.1.20:47321"));
        assert!(label_for("http://[fd7a::1]:8080").starts_with("remote--fd7a--1--8080-"));
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
        assert_ne!(a, label_for("http://192.168.1.21:47321"));
        // Origins that read the same once punctuation and scheme are dropped still get windows of their own.
        assert_ne!(label_for("http://my-mac.local:1"), label_for("http://my.mac.local:1"));
        assert_ne!(label_for("http://host"), label_for("https://host"));
    }

    #[test]
    fn control_windows_stay_on_this_apps_pages() {
        let page = |u: &str| url::Url::parse(u).unwrap();
        assert!(is_app_page(&page("tauri://localhost/index.html?remote&control"), None));
        assert!(is_app_page(&page("http://tauri.localhost/index.html?remote&control"), None));
        assert!(is_app_page(&page("http://localhost:1420/index.html"), Some("http://localhost:1420")));
        for away in ["http://localhost:1420/", "https://example.com/", "http://192.168.1.20:47321/?remote", "tauri://evil/", "file:///etc/passwd"] {
            assert!(!is_app_page(&page(away), None), "{away}");
        }
    }
}
