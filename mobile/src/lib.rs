//! Coffee CLI on a phone. The phone runs the desktop's own UI in control mode
//! (`index.html?remote&control`, src-ui/src/remote/bridge.ts), the same as a desktop window
//! controlling another computer: everything is done by the paired computer, and this shell only
//! keeps the pairing key, opens links, and relays the already-encrypted connection.

use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewWindow};

/// The relay is the desktop's own (src/remote_link.rs), shared rather than copied.
#[path = "../../src/remote_link.rs"]
#[allow(dead_code)] // close_window: the phone's one window ends with the app
mod remote_link;

/// What remote_link.rs checks a caller against: on the phone, the one window is the control window.
mod remote_window {
    pub const LABEL_PREFIX: &str = "main";
}

fn pairing_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("pairing.json"))
}

fn load_pairing(app: &AppHandle) -> Value {
    pairing_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or(Value::Null)
}

/// The key this phone paired with. One computer for now; the pairing link comes from the page.
#[tauri::command]
fn remote_control_info(window: WebviewWindow) -> Value {
    json!({ "origin": null, "pairing": load_pairing(window.app_handle()), "pairLink": null })
}

/// Keep (or, with `null`, drop) the pairing key.
#[tauri::command]
fn remote_pairing_save(window: WebviewWindow, pairing: Value) -> Result<(), String> {
    let path = pairing_path(window.app_handle())?;
    if pairing.is_null() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if !pairing.is_object() {
        return Err("bad pairing".into());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec(&pairing).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// The page learned its computer's name. A phone has no window title to put it in.
#[tauri::command]
fn remote_window_set_name(_name: String) {}

/// Links from the UI open in the phone's browser.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "bad url".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("unsupported link".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            remote_control_info,
            remote_pairing_save,
            remote_window_set_name,
            open_url,
            remote_link::remote_link_open,
            remote_link::remote_link_send,
            remote_link::remote_link_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Coffee CLI mobile");
}
