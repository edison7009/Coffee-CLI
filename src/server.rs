use crate::terminal;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{State, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;

/// Shared app state
pub struct AppState {
    pub terminal_session: terminal::SharedSession,
    /// Active OS fs watcher (one per app instance). Some(...) while a
    /// workspace folder is open; None otherwise. Swapping this Mutex'd
    /// Option replaces the watcher atomically on folder switch.
    pub fs_watcher: Mutex<Option<crate::fs_watcher::FsWatcher>>,
    /// External launch requests (`launch --tool …` argv or a `coffeecli://`
    /// prompt link). Parked until the frontend drains it on mount
    /// (`take_pending_launch`); later ones are emitted as `launch-request`
    /// events instead (see launch.rs).
    pub pending_launch: Mutex<crate::launch::LaunchInbox>,
}


#[tauri::command]
fn window_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_maximize(window: tauri::Window) {
    let is_max = window.is_maximized().unwrap_or(false);
    if is_max { let _ = window.unmaximize(); } else { let _ = window.maximize(); }
}

#[tauri::command]
fn window_close(window: tauri::Window, app: tauri::AppHandle) {
    let label = window.label().to_string();
    if label == "main" {
        // Main window: the frontend decides between asking, keeping Coffee CLI running and quitting.
        crate::app_close::request(&app);
    } else {
        // Detached window: just close this one
        let _ = window.close();
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Apply (on=true) or clear (off=false) a native frosted backdrop so the
/// desktop behind the window is genuinely blurred — real transparency, not a
/// blurred wallpaper image. CSS backdrop-filter cannot sample pixels outside
/// a webview, so Windows uses DWM Acrylic, macOS uses NSVisualEffectView, and
/// Linux asks KWin through its X11/Wayland blur-behind interfaces.
///
/// On Windows, while Frost is on the window is made OPAQUE (WS_EX_LAYERED
/// removed) and rounded via DWMWCP_ROUND — the standard Win11 Acrylic-window
/// path (Windows Terminal, Files, etc.). Rounding via DWM, NOT SetWindowRgn:
/// a window region can't clip the Acrylic layer (square corners) and resets the frameless
/// borderless state on focus (default frame reappearing). The webview stays
/// transparent so the Acrylic shows through; the app's rounded corners come
/// from DWM instead of the CSS clip-path while Frost is active.
#[tauri::command]
fn set_frosted_backdrop(app: tauri::AppHandle, on: bool, dark: bool, follow_system: Option<bool>) {
    #[cfg(target_os = "windows")]
    {
        let _ = follow_system;
        use tauri::Manager;
        use windows::Win32::Foundation::{BOOL, FALSE, HWND, TRUE};
        use windows::Win32::Graphics::Dwm::{
            DWM_SYSTEMBACKDROP_TYPE, DWMSBT_TRANSIENTWINDOW, DwmSetWindowAttribute,
            DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_WINDOW_CORNER_PREFERENCE,
            DWMWCP_DONOTROUND, DWMWCP_ROUND, DWMWINDOWATTRIBUTE,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED,
        };

        if let Some(w) = app.get_webview_window("main") {
            let win = w.as_ref().window();
            // tauri's `.hwnd()` returns its own windows-crate HWND (0.61);
            // re-wrap into OUR windows 0.58 HWND so it unifies with the DWM /
            // style APIs below (mirrors the setup hook).
            let Ok(raw) = win.hwnd() else { return };
            let hwnd = HWND(raw.0 as *mut _);

            // Toggle the layered style so DWM owns the window backdrop.
            unsafe {
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                let new_ex = if on { ex & !WS_EX_LAYERED.0 } else { ex | WS_EX_LAYERED.0 };
                let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex as isize);
            }

            if on {
                // Native acrylic (DWMSBT_TRANSIENTWINDOW). window-vibrancy's
                // apply_acrylic IGNORES its tint on Win11 22H2+ (only the legacy
                // fallback uses it). DWM therefore owns blur/noise only; the
                // WebView overlays the user's selected --bg-app colour. Keep
                // DWM's base palette in sync with that theme and let DWM own
                // the rounded corners. Attribute 35 is DWMWA_CAPTION_COLOR,
                // not a backdrop-tint API, so it must not be used here.
                let backdrop = DWMSBT_TRANSIENTWINDOW;
                let dark_mode: BOOL = if dark { TRUE } else { FALSE };
                let pref: i32 = DWMWCP_ROUND.0;
                unsafe {
                    let _ = DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop as *const _ as *const core::ffi::c_void, 4);
                    let _ = DwmSetWindowAttribute(hwnd, DWMWINDOWATTRIBUTE(20), &dark_mode as *const _ as *const core::ffi::c_void, 4);
                    let _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const _ as *const core::ffi::c_void, 4);
                }
            } else {
                let backdrop = DWM_SYSTEMBACKDROP_TYPE(0); // DWMSBT_DISABLE
                let dark: BOOL = FALSE;
                let pref: i32 = DWMWCP_DONOTROUND.0;
                unsafe {
                    let _ = DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop as *const _ as *const core::ffi::c_void, 4);
                    let _ = DwmSetWindowAttribute(hwnd, DWMWINDOWATTRIBUTE(20), &dark as *const _ as *const core::ffi::c_void, 4);
                    let _ = DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &pref as *const _ as *const core::ffi::c_void, 4);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        use window_vibrancy::{
            apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
        };
        if let Some(w) = app.get_webview_window("main") {
            // The window's native appearance follows the app's light or dark mode, not the system's,
            // so the traffic lights are drawn for the page under them (dark ones turn to glass).
            // "System" releases the override, so the page still hears the system switch light and dark.
            let _ = w.set_theme(if follow_system.unwrap_or(false) { None } else if dark { Some(tauri::Theme::Dark) } else { Some(tauri::Theme::Light) });
            if on {
                // Match vibrancy to the colour theme rather than the macOS
                // system appearance. With the intentionally light 30% CSS
                // tint, a mismatched native material would dominate the
                // remaining 70% and destroy text contrast.
                #[allow(deprecated)]
                let material = if dark {
                    NSVisualEffectMaterial::Dark
                } else {
                    NSVisualEffectMaterial::Light
                };
                let _ = apply_vibrancy(
                    &w,
                    material,
                    Some(NSVisualEffectState::FollowsWindowActiveState),
                    Some(20.0),
                );
            } else {
                let _ = clear_vibrancy(&w);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            // KWin performs real, live compositor blur on both X11 and
            // Wayland. Other Linux compositors simply keep Tauri's genuine
            // transparent surface plus the selected-theme tint; there is no
            // cross-desktop blur API and no wallpaper/screenshot fakery.
            let _ = crate::linux_blur::set_blur(&w, on);
        }
        let _ = (dark, follow_system);
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let _ = (app, on, dark, follow_system);
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<String, String> {
    let folder = app
        .dialog()
        .file()
        .blocking_pick_folder();

    match folder {
        Some(path) => Ok(path.to_string()),
        None => Err("cancelled".to_string()),
    }
}

// ─── Tool Availability Detection ─────────────────────────────────────────────

/// PATH lookup wrapper. Used by hook_installer + agent_mcp_config to
/// gate config-file writes so we don't materialize stray `~/.codex/`,
/// `~/.config/opencode/`, etc. on machines where the user hasn't
/// installed the upstream CLI yet.
pub(crate) fn binary_on_path(bin: &str) -> bool {
    if bin == "claude" && dirs::home_dir().is_some_and(|home| home.join(".local/bin").join(if cfg!(windows) { "claude.exe" } else { "claude" }).is_file()) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        check_tool_windows(bin)
    }
    #[cfg(not(target_os = "windows"))]
    {
        check_tool_unix(bin)
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn check_tool_windows(bin: &str) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("where")
        .arg(bin)
        .env("PATH", crate::windows_path::terminal_path())
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn check_tool_unix(bin: &str) -> bool {
    std::process::Command::new("which")
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Apply non-hook presentation maintenance for one tool.
/// Called from the launchpad's focus-rescan when `check_tools_installed`
/// flips a CLI from not-installed → installed, so users who install a
/// CLI while Coffee CLI is running also get the OpenCode-family transparent
/// theme migration without restarting. Idempotent.
#[tauri::command]
fn take_pending_launch(state: State<'_, AppState>) -> Option<crate::launch::LaunchRequest> {
    state.pending_launch.lock().ok()?.take()
}

/// Probe which optional shells are installed, so the settings picker can
/// show only the ones the user actually has (avoids offering a dead Git
/// Bash card when Git for Windows isn't installed, etc.). Cheap — a few
/// `where`/`exists` checks — safe to call on settings open. See
/// `shell_probe::detect_capabilities` for the per-shell strategy.
#[tauri::command]
async fn detect_shells() -> Result<crate::shell_probe::ShellCapabilitiesJson, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut caps = crate::shell_probe::detect_capabilities();
        // Exact versions are probed here (Settings open), not in
        // detect_capabilities (startup/spawn) — powershell.exe's $PSVersionTable
        // takes ~1-2s and would stall boot if it ran there.
        crate::shell_probe::populate_versions(&mut caps);
        crate::shell_probe::ShellCapabilitiesJson::from(&caps)
    }).await.map_err(|e| e.to_string())
}

// ─── File System Live Watcher ────────────────────────────────────────────────
//
// Start/stop a recursive fs watcher on the workspace folder so changes
// made by external tools (terminal CLIs, editors, git, etc.) propagate
// into the Explorer tree immediately. See fs_watcher.rs for mechanics.

#[tauri::command]
async fn start_fs_watcher(
    path: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let watcher = crate::fs_watcher::FsWatcher::start(app.clone(), PathBuf::from(path))?;
        let old = app.state::<AppState>().fs_watcher.lock().map_err(|e| format!("lock: {}", e))?.replace(watcher);
        drop(old);
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_fs_watcher(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let old = app.state::<AppState>().fs_watcher.lock().map_err(|e| format!("lock: {}", e))?.take();
        drop(old);
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

// ─── File System Browsing API ────────────────────────────────────────────────

/// Information about a single directory entry (file or folder)
#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// List the immediate children of a directory.
/// Returns files and subdirectories sorted: directories first, then files, both alphabetical.
#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_directory_blocking(path)).await.map_err(|e| e.to_string())?
}

fn list_directory_blocking(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<DirEntry> = Vec::new();

    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Cannot read directory: {}", e))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // Skip unreadable entries
        };
        let name = entry.file_name().to_string_lossy().to_string();

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // Skip unreadable entries
        };

        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // Sort: directories first, then files, both alphabetical (case insensitive)
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(entries)
}


fn stats_is_text(bytes: &[u8]) -> bool {
    // Same heuristic git uses: any null byte in first 8 KB → treat as binary.
    !bytes[..bytes.len().min(8192)].contains(&0u8)
}


/// Canonical form of a path used as a snapshot map key. Forward-slashes
/// always; on Windows the drive letter is forced to uppercase. Reason:
/// `start_folder_snapshot` walks the dir the user picked (typically
/// uppercase `D:\…`) and writes keys like `D:/Coffee-CLI/…`, but
/// Claude Code's PostToolUse hook reports `tool_input.file_path` with
/// whatever casing the model chose — often lowercase `d:\…`. HashMap
/// is case-sensitive, so without this normalization every per-call
/// hook event misses the baseline and the audit list fills up with
/// bogus "+N -0" rows from the no-baseline fall-through branch.
pub(crate) fn normalize_path_key(path: &str) -> String {
    let s = path.replace('\\', "/");
    #[cfg(windows)]
    {
        let bytes = s.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            let mut out = String::with_capacity(s.len());
            out.push((bytes[0] as char).to_ascii_uppercase());
            out.push_str(&s[1..]);
            return out;
        }
    }
    s
}


/// Read a text file from disk as UTF-8 string. `None` when the file doesn't
/// exist, can't be read, or fails the text-vs-binary heuristic. Pairs with
/// `get_baseline_content` to feed the right-side Diff panel: baseline +
/// current = both sides of the diff.
#[tauri::command]
async fn read_text_file(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).ok()?;
        if !stats_is_text(&bytes) { return None; }
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }).await.ok().flatten()
}


