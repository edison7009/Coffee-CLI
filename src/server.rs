use crate::terminal;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{State, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;

/// Shared app state
pub struct AppState {
    pub terminal_session: terminal::SharedSession,
    /// Active OS fs watcher (one per app instance). Some(...) while a
    /// workspace folder is open; None otherwise. Swapping this Mutex'd
    /// Option replaces the watcher atomically on folder switch.
    pub fs_watcher: Mutex<Option<crate::fs_watcher::FsWatcher>>,
    /// External launch request passed via `launch --tool … [--cwd …]` argv.
    /// Drained exactly once by the frontend (`take_pending_launch`) on mount;
    /// warm-start requests skip this slot and arrive as `launch-request`
    /// events from the single-instance callback instead (see launch.rs).
    pub pending_launch: Mutex<Option<crate::launch::LaunchRequest>>,
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
        // Main window: close entire application (including all detached windows)
        app.exit(0);
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
async fn maintain_tool_integration(tool: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::hook_installer::maintain_for_tool(&tool)).await.map_err(|e| e.to_string())
}

/// Drain the cold-start external launch request (`launch --tool … --cwd …`),
/// if any. Exactly-once semantics — the first caller gets the request, every
/// later caller gets `None`. Warm-start requests don't pass through here;
/// they arrive as `launch-request` events from the single-instance callback.
#[tauri::command]
fn take_pending_launch(state: State<'_, AppState>) -> Option<crate::launch::LaunchRequest> {
    state.pending_launch.lock().ok()?.take()
}

#[tauri::command]
async fn check_tools_installed() -> Result<std::collections::HashMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut result = std::collections::HashMap::new();
        for tool in crate::tools::TOOLS {
            result.insert(tool.id.to_string(), binary_on_path(tool.binary_name));
        }
        // DeepSeek Harness is "installed" exactly when its tab can start: `where dsh` also
        // matches scripts it cannot run, and misses the Desktop runtime, which stays off PATH.
        result.insert("dsh".to_string(), crate::dsh_session::executable().is_some());
        // `terminal` (system shell) and `remote` (SSH) have no binary to
        // probe — always available, not registered.
        result.insert("terminal".to_string(), true);
        result
    }).await.map_err(|e| e.to_string())
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

/// Open the native file explorer and highlight / reveal the given path.
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
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

// ─── Tier Terminal API ────────────────────────────────────────────────────────

#[tauri::command]
async fn tier_terminal_start(
    session_id: String,
    tool: Option<String>,
    tool_data: Option<String>,
    cols: u16,
    rows: u16,
    theme_mode: Option<String>,
    locale: Option<String>,
    cwd: Option<String>,
    resume_token: Option<String>,
    shell: Option<String>,
    strict_cwd: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Offload the whole spawn sequence to a blocking thread so the Tauri
    // command dispatcher returns immediately. Without this, Windows was
    // paying ~cmd.exe boot + Defender AV scan + Node startup on the command
    // thread, stalling every other IPC call (resize, theme, terminal I/O)
    // until the spawn returned. Running in the terminal directly avoids
    // this because no IPC layer is involved — the shell forks directly.
    let terminal_session = state.terminal_session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tier_terminal_start_blocking(
            session_id, tool, tool_data, cols, rows,
            theme_mode, locale, cwd, resume_token, shell, strict_cwd.unwrap_or(false), app, terminal_session,
        )
    })
    .await
    .map_err(|e| format!("Spawn task join failed: {e}"))?
}

