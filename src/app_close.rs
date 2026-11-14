//! Closing the main window.
//!
//! The close button, Alt+F4 and (on macOS) the red traffic light or Cmd+W all
//! land in `request`, which asks the frontend what to do: it owns the user's
//! choice (ask / keep running / quit) and knows which sessions are running.
//! The frontend answers with `app_close_ack` at once; a webview that never
//! answers cannot keep the window open, so an unanswered request quits after a
//! short grace period. Cmd+Q still quits on macOS: it never asks to close.
//!
//! Keeping running hides the window to the notification area on Windows and
//! to the menu bar on macOS (the Dock icon goes too until the window is back),
//! and minimizes it on Linux. The macOS menu bar icon is there from launch.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};

static REQUESTED: AtomicU64 = AtomicU64::new(0);
static ACKNOWLEDGED: AtomicU64 = AtomicU64::new(0);
const ACK_GRACE: Duration = Duration::from_millis(2500);

/// A running session as the tray menu lists it.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub struct TraySession {
    pub id: String,
    pub label: String,
}

/// The tray menu in the interface language: open, each running session, quit.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
pub struct TrayMenu {
    pub open: String,
    pub quit: String,
    pub sessions: Vec<TraySession>,
}

static TRAY_MENU: Mutex<Option<TrayMenu>> = Mutex::new(None);

/// Ask the frontend how to close the main window.
pub fn request(app: &AppHandle) {
    let seq = REQUESTED.fetch_add(1, Ordering::SeqCst) + 1;
    if app.emit_to("main", "main-window-close-requested", seq).is_err() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ACK_GRACE);
        if unanswered(seq, ACKNOWLEDGED.load(Ordering::SeqCst)) {
            eprintln!("[app-close] the window never answered close request {seq}; quitting");
            app.exit(0);
        }
    });
}

fn unanswered(requested: u64, acknowledged: u64) -> bool {
    acknowledged < requested
}

#[tauri::command]
pub fn app_close_ack(seq: u64) {
    ACKNOWLEDGED.fetch_max(seq, Ordering::SeqCst);
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// Keep running without a window: in the notification area on Windows, in the menu bar on macOS, minimized on Linux.
#[tauri::command]
pub fn app_keep_running(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    #[cfg(any(windows, target_os = "macos"))]
    {
        tray::ensure(&app).map_err(|error| error.to_string())?;
        window.hide().map_err(|error| error.to_string())?;
        // macOS: the menu bar icon is the way back, so the Dock icon goes until the window does.
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        window.minimize().map_err(|error| error.to_string())
    }
}

/// Bring the main window back (and on macOS the Dock icon with it).
pub fn show_main(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// macOS: the menu bar icon is there from launch, as in the sister app.
#[cfg(target_os = "macos")]
pub fn install_menu_bar(app: &AppHandle) {
    if let Err(error) = tray::ensure(app) {
        eprintln!("[app-close] menu bar icon unavailable: {error}");
    }
}

/// What the tray menu shows; the menu is rebuilt when a tray exists.
#[tauri::command]
pub fn app_tray_menu(app: AppHandle, menu: TrayMenu) {
    if let Ok(mut current) = TRAY_MENU.lock() {
        *current = Some(menu);
    }
    #[cfg(any(windows, target_os = "macos"))]
    tray::refresh(&app);
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = app;
}

#[cfg(any(windows, target_os = "macos"))]
mod tray {
    use super::{show_main, TrayMenu, TRAY_MENU};
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{AppHandle, Emitter, Manager, Wry};

    const TRAY_ID: &str = "main";
    const TAB_PREFIX: &str = "tab:";

    pub fn ensure(app: &AppHandle) -> tauri::Result<()> {
        if app.tray_by_id(TRAY_ID).is_some() {
            return Ok(());
        }
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("Coffee CLI")
            .menu(&menu(app)?)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "open" {
                    show_main(app);
                } else if id == "quit" {
                    app.exit(0);
                } else if let Some(tab) = id.strip_prefix(TAB_PREFIX) {
                    show_main(app);
                    let _ = app.emit_to("main", "tray-focus-tab", tab.to_string());
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    let app = tray.app_handle();
                    // macOS: a left click toggles the window, as in the sister app; the menu is on the right button.
                    #[cfg(target_os = "macos")]
                    if app.get_webview_window("main").and_then(|window| window.is_visible().ok()).unwrap_or(false) {
                        let _ = super::app_keep_running(app.clone());
                        return;
                    }
                    show_main(app);
                }
            });
        #[cfg(target_os = "macos")]
        {
            // A one-colour template image, so the menu bar tints it for light and dark.
            builder = builder.icon(menu_bar_icon()?).icon_as_template(true);
        }
        #[cfg(windows)]
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn menu_bar_icon() -> tauri::Result<tauri::image::Image<'static>> {
        let decoder = png::Decoder::new(&include_bytes!("../icons/tray-template.png")[..]);
        let mut reader = decoder.read_info().map_err(|error| tauri::Error::Anyhow(error.into()))?;
        let mut pixels = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut pixels).map_err(|error| tauri::Error::Anyhow(error.into()))?;
        pixels.truncate(frame.buffer_size());
        Ok(tauri::image::Image::new_owned(pixels, frame.width, frame.height))
    }

    pub fn refresh(app: &AppHandle) {
        if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), menu(app)) {
            let _ = tray.set_menu(Some(menu));
        }
    }

    fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
        let content = TRAY_MENU.lock().ok().and_then(|menu| menu.clone()).unwrap_or_else(|| TrayMenu {
            open: "Open Coffee CLI".into(),
            quit: "Quit".into(),
            sessions: Vec::new(),
        });
        let menu = Menu::new(app)?;
        menu.append(&MenuItem::with_id(app, "open", content.open, true, None::<&str>)?)?;
        if !content.sessions.is_empty() {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            for session in content.sessions {
                menu.append(&MenuItem::with_id(app, format!("{TAB_PREFIX}{}", session.id), session.label, true, None::<&str>)?)?;
            }
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "quit", content.quit, true, None::<&str>)?)?;
        Ok(menu)
    }
}

#[cfg(test)]
mod tests {
    use super::unanswered;

    #[test]
    fn a_close_request_quits_only_until_the_window_answers_it() {
        assert!(unanswered(1, 0));
        assert!(!unanswered(1, 1));
        assert!(unanswered(3, 2), "an answer to an older request does not cover a newer one");
        assert!(!unanswered(2, 3));
    }
}