/// Save a base64-encoded clipboard image to a temp file.
/// Used by the Gambit compose window so pasted screenshots can be referenced
/// by path when forwarded to AI CLI agents (Claude Code, etc.).
///
/// Guards:
/// - Extension whitelisted to common raster formats
/// - Hard 25 MB size cap to prevent runaway base64 payloads filling the disk
/// - Filename uses pid + atomic counter so two concurrent paste calls (same
///   millisecond) can never collide and truncate each other's file
#[tauri::command]
fn save_clipboard_image(data_base64: String, extension: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    const MAX_BYTES: usize = 25 * 1024 * 1024; // 25 MB

    // Only allow common web image formats. Block anything that could
    // execute or exploit a path-traversal quirk in the extension.
    let ext = match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => extension,
        _ => return Err(format!("Unsupported image extension: {}", extension)),
    };

    let bytes = general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64 decode: {}", e))?;

    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "Image too large: {} bytes (max {})",
            bytes.len(),
            MAX_BYTES
        ));
    }

    let tmp_dir = std::env::temp_dir().join("coffee-cli").join("pasted-images");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("mkdir: {}", e))?;

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path = tmp_dir.join(format!("clip-{}-{}-{}.{}", stamp, pid, seq, ext));

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("create image file: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("write image bytes: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

/// Read a still image from the system clipboard and persist it as a PNG temp
/// file, returning the path (or `None` when the clipboard holds no image).
///
/// This replaces the old `navigator.clipboard.read()` path in the frontend,
/// which violated the project's clipboard rule: WebView2 may pop a native
/// "tauri.localhost wants to read the clipboard" permission prompt on every
/// paste. Routing through Tauri's `plugin-clipboard-manager` (arboard) reads
/// the OS clipboard directly with no permission prompt.
///
/// `read_image()` must NOT run on the main thread (deadlocks on Linux when
/// the WebView also touches the clipboard), so the whole command is async and
/// offloaded to `spawn_blocking`. The plugin returns raw RGBA — no original
/// format — so we re-encode to PNG (screenshots paste as PNG anyway).
#[tauri::command]
async fn read_clipboard_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use std::sync::atomic::{AtomicU64, Ordering};

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;

        let image = match app.clipboard().read_image() {
            Ok(img) => img,
            // No image in the clipboard, or clipboard temporarily unavailable
            // (some apps hold an exclusive lock). Not an error — caller falls
            // back to text paste.
            Err(_) => return Ok(None),
        };

        let rgba = image.rgba();
        let width = image.width();
        let height = image.height();
        if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
            return Ok(None);
        }

        // 25 MB cap matches save_clipboard_image — bounds temp-disk usage from
        // absurdly large clipboard bitmaps before we even attempt PNG deflate.
        const MAX_BYTES: usize = 25 * 1024 * 1024;
        if rgba.len() > MAX_BYTES {
            return Err(format!(
                "Clipboard image too large: {} bytes (max {})",
                rgba.len(),
                MAX_BYTES
            ));
        }

        let tmp_dir = std::env::temp_dir().join("coffee-cli").join("pasted-images");
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("mkdir: {}", e))?;

        static SEQ: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let pid = std::process::id();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = tmp_dir.join(format!("clip-{}-{}-{}.png", stamp, pid, seq));

        // Encode RGBA → PNG. The png 0.17 encoder owns the writer; collect to
        // a Vec then write once so a mid-encode failure can't leave a partial
        // file that an AI CLI would later try to read as a real image.
        let mut buf = std::io::Cursor::new(Vec::with_capacity(rgba.len()));
        {
            let mut encoder = png::Encoder::new(&mut buf, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| format!("png header: {}", e))?;
            writer
                .write_image_data(rgba)
                .map_err(|e| format!("png encode: {}", e))?;
        }

        std::fs::write(&path, buf.into_inner())
            .map_err(|e| format!("write image file: {}", e))?;

        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("join: {}", e))?
}