fn tier_terminal_start_blocking(
    session_id: String,
    tool: Option<String>,
    tool_data: Option<String>,
    cols: u16,
    rows: u16,
    theme_mode: Option<String>,
    locale: Option<String>,
    cwd: Option<String>,
    resume_token: Option<String>,
    shell: Option<String>,
    strict_cwd: bool,
    app: tauri::AppHandle,
    terminal_session: terminal::SharedSession,
) -> Result<(), String> {
    // CWD resolution order (first non-empty wins):
    //   1. cwd passed from the frontend (launchpad's folder picker / per-tab cwd)
    //   2. tool_config.default_cwd from ~/.coffee-cli/tools.json (WSL-type users
    //      who want a fixed launch dir regardless of launchpad selection)
    //   3. empty → spawn process inherits Coffee CLI's own cwd
    //
    // The launchpad picker dominates because it's the per-launch user choice;
    // tool_config.default_cwd is the always-on fallback for users who don't
    // want to pick each time (or whose launchpad-side path can't address the
    // tool's actual workspace, e.g. WSL).
    let frontend_cwd = cwd.clone().unwrap_or_default();
    let dir = if !frontend_cwd.is_empty() {
        std::path::PathBuf::from(frontend_cwd)
    } else if let Some(name) = tool.as_deref() {
        let cfg_cwd = crate::tool_config::get(name).default_cwd;
        if cfg_cwd.is_empty() {
            std::path::PathBuf::default()
        } else {
            std::path::PathBuf::from(cfg_cwd)
        }
    } else {
        std::path::PathBuf::default()
    };

    // Resolve the binary + default args from the tool registry. `remote`
    // and the fallback shell are not in the registry — `remote` parses
    // tool_data at runtime, the shell is platform-derived.
    let registry_descriptor = tool.as_deref().and_then(crate::tools::find);
    let (cmd, args): (String, Vec<String>) = match (tool.as_deref(), registry_descriptor) {
        (Some(_id), Some(descriptor)) => {
            let a: Vec<String> = descriptor
                .default_args
                .iter()
                .map(|s| s.to_string())
                .collect();
            (descriptor.binary_name.to_string(), a)
        }
        (Some("remote"), _) => {
            // Parse connection info from toolData JSON
            let data = tool_data.as_deref().unwrap_or("{}");
            let conn: serde_json::Value = serde_json::from_str(data)
                .map_err(|e| format!("Invalid remote connection data: {}", e))?;

            let protocol = conn["protocol"].as_str().unwrap_or("ssh");
            let host = conn["host"].as_str().unwrap_or("localhost");
            let port = conn["port"].as_u64().unwrap_or(if protocol == "ssh" { 22 } else { 7681 });
            let username = conn["username"].as_str().unwrap_or("root");
            let _password = conn["password"].as_str().unwrap_or("");

            if protocol == "ssh" {
                // Build SSH command — user will type password interactively in PTY
                let mut ssh_args = vec![
                    "-o".to_string(),
                    "StrictHostKeyChecking=no".to_string(),
                    "-p".to_string(),
                    port.to_string(),
                    format!("{}@{}", username, host),
                ];

                // If password is provided, try to use sshpass for auto-login
                // Otherwise user types password in terminal
                if !_password.is_empty() {
                    // Check if sshpass is available
                    let has_sshpass = if cfg!(target_os = "windows") {
                        false // sshpass not typically available on Windows
                    } else {
                        std::process::Command::new("which")
                            .arg("sshpass")
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()
                            .map(|s| s.success())
                            .unwrap_or(false)
                    };

                    if has_sshpass {
                        let mut full_args = vec![
                            "-p".to_string(),
                            _password.to_string(),
                            "ssh".to_string(),
                        ];
                        full_args.append(&mut ssh_args);
                        ("sshpass".to_string(), full_args)
                    } else {
                        ("ssh".to_string(), ssh_args)
                    }
                } else {
                    ("ssh".to_string(), ssh_args)
                }
            } else {
                // WebSocket protocol — not handled by PTY backend
                // Frontend will handle this via xterm.js AttachAddon directly
                return Err("ws".to_string());
            }
        },

        _ => if cfg!(target_os = "windows") {
            // User's chosen default shell (settings → Terminal), resolved to a
            // concrete (program, args). `Auto` keeps the historical pwsh→
            // powershell fallback. Resolving to an ABSOLUTE path here also
            // defeats the Microsoft-Store App Execution Alias trap: a 0-byte
            // `pwsh.exe` reparse point probes as "installed" via `where` but
            // fails to spawn with ERROR_ACCESS_DENIED. shell_probe treats
            // aliases as not-installed, so the picker never offers a dead
            // shell. Power users can still override via `terminal` in
            // ~/.coffee-cli/tools.json (applied just below, as final word).
            let id = crate::shell_probe::ShellId::from_opt(&shell);
            let caps = crate::shell_probe::detect_capabilities();
            crate::shell_probe::resolve_shell(id, &caps)
        } else {
            // Unix: `Auto` reads $SHELL (with an existence guard) and falls
            // back to bash; an explicit choice spawns that shell directly.
            // fish gets its OSC 7 cwd-reporting hook via -C (bash gets it via
            // PROMPT_COMMAND in terminal.rs; zsh has no clean flag hook).
            let id = crate::shell_probe::ShellId::from_opt(&shell);
            let caps = crate::shell_probe::ShellCapabilities::default();
            crate::shell_probe::resolve_shell(id, &caps)
        }
    };

    // ── Resume override ─────────────────────────────────────────────────────
    // When resume_token is present, this tab was opened from a history
    // "Continue this session" action. Override the fresh-launch cmd/args
    // built above with the tool's resume flags (e.g. `claude --resume <uuid>`,
    // `codex resume <id>`). The match above still ran (harmless — tool is
    // always set in the resume path, so it hit the registry branch and
    // produced a throwaway `(binary_name, [])`); we discard that and rebuild
    // from the agent preset. Validation mirrors the deleted tier_terminal_resume:
    // cwd existence (don't silently resume into the wrong project) + token-
    // format anti-injection.
    let (cmd, args): (String, Vec<String>) = if let Some(token) = resume_token.as_deref().filter(|t| !t.is_empty()) {
        let tool_name = tool.as_deref()
            .ok_or_else(|| "Resume requires a tool, but none was set".to_string())?;
        let preset = terminal::find_preset(tool_name)
            .ok_or_else(|| format!("Unknown tool for resume: {}", tool_name))?;
        let resume_program = preset.resume_program
            .ok_or_else(|| format!("Tool '{}' does not support resume", tool_name))?;

        let resume_dir = cwd.as_deref().unwrap_or("").trim();
        if !std::path::Path::new(resume_dir).is_dir() {
            return Err(if resume_dir.is_empty() {
                "Could not determine this session's project folder — refusing to resume into the wrong directory".to_string()
            } else {
                format!("This session's project folder no longer exists ({resume_dir}) — refusing to resume into the wrong directory")
            });
        }
        if let Some(fmt) = preset.token_format {
            let re = regex::Regex::new(fmt)
                .map_err(|e| format!("Invalid token format pattern: {e}"))?;
            if !re.is_match(token) {
                return Err(format!("Invalid session token format for tool '{}'", tool_name));
            }
        }

        // Token is a separate vec element — never string-interpolated into a
        // command line that gets whitespace-split.
        let mut resume_args: Vec<String> = preset.resume_args_before.iter().map(|s| s.to_string()).collect();
        resume_args.push(token.to_string());
        resume_args.extend(preset.resume_args_after.iter().map(|s| s.to_string()));
        (resume_program.to_string(), resume_args)
    } else {
        (cmd, args)
    };

    // ── User-configurable launch overrides ─────────────────────────────────
    // ~/.coffee-cli/tools.json lets users say e.g. "always launch claude with
    // --dangerously-skip-permissions" or "run codex through `docker exec mybox`".
    // `remote` is excluded by design: its argv is protocol-derived from
    // runtime tool_data, not configurable.
    let launch_config = match tool.as_deref() {
        Some(name) if name == "terminal" || crate::tools::find(name).is_some() => crate::tool_config::get(name),
        _ => Default::default(),
    };
    let (cmd, args) = match tool.as_deref() {
        Some(name) if name == "terminal" || crate::tools::find(name).is_some() => {
            let entry = &launch_config;
            let (cmd, mut args) = (cmd, args);
            let (cmd, args) = if let (Some(bin), prefix_args) =
                crate::tool_config::parse_command(&entry.command)
            {
                // User overrode the binary. Prepend any prefix args
                // (e.g. for `wsl claude`, prefix_args = ["claude"]) so
                // the original built-in args (--mcp-config / --append-
                // system-prompt / etc) follow them.
                let mut new_args = prefix_args;
                new_args.append(&mut args);
                (crate::tool_config::command_binary(name, &bin).to_owned(), new_args)
            } else {
                (cmd, args)
            };
            // Append user's extra_args after the built-in flags so
            // they take precedence (e.g. user can override --approval-
            // mode by adding their own at the end).
            let mut args = args;
            args.extend(entry.extra_args.iter().cloned());
            (cmd, args)
        }
        // Synthetic / pane-internal tools (remote / multi-agent)
        // intentionally bypass user override.
        _ => (cmd, args),
    };

    let mut args = args;
    let native_token = if tool.as_deref() == Some("claude") {
        terminal::claude_launch_token(&mut args, launch_config.command.trim().is_empty())
    } else {
        None
    };
    // Pi writes the session only after the first message (and Pi before 0.76
    // ignores `--session-id`), so its id is reported once the file exists.
    let pi_token = if tool.as_deref() == Some("pi") {
        terminal::pi_launch_token(&mut args, launch_config.command.trim().is_empty())
    } else {
        None
    };

    // If a session with the same ID already exists (e.g. restart-in-place),
    // forcefully kill and remove it before spawning a fresh one.
    {
        let mut lock = terminal_session.lock().unwrap();
        if let Some(old_session) = lock.remove(&session_id) {
            eprintln!("[Tier Terminal] Killing existing session {} for restart", session_id);
            let _ = old_session.kill_tx.send(());
            // Brief pause to let the OS reclaim PTY resources
            drop(lock);
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    // Determine the CWD to pass to the Agent:
    // 1. If workspace has an explicit dir (from open-folder or resume) → use it
    // 2. Otherwise default to user's home dir (matches most agents' default)
    if strict_cwd && (dir.as_os_str().is_empty() || !dir.is_dir()) {
        return Err("Agent working directory no longer exists; terminal was not started".into());
    }
    let spawn_cwd = if dir.as_os_str().is_empty() || !dir.is_dir() {
        dirs::home_dir().map(|p| p.to_string_lossy().to_string())
    } else {
        Some(dir.to_string_lossy().to_string())
    };
    let spawn_cwd = spawn_cwd.map(|cwd| {
        terminal::shell_working_directory(std::path::Path::new(&cwd))
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|e| e.to_string())
    }).transpose()?;

    let tool_name = tool.clone();
    let actual_cwd = spawn_cwd.clone().unwrap_or_default();

    eprintln!("[Tier Terminal] Starting tool={:?}, cmd={}, args={:?}, cwd={:?}", tool, cmd, args, spawn_cwd);

    // Per-pane env overrides (reserved). Independent-split and
    // single-terminal panes spawn with no extra env today.
    let extra_env: Vec<(String, String)> = Vec::new();

    if tool.as_deref() == Some("claude") {
        if let Some(native_id) = &native_token {
            if let Some(parent) = crate::orchestration::parent_launch(&app, &session_id, native_id, std::path::Path::new(&actual_cwd), false)? {
                args.extend(["--mcp-config".into(), parent.mcp, "--append-system-prompt".into(), parent.prompt]);
                args.extend(parent.args);
            }
        }
    }

    let launched_at = std::time::SystemTime::now();
    terminal::spawn(
        app.clone(),
        session_id.clone(),
        terminal_session.clone(),
        cmd,
        args,
        spawn_cwd,
        locale.clone().unwrap_or_else(|| "en".to_string()),
        cols,
        rows,
        tool_name.clone(),
        theme_mode,
        locale,
        extra_env,
    ).map_err(|e| format!("Failed to spawn PTY: {}", e))?;

    if let Some(token) = native_token {
        if let Some(session) = terminal_session.lock().unwrap().get(&session_id) {
            *session.session_token.lock().unwrap() = Some(token.clone());
        }
        let _ = app.emit("tier-terminal-token", terminal::SessionTokenPayload { id: session_id.clone(), token });
    }

    if let Some(token) = pi_token {
        let root = crate::tools::find("pi").and_then(|t| Some(history_root(t, t.history_shape.as_ref()?, &dirs::home_dir()?)));
        if let Some(root) = root {
            let suffix = format!("_{token}.jsonl");
            watch_session_token(app.clone(), terminal_session.clone(), session_id.clone(), false, move || {
                pi_session_written(&root, &suffix).then(|| token.clone())
            });
        }
    }
    #[cfg(unix)]
    if tool.as_deref() == Some("omp") {
        let tty = terminal_session.lock().ok()
            .and_then(|map| map.get(&session_id).map(|s| s._master.clone()))
            .and_then(|master| master.lock().ok().and_then(|m| m.as_ref().and_then(|m| m.tty_name())));
        if let Some(tty) = tty {
            watch_session_token(app.clone(), terminal_session.clone(), session_id.clone(), true, move || {
                terminal::omp_terminal_token(&tty, launched_at)
            });
        }
    }

    // Emit the initial CWD to the frontend so the left panel can map immediately.
    // On Windows, cmd.exe does not emit OSC 7, and full-screen agents enter alt-screen
    // before any shell prompt appears. This one-time emit bridges the gap.
    if !actual_cwd.is_empty() {
        #[derive(serde::Serialize, Clone)]
        struct CwdPayload { id: String, cwd: String }
        let _ = app.emit("tier-terminal-cwd", CwdPayload {
            id: session_id,
            cwd: actual_cwd,
        });
    }

    Ok(())
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

// ─── Session Resume API ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct SavedSession {
    id: String,
    name: String,
    tool: String,
    cwd: String,
    session_token: Option<String>,
    saved_at: String,
    #[serde(default)]
    created_at: Option<String>,
    file_path: Option<String>,
    turn_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    git_context: Option<crate::session_git_context::SessionGitContext>,
    /// A conversation held in a Coffee worktree that still exists resumes there rather than in the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_cwd: Option<String>,
}

/// Poll `probe` once a second for this PTY's native id and report it. With
/// `follow`, keep watching for the PTY's whole life (omp's in-app `/new`
/// switches sessions); otherwise stop at the first id.
fn watch_session_token(
    app: tauri::AppHandle,
    sessions: terminal::SharedSession,
    session_id: String,
    follow: bool,
    probe: impl Fn() -> Option<String> + Send + 'static,
) {
    let Some(master) = sessions.lock().ok().and_then(|map| map.get(&session_id).map(|s| s._master.clone())) else { return };
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let token = probe();
        let Ok(map) = sessions.lock() else { return };
        // Stop once this PTY is gone or the id was reused by a restart.
        let Some(session) = map.get(&session_id).filter(|s| std::sync::Arc::ptr_eq(&s._master, &master)) else { return };
        let Some(token) = token else { continue };
        let Ok(mut current) = session.session_token.lock() else { return };
        if current.as_deref() != Some(token.as_str()) {
            *current = Some(token.clone());
            drop(current);
            drop(map);
            let _ = app.emit("tier-terminal-token", terminal::SessionTokenPayload { id: session_id.clone(), token });
        }
        if !follow { return; }
    });
}

/// Pi keeps `<root>/--<encoded-cwd>--/<ts>_<id>.jsonl`; true once that file exists.
fn pi_session_written(root: &std::path::Path, suffix: &str) -> bool {
    std::fs::read_dir(root).into_iter().flatten().flatten().any(|bucket| {
        std::fs::read_dir(bucket.path()).into_iter().flatten().flatten()
            .any(|file| file.file_name().to_string_lossy().ends_with(suffix))
    })
}

