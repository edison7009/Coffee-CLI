use crate::scanner;
use crate::terminal;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{State, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;

/// Shared app state
pub struct AppState {
    pub project_dir: Mutex<PathBuf>,
    pub terminal_session: terminal::SharedSession,
    /// Loopback port of the hook TCP server (set once during setup).
    /// 0 means the hook server failed to start; env var injection is skipped in that case.
    pub hook_port: std::sync::atomic::AtomicU16,
    /// Active OS fs watcher (one per app instance). Some(...) while a
    /// workspace folder is open; None otherwise. Swapping this Mutex'd
    /// Option replaces the watcher atomically on folder switch.
    pub fs_watcher: Mutex<Option<crate::fs_watcher::FsWatcher>>,
}

#[derive(Serialize)]
struct FileInfo {
    relative_path: String,
    size: u64,
    extension: String,
    symbols: Vec<String>, // simplified
    line_count: usize,
}

#[derive(Serialize)]
struct ScanResponse {
    root: String,
    files: Vec<FileInfo>,
    total_scanned: usize,
    skipped: Vec<String>,
}


#[tauri::command]
fn scan_project(
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<ScanResponse, String> {
    if let Some(p) = path {
        let new_dir = PathBuf::from(&p);
        if !new_dir.is_dir() {
            return Err(format!("Not a valid directory: {}", p));
        }
        let mut dir = state.project_dir.lock().map_err(|e| e.to_string())?;
        *dir = new_dir.clone();

    }

    let dir = state.project_dir.lock().map_err(|e| e.to_string())?;
    let scan_result = scanner::scan_directory(&dir).map_err(|e| e.to_string())?;

    let files: Vec<FileInfo> = scan_result
        .files
        .iter()
        .map(|f| FileInfo {
            relative_path: f.relative_path.clone(),
            size: f.size,
            extension: f.extension.clone(),
            symbols: vec![],
            line_count: 0,
        })
        .collect();

    Ok(ScanResponse {
        root: dir.display().to_string(),
        files,
        total_scanned: scan_result.total_scanned,
        skipped: scan_result.skipped,
    })
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

/// Spawn a new independent Coffee CLI window.
/// Each window is a fully standalone instance with its own tabs.
#[tauri::command]
fn create_detached_window(
    app: tauri::AppHandle,
    _session_id: String,
    _tool: String,
    _tool_data: Option<String>,
) -> Result<(), String> {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let label = format!("detached-{}", ts);

    let _window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Coffee CLI")
    .inner_size(1200.0, 800.0)
    .min_inner_size(900.0, 600.0)
    .decorations(false)
    .shadow(false)
    .center()
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    Ok(())
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

#[cfg(target_os = "windows")]
fn check_tool_windows(bin: &str) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("where")
        .arg(bin)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn check_tool_unix(bin: &str) -> bool {
    std::process::Command::new("which")
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
fn check_tools_installed(extras: Option<Vec<String>>) -> std::collections::HashMap<String, bool> {
    let tools = vec![
        ("claude", "claude"),
        ("qwen", "qwen"),
        ("hermes", "hermes"),
        ("opencode", "opencode"),
        ("codex", "codex"),
        ("gemini", "gemini"),
        // remote is always available — it's just SSH (built into the OS)
    ];
    let mut result = std::collections::HashMap::new();
    for (key, bin) in tools {
        #[cfg(target_os = "windows")]
        let found = check_tool_windows(bin);

        #[cfg(not(target_os = "windows"))]
        let found = check_tool_unix(bin);

        result.insert(key.to_string(), found);
    }
    // Terminal is always available — it's the system shell
    result.insert("terminal".to_string(), true);

    // Extras are binary names from the remote agents catalog (e.g. "openclaw").
    // Frontend passes the binaries of pinned remote agents for PATH detection.
    // Non-empty names only; bad input is silently ignored.
    if let Some(list) = extras {
        for bin in list {
            if bin.is_empty() || bin.contains('\0') { continue; }
            if result.contains_key(&bin) { continue; }
            #[cfg(target_os = "windows")]
            let found = check_tool_windows(&bin);
            #[cfg(not(target_os = "windows"))]
            let found = check_tool_unix(&bin);
            result.insert(bin, found);
        }
    }

    result
}

// ─── File System Live Watcher ────────────────────────────────────────────────
//
// Start/stop a recursive fs watcher on the workspace folder so changes
// made by external tools (terminal CLIs, editors, git, etc.) propagate
// into the Explorer tree immediately. See fs_watcher.rs for mechanics.

#[tauri::command]
fn start_fs_watcher(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    let watcher = crate::fs_watcher::FsWatcher::start(app, root)?;
    // Replace atomically; dropping the old FsWatcher stops its OS handle.
    let mut guard = state.fs_watcher.lock().map_err(|e| format!("lock: {}", e))?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
fn stop_fs_watcher(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.fs_watcher.lock().map_err(|e| format!("lock: {}", e))?;
    // Drop releases the OS watcher handle.
    *guard = None;
    Ok(())
}

// ─── File System Browsing API ────────────────────────────────────────────────

/// Information about a single drive / mount point
#[derive(Serialize)]
struct DriveInfo {
    path: String,
    label: String,
    /// Semantic kind used by frontend for icon selection and i18n.
    /// Values: "desktop", "downloads", "documents", "pictures", "music", "videos", "home", "drive", "root", "volume"
    kind: String,
}

/// Information about a single directory entry (file or folder)
#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// List all available drives (Windows) or common mount points (Unix)
#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    let mut drives: Vec<DriveInfo> = Vec::new();

    // ── Quick Access locations (order matches Windows Explorer) ──

    if let Some(desktop) = dirs::desktop_dir() {
        if desktop.exists() {
            drives.push(DriveInfo {
                path: desktop.to_string_lossy().to_string(),
                label: "Desktop".to_string(),
                kind: "desktop".to_string(),
            });
        }
    }

    if let Some(dl) = dirs::download_dir() {
        if dl.exists() {
            drives.push(DriveInfo {
                path: dl.to_string_lossy().to_string(),
                label: "Downloads".to_string(),
                kind: "downloads".to_string(),
            });
        }
    }

    if let Some(docs) = dirs::document_dir() {
        if docs.exists() {
            drives.push(DriveInfo {
                path: docs.to_string_lossy().to_string(),
                label: "Documents".to_string(),
                kind: "documents".to_string(),
            });
        }
    }

    if let Some(pics) = dirs::picture_dir() {
        if pics.exists() {
            drives.push(DriveInfo {
                path: pics.to_string_lossy().to_string(),
                label: "Pictures".to_string(),
                kind: "pictures".to_string(),
            });
        }
    }

    if let Some(music) = dirs::audio_dir() {
        if music.exists() {
            drives.push(DriveInfo {
                path: music.to_string_lossy().to_string(),
                label: "Music".to_string(),
                kind: "music".to_string(),
            });
        }
    }

    if let Some(videos) = dirs::video_dir() {
        if videos.exists() {
            drives.push(DriveInfo {
                path: videos.to_string_lossy().to_string(),
                label: "Videos".to_string(),
                kind: "videos".to_string(),
            });
        }
    }

    // Home directory
    if let Some(home) = dirs::home_dir() {
        drives.push(DriveInfo {
            path: home.to_string_lossy().to_string(),
            label: "Home".to_string(),
            kind: "home".to_string(),
        });
    }

    // ── Disk Drives ──

    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let drive_path = format!("{}:\\", letter as char);
            let p = std::path::Path::new(&drive_path);
            if p.exists() {
                drives.push(DriveInfo {
                    path: drive_path.clone(),
                    label: format!("{}", letter as char),
                    kind: "drive".to_string(),
                });
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let root = std::path::Path::new("/");
        if root.exists() {
            drives.push(DriveInfo {
                path: "/".to_string(),
                label: "Root (/)".to_string(),
                kind: "root".to_string(),
            });
        }
        if cfg!(target_os = "macos") {
            if let Ok(entries) = std::fs::read_dir("/Volumes") {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        drives.push(DriveInfo {
                            path: entry.path().to_string_lossy().to_string(),
                            label: entry.file_name().to_string_lossy().to_string(),
                            kind: "volume".to_string(),
                        });
                    }
                }
            }
        }
    }

    drives
}

/// List the immediate children of a directory.
/// Returns files and subdirectories sorted: directories first, then files, both alphabetical.
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
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

        // Skip hidden files/dirs (start with .)
        if name.starts_with('.') {
            continue;
        }

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

// ─── Installer script temp-file helper ───────────────────────────────────────

/// Write a script (PowerShell or shell) to a temp file and return its path.
///
/// Needed because the Windows CMD command-line length limit is ~8191 chars.
/// The agent-tools-installer.ps1 script (with Language Packs menus) base64
/// encodes to ~40KB UTF-16LE, far over the limit. Instead of trying to pipe
/// it through `powershell -EncodedCommand <b64>`, the frontend writes the
/// script text here, gets back a path, and invokes `powershell -File <path>`.
#[tauri::command]
fn write_temp_script(content: String, extension: String) -> Result<String, String> {
    use std::io::Write;
    // Sanitize extension — only allow a small allowlist to prevent path tricks.
    let ext = match extension.as_str() {
        "ps1" | "sh" | "bat" | "cmd" => extension,
        _ => return Err(format!("Unsupported script extension: {}", extension)),
    };
    let tmp_dir = std::env::temp_dir();
    let filename = format!("coffee-installer-{}.{}", std::process::id(), ext);
    let path = tmp_dir.join(&filename);
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("Failed to create temp script: {}", e))?;
    // Windows PowerShell 5.x reads .ps1 files using the system codepage (e.g. GBK)
    // unless the file starts with a UTF-8 BOM. Without BOM, CJK characters are garbled.
    if ext == "ps1" {
        file.write_all(b"\xEF\xBB\xBF")
            .map_err(|e| format!("Failed to write BOM: {}", e))?;
    }
    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write temp script: {}", e))?;
    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    Ok(path.to_string_lossy().to_string())
}

/// Check whether a Claude Code skill is installed locally.
/// Returns true if `~/.claude/skills/<name>/SKILL.md` exists.
#[tauri::command]
fn check_skill_installed(name: String) -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    home.join(".claude").join("skills").join(&name).join("SKILL.md").exists()
}

/// Write a file into `~/.claude/skills/vibeid/<rel_path>`.
/// Creates parent directories as needed. `rel_path` must be a relative path
/// with no `..` segments. Used by the frontend to hydrate the VibeID skill
/// package on first launch by fetching from the remote skill URL.
#[tauri::command]
fn write_skill_file(rel_path: String, bytes: Vec<u8>) -> Result<(), String> {
    // Reject absolute paths and parent-dir escapes. Skill tree is always
    // under ~/.claude/skills/vibeid/ and rel_path is a forward-slash path.
    if rel_path.contains("..") || rel_path.starts_with('/') || rel_path.starts_with('\\')
        || rel_path.contains(':')
    {
        return Err(format!("Invalid relative path: {}", rel_path));
    }
    let home = dirs::home_dir().ok_or_else(|| "No home directory".to_string())?;
    let target = home.join(".claude").join("skills").join("vibeid").join(&rel_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create skill dir: {}", e))?;
    }
    std::fs::write(&target, &bytes)
        .map_err(|e| format!("Failed to write skill file: {}", e))?;
    Ok(())
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

    let tmp_dir = std::env::temp_dir().join("coffee-cli-compose");
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

// ─── File System Operations ───────────────────────────────────────────────────

/// Open the native file explorer and highlight / reveal the given path.
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
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

/// Validate that a path is safe to operate on:
/// - Canonicalizes the path (resolves `..` and symlinks)
/// - Rejects paths with fewer than 3 components (drive root, OS dirs, etc.)
fn validate_fs_path(path: &str) -> Result<std::path::PathBuf, String> {
    let canonical = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    // Require at least 3 components, e.g. C:\Users\foo or /home/user
    // This blocks C:\, C:\Windows, /, /etc, /usr, etc.
    if canonical.components().count() < 3 {
        return Err("Operation rejected: path is too shallow (system-level directory)".to_string());
    }
    Ok(canonical)
}

/// Delete a file or directory permanently (no recycle bin).
#[tauri::command]
fn fs_delete(path: String) -> Result<(), String> {
    let p = validate_fs_path(&path)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Delete failed: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Delete failed: {e}"))
    }
}

/// Rename / move a path to a new name within the same parent directory.
#[tauri::command]
fn fs_rename(path: String, new_name: String) -> Result<(), String> {
    let src = validate_fs_path(&path)?;
    let dest = src.parent()
        .ok_or_else(|| "No parent directory".to_string())?
        .join(&new_name);
    std::fs::rename(&src, dest).map_err(|e| format!("Rename failed: {e}"))
}

/// Paste (copy or move) a file/directory into a target directory.
/// `action` is either "copy" or "cut".
#[tauri::command]
fn fs_paste(action: String, src_path: String, target_dir: String) -> Result<(), String> {
    let src = validate_fs_path(&src_path)?;
    // target_dir may not exist yet for copy — validate its parent instead
    let target_canonical = std::path::Path::new(&target_dir)
        .canonicalize()
        .map_err(|e| format!("Invalid target directory: {e}"))?;
    if target_canonical.components().count() < 3 {
        return Err("Operation rejected: target is a system-level directory".to_string());
    }
    let file_name = src.file_name().ok_or("Invalid source path")?;
    let dest = target_canonical.join(file_name);

    match action.as_str() {
        "cut" => {
            std::fs::rename(&src, &dest).map_err(|e| format!("Move failed: {e}"))
        }
        "copy" => {
            if src.is_dir() {
                copy_dir_all(&src, &dest).map_err(|e| format!("Copy dir failed: {e}"))
            } else {
                std::fs::copy(&src, &dest).map(|_| ()).map_err(|e| format!("Copy failed: {e}"))
            }
        }
        _ => Err(format!("Unknown action: {action}")),
    }
}

/// Recursively copy a directory and all its contents.
fn copy_dir_all(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ─── Tier Terminal API ────────────────────────────────────────────────────────

#[tauri::command]
fn tier_terminal_start(
    session_id: String,
    tool: Option<String>,
    tool_data: Option<String>,
    cols: u16,
    rows: u16,
    theme_mode: Option<String>,
    locale: Option<String>,
    cwd: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Use per-tab CWD from frontend, NOT the global project_dir.
    // Each tab is independent: new tabs get home dir, existing tabs keep their own.
    let dir = cwd.map(std::path::PathBuf::from).unwrap_or_default();

    // Map the requested tool to an actual CLI command.
    let (cmd, args): (String, Vec<String>) = match tool.as_deref() {
        Some("claude")   => ("claude".to_string(), vec![]),
        // VibeID is a skill-launcher: spawn plain `claude` binary with `/vibeid`
        // as the initial positional prompt argument. Claude Code's REPL parses
        // leading slash commands as skill invocations, so the `vibeid` skill
        // fires immediately on startup with no PTY-write hacks required.
        Some("vibeid")   => ("claude".to_string(), vec!["/vibeid".to_string()]),
        Some("qwen")     => ("qwen".to_string(),   vec![]),
        Some("hermes")   => ("hermes".to_string(), vec![]),
        Some("opencode") => ("opencode".to_string(), vec![]),
        Some("codex")    => ("codex".to_string(),  vec![]),
        Some("gemini")   => ("gemini".to_string(), vec![]),
        Some("agent") => {
            // Generic remote-catalog agent: binary + args are passed by the
            // frontend via tool_data JSON (same pattern as "remote" uses for
            // SSH connection info). Only null-byte rejection is enforced —
            // the catalog itself is trusted (same origin as install.sh).
            let data = tool_data.as_deref().unwrap_or("{}");
            let spec: serde_json::Value = serde_json::from_str(data)
                .map_err(|e| format!("Invalid agent spec: {}", e))?;
            let binary = spec["binary"].as_str().unwrap_or("").to_string();
            let args: Vec<String> = spec["args"].as_array()
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if binary.is_empty() || binary.contains('\0') {
                return Err("Invalid agent binary".to_string());
            }
            if args.iter().any(|a| a.contains('\0')) {
                return Err("Invalid agent arg".to_string());
            }
            (binary, args)
        },
        Some("remote") => {
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
            ("powershell.exe".to_string(), vec!["-NoExit".to_string()])
        } else {
            ("bash".to_string(), vec!["-l".to_string(), "-i".to_string()])
        }
    };

    // If a session with the same ID already exists (e.g. restart-in-place),
    // forcefully kill and remove it before spawning a fresh one.
    {
        let mut lock = state.terminal_session.lock().unwrap();
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
    let spawn_cwd = if dir.as_os_str().is_empty() || !dir.is_dir() {
        dirs::home_dir().map(|p| p.to_string_lossy().to_string())
    } else {
        Some(dir.to_string_lossy().to_string())
    };

    let tool_name = tool.clone();
    let actual_cwd = spawn_cwd.clone().unwrap_or_default();

    eprintln!("[Tier Terminal] Starting tool={:?}, cmd={}, args={:?}, cwd={:?}", tool, cmd, args, spawn_cwd);

    terminal::spawn(
        app.clone(),
        session_id.clone(),
        state.terminal_session.clone(),
        cmd,
        args,
        spawn_cwd,
        locale.clone().unwrap_or_else(|| "en".to_string()),
        cols,
        rows,
        tool_name,
        theme_mode,
        locale,
    ).map_err(|e| format!("Failed to spawn PTY: {}", e))?;

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
fn tier_terminal_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Step 1: grab Arc handles while holding the map lock (cheap clones, no IO)
    let (writer_arc, activity_arc) = {
        let map = state.terminal_session.lock().unwrap();
        match map.get(&session_id) {
            Some(s) => (s.writer_lock.clone(), s.activity.clone()),
            None => return Err(format!("No active terminal session for id: {}", session_id)),
        }
    };
    // Map lock released — other tabs can now proceed concurrently

    // Step 2: PTY write (syscall, may block under back-pressure)
    use std::io::Write;
    let mut w = writer_arc.lock().map_err(|e| format!("Writer lock poisoned: {}", e))?;
    w.write_all(data.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
    w.flush().map_err(|e| format!("Flush failed: {}", e))?;
    drop(w);

    // Step 3: Dual-signal — detect user prompt submission
    // Only trigger "working" when user presses Enter while agent is at prompt.
    // System-generated input (auto-skip) uses tier_terminal_raw_write instead.
    if data.contains('\r') || data.contains('\n') {
        if let Ok(mut act) = activity_arc.lock() {
            if act.last_status == "wait_input" {
                act.user_submitted_at = Some(std::time::Instant::now());
            }
        }
    }

    Ok(())
}

/// Raw write to PTY without triggering agent-status detection.
/// Used for system-generated input like auto-skip Enter for Claude trust prompt.
#[tauri::command]
fn tier_terminal_raw_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Grab writer Arc, release map lock before PTY I/O
    let writer_arc = {
        let map = state.terminal_session.lock().unwrap();
        match map.get(&session_id) {
            Some(s) => s.writer_lock.clone(),
            None => return Err(format!("No active terminal session for id: {}", session_id)),
        }
    };

    use std::io::Write;
    let mut w = writer_arc.lock().map_err(|e| format!("Writer lock poisoned: {}", e))?;
    w.write_all(data.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
    w.flush().map_err(|e| format!("Flush failed: {}", e))?;
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
fn tier_terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use portable_pty::PtySize;
    let map = state.terminal_session.lock().unwrap();
    if let Some(session) = map.get(&session_id) {
        let master_guard = session._master.lock().unwrap();
        if let Some(ref master) = *master_guard {
            let size = PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            };
            master.resize(size).map_err(|e| format!("Resize failed: {}", e))?;
        }
    }
    Ok(())
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
    file_path: Option<String>,
    turn_count: Option<u32>,
}

fn sessions_file_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".coffee-cli");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("sessions.json")
}

/// XML-style tags Claude Code injects into the user message stream when
/// integrated with an IDE or shell. These are not things the user typed —
/// filtering them out of the history title extractor keeps the sidebar
/// readable (no more "<ide_opened_file>The user opened the..." cards).
const SYSTEM_INJECTION_TAGS: &[&str] = &[
    "<environment_context>",
    "<ide_opened_file>",
    "<ide_closed_file>",
    "<ide_selection>",
    "<system-reminder>",
    "<command-message>",
    "<command-name>",
];

fn is_system_injected(text: &str) -> bool {
    let t = text.trim();
    SYSTEM_INJECTION_TAGS.iter().any(|tag| t.starts_with(tag))
}

fn parse_agent_jsonl(file_path: &std::path::Path, tool_name: &str) -> Option<SavedSession> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id = file_path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = String::new();
    let mut updated_at = String::new();
    let mut title = String::new();
    let mut total_messages = 0;

    for line in reader.lines().map_while(Result::ok) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(s) = value.get("sessionId").and_then(|v| v.as_str()) {
                if !s.is_empty() { session_id = s.to_string(); }
            }
            if let Some(c) = value.get("cwd").and_then(|v| v.as_str()) {
                if cwd.is_empty() && !c.is_empty() { cwd = c.to_string(); }
            }
            let mut maybe_msg_obj = value.get("message").and_then(|v| v.as_object());
            if maybe_msg_obj.is_none() {
                if let Some(payload) = value.get("payload").and_then(|v| v.as_object()) {
                    if let Some(ptype) = payload.get("type").and_then(|v| v.as_str()) {
                        if ptype == "message" {
                            maybe_msg_obj = Some(payload);
                        }
                    }
                }
            }

            if let Some(msg_obj) = maybe_msg_obj {
                if let Some(role) = msg_obj.get("role").and_then(|v| v.as_str()) {
                    if role == "user" || role == "assistant" {
                        total_messages += 1;
                    }
                    if role == "user" && title.is_empty() {
                        if let Some(content_str) = msg_obj.get("content").and_then(|v| v.as_str()) {
                            // Skip whole-message IDE/system injections so the
                            // next real user line becomes the title.
                            if !is_system_injected(content_str) {
                                let content_safe = content_str.replace('\n', " ");
                                let mut chars = content_safe.chars();
                                let t: String = chars.by_ref().take(40).collect();
                                title = if chars.next().is_some() { format!("{}...", t) } else { t };
                            }
                        } else if let Some(content_arr) = msg_obj.get("content").and_then(|v| v.as_array()) {
                            // Extract text from object array
                            for block in content_arr {
                                if let Some(t) = block.get("type").and_then(|v| v.as_str()) {
                                    if t == "text" || t == "input_text" {
                                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                            if is_system_injected(text) {
                                                continue; // skip IDE / system-injected prompts
                                            }
                                            let safe_text = text.replace('\n', " ");
                                            let mut chars = safe_text.chars();
                                            let chunk: String = chars.by_ref().take(40).collect();
                                            title = if chars.next().is_some() { format!("{}...", chunk) } else { chunk };
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Fallback: If cwd is still empty, derive it from the parent project folder name
    // e.g., "D--Coffee-Code" -> "D:\Coffee-Code", "C--Users--..." -> "C:\Users\..."
    if cwd.is_empty() {
        if let Some(parent) = file_path.parent() {
            if let Some(folder_name) = parent.file_name().and_then(|n| n.to_str()) {
                if folder_name.contains("--") {
                    let mut parts = folder_name.split("--");
                    if let Some(drive) = parts.next() {
                        let rest: Vec<&str> = parts.collect();
                        let decoded_path = if cfg!(target_os = "windows") {
                            format!("{}:\\{}", drive, rest.join("\\"))
                        } else {
                            format!("/{}/{}", drive, rest.join("/"))
                        };
                        cwd = decoded_path;
                    }
                }
            }
        }
    }
    let turn_count = if total_messages > 0 { std::cmp::max(1, (total_messages + 1) / 2) } else { 0 };
    
    // Fallback date from file metadata
    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                updated_at = dur.as_millis().to_string();
            }
        }
    }

    if title.is_empty() {
        let mut chars = tool_name.chars();
        let cap_name = match chars.next() {
            None => String::new(),
            Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        };
        title = format!("{} Session", cap_name);
    }

    Some(SavedSession {
        id: format!("{}_native_{}", tool_name, session_id),
        name: title,
        tool: tool_name.to_string(),
        cwd,
        session_token: Some(session_id),
        saved_at: updated_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

#[tauri::command]
fn read_native_session(file_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&file_path);

    // Only allow .jsonl / .json files
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext != "jsonl" && ext != "json" {
        return Err("Only .jsonl and .json files are allowed".to_string());
    }

    // Canonicalize to resolve any `..` or symlink traversal
    let canonical_raw = path.canonicalize().map_err(|e| format!("Invalid path: {e}"))?;
    // On Windows, canonicalize() prepends \\?\ (UNC extended-length prefix).
    // Strip it so that starts_with() comparisons against plain home-dir paths work.
    #[cfg(windows)]
    let canonical = {
        let s = canonical_raw.to_string_lossy();
        if s.starts_with(r"\\?\") {
            std::path::PathBuf::from(s[4..].to_string())
        } else {
            canonical_raw
        }
    };
    #[cfg(not(windows))]
    let canonical = canonical_raw;

    // Must reside under a known agent data directory
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let allowed: &[std::path::PathBuf] = &[
        home.join(".claude"),
        home.join(".hermes"),
        home.join(".local").join("share").join("opencode"),
    ];
    if !allowed.iter().any(|prefix| canonical.starts_with(prefix)) {
        return Err("Access denied: path is outside allowed agent data directories".to_string());
    }

    std::fs::read_to_string(&canonical).map_err(|e| e.to_string())
}

fn find_jsonl_sessions_recursively(dir: std::path::PathBuf, depth: u8, tool: &str, result: &mut Vec<SavedSession>) {
    if depth == 0 || !dir.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    if let Some(session) = parse_agent_jsonl(&path, tool) {
                        result.push(session);
                    }
                }
            } else if path.is_dir() {
                find_jsonl_sessions_recursively(path, depth - 1, tool, result);
            }
        }
    }
}

fn parse_hermes_json(file_path: &std::path::Path) -> Option<SavedSession> {
    let content = std::fs::read_to_string(file_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;

    let session_id = value.get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| file_path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown"))
        .to_string();

    let mut title = String::new();
    let mut total_messages = 0u32;

    if let Some(messages) = value.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role == "user" || role == "assistant" {
                total_messages += 1;
            }
            if role == "user" && title.is_empty() {
                if let Some(content_str) = msg.get("content").and_then(|v| v.as_str()) {
                    let s = content_str.trim();
                    // Skip internal/system messages
                    if !s.is_empty() && !s.starts_with("[Note:") && !s.starts_with("[CONTEXT") {
                        let safe = s.replace('\n', " ");
                        let mut chars = safe.chars();
                        let t: String = chars.by_ref().take(40).collect();
                        title = if chars.next().is_some() { format!("{}...", t) } else { t };
                    }
                }
            }
        }
    }

    if title.is_empty() {
        title = "Hermes Session".to_string();
    }

    let turn_count = if total_messages > 0 { std::cmp::max(1, (total_messages + 1) / 2) } else { 0 };

    let mut saved_at = String::new();
    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                saved_at = dur.as_millis().to_string();
            }
        }
    }

    Some(SavedSession {
        id: format!("hermes_native_{}", session_id),
        name: title,
        tool: "hermes".to_string(),
        cwd: String::new(),
        session_token: Some(session_id),
        saved_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

fn parse_opencode_session(file_path: &std::path::Path, message_dir: &std::path::Path) -> Option<SavedSession> {
    let content = std::fs::read_to_string(file_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;

    let id = value.get("id").and_then(|v| v.as_str())?.to_string();
    let title = value.get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("OpenCode Session")
        .to_string();
    let cwd = value.get("directory").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let saved_at = value.get("time")
        .and_then(|t| t.get("updated"))
        .and_then(|v| v.as_u64())
        .map(|ms| ms.to_string())
        .unwrap_or_default();

    // Count message files to estimate turn count
    let msg_dir = message_dir.join(&id);
    let msg_count = if msg_dir.is_dir() {
        std::fs::read_dir(&msg_dir)
            .map(|entries| entries.flatten().filter(|e| e.path().is_file()).count() as u32)
            .unwrap_or(0)
    } else {
        0
    };
    let turn_count = std::cmp::max(1, msg_count / 2);

    Some(SavedSession {
        id: format!("opencode_native_{}", id),
        name: title,
        tool: "opencode".to_string(),
        cwd,
        session_token: Some(id),
        saved_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

fn find_opencode_sessions(base_dir: std::path::PathBuf, result: &mut Vec<SavedSession>) {
    // Prefer SQLite DB (current OpenCode format) over legacy JSON files
    let db_path = base_dir.join("opencode.db");
    if db_path.is_file() {
        find_opencode_sessions_sqlite(&db_path, result);
        return;
    }

    // Fallback: legacy JSON layout — storage/session/<project-id>/ses_*.json
    let session_dir = base_dir.join("storage").join("session");
    let message_dir = base_dir.join("storage").join("message");
    if !session_dir.is_dir() { return; }

    if let Ok(projects) = std::fs::read_dir(&session_dir) {
        for project_entry in projects.flatten() {
            let project_path = project_entry.path();
            if !project_path.is_dir() { continue; }
            if let Ok(sessions) = std::fs::read_dir(&project_path) {
                for session_entry in sessions.flatten() {
                    let path = session_entry.path();
                    if !path.is_file() { continue; }
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with("ses_") && name.ends_with(".json") {
                        if let Some(session) = parse_opencode_session(&path, &message_dir) {
                            result.push(session);
                        }
                    }
                }
            }
        }
    }
}

fn find_opencode_sessions_sqlite(db_path: &std::path::Path, result: &mut Vec<SavedSession>) {
    let conn = match rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return,
    };

    // Query sessions with message count, skip archived ones
    let query = "SELECT s.id, s.title, s.directory, s.time_updated, \
                 COUNT(m.id) as msg_count \
                 FROM session s \
                 LEFT JOIN message m ON m.session_id = s.id \
                 WHERE s.time_archived IS NULL \
                 GROUP BY s.id \
                 ORDER BY s.time_updated DESC \
                 LIMIT 200";

    let mut stmt = match conn.prepare(query) {
        Ok(s) => s,
        Err(_) => return,
    };

    let sessions_iter = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let title: String = row.get::<_, Option<String>>(1)
            .unwrap_or(None)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "OpenCode Session".to_string());
        let directory: String = row.get::<_, Option<String>>(2)
            .unwrap_or(None)
            .unwrap_or_default();
        let time_updated: i64 = row.get(3).unwrap_or(0);
        let msg_count: i64 = row.get(4).unwrap_or(0);
        let turn_count = std::cmp::max(1, msg_count / 2) as u32;

        Ok(SavedSession {
            id: format!("opencode_native_{}", id),
            name: title,
            tool: "opencode".to_string(),
            cwd: directory,
            session_token: Some(id),
            saved_at: time_updated.to_string(),
            file_path: None,
            turn_count: Some(turn_count),
        })
    });

    if let Ok(iter) = sessions_iter {
        for session in iter.flatten() {
            result.push(session);
        }
    }
}

fn find_hermes_sessions(dir: std::path::PathBuf, result: &mut Vec<SavedSession>) {
    if !dir.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Only session_*.json files — skip request_dump_* and state.db
            if name.starts_with("session_") && name.ends_with(".json") {
                if let Some(session) = parse_hermes_json(&path) {
                    result.push(session);
                }
            }
        }
    }
}