// ─── File System Operations ───────────────────────────────────────────────────

/// A conversation's `~/…` path names the home folder; the shell would expand it, the OS opener does not.
fn expand_home(path: String) -> String {
    let rest = if path == "~" { Some("") } else { path.strip_prefix("~/") };
    match (rest, dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest).to_string_lossy().into_owned(),
        _ => path,
    }
}
/// Open the native file explorer and highlight / reveal the given path.
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    let path = expand_home(path);
    // Explorer opens an unrelated default folder for a path that does not exist.
    if !std::path::Path::new(&path).exists() { return Err(format!("Path not found: {path}")); }
    #[cfg(target_os = "windows")]
    {
        // explorer /select, highlights the item in its parent folder.
        // The frontend normalizes paths to forward slashes, but explorer.exe
        // requires backslashes — forward slashes cause it to silently open Desktop.
        let win_path = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&win_path)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let p = std::path::Path::new(&path);
        std::process::Command::new("open")
            .arg("-R") // Reveal in Finder
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let p = std::path::Path::new(&path);
        // Open the parent directory; most Linux file managers don't support select
        let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().unwrap_or(p).to_path_buf() };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }
    Ok(())
}

/// Resolve the parent, preserving the final entry (including dangling links).
/// Canonicalizing the entry itself would delete/move a link's target instead.
fn validate_fs_path(path: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::Path::new(path);
    let name = path.file_name().ok_or("Invalid source path")?;
    let parent = path.parent().ok_or("No parent directory")?;
    let canonical = parent
        .canonicalize()
        .map_err(|e| format!("Invalid parent directory: {e}"))?
        .join(name);
    validate_fs_depth(&canonical)?;
    std::fs::symlink_metadata(&canonical).map_err(|e| format!("Invalid path: {e}"))?;
    Ok(canonical)
}

