use crate::git_intel;
use crate::scanner;
use crate::watcher;
use crate::terminal;
use crate::translation;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{State, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;

/// Shared app state
pub struct AppState {
    pub project_dir: Mutex<PathBuf>,
    pub watcher_tx: Mutex<std::sync::mpsc::Sender<PathBuf>>,
    pub terminal_session: terminal::SharedSession,
    pub translation_engine: std::sync::Arc<translation::TranslationEngine>,
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

#[derive(Serialize)]
struct ModelInfo {
    name: String,
    model_id: String,
    base_url: String,
    configured: bool,
}

#[derive(Deserialize)]
struct ModelConfig {
    name: String,
    #[serde(rename = "modelId")]
    model_id: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "apiKey", default)]
    api_key: String,
}

#[derive(Serialize)]
struct GitStatusResponse {
    files_changed: usize,
    insertions: usize,
    deletions: usize,
}

// Helper: highly naive fallback replacing trailing commas
fn strip_trailing_commas(s: &str) -> String {
    let mut res = s.to_string();
    // 粗略处理 JSON 尾随逗号的问题，不依赖 regex
    res = res.replace(",\n}", "\n}");
    res = res.replace(",\n]", "\n]");
    res = res.replace(",\r\n}", "\r\n}");
    res = res.replace(",\r\n]", "\r\n]");
    res = res.replace(", }", " }");
    res = res.replace(", ]", " ]");
    res
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

        if let Ok(tx) = state.watcher_tx.lock() {
            let _ = tx.send(new_dir.clone());
        }

        // Save last directory for next launch
        if let Some(home) = dirs::home_dir() {
            let rc_dir = home.join(".coffee-cli");
            let _ = std::fs::create_dir_all(&rc_dir);
            let last_dir_file = rc_dir.join("last_dir.txt");
            let _ = std::fs::write(&last_dir_file, &p);
        }
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
fn get_model(_state: State<'_, AppState>) -> Result<ModelInfo, String> {
    let models_path = dirs::home_dir()
        .ok_or_else(|| "Cannot determine home directory".to_string())?
        .join(".coffee-cli")
        .join("models.json");

    let content = std::fs::read_to_string(&models_path)
        .map_err(|_| "models.json not found".to_string())?;

    let cleaned = strip_trailing_commas(&content);

    let model: ModelConfig = serde_json::from_str::<ModelConfig>(&cleaned)
        .or_else(|_| {
            serde_json::from_str::<Vec<ModelConfig>>(&cleaned)
                .map(|v| v.into_iter().next().unwrap_or_else(|| ModelConfig {
                    name: "Not configured".to_string(),
                    model_id: String::new(),
                    base_url: String::new(),
                    api_key: String::new(),
                }))
        })
        .map_err(|e| format!("Failed to parse models.json: {}", e))?;

    Ok(ModelInfo {
        name: model.name,
        model_id: model.model_id,
        base_url: model.base_url,
        configured: !model.api_key.is_empty(),
    })
}

#[tauri::command]
fn get_git_status(state: State<'_, AppState>) -> Result<Option<GitStatusResponse>, String> {
    let dir = state.project_dir.lock().map_err(|e| e.to_string())?;
    Ok(git_intel::get_git_status_summary(dir.as_ref()).map(|(fc, ins, del)| {
        GitStatusResponse {
            files_changed: fc,
            insertions: ins,
            deletions: del,
        }
    }))
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
        // Main window: close entire application (including island + all detached)
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
        .unwrap_or_default()
        .as_millis();
    let label = format!("detached-{}", ts);

    let window = tauri::WebviewWindowBuilder::new(
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

    #[cfg(debug_assertions)]
    window.open_devtools();

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

#[tauri::command]
fn check_tools_installed() -> std::collections::HashMap<String, bool> {
    let tools = vec![
        ("claude", "claude"),
        ("codex", "codex"),
        ("gemini", "gemini-cli"),
        ("openclaw", "openclaw"),
        ("coffee-code", "coffee-code"),
        // remote is always available — it's just SSH (built into the OS)
    ];
    let mut result = std::collections::HashMap::new();
    for (key, bin) in tools {
        let found = if cfg!(target_os = "windows") {
            std::process::Command::new("where")
                .arg(bin)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        } else {
            std::process::Command::new("which")
                .arg(bin)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        result.insert(key.to_string(), found);
    }
    // Terminal is always available — it's the system shell
    result.insert("terminal".to_string(), true);
    result
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

// ─── File System Operations ───────────────────────────────────────────────────

/// Open the native file explorer and highlight / reveal the given path.
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    #[cfg(target_os = "windows")]
    {
        // explorer /select, highlights the item in its parent folder
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R") // Reveal in Finder
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Open the parent directory; most Linux file managers don't support select
        let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().unwrap_or(p).to_path_buf() };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }
    Ok(())
}

/// Delete a file or directory permanently (no recycle bin).
#[tauri::command]
fn fs_delete(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("Delete failed: {e}"))
    } else {
        std::fs::remove_file(p).map_err(|e| format!("Delete failed: {e}"))
    }
}

/// Rename / move a path to a new name within the same parent directory.
#[tauri::command]
fn fs_rename(path: String, new_name: String) -> Result<(), String> {
    let src = std::path::Path::new(&path);
    let dest = src.parent()
        .ok_or_else(|| "No parent directory".to_string())?
        .join(&new_name);
    std::fs::rename(src, dest).map_err(|e| format!("Rename failed: {e}"))
}

/// Paste (copy or move) a file/directory into a target directory.
/// `action` is either "copy" or "cut".
#[tauri::command]
fn fs_paste(action: String, src_path: String, target_dir: String) -> Result<(), String> {
    let src = std::path::Path::new(&src_path);
    let file_name = src.file_name().ok_or("Invalid source path")?;
    let dest = std::path::Path::new(&target_dir).join(file_name);

    match action.as_str() {
        "cut" => {
            std::fs::rename(&src, &dest).map_err(|e| format!("Move failed: {e}"))
        }
        "copy" => {
            if src.is_dir() {
                copy_dir_all(src, &dest).map_err(|e| format!("Copy dir failed: {e}"))
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = state.project_dir.lock().map_err(|e| e.to_string())?.clone();

    // Map the requested tool to an actual CLI command.
    let (cmd, args): (String, Vec<String>) = match tool.as_deref() {
        Some("claude")   => ("claude".to_string(), vec![]),
        Some("codex")    => ("codex".to_string(),  vec![]),
        Some("gemini")   => ("gemini-cli".to_string(), vec![]),
        Some("openclaw") => ("openclaw".to_string(), vec![]),
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
        Some("coffee-code") => {
            let found = if cfg!(target_os = "windows") {
                std::process::Command::new("where")
                    .arg("coffee-code")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            } else {
                std::process::Command::new("which")
                    .arg("coffee-code")
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            };

            if found {
                ("coffee-code".to_string(), vec![])
            } else {
                return Err("COFFEE_CODE_NOT_INSTALLED".to_string());
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

    // Detect tool from command for translation dictionary selection
    state.translation_engine.detect_tool_from_command(&cmd);

    let tool_name = tool.clone();

    eprintln!("[Tier Terminal] Starting tool={:?}, cmd={}, args={:?}, cwd={:?}", tool, cmd, args, dir);

    terminal::spawn(
        app,
        session_id,
        state.terminal_session.clone(),
        state.translation_engine.clone(),
        cmd,
        args,
        Some(dir.to_string_lossy().to_string()),
        "en".to_string(),
        cols,
        rows,
        tool_name,
        theme_mode,
        locale,
    ).map_err(|e| format!("Failed to spawn PTY: {}", e))?;

    Ok(())
}


#[tauri::command]
fn set_translation_lang(
    lang: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.translation_engine.set_lang(&lang);
    Ok(())
}

/// Export translation entries for the CoffeeOverlay renderer.
/// Returns pattern-translation pairs for the given tool and language.
#[tauri::command]
fn get_translation_entries(
    tool: String,
    lang: String,
    state: State<'_, AppState>,
) -> Vec<(String, String)> {
    state.translation_engine.get_entries_for_frontend(&tool, &lang)
}

#[tauri::command]
fn tier_terminal_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut map = state.terminal_session.lock().unwrap();
    if let Some(session) = map.get_mut(&session_id) {
        use std::io::Write;
        session.writer.write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        session.writer.flush()
            .map_err(|e| format!("Flush failed: {}", e))?;

        // ── Dual-signal: detect user prompt submission ────────────────────
        // Only trigger "working" when user presses Enter while agent is at prompt.
        // System-generated input (auto-skip) uses tier_terminal_raw_write instead.
        if data.contains('\r') || data.contains('\n') {
            if let Ok(mut act) = session.activity.lock() {
                if act.last_status == "wait_input" {
                    act.user_submitted_at = Some(std::time::Instant::now());
                }
            }
        }

        Ok(())
    } else {
        Err(format!("No active terminal session for id: {}", session_id))
    }
}

/// Raw write to PTY without triggering agent-status detection.
/// Used for system-generated input like auto-skip Enter for Claude trust prompt.
#[tauri::command]
fn tier_terminal_raw_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut map = state.terminal_session.lock().unwrap();
    if let Some(session) = map.get_mut(&session_id) {
        use std::io::Write;
        session.writer.write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {}", e))?;
        session.writer.flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    } else {
        Err(format!("No active terminal session for id: {}", session_id))
    }
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
}

fn sessions_file_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".coffee-cli");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("sessions.json")
}

fn parse_claude_jsonl(file_path: &std::path::Path) -> Option<SavedSession> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id = file_path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = String::new();
    let mut updated_at = String::new();
    let mut title = String::new();

    for line in reader.lines().map_while(Result::ok) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(s) = value.get("sessionId").and_then(|v| v.as_str()) {
                if !s.is_empty() { session_id = s.to_string(); }
            }
            if let Some(c) = value.get("cwd").and_then(|v| v.as_str()) {
                if cwd.is_empty() && !c.is_empty() { cwd = c.to_string(); }
            }
            if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
                if title.is_empty() && !message.is_empty() {
                    let mut chars = message.chars();
                    let t: String = chars.by_ref().take(40).collect();
                    title = if chars.next().is_some() { format!("{}...", t) } else { t };
                }
            }
        }
    }
    
    // Fallback date from file metadata
    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                updated_at = dur.as_millis().to_string();
            }
        }
    }

    if title.is_empty() {
        title = "Claude Session".to_string();
    }

    Some(SavedSession {
        id: format!("claude_native_{}", session_id),
        name: title,
        tool: "claude".to_string(),
        cwd,
        session_token: Some(session_id),
        saved_at: updated_at,
    })
}