#[tauri::command]
fn get_native_history(_state: State<'_, AppState>) -> Result<Vec<SavedSession>, String> {
    let mut result: Vec<SavedSession> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        // 1. Claude Code (Max depth 2: projects/<hash>/<hash>.jsonl)
        let claude_dir = home.join(".claude").join("projects");
        find_jsonl_sessions_recursively(claude_dir, 2, "claude", &mut result);

        // 2. Hermes (sessions/session_*.json — flat directory, JSON format)
        let hermes_dir = home.join(".hermes").join("sessions");
        find_hermes_sessions(hermes_dir, &mut result);

        // 4. OpenCode (storage/session/<project-id>/ses_*.json)
        let opencode_dir = home.join(".local").join("share").join("opencode");
        find_opencode_sessions(opencode_dir, &mut result);
    }

    result.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(result)
}

#[tauri::command]
fn tier_terminal_resume(
    session_id: String,
    saved_session_id: String, // The UUID of the new terminal tab
    tool: String,
    session_token: String,
    cols: u16,
    rows: u16,
    cwd: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {

    let preset = terminal::find_preset(&tool)
        .ok_or_else(|| format!("Unknown tool: {}", tool))?;
    let resume_program = preset.resume_program
        .ok_or_else(|| format!("Tool '{}' does not support resume", tool))?;

    // Validate session_token against the tool's token_format.
    // Prevents flag injection: "uuid --dangerously-skip-permissions" would fail this check.
    if let Some(fmt) = preset.token_format {
        let re = regex::Regex::new(fmt)
            .map_err(|e| format!("Invalid token format pattern: {e}"))?;
        if !re.is_match(&session_token) {
            return Err(format!("Invalid session token format for tool '{}'", tool));
        }
    }

    // Build args without string interpolation: token is always a separate element,
    // never concatenated into a command string that gets split by whitespace.
    let program = resume_program.to_string();
    let mut args: Vec<String> = preset.resume_args_before.iter().map(|s| s.to_string()).collect();
    args.push(session_token.clone());
    args.extend(preset.resume_args_after.iter().map(|s| s.to_string()));

    let actual_cwd = cwd.clone();
    let emit_session_id = saved_session_id.clone();

    terminal::spawn(
        app.clone(),
        saved_session_id,
        state.terminal_session.clone(),
        program,
        args,
        Some(cwd),
        "en".to_string(),
        cols,
        rows,
        Some(tool),
        None, // theme_mode: resume sessions use default detection
        None, // locale: resume sessions use env detection
    ).map_err(|e| format!("Failed to resume: {}", e))?;

    // Emit CWD so the left panel maps the resumed session's directory
    if !actual_cwd.is_empty() {
        #[derive(serde::Serialize, Clone)]
        struct CwdPayload { id: String, cwd: String }
        let _ = app.emit("tier-terminal-cwd", CwdPayload {
            id: emit_session_id,
            cwd: actual_cwd,
        });
    }

    // Remove from saved sessions file
    let path = sessions_file_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(mut saved) = serde_json::from_str::<Vec<SavedSession>>(&content) {
                saved.retain(|s| s.id != session_id);
                let _ = std::fs::write(&path, serde_json::to_string_pretty(&saved).unwrap_or_default());
            }
        }
    }

    Ok(())
}