fn validate_fs_depth(path: &std::path::Path) -> Result<(), String> {
    // Count names, excluding drive/UNC prefixes and root separators on Windows.
    if path.components().filter(|c| matches!(c, std::path::Component::Normal(_))).count() < 2 {
        return Err("Operation rejected: path is too shallow (system-level directory)".to_string());
    }
    Ok(())
}

fn require_unused_destination(path: &std::path::Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Err("Destination already exists; choose another name or folder".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot inspect destination: {e}")),
    }
}

/// Delete a file or directory permanently (no recycle bin).
#[tauri::command]
fn fs_delete(path: String) -> Result<(), String> {
    let p = validate_fs_path(&path)?;
    let metadata = std::fs::symlink_metadata(&p).map_err(|e| format!("Delete failed: {e}"))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        // Directory symlinks and junctions use RemoveDirectory, even dangling.
        if metadata.file_type().is_symlink_dir() {
            return std::fs::remove_dir(&p).map_err(|e| format!("Delete link failed: {e}"));
        }
    }
    if metadata.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Delete failed: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Delete failed: {e}"))
    }
}

/// Rename / move a path to a new name within the same parent directory.
#[tauri::command]
fn fs_rename(path: String, new_name: String) -> Result<(), String> {
    if new_name.is_empty() || new_name == "." || new_name == ".."
        || new_name.contains(['/', '\\', '\0'])
        || (cfg!(windows) && (new_name.contains(':') || new_name.ends_with(['.', ' '])))
    {
        return Err("New name must be a single file or directory name".into());
    }
    let src = validate_fs_path(&path)?;
    let dest = src.parent()
        .ok_or_else(|| "No parent directory".to_string())?
        .join(&new_name);
    if src == dest { return Ok(()); }
    require_unused_destination(&dest)?;
    std::fs::rename(&src, dest).map_err(|e| format!("Rename failed: {e}"))
}

/// Paste (copy or move) a file/directory into a target directory.
/// `action` is either "copy" or "cut".
#[tauri::command]
fn fs_paste(action: String, src_path: String, target_dir: String) -> Result<(), String> {
    let src = validate_fs_path(&src_path)?;
    let target_canonical = std::path::Path::new(&target_dir)
        .canonicalize()
        .map_err(|e| format!("Invalid target directory: {e}"))?;
    validate_fs_depth(&target_canonical)?;
    if !target_canonical.is_dir() { return Err("Target must be a directory".into()); }
    let file_name = src.file_name().ok_or("Invalid source path")?;
    let dest = target_canonical.join(file_name);
    require_unused_destination(&dest)?;
    // Resolve aliases in the target before checking ancestry. A directory must
    // never be copied/moved into itself, including through a parent symlink.
    if src.is_dir() && target_canonical.starts_with(src.canonicalize().map_err(|e| e.to_string())?) {
        return Err("Cannot paste a directory inside itself".into());
    }

    match action.as_str() {
        "cut" => {
            std::fs::rename(&src, &dest).map_err(|e| format!("Move failed: {e}"))
        }
        "copy" => {
            copy_fs_entry(&src, &dest).map_err(|e| format!("Copy failed: {e}"))
        }
        _ => Err(format!("Unknown action: {action}")),
    }
}

/// Copy entries without merging, overwriting files, or traversing symlinks.
fn copy_fs_entry(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(src)?;
    #[cfg(unix)]
    if metadata.is_symlink() {
        return std::os::unix::fs::symlink(std::fs::read_link(src)?, dest);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if metadata.is_symlink() {
            let target = std::fs::read_link(src)?;
            return if metadata.file_type().is_symlink_dir() {
                std::os::windows::fs::symlink_dir(target, dest)
            } else {
                std::os::windows::fs::symlink_file(target, dest)
            };
        }
    }
    if metadata.is_dir() {
        std::fs::create_dir(dest)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_fs_entry(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        let mut input = std::fs::File::open(src)?;
        let mut output = std::fs::File::options().write(true).create_new(true).open(dest)?;
        std::io::copy(&mut input, &mut output)?;
    } else {
        return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Cannot copy a special file"));
    }
    std::fs::set_permissions(dest, metadata.permissions())
}

#[tauri::command]
async fn tier_terminal_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Grab the writer handle while holding the map lock (cheap clone, no I/O).
    let writer_arc = {
        let map = state.terminal_session.lock().unwrap();
        match map.get(&session_id) {
            Some(s) => s.writer_lock.clone(),
            None => return Err(format!("No active terminal session for id: {}", session_id)),
        }
    };
    // Map lock released — other tabs can now proceed concurrently

    // PTY write may block under back-pressure, after the session-map lock has
    // already been released so other tabs remain responsive.
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let mut w = writer_arc.lock().map_err(|e| format!("Writer lock poisoned: {}", e))?;
        w.write_all(data.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
        w.flush().map_err(|e| format!("Flush failed: {}", e))
    }).await.map_err(|e| e.to_string())?
}

/// Raw write used for system-generated input like auto-skip Enter for the
/// Claude trust prompt.
#[tauri::command]
async fn tier_terminal_raw_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tier_terminal_input(session_id, data, state).await
}

/// Toggle the global background-throttle flag. Called by the frontend
/// from a `document.visibilitychange` listener: when the OS hides the
/// Coffee CLI window (other Space, app switched away, minimized) we
/// widen every per-session worker's polling cadence so the app drops
/// to near-zero CPU instead of running its full foreground loop.
#[tauri::command]
fn set_background_mode(hidden: bool) {
    crate::terminal::BACKGROUND_MODE
        .store(hidden, std::sync::atomic::Ordering::Relaxed);
}