#[tauri::command]
fn get_terminal_session_token(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let map = state.terminal_session.lock().map_err(|e| e.to_string())?;
    let Some(session) = map.get(&session_id) else {
        return Ok(None);
    };
    let token = session.session_token.lock()
        .map(|token| token.clone())
        .map_err(|e| e.to_string())?;
    Ok(token)
}

pub(crate) mod history;
#[allow(unused_imports)]
use history::*;
pub(crate) use history::{is_system_injected, strip_codex_desktop_file_preamble};

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

// ─── In-app self-update ────────────────────────────────────────────────────
//
// Downloads the latest installer and launches it. Sources (see
// update_sources.rs): the CNB and GitCode mirrors when their manifest has the
// newest version, then `coffeecli.com/download/<os>` (a CF Worker proxying
// the GitHub Release asset). The sources race briefly ("speed_test"), the
// fastest is downloaded, and a mirror's installer is checked against its
// manifest's size and SHA-256 — a failed check falls through to the next
// source. Progress streams to the frontend's ring via `self-update-progress`.
// ureq is blocking + rustls, so the whole thing runs on a spawn_blocking
// thread; `app.emit` works from any thread.

#[derive(serde::Serialize, Clone)]
struct SelfUpdateProgress {
    status: String, // "speed_test" | "downloading" | "launching" | "error"
    percent: u32,
}

fn emit_self_update(app: &tauri::AppHandle, status: &str, percent: u32) {
    let _ = app.emit(
        "self-update-progress",
        SelfUpdateProgress { status: status.to_string(), percent },
    );
}

#[tauri::command]
async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_self_update(&app2))
        .await
        .map_err(|e| format!("self-update task join failed: {e}"))?
}

/// The update platform this build runs on, in `update_sources` terms.
fn self_update_os() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        Some("windows")
    } else if cfg!(target_os = "macos") {
        Some("macos")
    } else {
        crate::update_sources::linux_package_kind(program_on_path)
    }
}

fn program_on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// Download the installer for this platform into the user's Downloads
/// folder, then: Windows installs it silently (`/S`), the NSIS template
/// relaunches Coffee CLI (`/R`), and a failed silent run opens the visible
/// wizard instead; we exit so the installer can overwrite our files; macOS opens the DMG (Finder mounts it and shows the drag-to-
/// Applications window); Linux opens the Downloads folder so the user can
/// double-click the package. Mac and Linux keep running.
fn run_self_update(app: &tauri::AppHandle) -> Result<(), String> {
    let arch = std::env::consts::ARCH;
    let os = self_update_os().ok_or("no installer for this system")?;
    let suffix = crate::update_sources::asset_suffix(os, arch).ok_or("no installer for this system")?;
    let platform = crate::update_sources::website_platform(os, arch).ok_or("no installer for this system")?;
    let official_url = format!("https://coffeecli.com/download/{platform}");
    emit_self_update(app, "speed_test", 0);

    let (target, candidates) = crate::update_sources::resolve(os, &official_url);
    let opened = crate::update_sources::probe(&candidates, std::time::Duration::from_millis(1500));
    if opened.is_empty() {
        emit_self_update(app, "error", 0);
        return Err("no download source reachable".into());
    }

    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    let file_name = match &target {
        Some(version) => format!("Coffee.CLI_{version}_{suffix}"),
        None => format!("Coffee.CLI_{suffix}"),
    };
    let out_path = dir.join(&file_name);
    // Download beside the final name and rename once verified, so a failed
    // or partial download never leaves a broken installer in Downloads.
    let part_path = dir.join(format!("{file_name}.part"));

    let mut last_err = String::from("download failed");
    let mut done = false;
    for source in opened {
        match download_installer(app, source, &part_path) {
            Ok(()) => { done = true; break; }
            Err(e) => last_err = e,
        }
    }
    if !done {
        let _ = std::fs::remove_file(&part_path);
        emit_self_update(app, "error", 0);
        return Err(last_err);
    }
    if let Err(e) = std::fs::rename(&part_path, &out_path) {
        let _ = std::fs::remove_file(&part_path);
        emit_self_update(app, "error", 100);
        return Err(format!("save installer failed: {e}"));
    }
    emit_self_update(app, "downloading", 100);

    emit_self_update(app, "launching", 100);
    #[cfg(target_os = "windows")]
    let launch = {
        use std::os::windows::process::CommandExt;
        installer_command_line(&out_path).and_then(|args| {
            std::process::Command::new("cmd")
                .raw_arg(args)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .spawn()
                .map_err(|e| e.to_string())
        })
    };
    #[cfg(target_os = "macos")]
    let launch = std::process::Command::new("open").arg(&out_path).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let launch = std::process::Command::new("xdg-open").arg(&dir).spawn();
    if let Err(e) = launch {
        emit_self_update(app, "error", 100);
        return Err(format!("open installer failed: {e}"));
    }

    if cfg!(target_os = "windows") {
        // Let the installer start before we exit so it can replace our files.
        std::thread::sleep(std::time::Duration::from_millis(800));
        app.exit(0);
    } else {
        emit_self_update(app, "downloaded", 100);
    }
    Ok(())
}

/// `cmd` arguments that install silently (`/S`, relaunch via `/R`) and open
/// the visible wizard when the silent run fails, so a failed update never
/// leaves the user without the app or an explanation.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn installer_command_line(path: &std::path::Path) -> Result<String, String> {
    let path = path.to_string_lossy();
    // cmd cannot escape these inside a quoted path.
    if path.contains(['"', '%', '\n', '\r']) {
        return Err("installer path cannot be launched safely".into());
    }
    Ok(format!("/d /c start \"\" /wait \"{path}\" /S /R || start \"\" \"{path}\""))
}

#[cfg(test)]
mod self_update_tests {
    use super::installer_command_line;
    use std::path::Path;

    #[test]
    fn installs_silently_and_falls_back_to_the_wizard() {
        let path = Path::new(r"C:\Users\A B\Downloads\Coffee.CLI_4.0.2_x64-setup.exe");
        assert_eq!(
            installer_command_line(path).unwrap(),
            r#"/d /c start "" /wait "C:\Users\A B\Downloads\Coffee.CLI_4.0.2_x64-setup.exe" /S /R || start "" "C:\Users\A B\Downloads\Coffee.CLI_4.0.2_x64-setup.exe""#
        );
        for unsafe_path in [r#"C:\a"b\setup.exe"#, r"C:\%TEMP%\setup.exe"] {
            assert!(installer_command_line(Path::new(unsafe_path)).is_err());
        }
    }
}

/// Stream one opened source to `out_path`, reporting progress, then check it
/// against the source's manifest entry (size + SHA-256).
fn download_installer(
    app: &tauri::AppHandle,
    source: crate::update_sources::Opened,
    out_path: &std::path::Path,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    let crate::update_sources::Opened { candidate, head, mut reader, total, header_version, eof, .. } = source;
    // The manifest knows the size even when the mirror sends no Content-Length.
    let total = candidate.expect.as_ref().map(|e| e.size).or(total).unwrap_or(0);
    let mut file = std::fs::File::create(out_path).map_err(|e| format!("create temp file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_pct: u32 = 0;
    emit_self_update(app, "downloading", 0);

    let mut write = |chunk: &[u8], downloaded: &mut u64, last_pct: &mut u32| -> Result<(), String> {
        file.write_all(chunk).map_err(|e| format!("write temp file failed: {e}"))?;
        hasher.update(chunk);
        *downloaded += chunk.len() as u64;
        if total > 0 {
            // Cap at 99 during streaming; 100 is reserved for "fully written".
            let pct = (downloaded.saturating_mul(100) / total).min(99) as u32;
            if pct != *last_pct {
                *last_pct = pct;
                emit_self_update(app, "downloading", pct);
            }
        }
        Ok(())
    };
    write(&head, &mut downloaded, &mut last_pct)?;
    if !eof {
        let mut buf = [0u8; 65536];
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("{}: download read failed: {e}", candidate.id))?;
            if n == 0 {
                break;
            }
            write(&buf[..n], &mut downloaded, &mut last_pct)?;
        }
    }
    drop(write);
    file.sync_all().map_err(|e| format!("flush temp file failed: {e}"))?;
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    crate::update_sources::verify(&candidate, header_version.as_deref(), downloaded, &digest)
}

// ─── Hyper-Agent: global anonymous MCP server for external orchestrators ──
//
// Started lazily when the user opens the Hyper-Agent tab. `self_pane_id=None`,
// so list_panes / send_to_pane bypass tab-scope filtering — exactly the
// "super admin can see and dispatch to every pane" semantics the product
// needs. Uses a port persisted across launches so OpenClaw / Hermes Agent
// configs stay stable (no config-file thrash → no gateway restart loops).
//
// Tauri commands here are all the frontend needs to know about.

// ─── Per-tool launch overrides (~/.coffee-cli/tools.json) ────────────────
//
// Lets users tell Coffee CLI things like "my claude is at
// `/opt/coffee/bin/claude`, not on PATH" or "always launch claude with
// --dangerously-skip-permissions". Replaces what the abandoned in-app
// installer was supposed to handle by auto-detection — defer to the
// user, who knows their machine better than we do.

#[tauri::command]
pub fn get_tool_config(tool: String) -> crate::tool_config::ToolConfigEntry {
    crate::tool_config::get(&tool)
}

#[tauri::command]
pub fn get_all_tool_configs() -> crate::tool_config::ToolConfig {
    crate::tool_config::load()
}