// ─── Coffee Play (Arcade) ────────────────────────────────────────────────────

#[derive(Serialize)]
struct JsdosBundle {
    name: String,
    path: String,
    size: u64,
}

/// List all .jsdos game bundles in the `play` directory next to the executable
/// (or in the project root during development).
#[tauri::command]
fn list_jsdos_bundles() -> Vec<JsdosBundle> {
    let mut bundles = Vec::new();

    // Try several candidate directories:
    // 1. User data directory ~/.coffee-cli/play/ (production + development)
    // 2. Next to the executable (production)
    // 3. Current working directory / play (development)
    // 4. Source tree (development)
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Primary: user data directory (works on all platforms, all build modes)
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".coffee-cli").join("play"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("play"));
        }
    }
    candidates.push(PathBuf::from("play"));
    candidates.push(PathBuf::from("src-ui/public/play"));

    for play_dir in &candidates {
        if !play_dir.is_dir() { continue; }
        if let Ok(entries) = std::fs::read_dir(play_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e.to_ascii_lowercase()) == Some(std::ffi::OsString::from("jsdos")) {
                    if let Ok(meta) = entry.metadata() {
                        bundles.push(JsdosBundle {
                            name: entry.file_name().to_string_lossy().to_string(),
                            path: path.to_string_lossy().to_string(),
                            size: meta.len(),
                        });
                    }
                }
            }
        }
        if !bundles.is_empty() { break; } // Use first directory that has games
    }

    bundles
}