/// Per-tab visibility flag, flipped by a frontend IntersectionObserver on
/// each terminal's DOM element. Narrower than `set_background_mode`: a tab
/// can be inactive this way while the Coffee CLI window itself is still
/// focused and foreground (e.g. one of several open AI-CLI tabs that isn't
/// the one currently shown). Widens that single session's emitter coalesce
/// window instead of parsing/emitting output nobody can see at full cadence.
/// No-op if the session doesn't exist yet (frontend can fire before the PTY
/// finishes spawning) or has already been killed.
#[tauri::command]
fn set_session_active(session_id: String, active: bool, state: State<'_, AppState>) -> Result<(), String> {
    let map = state.terminal_session.lock().unwrap();
    if let Some(session) = map.get(&session_id) {
        session.is_tab_active.store(active, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn tier_terminal_kill(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let map = state.terminal_session.lock().unwrap();
    if let Some(session) = map.get(&session_id) {
        let _ = session.kill_tx.send(());
    }
    Ok(())
}

#[tauri::command]
async fn tier_terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    resize_terminal_session(state.terminal_session.clone(), session_id.clone(), cols, rows).await?;
    // Browsers mirroring this terminal draw at the desktop's size.
    let _ = app.emit("tier-terminal-size", serde_json::json!({"id": session_id, "cols": cols, "rows": rows}));
    Ok(())
}

/// The PTY's current grid, for a browser that starts mirroring this terminal.
pub(crate) fn terminal_size(app: &tauri::AppHandle, session_id: &str) -> Option<(u16, u16)> {
    let state = app.state::<AppState>();
    let master = state.terminal_session.lock().ok()?.get(session_id)?._master.clone();
    let guard = master.lock().ok()?;
    let size = guard.as_ref()?.get_size().ok()?;
    Some((size.cols, size.rows))
}

async fn resize_terminal_session(sessions: terminal::SharedSession, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let master = {
        let map = sessions.lock().unwrap();
        map.get(&session_id).ok_or_else(|| format!("No active terminal session for id: {session_id}"))?._master.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let guard = master.lock().unwrap();
        let master = guard.as_ref().ok_or_else(|| format!("Terminal session has no PTY master: {session_id}"))?;
        resize_terminal_pty(master.as_ref(), cols, rows)
    }).await.map_err(|e| e.to_string())?
}

fn resize_terminal_pty(master: &dyn portable_pty::MasterPty, cols: u16, rows: u16) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("Resize requires a non-zero PTY size".to_string());
    }
    // get_size reads kernel state on Unix and ConPTY's applied size on Windows.
    // In particular, a Unix child can change winsize itself (e.g. stty).
    if master.get_size().is_ok_and(|size| size.cols == cols && size.rows == rows) {
        return Ok(());
    }
    master.resize(portable_pty::PtySize { cols, rows, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Resize failed: {e}"))
}

// Native chat history of each tool is a Pro module (pro/src/history.rs).
#[cfg(feature = "pro")]
pub(crate) use crate::history;
#[cfg(feature = "pro")]
#[allow(unused_imports)]
use crate::history::*;
#[cfg(feature = "pro")]
pub(crate) use crate::history::{is_system_injected, strip_codex_desktop_file_preamble};

// ─── Task Board Persistence ──────────────────────────────────────────────────

fn tasks_file_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".coffee-cli");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("tasks.json")
}

#[tauri::command]
fn load_tasks() -> Result<String, String> {
    let path = tasks_file_path();
    if path.exists() {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read tasks: {}", e))
    } else {
        Ok("[]".to_string())
    }
}

#[tauri::command]
fn save_tasks(data: String, app: tauri::AppHandle) -> Result<(), String> {
    // Validate JSON before writing to disk — guards against corrupted broadcasts
    serde_json::from_str::<serde_json::Value>(&data)
        .map_err(|e| format!("Invalid task data (not valid JSON): {e}"))?;
    let path = tasks_file_path();
    crate::json_file::write_atomic(&path, data.as_bytes())
        .map_err(|e| format!("Failed to save tasks: {}", e))?;
    // Notify all windows so other instances can reload
    let _ = app.emit("tasks-changed", &data);
    Ok(())
}

// ─── Saved Passwords (plain text) ──────────────────────────────────────────

const CREDENTIAL_SERVICE: &str = "coffee-cli";