#[tauri::command]
fn get_resumable_sessions(_state: State<'_, AppState>) -> Result<Vec<SavedSession>, String> {
    let mut result: Vec<SavedSession> = Vec::new();
    let path = sessions_file_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(saved) = serde_json::from_str::<Vec<SavedSession>>(&content) {
                result = saved;
            }
        }
    }
    Ok(result)
}

#[tauri::command]
fn get_native_history(_state: State<'_, AppState>) -> Result<Vec<SavedSession>, String> {
    let mut result: Vec<SavedSession> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        let projects_dir = home.join(".claude").join("projects");
        if projects_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(projects_dir) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        if let Ok(files) = std::fs::read_dir(entry.path()) {
                            for file in files.flatten() {
                                let fpath = file.path();
                                if fpath.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                                    if let Some(session) = parse_claude_jsonl(&fpath) {
                                        result.push(session);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = state.project_dir.lock().map_err(|e| e.to_string())?.clone();

    let preset = terminal::find_preset(&tool)
        .ok_or_else(|| format!("Unknown tool: {}", tool))?;
    let resume_cmd = preset.resume_command
        .ok_or_else(|| format!("Tool '{}' does not support resume", tool))?;

    // Replace {{sessionId}} placeholder
    let full_cmd = resume_cmd.replace("{{sessionId}}", &session_token);
    let parts: Vec<&str> = full_cmd.split_whitespace().collect();
    if parts.is_empty() {
        return Err("Empty resume command".to_string());
    }

    let program = parts[0].to_string();
    let args: Vec<String> = parts[1..].iter().map(|s| s.to_string()).collect();

    state.translation_engine.detect_tool_from_command(&program);

    terminal::spawn(
        app,
        saved_session_id,
        state.terminal_session.clone(),
        state.translation_engine.clone(),
        program,
        args,
        Some(dir.to_string_lossy().to_string()),
        "en".to_string(),
        cols,
        rows,
        Some(tool),
        None, // theme_mode: resume sessions use default detection
        None, // locale: resume sessions use env detection
    ).map_err(|e| format!("Failed to resume: {}", e))?;

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

/// Save all live sessions with captured tokens to disk
fn save_sessions(session: &terminal::SharedSession) {
    let map = session.lock().unwrap();
    let mut saved: Vec<SavedSession> = Vec::new();

    for (id, sess) in map.iter() {
        let token = sess.session_token.lock().ok().and_then(|t| t.clone());
        if let (Some(tool), Some(token)) = (&sess.tool_name, token) {
            // Only save if tool supports resume
            if let Some(preset) = terminal::find_preset(tool) {
                if preset.resume_command.is_some() {
                    saved.push(SavedSession {
                        id: id.clone(),
                        name: tool.clone(),
                        tool: tool.clone(),
                        cwd: String::new(), // CWD tracked on frontend
                        session_token: Some(token),
                        saved_at: format!("{:?}", std::time::SystemTime::now()),
                    });
                }
            }
        }
    }

    // Merge with existing saved sessions that weren't resumed
    let path = sessions_file_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(existing) = serde_json::from_str::<Vec<SavedSession>>(&content) {
                let live_ids: std::collections::HashSet<String> = saved.iter().map(|s| s.id.clone()).collect();
                for e in existing {
                    if !live_ids.contains(&e.id) {
                        saved.push(e);
                    }
                }
            }
        }
    }

    let _ = std::fs::write(&path, serde_json::to_string_pretty(&saved).unwrap_or_default());
    if !saved.is_empty() {
        eprintln!("[Session] Saved {} resumable session(s)", saved.len());
    }
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
    let path = tasks_file_path();
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to save tasks: {}", e))?;
    // Notify all windows so other instances can reload
    let _ = app.emit("tasks-changed", &data);
    Ok(())
}


pub fn start_ui(project_dir: PathBuf) -> anyhow::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let abs_dir = std::fs::canonicalize(&project_dir).unwrap_or_else(|_| project_dir.clone());
    let _ = tx.send(abs_dir);

    // Initialize translation engine with user's dictionaries
    let dict_dir = translation::dictionaries_dir()
        .unwrap_or_else(|| PathBuf::from("."));
    let engine = translation::TranslationEngine::load(&dict_dir, "en");

    // Create shared session BEFORE the builder so we can clone it for the exit handler
    let terminal_session = terminal::SharedSession::default();
    let terminal_session_for_exit = terminal_session.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            project_dir: Mutex::new(project_dir),
            watcher_tx: Mutex::new(tx),
            terminal_session,
            translation_engine: engine,
        })
        .invoke_handler(tauri::generate_handler![
            scan_project,
            get_model,
            get_git_status,
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
            get_resumable_sessions,
            get_native_history,
            set_translation_lang,

            get_translation_entries,
            check_tools_installed,
            list_drives,
            list_directory,
            show_in_folder,
            fs_delete,
            fs_rename,
            fs_paste,
            list_jsdos_bundles,
            get_terminal_buffer,
            load_tasks,
            save_tasks,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            watcher::start_watcher(app.handle().clone(), rx);

            Ok(())
        })
        .on_window_event({
            let terminal_session = terminal_session_for_exit.clone();
            move |_window, event| {
                if let tauri::WindowEvent::Destroyed = event {
                    save_sessions(&terminal_session);
                }
            }
        })
        .run(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!("Error while running tauri application: {}", e))?;

    Ok(())
}