/// Read a .jsdos bundle file and return its raw bytes.
/// This allows the frontend to load local bundles without asset protocol.
#[tauri::command]
fn read_jsdos_bundle(path: String) -> Result<Vec<u8>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Bundle not found: {}", path));
    }
    if p.extension().map(|e| e.to_ascii_lowercase()) != Some(std::ffi::OsString::from("jsdos")) {
        return Err("Not a .jsdos file".to_string());
    }
    std::fs::read(p).map_err(|e| format!("Failed to read: {}", e))
}

/// Save a downloaded .jsdos bundle to the local play directory
#[tauri::command]
fn save_jsdos_bundle(name: String, data: Vec<u8>) -> Result<(), String> {
    let play_dir = dirs::home_dir()
        .ok_or_else(|| "Could not find home directory".to_string())?
        .join(".coffee-cli")
        .join("play");
    
    if !play_dir.exists() {
        std::fs::create_dir_all(&play_dir).map_err(|e| e.to_string())?;
    }
    
    let file_path = play_dir.join(name);
    std::fs::write(file_path, data).map_err(|e| e.to_string())
}

// ─── Terminal Buffer Replay (for detached windows) ───────────────────────────

#[tauri::command]
fn get_terminal_buffer(session_id: String, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let map = state.terminal_session.lock().map_err(|e| e.to_string())?;
    if let Some(session) = map.get(&session_id) {
        let buf = session.output_buffer.lock().map_err(|e| e.to_string())?;
        Ok(buf.clone())
    } else {
        Ok(vec![])
    }
}

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
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to save tasks: {}", e))?;
    // Notify all windows so other instances can reload
    let _ = app.emit("tasks-changed", &data);
    Ok(())
}