#[tauri::command]
pub fn set_tool_config(
    tool: String,
    entry: crate::tool_config::ToolConfigEntry,
) -> Result<(), String> {
    crate::tool_config::set(&tool, entry).map_err(|e| e.to_string())
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
        // A second instance invoked as `launch --tool … --cwd …` forwards
        // its argv here — re-parse and hand the request to the frontend of
        // the ALREADY-RUNNING instance, so the launcher works without
        // restarting the app or touching existing tabs (see launch.rs).
        if let Some(req) = crate::launch::parse_launch_args(&args) {
            use tauri::Emitter;
            let _ = app.emit("launch-request", req);
        }
    }));

    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Reopen the window at the size and place the user left it. Visibility stays with
        // show_main_window (the window appears after the first paint), decorations differ per
        // platform, and a restored fullscreen opens awkwardly on macOS, so only these three persist.
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .build())
        .manage(crate::claude_session::ClaudeSessions::default())
        .manage(crate::codex_session::CodexSessions::default())
        .manage(crate::dsh_session::DshSessions::default())
        .manage(crate::pi_session::PiSessions::default())
        .manage(crate::opencode_session::OpenCodeSessions::default())
        .manage(AppState {
            terminal_session,
            fs_watcher: Mutex::new(None),
            pending_launch: Mutex::new(pending_launch),
        })
        .invoke_handler(tauri::generate_handler![
            crate::session_directory::check_project_directories,
            crate::session_directory::resolve_project_directory,
            crate::claude_session::claude_session_start,
            crate::claude_session::claude_session_history,
            crate::claude_session::claude_session_preview,
            crate::claude_session::claude_session_send,
            crate::claude_session::claude_session_control,
            crate::claude_session::claude_session_respond,
            crate::claude_session::claude_session_close,
            crate::codex_session::codex_session_start,
            crate::usage_quota::usage_quota_query,
            crate::codex_session::codex_session_request,
            crate::codex_session::codex_session_respond,
            crate::codex_session::codex_session_close,
            crate::opencode_session::opencode_session_start,
            crate::opencode_session::opencode_session_request,
            crate::opencode_session::opencode_session_close,
            crate::dsh_session::dsh_session_start,
            crate::dsh_session::dsh_session_request,
            crate::dsh_session::dsh_session_set_preset,
            crate::dsh_session::dsh_session_respond,
            crate::dsh_session::dsh_session_close,
            crate::dsh_session::dsh_session_history,
            crate::pi_session::pi_session_start,
            crate::pi_session::pi_session_request,
            crate::pi_session::pi_session_respond,
            crate::pi_session::pi_session_close,
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
            tier_terminal_start,
            tier_terminal_input,
            tier_terminal_raw_write,
            tier_terminal_kill,
            tier_terminal_resize,
            set_background_mode,
            set_session_active,
            get_native_history,
            get_message_heatmap,
            crate::usage_stats::get_usage_statistics,
            read_chat_session,
            read_chat_navigation,
            get_terminal_session_token,
            check_network_port,
            check_tools_installed,
            crate::cli_updates::check_cli_update,
            crate::cli_updates::update_cli,
            detect_shells,
            crate::tools::list_tools,
            maintain_tool_integration,
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
            download_and_install_update,
            get_tool_config,
            get_all_tool_configs,
            set_tool_config,
            crate::tool_memory::read_tool_memory,
            crate::tool_memory::save_tool_memory,
            crate::tool_skills::get_tool_skills,
            crate::tool_skills::search_tool_skills,
            crate::voice_input::voice_input_available,
            crate::voice_input::voice_input_sources,
            crate::voice_input::probe::voice_input_probe_source,
            crate::voice_input::voice_input_select_source,
            crate::voice_input::voice_input_start,
            crate::voice_input::voice_input_finish,
            crate::voice_input::voice_input_cancel,
            crate::voice_input::voice_input_devices,
            crate::voice_input::voice_mic_test_start,
            crate::voice_input::voice_mic_test_stop,
            crate::tool_skills::get_tool_skill_description,
            crate::tool_skills::install_tool_skill,
            crate::tool_skills::remove_tool_skill,
            crate::tool_skills::check_tool_skill_updates,
            crate::tool_control::get_tool_control,
            crate::tool_control::check_tool_control,
            crate::tool_control::install_browser_control,
            crate::tool_control::set_tool_control,
            crate::orchestration::orchestration_get,
            crate::orchestration::orchestration_set_agent,
            crate::orchestration::orchestration_set_pick,
            crate::orchestration::orchestration_set_mode,
            crate::worker_worktree::worktree_available,
            crate::worker_worktree::worktree_create,
            crate::worker_worktree::worktree_status,
            crate::worker_worktree::worktree_merge,
            crate::worker_worktree::worktree_remove,
            crate::worker_worktree::worktree_sweep,
            crate::orchestration::orchestration_sync,
            crate::orchestration::orchestration_close_group,
            crate::orchestration::orchestration_remove_worker,
            crate::orchestration::orchestration_restore_worker,
            crate::orchestration::orchestration_detach_worker,
            crate::orchestration::orchestration_pending,
            crate::orchestration::orchestration_resolve,
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
            crate::git_project_status::git_project_status,
            crate::git::git_show_file,
            crate::git::git_init,
            crate::git::git_capture_baseline,
            crate::git::git_commit_files,
        ])
        .setup(|app| {
            crate::mobile_rpc::init(app.handle());
            // Presentation and npm-bin maintenance never modifies status hooks.
            crate::hook_installer::maintain_all();

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
            // Issue #87: on macOS a reflexive Cmd+W / red traffic-light
            // click should hide the main window to the Dock instead of
            // quitting the app (standard Mac convention - Safari, VS Code,
            // etc. all keep running). The app stays alive; clicking the
            // Dock icon restores it via the Reopen event in `.run()` below.
            // Cmd+Q still terminates normally because NSApplication
            // terminate does not dispatch CloseRequested, so this prevent is
            // never reached on a real quit. Only the main window hides -
            // detached windows close normally.
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (window, event);
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
            // Pairs with the CloseRequested handler in `.on_window_event`:
            // Cmd+W hides the main window rather than quitting, so on
            // applicationShouldHandleReopen (Dock icon click) we must bring
            // it back ourselves - macOS does not auto-unhide a hidden window
            // on reopen. Issue #87.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                use tauri::Manager;
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }

            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                crate::claude_session::shutdown(&app_handle.state::<crate::claude_session::ClaudeSessions>());
                crate::codex_session::shutdown(&app_handle.state::<crate::codex_session::CodexSessions>());
                crate::dsh_session::shutdown(&app_handle.state::<crate::dsh_session::DshSessions>());
                crate::pi_session::shutdown(&app_handle.state::<crate::pi_session::PiSessions>());
                crate::opencode_session::shutdown(&app_handle.state::<crate::opencode_session::OpenCodeSessions>());
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
mod resume_cwd_tests {
    use super::{coffee_worktree_cwd, load_claude_project_map, project_root_from_cwd};
    use std::io::Write;

    // The exact path that was landing wrong in the wild: a Claude session run
    // inside a worktree recorded the worktree as its cwd, so resume cd'd into
    // the ephemeral worktree instead of the project root.
    #[test]
    fn strips_windows_worktree_cwd_to_project_root() {
        assert_eq!(
            project_root_from_cwd(r"D:\Coffee-CLI\.claude\worktrees\intelligent-heyrovsky-b3d421"),
            r"D:\Coffee-CLI"
        );
    }

    #[test]
    fn strips_unix_worktree_cwd_to_project_root() {
        assert_eq!(
            project_root_from_cwd("/home/eben/coffee-cli/.claude/worktrees/foo"),
            "/home/eben/coffee-cli"
        );
    }

    #[test]
    fn leaves_a_plain_project_dir_unchanged() {
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI"), r"D:\Coffee-CLI");
        assert_eq!(project_root_from_cwd("/home/eben/coffee-cli"), "/home/eben/coffee-cli");
    }

    #[test]
    fn leaves_a_real_subdir_unchanged() {
        // A genuine working subdir must NOT be collapsed — only worktrees.
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI\src\ui"), r"D:\Coffee-CLI\src\ui");
    }

    #[test]
    fn strips_only_dot_claude_worktrees_not_other_dot_dir_worktrees() {
        // `.claude/worktrees` is the harness's real worktree layout, so it
        // strips. `.git/worktrees` is git's INTERNAL metadata (never a working
        // cwd), so anchoring on `.claude` specifically leaves it — and any
        // other `.<dir>/worktrees` — untouched, avoiding a bogus over-collapse.
        assert_eq!(project_root_from_cwd(r"D:\proj\.git\worktrees\x"), r"D:\proj\.git\worktrees\x");
        assert_eq!(project_root_from_cwd("/home/e/proj/.jj/worktrees/y"), "/home/e/proj/.jj/worktrees/y");
    }

    #[test]
    fn does_not_touch_an_ordinary_hidden_dir_without_worktrees() {
        // The Linux/macOS safety case: editing dotfiles with an agent runs the
        // session INSIDE a hidden dir; that cwd must survive intact.
        assert_eq!(project_root_from_cwd("/home/eben/.config/nvim"), "/home/eben/.config/nvim");
        assert_eq!(project_root_from_cwd("/home/eben/.dotfiles"), "/home/eben/.dotfiles");
        assert_eq!(project_root_from_cwd(r"D:\proj\.vscode"), r"D:\proj\.vscode");
        // `.claude` itself, without a worktrees child, is a real (if unusual) dir.
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI\.claude"), r"D:\Coffee-CLI\.claude");
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI\.claude\settings"), r"D:\Coffee-CLI\.claude\settings");
    }

    #[test]
    fn only_coffee_worktrees_resume_in_place() {
        assert!(coffee_worktree_cwd(r"D:\Proj\.claude\worktrees\coffee-fix-a1b2c3\src"));
        assert!(coffee_worktree_cwd("/home/e/proj/.claude/worktrees/coffee-x-1"));
        assert!(!coffee_worktree_cwd(r"D:\Proj\.claude\worktrees\intelligent-heyrovsky-b3d421"));
        assert!(!coffee_worktree_cwd(r"D:\Proj\coffee-x"));
    }

    #[test]
    fn requires_worktrees_to_be_a_whole_next_component() {
        // A plain, non-hidden `worktrees/` folder is a legitimate project subdir.
        assert_eq!(project_root_from_cwd(r"D:\proj\worktrees\x"), r"D:\proj\worktrees\x");
        // `worktrees` must be a WHOLE next component, not a prefix.
        assert_eq!(
            project_root_from_cwd(r"D:\proj\.claude\worktrees-archive\x"),
            r"D:\proj\.claude\worktrees-archive\x"
        );
    }

    #[test]
    fn handles_mixed_separators_and_non_ascii() {
        // Windows sometimes emits mixed separators; a Chinese project name must
        // not panic the byte-slice (all slice indices land on ASCII separators).
        assert_eq!(project_root_from_cwd(r"D:/Coffee-CLI\.claude/worktrees\x"), r"D:/Coffee-CLI");
        assert_eq!(project_root_from_cwd(r"D:\项目名\.claude\worktrees\x"), r"D:\项目名");
    }

    #[test]
    fn does_not_split_on_a_dot_inside_a_component() {
        // The dot must open a `.claude` component; a dot mid-name never matches.
        assert_eq!(project_root_from_cwd(r"D:\proj\my.claude\worktrees\x"), r"D:\proj\my.claude\worktrees\x");
        assert_eq!(project_root_from_cwd(r"D:\tools\v1.2\bin"), r"D:\tools\v1.2\bin");
    }

    // Isolated per-test home dir under the OS temp dir — avoids clobbering
    // the real ~/.claude.json and avoids tests racing each other on a
    // shared path (each test gets a name-derived subfolder).
    fn temp_home(test_name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coffee-cli-test-{}", test_name));
        let _ = std::fs::remove_dir_all(&dir); // clean slate if a prior run left it behind
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_claude_json(home: &std::path::Path, project_paths: &[&str]) {
        let projects_obj = project_paths
            .iter()
            .map(|p| format!("{:?}: {{}}", p)) // {:?} on &str gives a valid escaped JSON string
            .collect::<Vec<_>>()
            .join(",");
        let json = format!(r#"{{"projects": {{{}}}}}"#, projects_obj);
        let mut f = std::fs::File::create(home.join(".claude.json")).unwrap();
        f.write_all(json.as_bytes()).unwrap();
    }

    // Real folder name observed on disk, verified by hand against the known
    // real path — the exact case that motivated the fix (a project name
    // containing a hyphen, "Coffee-CLI", made the old split("--") fallback
    // reconstruct a nonexistent path). load_claude_project_map forward-encodes
    // the real key so the mangled folder name maps back exactly.
    #[test]
    fn map_resolves_real_world_hyphenated_project_path() {
        let home = temp_home("hyphenated-project");
        let real_path = r"D:\Coffee-CLI\.claude\worktrees\exciting-swanson-f7e8be";
        write_claude_json(&home, &[real_path]);

        let map = load_claude_project_map(&home);

        assert_eq!(
            map.get("D--Coffee-CLI--claude-worktrees-exciting-swanson-f7e8be").map(String::as_str),
            Some(real_path)
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_resolves_second_real_world_project_path() {
        let home = temp_home("echobird-project");
        let real_path = r"E:\EchoBird";
        write_claude_json(&home, &[real_path]);

        let map = load_claude_project_map(&home);

        assert_eq!(map.get("E--EchoBird").map(String::as_str), Some(real_path));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_has_no_entry_for_an_unregistered_folder() {
        let home = temp_home("no-match");
        write_claude_json(&home, &[r"D:\some\other\project"]);

        let map = load_claude_project_map(&home);

        assert_eq!(map.get("D--Coffee-CLI--claude-worktrees-foo"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_is_empty_when_claude_json_is_missing() {
        let home = temp_home("missing-config");
        // Deliberately don't write .claude.json.
        assert!(load_claude_project_map(&home).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_is_empty_and_does_not_panic_on_malformed_json() {
        // A truncated/corrupt ~/.claude.json (a real post-crashed-write state)
        // must degrade to an empty map (and an eprintln breadcrumb), never panic
        // or reconstruct the old broken split("--") guess.
        let home = temp_home("malformed-config");
        let mut f = std::fs::File::create(home.join(".claude.json")).unwrap();
        f.write_all(br#"{"projects": {"D:\Coffee-CLI": {"#).unwrap(); // truncated
        drop(f);

        let map = load_claude_project_map(&home);

        assert!(map.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod file_ops_tests;

#[cfg(test)]
mod antigravity_history_tests {
    #[test]
    fn antigravity_history_reads_root_conversations_from_its_index() {
        use super::*;
        let dir = std::env::temp_dir().join(format!("coffee-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("conversation_summaries.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        // Columns as created by agy 1.4.12.
        conn.execute_batch(r#"CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`));"#).unwrap();
        let row = |id: &str, title: &str, preview: &str, steps: i64, time: &str, uris: &str, parent: &str| {
            conn.execute("INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5)",
                rusqlite::params![id, title, preview, steps, time, uris, parent]).unwrap();
        };
        row("f99ca1a5-1184-4740-8c60-5c28d2252186", "Chinese Greeting", "你好", 10, "2026-11-03 22:19:37.954952+00:00", r#"["file:///Users/eben"]"#, "");
        row("0a1b2c3d-0000-4000-8000-000000000001", "", "修复构建\n第二行", 4, "2026-11-04 08:00:00.5+00:00", r#"["file:///Volumes/%E6%89%A9%E5%B1%95%E5%AD%98%E5%82%A8/coffee-cli"]"#, "");
        row("0a1b2c3d-0000-4000-8000-000000000002", "Worker", "", 6, "2026-11-04 09:00:00+00:00", r#"["file:///Users/eben"]"#, "f99ca1a5-1184-4740-8c60-5c28d2252186");
        row("0a1b2c3d-0000-4000-8000-000000000003", "", "", 0, "2026-11-04 10:00:00+00:00", "[]", "");
        row("not a conversation --flag", "Bad id", "", 3, "2026-11-04 11:00:00+00:00", "[]", "");
        drop(conn);

        let mut sessions = Vec::new();
        find_antigravity_sessions(&db, &mut sessions);
        let summary: Vec<_> = sessions.iter().map(|s| (s.name.as_str(), s.cwd.as_str(), s.session_token.as_deref(), s.saved_at.as_str(), s.tool.as_str())).collect();
        assert_eq!(summary, vec![
            ("修复构建", if cfg!(windows) { "" } else { "/Volumes/扩展存储/coffee-cli" }, Some("0a1b2c3d-0000-4000-8000-000000000001"), "1793779200500", "antigravity"),
            ("Chinese Greeting", if cfg!(windows) { "" } else { "/Users/eben" }, Some("f99ca1a5-1184-4740-8c60-5c28d2252186"), "1793744377954", "antigravity"),
        ], "root conversations only, newest first; sub-agent and empty conversations are skipped");
        assert!(crate::terminal::find_preset("antigravity").is_some_and(|preset| preset.resume_program == Some("agy") && preset.resume_args_before == ["--conversation"]));

        let mut heatmap = Vec::new();
        collect_antigravity_heatmap_entries(&db, 1793744377, &mut heatmap);
        let mut counts: Vec<_> = heatmap.iter().map(|entry| (entry.ts, entry.count)).collect();
        counts.sort();
        assert_eq!(counts, vec![(1793744377, 10), (1793779200, 4)]);
        // Workspaces decode per platform, including percent-encoded non-ASCII folders.
        #[cfg(windows)]
        assert_eq!(antigravity_workspace(r#"["file:///C:/Users/eben/%E6%89%A9%E5%B1%95%E5%AD%98%E5%82%A8"]"#), r"C:\Users\eben\扩展存储");
        #[cfg(not(windows))]
        assert_eq!(antigravity_workspace(r#"["file:///home/eben/%E6%89%A9%E5%B1%95%E5%AD%98%E5%82%A8"]"#), "/home/eben/扩展存储");
        assert_eq!(antigravity_workspace("[]"), "");
        // Older index rows may carry no offset; they are UTC.
        assert_eq!(antigravity_time_ms("2026-11-03 22:19:37.954952"), Some(1793744377954));
        assert_eq!(antigravity_time_ms("2026-11-03T22:19:37Z"), Some(1793744377000));
        assert_eq!(antigravity_time_ms("yesterday"), None);
        let mut recent = Vec::new();
        collect_antigravity_heatmap_entries(&db, 1793744378, &mut recent);
        assert_eq!(recent.len(), 1, "the cutoff applies");

        // An index without the filter columns still lists its conversations, ordered by parsed time.
        let legacy = dir.join("legacy.db");
        let conn = rusqlite::Connection::open(&legacy).unwrap();
        conn.execute_batch("CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,preview TEXT,last_modified_time TEXT);").unwrap();
        for (id, time) in [("0a1b2c3d-0000-4000-8000-00000000000a", "2026-11-04 09:00:00"), ("0a1b2c3d-0000-4000-8000-00000000000b", "2026-11-04T10:00:00Z")] {
            conn.execute("INSERT INTO conversation_summaries VALUES (?1, 'Legacy', '[]', '', ?2)", rusqlite::params![id, time]).unwrap();
        }
        drop(conn);
        let mut legacy_sessions = Vec::new();
        find_antigravity_sessions(&legacy, &mut legacy_sessions);
        assert_eq!(legacy_sessions.iter().map(|s| s.session_token.as_deref().unwrap()).collect::<Vec<_>>(),
            ["0a1b2c3d-0000-4000-8000-00000000000b", "0a1b2c3d-0000-4000-8000-00000000000a"], "newest by time, not by text");
        let mut legacy_heatmap = Vec::new();
        collect_antigravity_heatmap_entries(&legacy, 0, &mut legacy_heatmap);
        assert_eq!(legacy_heatmap.iter().map(|entry| entry.count).collect::<Vec<_>>(), [1, 1]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_lines_keep_only_candidate_rows_and_exact_cursor() {
        let assistant = "{\"message\":{\"role\":\"assistant\",\"content\":\"done\"}}\n";
        let user = "{\"id\":\"u-1\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n";
        let data = format!("{assistant}{user}");
        let mut rows = Vec::new();

        push_navigation_lines(&mut rows, &data, 41, true);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].data, user);
        assert_eq!(rows[0].cursor, 41 + assistant.len() as u64);
    }

    #[test]
    fn jsonl_history_windows_reassemble_without_gap_or_overlap() {
        let data = (0..250)
            .map(|index| format!("{{\"message\":{{\"role\":\"user\",\"content\":\"第 {index} 条\"}}}}\n"))
            .collect::<String>();
        let (tail, tail_start) = slice_jsonl_window(&data, data.len() as u64);
        let (older, older_start) = slice_jsonl_window(&data, tail_start);

        assert_eq!(older_start, 0);
        assert_eq!(format!("{older}{tail}"), data);
        assert_eq!(tail.lines().count(), CHAT_WINDOW_ROWS);
    }

    #[test]
    fn jsonl_window_drops_only_the_leading_partial_row() {
        let bytes = b"partial row\nsecond\nthird\n";
        let (relative, absolute) = jsonl_window_bounds(bytes, 100);
        assert_eq!(&bytes[relative..], b"second\nthird\n");
        assert_eq!(absolute, 112);
    }

    #[test]
    fn jsonl_window_skips_one_oversized_row_without_stalling_history() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "coffee-cli-chat-window-{}.jsonl",
            std::process::id(),
        ));
        let mut file = std::fs::File::create(&path).expect("create window fixture");
        file.write_all(b"first\nsecond\n").expect("write ordinary rows");
        file.write_all(&vec![b'x'; CHAT_WINDOW_BYTES as usize + 32])
            .expect("write oversized row");
        file.write_all(b"\n").expect("finish oversized row");
        drop(file);

        let len = std::fs::metadata(&path).expect("fixture metadata").len();
        let (data, history_cursor, valid_end, skipped) =
            read_jsonl_file_window(&path, len).expect("read tail window");
        let _ = std::fs::remove_file(&path);

        assert!(skipped);
        assert_eq!(data, "first\nsecond\n");
        assert_eq!(history_cursor, 0);
        assert_eq!(valid_end, 13);
    }

    /// Build a temp Drizzle-schema SQLite db (the `session` + `message` shape
    /// `find_drizzle_sessions_sqlite` reads), seeded with one parent session,
    /// two sub-agent children (parent_id set), and one archived session. Only
    /// the columns the scanner touches are created.
    fn seed_drizzle_db(test_name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "coffee-cli-drizzle-test-{}-{}.db",
            std::process::id(),
            test_name,
        ));
        let _ = std::fs::remove_file(&path);
        let conn = rusqlite::Connection::open(&path).expect("open temp db");
        conn.execute_batch(
             r#"CREATE TABLE session (
                id            TEXT PRIMARY KEY,
                title         TEXT,
                directory     TEXT,
                time_created  INTEGER,
                time_updated  INTEGER,
                time_archived INTEGER,
                parent_id     TEXT
             );
             CREATE TABLE message (
                id           TEXT PRIMARY KEY,
                session_id   TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                data         TEXT
             );
             CREATE TABLE part (
                id           TEXT PRIMARY KEY,
                message_id   TEXT,
                session_id   TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                data         TEXT
             );
             INSERT INTO session (id, title, directory, time_created, time_updated, time_archived, parent_id) VALUES
                ('ses_parent',   'Main task',                      '/proj', 2000, 3000, NULL, NULL),
                ('ses_child_a',  'Find files (@explore subagent)', '/proj', 2010, 3010, NULL, 'ses_parent'),
                ('ses_child_b',  'Refactor (@general subagent)',   '/proj', 2020, 3020, NULL, 'ses_parent'),
                ('ses_archived', 'Old session',                    '/proj',  900, 1000, 999,  NULL);
             INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
                ('m1', 'ses_parent',   2001, 2001, '{"role":"user"}'),
                ('m2', 'ses_parent',   2002, 2002, '{"role":"assistant"}'),
                ('m3', 'ses_child_a',  2011, 2011, '{"role":"user"}'),
                ('m4', 'ses_archived',  901,  901, '{"role":"user"}');
             INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
                ('p1', 'm1', 'ses_parent', 2001, 2001, '{"type":"text","text":"hello"}');"#,
        )
        .expect("seed db");
        drop(conn);
        path
    }

    /// Sub-agent sessions carry a non-null `parent_id` (OpenCode writes one
    /// row per spawned sub-agent). The scanner must surface only root
    /// sessions — matching OpenCode's own desktop, whose root list query is
    /// `WHERE parent_id IS NULL`. Without this filter every sub-agent
    /// clutters the Sessions board as a top-level card.
    #[test]
    fn drizzle_scanner_excludes_subagent_and_archived_sessions() {
        let db = seed_drizzle_db("scanner");
        let mut result: Vec<SavedSession> = Vec::new();
        find_drizzle_sessions_sqlite(&db, "opencode", "OpenCode Session", &mut result);
        let _ = std::fs::remove_file(&db);

        let ids: Vec<&str> = result
            .iter()
            .map(|s| s.session_token.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(
            result.len(),
            1,
            "expected only the root parent session, got {ids:?}"
        );
        assert_eq!(result[0].session_token.as_deref(), Some("ses_parent"));
        assert_eq!(result[0].created_at.as_deref(), Some("2000"));
    }

    #[test]
    fn drizzle_revision_changes_without_reading_message_bodies() {
        let db = seed_drizzle_db("revision");
        let before = drizzle_session_revision(&db, "ses_parent").expect("initial revision");
        let conn = rusqlite::Connection::open(&db).expect("reopen temp db");
        conn.execute(
            "UPDATE part SET data = ?1, time_updated = 2100 WHERE id = 'p1'",
            [r#"{"type":"text","text":"hello again"}"#],
        )
        .expect("update part");
        drop(conn);
        let after = drizzle_session_revision(&db, "ses_parent").expect("updated revision");
        let _ = std::fs::remove_file(&db);
        assert_ne!(before, after);
    }

    #[test]
    fn drizzle_chat_page_queries_only_the_requested_message_window() {
        let db = seed_drizzle_db("chat-page");
        let mut conn = rusqlite::Connection::open(&db).expect("reopen temp db");
        let transaction = conn.transaction().expect("start seed transaction");
        for index in 0..205 {
            let message_id = format!("page-message-{index:03}");
            transaction.execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) \
                 VALUES (?1, 'ses_parent', ?2, ?2, '{\"role\":\"assistant\"}')",
                rusqlite::params![message_id, 10_000 + index],
            ).expect("insert paged message");
            transaction.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) \
                 VALUES (?1, ?2, 'ses_parent', ?3, ?3, ?4)",
                rusqlite::params![
                    format!("page-part-{index:03}"),
                    message_id,
                    10_000 + index,
                    format!(r#"{{"type":"text","text":"message {index}"}}"#),
                ],
            ).expect("insert paged part");
        }
        transaction.commit().expect("commit seed transaction");
        drop(conn);

        let tail = read_opencode_sqlite_session_page(&db, "ses_parent", None)
            .expect("read tail page");
        let older = read_opencode_sqlite_session_page(
            &db,
            "ses_parent",
            Some(tail.history_cursor),
        ).expect("read older page");
        let _ = std::fs::remove_file(&db);

        assert!(tail.has_older);
        assert_eq!(tail.data.lines().count(), CHAT_WINDOW_ROWS);
        assert!(!older.has_older);
        assert!(older.data.contains("hello"));
        assert!(!older.data.contains("message 204"));
    }

    #[test]
    fn hermes_revision_changes_when_a_message_is_appended() {
        let db = std::env::temp_dir().join(format!(
            "coffee-cli-hermes-revision-test-{}.db",
            std::process::id(),
        ));
        let _ = std::fs::remove_file(&db);
        let conn = rusqlite::Connection::open(&db).expect("open Hermes test db");
        conn.execute_batch(
            "CREATE TABLE messages (
                id INTEGER PRIMARY KEY,
                session_id TEXT,
                timestamp REAL,
                content TEXT
             );
             INSERT INTO messages (id, session_id, timestamp, content)
             VALUES (1, 'session-a', 1.0, 'hello');",
        )
        .expect("seed Hermes test db");
        let before = hermes_session_revision(&db, "session-a").expect("initial revision");
        conn.execute(
            "INSERT INTO messages (id, session_id, timestamp, content) VALUES (2, ?1, 2.0, 'world')",
            ["session-a"],
        )
        .expect("append Hermes message");
        drop(conn);
        let after = hermes_session_revision(&db, "session-a").expect("updated revision");
        let _ = std::fs::remove_file(&db);
        assert_ne!(before, after);
    }

    /// Write a Codex-style rollout JSONL with the given `session_meta` payload
    /// fields and one user message, returning the temp file path. Mirrors the
    /// real `~/.codex/sessions/.../rollout-*.jsonl` shape. `case` is a unique
    /// discriminator so parallel tests don't race on the same temp filename.
    /// `source` is passed as a `Value` so callers can exercise both the string
    /// form ("vscode"/"cli" - user sessions) and the object form
    /// (`{"subagent": ...}` - sub-agents) that real Codex rollouts use.
    fn write_codex_rollout(
        case: &str,
        source: serde_json::Value,
        thread_source: Option<&str>,
        forked_from_id: Option<&str>,
    ) -> std::path::PathBuf {
        write_codex_rollout_with_user_messages(
            case,
            source,
            thread_source,
            forked_from_id,
            &["refactor the auth module"],
        )
    }

    fn write_codex_rollout_with_user_messages(
        case: &str,
        source: serde_json::Value,
        thread_source: Option<&str>,
        forked_from_id: Option<&str>,
        user_messages: &[&str],
    ) -> std::path::PathBuf {
        use std::io::Write;
        let mut payload = serde_json::json!({
            "timestamp": "2026-07-12T10:48:37.000Z",
            "type": "session_meta",
            "payload": {
                "id": "019f55f1-7c10-75f2-b536-84009ee1d4dc",
                "timestamp": "2026-07-12T10:48:37.000Z",
                "cwd": "E:\\test",
                "originator": "Codex Desktop",
                "cli_version": "0.144.1",
                "source": source,
                "model_provider": "OpenAI",
            },
        });
        let inner = payload.get_mut("payload").unwrap().as_object_mut().unwrap();
        if let Some(ts) = thread_source {
            inner.insert("thread_source".to_string(), serde_json::Value::String(ts.to_string()));
        }
        if let Some(fid) = forked_from_id {
            inner.insert("forked_from_id".to_string(), serde_json::Value::String(fid.to_string()));
        }
        let path = std::env::temp_dir().join(format!(
            "coffee-cli-codex-test-{}-{}.jsonl",
            std::process::id(),
            case
        ));
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{}", payload).unwrap();
        for text in user_messages {
            let msg = serde_json::json!({
                "timestamp": "2026-07-12T10:48:38.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                },
            });
            writeln!(f, "{}", msg).unwrap();
        }
        path
    }

    /// A normal user-created main session stays visible.
    #[test]
    fn codex_parser_keeps_user_main_session() {
        let path = write_codex_rollout("user-main", serde_json::json!("vscode"), Some("user"), None);
        let session = parse_codex_session_jsonl(&path).expect("user session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.tool, "codex");
        assert_eq!(session.name, "refactor the auth module");
        assert_eq!(session.created_at.as_deref(), Some("2026-07-12T10:48:37.000Z"));
    }

    /// Codex Desktop writes plugin/AGENTS/environment bootstrap context as
    /// synthetic user messages before the first thing the user actually typed.
    /// The sidebar title must scan past all of them.
    #[test]
    fn codex_parser_skips_desktop_bootstrap_messages_for_title() {
        let path = write_codex_rollout_with_user_messages(
            "desktop-bootstrap-title",
            serde_json::json!("vscode"),
            Some("user"),
            None,
            &[
                "<recommended_plugins> Here is a list of plugins that are available but not installed.",
                "# AGENTS.md instructions for D:\\Coffee-CLI\n<INSTRUCTIONS>...</INSTRUCTIONS>",
                "<environment_context><cwd>D:\\Coffee-CLI</cwd></environment_context>",
                "修复真正的用户标题",
            ],
        );
        let session = parse_codex_session_jsonl(&path).expect("desktop session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.name, "修复真正的用户标题");
    }

    /// `thread_source == "subagent"` rollouts are dropped entirely.
    #[test]
    fn codex_parser_drops_subagent_thread_source() {
        let path = write_codex_rollout("subagent-ts", serde_json::json!("vscode"), Some("subagent"), None);
        let session = parse_codex_session_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        assert!(session.is_none(), "subagent rollout must be hidden");
    }

    /// A sub-agent rollout identified by `source: {"subagent": ...}` is
    /// dropped even with no `thread_source` (older rollouts). Uses the real
    /// Codex Desktop shape, where `parent_thread_id` is nested under
    /// `source.subagent.thread_spawn` - not a top-level field.
    #[test]
    fn codex_parser_drops_subagent_source_object() {
        let source = serde_json::json!({
            "subagent": {"thread_spawn": {"parent_thread_id": "019e6d80-aaaa-bbbb-cccc-dddddddddddd", "depth": 1, "agent_role": "explorer"}}
        });
        let path = write_codex_rollout("subagent-src", source, None, None);
        let session = parse_codex_session_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        assert!(session.is_none(), "subagent source-object rollout must be hidden");
    }

    /// A sub-agent whose `SubAgentSource` is a unit variant (e.g. "review")
    /// still serializes `source` with a `subagent` key - caught by the
    /// `contains_key` check regardless of the nested variant shape.
    #[test]
    fn codex_parser_drops_subagent_source_unit_variant() {
        let path = write_codex_rollout("subagent-review", serde_json::json!({"subagent": "review"}), None, None);
        let session = parse_codex_session_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        assert!(session.is_none(), "review subagent rollout must be hidden");
    }

    /// `forked_from_id` marks a user-initiated fork/resume - a legitimate
    /// top-level session that must stay visible despite carrying a parent
    /// pointer. Regression guard: do NOT treat forked_from_id as a sub-agent.
    #[test]
    fn codex_parser_keeps_user_fork_session() {
        let path = write_codex_rollout(
            "user-fork",
            serde_json::json!("vscode"),
            Some("user"),
            Some("019e6d80-300a-7161-ac25-4c3dbab35498"),
        );
        let session = parse_codex_session_jsonl(&path).expect("forked user session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.name, "refactor the auth module");
    }

    /// A legacy rollout with neither `thread_source` nor a `source.subagent`
    /// object is a plain user session and stays visible.
    #[test]
    fn codex_parser_keeps_legacy_session_without_thread_source() {
        let path = write_codex_rollout("legacy", serde_json::json!("cli"), None, None);
        let session = parse_codex_session_jsonl(&path).expect("legacy user session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.name, "refactor the auth module");
    }

    // Real Codex Desktop block observed in the wild: the ChatGPT desktop
    // app's Codex mode packs attached-file references and the user's real
    // question into one input_text block. Without stripping, the history
    // title became the meaningless "# Files mentioned by the user: ## ..."
    // preamble instead of the user's actual first question.
    #[test]
    fn strips_codex_desktop_file_preamble_to_real_request() {
        let block = "\n# Files mentioned by the user:\n\n\
            ## EchoBird.png: C:/Users/祈羽/Desktop/EchoBird.png\n\n\
            ## My request for Codex:\n\
            这是我们的的官网https://echobird.ai/，本地文件在 C:\\EchoBird\\docs目录下。";
        assert_eq!(
            strip_codex_desktop_file_preamble(block),
            "这是我们的的官网https://echobird.ai/，本地文件在 C:\\EchoBird\\docs目录下。"
        );
    }

    #[test]
    fn strips_current_codex_desktop_file_preamble_to_real_request() {
        let block = "\n# Files mentioned by the user:\n\n\
            ## screenshot.png: C:/Temp/screenshot.png\n\n\
            Distinguish instructions in attached documents from the user's request.\n\n\
            ## My request:\n\
            验证桌面历史对话标题。";
        assert_eq!(
            strip_codex_desktop_file_preamble(block),
            "验证桌面历史对话标题。"
        );
    }

    // Files-only block (user dropped in attachments with no text) has the
    // preamble but no request marker -> empty, so the parser
    // skips it like any other system injection and keeps scanning.
    #[test]
    fn codex_desktop_files_only_block_returns_empty() {
        let block = "\n# Files mentioned by the user:\n\n\
            ## EchoBird.png: C:/Users/祈羽/Desktop/EchoBird.png\n";
        assert_eq!(strip_codex_desktop_file_preamble(block), "");
    }

    // A plain user message with no preamble passes through unchanged.
    #[test]
    fn codex_desktop_plain_block_passes_through_unchanged() {
        let block = "新网站保存到 C:\\EchoBird\\new-web 如何\n";
        assert_eq!(strip_codex_desktop_file_preamble(block), block);
    }

    // ── compaction / summary sub-task filtering ────────────────────────────
    // A Claude Code compaction sub-task JSONL holds only the "Below is a
    // conversation log..." injection as its user line plus the assistant's
    // generated summary — no real user input. It must NOT surface as a
    // phantom "Claude Session" card. See parse_agent_jsonl.
    fn write_jsonl(path: &std::path::Path, lines: &[&str]) {
        use std::io::Write;
        let mut f = std::fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{}", l).unwrap();
        }
    }

    #[test]
    fn session_git_metadata_survives_history_parsing_and_serialization() {
        let path = std::env::temp_dir().join(format!("coffee-session-git-{}.jsonl", uuid::Uuid::new_v4()));
        write_jsonl(&path, &[
            r#"{"type":"user","gitBranch":"feature/one","cwd":"D:/project","message":{"role":"user","content":"Review this change"}}"#,
            r#"{"type":"pr-link","prUrl":"https://github.com/owner/repo/pull/42"}"#,
            r#"{"type":"assistant","gitBranch":"main","message":{"role":"assistant","content":[]}}"#,
        ]);
        let session = parse_agent_jsonl(&path, "claude", &std::collections::HashMap::new()).unwrap();
        let restored: SavedSession = serde_json::from_value(serde_json::to_value(&session).unwrap()).unwrap();
        let context = restored.git_context.unwrap();
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert_eq!(context.pull_requests, ["https://github.com/owner/repo/pull/42"]);
        write_jsonl(&path, &[
            r#"{"type":"session_meta","payload":{"id":"one","cwd":"D:/project","git":{"branch":"main"}}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Review https://github.com/owner/repo/pull/43"}]}}"#,
        ]);
        let context = parse_codex_session_jsonl(&path).unwrap().git_context.unwrap();
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert_eq!(context.pull_requests, ["https://github.com/owner/repo/pull/43"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn drops_pure_compaction_subtask_session() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-compact-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("30d442fb-fake-compaction.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Below is a conversation log from a Claude Code coding session.\\nCreate a summary to help the next session quickly understand the context.\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"# Session Summary\\n...\"}]}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"### Tasks\\n- did stuff\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new());
        assert!(got.is_none(), "pure compaction sub-task must not be listed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_real_session_with_real_user_message() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-real-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("dadf2990-fake-real.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"修复一下历史记录的 bug\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"好的，我来看看\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("real session kept");
        assert_eq!(got.name, "修复一下历史记录的 bug");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_title_skips_rows_the_cli_marks_as_not_typed() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-wrapper-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("5b1c0f3e-fake-wrappers.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Caveat: the messages below were generated by the user while running local commands.\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<some-new-wrapper>hook output</some-new-wrapper>\"}]}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"[Request interrupted by user]\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"tool output\"}]}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<ide_opened_file>a.rs</ide_opened_file>\"},{\"type\":\"text\",\"text\":\"把工作中动画对齐竖线\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "把工作中动画对齐竖线");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_title_falls_back_to_slash_command_and_reads_shell_lines() {
        let mut fallback = String::new();
        assert_eq!(claude_prompt_title("<command-name>/model</command-name>\n<command-message>model</command-message>", &mut fallback), None);
        assert_eq!(fallback, "/model");
        assert_eq!(claude_prompt_title("<bash-input>git status</bash-input>", &mut fallback).as_deref(), Some("! git status"));
        assert_eq!(claude_prompt_title("Use <b>bold</b> here", &mut fallback).as_deref(), Some("Use <b>bold</b> here"));
        // Older CLIs put the message tag first; a prompt that only mentions the tags is still a prompt.
        let mut older = String::new();
        assert_eq!(claude_prompt_title("<command-message>usage</command-message>\n<command-name>/usage</command-name>", &mut older), None);
        assert_eq!(older, "/usage");
        let mut untouched = String::new();
        assert_eq!(claude_prompt_title("why is <command-name>/init</command-name> in the log?", &mut untouched).as_deref(), Some("why is <command-name>/init</command-name> in the log?"));
        assert_eq!(claude_prompt_title("run <bash-input>ls</bash-input> for me", &mut untouched).as_deref(), Some("run <bash-input>ls</bash-input> for me"));
        assert!(untouched.is_empty());
        let dir = std::env::temp_dir().join(format!("coffee-cli-command-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("7a2e9c1d-fake-command.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/init</command-name>\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"real prompt after the command\"}}",
        ]);
        assert_eq!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("kept").name, "real prompt after the command");
        // A session the user only ran a slash command in is theirs, named by the command.
        write_jsonl(&f, &["{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/usage</command-name>\"}}"]);
        assert_eq!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("kept").name, "/usage");
        // Hook output and interrupt markers alone are not a conversation the user had.
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<some-hook-output>ran</some-hook-output>\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"[Request interrupted by user]\"}}",
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Caveat: generated while running local commands.\"}}",
        ]);
        assert!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Row shapes below are copied from real Claude Code transcripts.
    #[test]
    fn claude_native_title_beats_first_prompt() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-title-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let user = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"帮我看看历史记录为什么少了几条\"}}";

        let f = dir.join("ai-title.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"ai-title\",\"aiTitle\":\"排查历史记录\",\"sessionId\":\"ai-title\"}",
            user,
            "{\"type\":\"ai-title\",\"aiTitle\":\"历史记录缺失排查\",\"sessionId\":\"ai-title\"}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "历史记录缺失排查", "the last generated title wins");
        assert_eq!(got.turn_count, Some(1), "title rows are not messages");

        let f = dir.join("custom-title.jsonl");
        write_jsonl(&f, &[
            user,
            "{\"type\":\"custom-title\",\"customTitle\":\"历史记录｜扫描稳定性\",\"sessionId\":\"custom-title\"}",
            "{\"type\":\"ai-title\",\"aiTitle\":\"历史记录缺失排查\",\"sessionId\":\"custom-title\"}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "历史记录｜扫描稳定性", "a user rename beats a generated title");

        let f = dir.join("blank-title.jsonl");
        write_jsonl(&f, &[user, "{\"type\":\"ai-title\",\"aiTitle\":\"  \",\"sessionId\":\"blank-title\"}"]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "帮我看看历史记录为什么少了几条", "a blank title falls back to the first prompt");

        // A title row is not a conversation: still a phantom without a real user line.
        let f = dir.join("title-only.jsonl");
        write_jsonl(&f, &["{\"type\":\"ai-title\",\"aiTitle\":\"Orphan\",\"sessionId\":\"title-only\"}"]);
        assert!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_thread_names_overlay_first_prompt_titles() {
        let names = parse_codex_thread_names(concat!(
            "{\"id\":\"t1\",\"thread_name\":\"修正 Codex 本地代理配置\",\"updated_at\":\"2026-09-19T10:31:30Z\"}\n",
            "not json\n",
            "{\"id\":\"t2\",\"thread_name\":\"  \"}\n",
            "{\"id\":\"t1\",\"thread_name\":\"Codex代理｜核对本地地址绕过配置\",\"updated_at\":\"2026-09-19T10:33:37Z\"}\n",
        ));
        assert_eq!(names.len(), 1, "blank names and malformed rows are skipped");
        assert_eq!(names["t1"], "Codex代理｜核对本地地址绕过配置", "a later row renames the thread");

        let home = std::env::temp_dir().join(format!("coffee-cli-codex-index-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(
            home.join(".codex").join("session_index.jsonl"),
            "{\"id\":\"t1\",\"thread_name\":\"Codex代理｜核对本地地址绕过配置\"}\n",
        ).unwrap();
        let row = |tool: &str, token: &str| SavedSession {
            id: format!("{}_native_{}", tool, token),
            name: "first prompt".to_string(),
            tool: tool.to_string(),
            cwd: String::new(),
            session_token: Some(token.to_string()),
            saved_at: String::new(),
            created_at: None,
            file_path: None,
            turn_count: None,
            git_context: None,
            worktree_cwd: None,
        };
        let mut sessions = vec![row("codex", "t1"), row("codex", "unnamed"), row("claude", "t1")];
        apply_codex_thread_names(&home.join(".codex/sessions"), &mut sessions);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(sessions[0].name, "Codex代理｜核对本地地址绕过配置");
        assert_eq!(sessions[1].name, "first prompt", "threads absent from the index keep their title");
        assert_eq!(sessions[2].name, "first prompt", "other tools are never touched");
    }

    #[test]
    fn keeps_session_that_continued_after_compaction() {
        // The live-session case: compaction injected as the FIRST user line,
        // but the user kept chatting in the same session file. Must survive —
        // filtering on "first user line is injected" would wrongly drop this.
        let dir = std::env::temp_dir().join(format!("coffee-cli-cont-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("43b57955-fake-continued.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Below is a conversation log from a Claude Code coding session.\\nCreate a summary...\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"summary\"}]}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"继续帮我测一下 OSC 52\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"好\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("continued session kept");
        // Title is the FIRST real user line, not the compaction injection.
        assert_eq!(got.name, "继续帮我测一下 OSC 52");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn counts_array_content_user_message_with_mixed_blocks() {
        // A user message whose content is an ARRAY can mix an injected block
        // (e.g. an ide_opened_file tool_result) with a real text block. The
        // counter must count this as ONE real user message (.any() semantics)
        // — not zero (which would drop a live session) and not >1. Covers the
        // array branch of the counter that the string-content tests don't.
        let dir = std::env::temp_dir().join(format!("coffee-cli-arr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a3f2c910-fake-array.jsonl");
        write_jsonl(&f, &[
            // First user msg: array with an injected tool_result block AND a
            // real text block — must count as 1 real user message.
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"x\",\"content\":\"<ide_opened_file>\"},{\"type\":\"text\",\"text\":\"帮我把这个文件重构一下\"}]}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"好的\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("mixed-array session kept");
        // Title comes from the real text block, not the injected tool_result.
        assert_eq!(got.name, "帮我把这个文件重构一下");
        let _ = std::fs::remove_dir_all(&dir);
    }

}

#[cfg(test)]
mod pi_session_written_tests {
    #[test]
    fn pi_token_waits_for_the_session_file() {
        let root = std::env::temp_dir().join(format!("coffee-pi-root-{}", uuid::Uuid::new_v4()));
        let bucket = root.join("--Users-me-proj--");
        std::fs::create_dir_all(&bucket).unwrap();
        let id = "0f0f0f0f-1111-2222-3333-444444444444";
        let suffix = format!("_{id}.jsonl");
        assert!(!super::pi_session_written(&root, &suffix));
        std::fs::write(bucket.join(format!("2026-11-03T01-02-03-000Z{suffix}")), "{}").unwrap();
        assert!(super::pi_session_written(&root, &suffix));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
#[path = "server/history_cache_tests.rs"]
mod history_cache_tests;

#[cfg(test)]
#[path = "server/opencode_tests.rs"]
mod opencode_tests;

#[cfg(test)]
#[path = "server/pty_resize_tests.rs"]
mod pty_resize_tests;