/// Save a remote password as plain text in ~/.coffee-cli/credentials.json.
/// The key is `username@host`.
#[tauri::command]
fn save_password(host: String, username: String, password: String) -> Result<(), String> {
    let account = format!("{}@{}", username, host);
    crate::credentials::Entry::new(CREDENTIAL_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .set_password(&password)
        .map_err(|e| e.to_string())
}

/// Load a previously saved password.
/// Returns `None` if no entry exists (user hasn't saved one yet).
#[tauri::command]
fn load_password(host: String, username: String) -> Result<Option<String>, String> {
    let account = format!("{}@{}", username, host);
    match crate::credentials::Entry::new(CREDENTIAL_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .get_password()
    {
        Ok(pw) => Ok(Some(pw)),
        Err(crate::credentials::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove a saved password (e.g. user clicked "forget").
#[tauri::command]
fn delete_password(host: String, username: String) -> Result<(), String> {
    let account = format!("{}@{}", username, host);
    match crate::credentials::Entry::new(CREDENTIAL_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) => Ok(()),
        Err(crate::credentials::Error::NoEntry) => Ok(()), // already gone, not an error
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn check_network_port(host: String, port: u16) -> Result<bool, String> {
    use std::time::Duration;
    use std::net::ToSocketAddrs;
    
    let target = format!("{}:{}", host, port);
    
    // Run blocking network check in a dedicated blocking task to avoid stalling the async runtime
    let reachable = tauri::async_runtime::spawn_blocking(move || {
        match target.to_socket_addrs() {
            Ok(mut addrs) => {
                if let Some(addr) = addrs.next() {
                    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_ok()
                } else {
                    false
                }
            },
            Err(_) => false
        }
    }).await.unwrap_or(false);

    Ok(reachable)
}

pub(crate) fn computer_name_value() -> String { computer_name().unwrap_or_default() }

#[tauri::command]
fn computer_name() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        if !name.trim().is_empty() { return Ok(name.trim().to_string()); }
    }
    let mut command = std::process::Command::new("hostname");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || name.is_empty() { return Err("Could not read computer name".into()); }
    Ok(name)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let url = expand_home(url);
    if url.is_empty() || url.starts_with('-') || url.contains('\0') {
        return Err("Invalid URL or file path".into());
    }
    #[cfg(target_os = "windows")]
    {
        use windows::{core::{w, PCWSTR}, Win32::{Foundation::HWND,
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL}}};
        // Pass the entire URL/path as data to the native association handler.
        // cmd /C start would interpret &, pipes and other shell syntax in it.
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            ShellExecuteW(HWND::default(), w!("open"), PCWSTR(target.as_ptr()),
                PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
        };
        if result.0 as isize <= 32 {
            return Err(format!("Failed to open URL or file (Windows error {})", result.0 as isize));
        }
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    Ok(())
}


pub fn start_ui(pending_launch: Option<crate::launch::LaunchRequest>) -> anyhow::Result<()> {
    // Create shared session BEFORE the builder so we can clone it for the exit handler
    let terminal_session = terminal::SharedSession::default();

    let builder = tauri::Builder::default();

    // Single-instance plugin MUST be the first plugin registered (per
    // Tauri docs) so its argv-forwarding hook runs before any other
    // plugin's init touches state. When a user double-launches Coffee CLI,
    // the second process sends its argv+cwd to this callback in the first
    // process and exits — the first process then refocuses the main window.
    // Side effect we want: only ever one WebView2 instance, which kills
    // the multi-process IME-jumps-to-(0,0) bug.
    //
    // Release-only: in debug builds we skip the lock so a dev `cargo tauri
    // dev` window can run side-by-side with an installed production build
    // (devs working on Coffee CLI inside Coffee CLI). Both builds otherwise
    // share the bundle identifier, and the lock would silently redirect the
    // dev launch to the production process and exit.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        // A second instance invoked as `launch --tool … --cwd …`, or opened
        // from a `coffeecli://` link on Windows/Linux, forwards its argv here —
        // re-parse and hand the request to the ALREADY-RUNNING instance, so
        // nothing restarts and existing tabs are untouched (see launch.rs).
        if let Some(req) = crate::launch::parse_launch_args(&args) {
            crate::launch::deliver(app, req);
        }
    }));

    // Pro's desktop conversations keep their sessions in app state.
    #[cfg(feature = "pro")]
    let builder = crate::pro::manage(builder);

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Reopen the window at the size and place the user left it. Visibility stays with
        // show_main_window (the window appears after the first paint), decorations differ per
        // platform, and a restored fullscreen opens awkwardly on macOS, so only these three persist.
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .build())
        .manage(AppState {
            terminal_session,
            fs_watcher: Mutex::new(None),
            pending_launch: Mutex::new(crate::launch::LaunchInbox::new(pending_launch)),
        })
        .invoke_handler(tauri::generate_handler![
            crate::app_close::app_close_ack,
            crate::remote_window::remote_window_open,
            crate::remote_window::remote_window_list,
            crate::remote_window::remote_window_focus,
            crate::remote_window::remote_window_close,
            crate::remote_window::remote_control_info,
            crate::remote_window::remote_pairing_save,
            crate::remote_window::remote_window_set_name,
            #[cfg(feature = "pro")] crate::window_control::window_control_tools,
            #[cfg(feature = "pro")] crate::window_control::window_control_set_tool,
            #[cfg(feature = "pro")] crate::window_control::window_control_resolve,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_remote_update,
            #[cfg(feature = "pro")] crate::git_project_status::git_repo_key,
            crate::remote_window::remote_window_show_tab,
            #[cfg(feature = "pro")] crate::window_control::window_control_state,
            #[cfg(feature = "pro")] crate::window_control::window_control_set_pick,
            crate::remote_link::remote_link_open,
            crate::remote_link::remote_link_send,
            crate::remote_link::remote_link_close,
            crate::app_close::app_quit,
            crate::app_close::app_keep_running,
            crate::app_close::app_tray_menu,
            crate::session_directory::check_project_directories,
            crate::session_directory::resolve_project_directory,
            #[cfg(feature = "pro")] crate::claude_session::claude_session_start,
            #[cfg(feature = "pro")] crate::claude_session::claude_session_history,
            #[cfg(feature = "pro")] crate::claude_session::claude_session_preview,
            #[cfg(feature = "pro")] crate::claude_session::claude_session_send,
            #[cfg(feature = "pro")] crate::claude_session::claude_session_control,
            #[cfg(feature = "pro")] crate::claude_session::claude_session_respond,
            #[cfg(feature = "pro")] crate::claude_session::claude_session_close,
            #[cfg(feature = "pro")] crate::codex_session::codex_session_start,
            #[cfg(feature = "pro")] crate::usage_quota::usage_quota_query,
            #[cfg(feature = "pro")] crate::codex_session::codex_session_request,
            #[cfg(feature = "pro")] crate::codex_session::codex_session_respond,
            #[cfg(feature = "pro")] crate::codex_session::codex_session_close,
            #[cfg(feature = "pro")] crate::opencode_session::opencode_session_start,
            #[cfg(feature = "pro")] crate::opencode_session::opencode_session_request,
            #[cfg(feature = "pro")] crate::opencode_session::opencode_session_close,
            #[cfg(feature = "pro")] crate::dsh_session::dsh_session_start,
            #[cfg(feature = "pro")] crate::dsh_session::dsh_session_request,
            #[cfg(feature = "pro")] crate::dsh_session::dsh_session_set_preset,
            #[cfg(feature = "pro")] crate::dsh_session::dsh_session_respond,
            #[cfg(feature = "pro")] crate::dsh_session::dsh_session_close,
            #[cfg(feature = "pro")] crate::dsh_session::dsh_session_history,
            #[cfg(feature = "pro")] crate::acp_session::acp_session_start,
            #[cfg(feature = "pro")] crate::acp_session::acp_session_request,
            #[cfg(feature = "pro")] crate::acp_session::acp_session_respond,
            #[cfg(feature = "pro")] crate::acp_session::acp_session_close,
            #[cfg(feature = "pro")] crate::pi_session::pi_session_start,
            #[cfg(feature = "pro")] crate::pi_session::pi_session_request,
            #[cfg(feature = "pro")] crate::pi_session::pi_session_respond,
            #[cfg(feature = "pro")] crate::pi_session::pi_session_close,
            crate::fonts::list_system_fonts,
            pick_folder,
            window_minimize,
            crate::notify_sound::play_notify_sound,
            crate::notify_sound::notify_sound_files,
            crate::notify_sound::notify_sound_choose,
            crate::notify_sound::notify_sound_clear,
            crate::notify_sound::notify_sound_read,
            window_maximize,
            window_close,
            show_main_window,
            set_frosted_backdrop,
            #[cfg(feature = "pro")] crate::tool_launch::tier_terminal_start,
            tier_terminal_input,
            tier_terminal_raw_write,
            tier_terminal_kill,
            tier_terminal_resize,
            set_background_mode,
            set_session_active,
            #[cfg(feature = "pro")] crate::history::get_native_history,
            #[cfg(feature = "pro")] crate::history::get_message_heatmap,
            #[cfg(feature = "pro")] crate::usage_stats::get_usage_statistics,
            #[cfg(feature = "pro")] crate::history::read_chat_session,
            #[cfg(feature = "pro")] crate::history::read_chat_navigation,
            #[cfg(feature = "pro")] crate::tool_launch::get_terminal_session_token,
            check_network_port,
            #[cfg(feature = "pro")] crate::tool_launch::check_tools_installed,
            #[cfg(feature = "pro")] crate::cli_updates::check_cli_update,
            #[cfg(feature = "pro")] crate::cli_updates::update_cli,
            detect_shells,
            #[cfg(feature = "pro")] crate::tools::list_tools,
            #[cfg(feature = "pro")] crate::tool_launch::maintain_tool_integration,
            take_pending_launch,
            start_fs_watcher,
            stop_fs_watcher,
            save_clipboard_image,
            read_clipboard_image,
            list_directory,
            read_text_file,
            show_in_folder,
            fs_delete,
            fs_rename,
            fs_paste,
            load_tasks,
            save_tasks,
            save_password,
            load_password,
            delete_password,
            computer_name,
            open_url,
            crate::self_update::download_update,
            crate::self_update::is_update_downloaded,
            crate::self_update::install_downloaded_update,
            #[cfg(feature = "pro")] crate::tool_launch::get_tool_config,
            #[cfg(feature = "pro")] crate::tool_launch::get_all_tool_configs,
            #[cfg(feature = "pro")] crate::tool_launch::set_tool_config,
            #[cfg(feature = "pro")] crate::tool_memory::read_tool_memory,
            #[cfg(feature = "pro")] crate::tool_memory::save_tool_memory,
            #[cfg(feature = "pro")] crate::tool_skills::get_tool_skills,
            #[cfg(feature = "pro")] crate::tool_skills::search_tool_skills,
            #[cfg(feature = "pro")] crate::voice_input::voice_input_available,
            #[cfg(feature = "pro")] crate::voice_input::voice_input_sources,
            #[cfg(feature = "pro")] crate::voice_input::probe::voice_input_probe_source,
            #[cfg(feature = "pro")] crate::voice_input::voice_input_select_source,
            #[cfg(feature = "pro")] crate::voice_input::voice_input_start,
            #[cfg(feature = "pro")] crate::voice_input::voice_input_finish,
            #[cfg(feature = "pro")] crate::voice_input::voice_input_cancel,
            #[cfg(feature = "pro")] crate::voice_input::voice_input_devices,
            #[cfg(feature = "pro")] crate::voice_input::voice_mic_test_start,
            #[cfg(feature = "pro")] crate::voice_input::voice_mic_test_stop,
            #[cfg(feature = "pro")] crate::tool_skills::get_tool_skill_description,
            #[cfg(feature = "pro")] crate::tool_skills::install_tool_skill,
            #[cfg(feature = "pro")] crate::tool_skills::remove_tool_skill,
            #[cfg(feature = "pro")] crate::tool_skills::check_tool_skill_updates,
            #[cfg(feature = "pro")] crate::tool_control::get_tool_control,
            #[cfg(feature = "pro")] crate::tool_control::check_tool_control,
            #[cfg(feature = "pro")] crate::tool_control::install_browser_control,
            #[cfg(feature = "pro")] crate::tool_control::set_tool_control,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_get,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_set_agent,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_set_pick,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_set_mode,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_set_device_access,
            #[cfg(feature = "pro")] crate::worker_worktree::worktree_available,
            #[cfg(feature = "pro")] crate::worker_worktree::worktree_create,
            #[cfg(feature = "pro")] crate::worker_worktree::worktree_status,
            #[cfg(feature = "pro")] crate::worker_worktree::worktree_merge,
            #[cfg(feature = "pro")] crate::worker_worktree::worktree_remove,
            #[cfg(feature = "pro")] crate::worker_worktree::worktree_sweep,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_sync,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_close_group,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_remove_worker,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_restore_worker,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_detach_worker,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_pending,
            #[cfg(feature = "pro")] crate::orchestration::orchestration_resolve,
            crate::folder_picker::folder_picker_places,
            crate::mobile_rpc::mobile_rpc_status,
            crate::mobile_rpc::mobile_rpc_set_enabled,
            crate::mobile_rpc::mobile_rpc_begin_pairing,
            crate::mobile_rpc::mobile_rpc_cancel_pairing,
            crate::mobile_rpc::mobile_rpc_sessions_changed,
            crate::mobile_rpc::mobile_rpc_firewall_status,
            crate::mobile_rpc::mobile_rpc_firewall_allow,
            crate::mobile_rpc::mobile_rpc_revoke_device,
            crate::mobile_rpc::mobile_rpc_resolve,
            crate::mobile_rpc::mobile_rpc_mirror,
            crate::git::git_changes,
            #[cfg(feature = "pro")] crate::git_project_status::git_project_status,
            crate::git::git_show_file,
            crate::git::git_init,
            crate::git::git_capture_baseline,
            crate::git::git_commit_files,
        ])
        .setup(|app| {
            crate::mobile_rpc::init(app.handle());
            // macOS hands `coffeecli://` links to the app through the deep-link
            // plugin, both the one that launched it and later ones; Windows and
            // Linux pass them as argv (main.rs and the single-instance callback).
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let deliver_urls = |handle: &tauri::AppHandle, urls: Vec<url::Url>| {
                    for url in urls {
                        if let Some(req) = crate::launch::parse_prompt_link(url.as_str()) {
                            crate::launch::deliver(handle, req);
                        }
                    }
                };
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| deliver_urls(&handle, event.urls()));
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    deliver_urls(app.handle(), urls);
                }
            }
            // macOS keeps a menu bar icon from launch (open, running tabs, quit).
            #[cfg(target_os = "macos")]
            crate::app_close::install_menu_bar(app.handle());
            #[cfg(feature = "pro")]
            crate::pro::on_start();

            // Per-pane MCP servers are spawned lazily inside
            // `tier_terminal_start` when each multi-agent pane boots
            // its CLI. Users who never open a multi-agent tab pay
            // zero MCP cost.

            // ── Bulletproof window-reveal fallback ──────────────────
            // The window is created with `visible: false` so the user
            // never sees the platform's chrome flash — main.tsx
            // invokes `show_main_window` after the first paint via
            // double-RAF and the window appears already-themed.
            //
            // BUT: if the WebView never paints (Gatekeeper rejection
            // on adhoc-signed macOS bundles, WebKit2GTK Wayland blank
            // window on Ubuntu 24.04, or any JS error before
            // ReactDOM mount), the `invoke` never fires, the window
            // stays hidden forever, and users see "process is running,
            // the process is running, but there is no window".
            // Multiple users have hit this across both platforms.
            //
            // Force a reveal after 3s as a safety net. Healthy
            // startups call show_main_window in ~50ms, well before
            // this fires, so the no-flash UX is preserved. Broken
            // startups at least get a (possibly blank) window the
            // user can interact with — they can quit it, file a bug
            // with devtools, or report what they see, instead of
            // staring at nothing.
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if let Some(window) = handle.get_webview_window("main") {
                        if !window.is_visible().unwrap_or(false) {
                            eprintln!(
                                "[main-window] frontend never called show_main_window after 3s — forcing reveal (likely WebView render failure)"
                            );
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            }

            // Force square corners + no shadow on the borderless window.
            // Windows 11's DWM rounds borderless windows by default and adds
            // a subtle drop-shadow; both create the visible "edge ring" we
            // want gone for the flat look.
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_shadow(false);
                    if let Ok(hwnd) = window.hwnd() {
                        unsafe {
                            use windows::Win32::Foundation::HWND;
                            use windows::Win32::Graphics::Dwm::{
                                DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                                DWMWCP_DONOTROUND,
                            };
                            let pref: i32 = DWMWCP_DONOTROUND.0;
                            let _ = DwmSetWindowAttribute(
                                HWND(hwnd.0 as *mut _),
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &pref as *const _ as *const _,
                                std::mem::size_of_val(&pref) as u32,
                            );
                        }
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window - the close button, Alt+F4, the taskbar,
            // or on macOS the red traffic light and Cmd+W - goes through the
            // user's choice (ask / keep running / quit, see app_close.rs).
            // Cmd+Q still quits at once: NSApplication terminate does not
            // dispatch CloseRequested. Detached windows close normally.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    crate::app_close::request(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!("Error while building tauri application: {}", e))?
        .run(|app_handle, event| {
            // ── Graceful PTY-child cleanup on app exit ─────────────────
            // Issue #28: closing Coffee CLI without first killing tabs
            // left orphan `claude.exe` / `node.exe` alive on Windows
            // (they don't share a job with the parent by default), which
            // held `~/.claude/` session locks and broke the NEXT launch's
            // Claude Code tab.
            //
            // Two-layer fix:
            //   1. Here (graceful path): on ExitRequested, drain every
            //      session and fire kill_tx → drops PTY master → SIGHUP
            //      flows down the pipe → child exits cleanly.
            //   2. Job Object (crash-proof path, see terminal.rs): every
            //      child is bound to a kill-on-close job so even a hard
            //      crash / force-quit takes them with us.
            // ── macOS: restore the hidden main window on Dock click ──────
            // Pairs with keeping Coffee CLI running (app_close.rs): the main
            // window is hidden, so on applicationShouldHandleReopen (Dock icon
            // click) we must bring it back ourselves - macOS does not
            // auto-unhide a hidden window on reopen. Issue #87.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                crate::app_close::show_main(app_handle);
            }

            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                #[cfg(feature = "pro")]
                crate::pro::shutdown(app_handle);
                let state = app_handle.state::<AppState>();
                let mut n = 0usize;
                if let Ok(mut map) = state.terminal_session.lock() {
                    n = map.len();
                    for (_, session) in map.drain() {
                        let _ = session.kill_tx.send(());
                    }
                }
                if n > 0 {
                    eprintln!(
                        "[Tier Terminal] App exiting — sent kill_tx to {} session(s)",
                        n
                    );
                }
            }
        });

    Ok(())
}

#[cfg(test)]
mod file_ops_tests;



#[cfg(test)]
#[path = "server/pty_resize_tests.rs"]
mod pty_resize_tests;