// ─── Credential Store (OS Keychain) ──────────────────────────────────────────

const KEYRING_SERVICE: &str = "coffee-cli";

/// Persist a remote password in the OS keychain (Windows Credential Manager /
/// macOS Keychain / Linux Secret Service). The key is `username@host`.
#[tauri::command]
fn save_password(host: String, username: String, password: String) -> Result<(), String> {
    let account = format!("{}@{}", username, host);
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .set_password(&password)
        .map_err(|e| e.to_string())
}

/// Load a previously saved password from the OS keychain.
/// Returns `None` if no entry exists (user hasn't saved one yet).
#[tauri::command]
fn load_password(host: String, username: String) -> Result<Option<String>, String> {
    let account = format!("{}@{}", username, host);
    match keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .get_password()
    {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove a saved password from the OS keychain (e.g. user clicked "forget").
#[tauri::command]
fn delete_password(host: String, username: String) -> Result<(), String> {
    let account = format!("{}@{}", username, host);
    match keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone, not an error
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

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
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

pub fn start_ui(project_dir: PathBuf) -> anyhow::Result<()> {
    // Create shared session BEFORE the builder so we can clone it for the exit handler
    let terminal_session = terminal::SharedSession::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            project_dir: Mutex::new(project_dir),
            terminal_session,
            hook_port: std::sync::atomic::AtomicU16::new(0),
            fs_watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            scan_project,
            pick_folder,
            window_minimize,
            window_maximize,
            window_close,
            show_main_window,
            create_detached_window,
            tier_terminal_start,
            tier_terminal_input,
            tier_terminal_raw_write,
            tier_terminal_kill,
            tier_terminal_resize,
            tier_terminal_resume,
            get_native_history,
            read_native_session,
            check_network_port,
            write_temp_script,
            check_tools_installed,
            start_fs_watcher,
            stop_fs_watcher,
            save_clipboard_image,
            list_drives,
            list_directory,
            show_in_folder,
            fs_delete,
            fs_rename,
            fs_paste,
            list_jsdos_bundles,
            read_jsdos_bundle,
            save_jsdos_bundle,
            get_terminal_buffer,
            load_tasks,
            save_tasks,
            save_password,
            load_password,
            delete_password,
            open_url,
            check_skill_installed,
            write_skill_file,
        ])
        .setup(|app| {
            // Install Claude/Qwen hook scripts + settings patches.
            // Runs once per launch; safe to call on a machine without either agent.
            crate::hook_installer::install_all();

            // Start loopback TCP listener that receives events from the hook
            // script and forwards them to the frontend as `agent-status` events.
            match crate::hook_server::start(app.handle().clone()) {
                Ok(port) => {
                    app.state::<AppState>()
                        .hook_port
                        .store(port, std::sync::atomic::Ordering::SeqCst);
                }
                Err(e) => {
                    eprintln!("[hook-server] start failed: {}", e);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!("Error while running tauri application: {}", e))?;

    Ok(())
}
