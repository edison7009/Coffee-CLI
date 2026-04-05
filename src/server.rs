use crate::git_intel;
use crate::scanner;
use crate::watcher;
use crate::terminal;
use crate::translation;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{State, Manager};
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
            let rc_dir = home.join(".CoffeeMode");
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
        .join(".CoffeeMode")
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
fn window_close(app: tauri::AppHandle) {
    // Close entire application (main window + island overlay)
    app.exit(0);
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
        // freecode is always available — it's a bundled sidecar binary
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
    // Bundled sidecar — always available
    result.insert("freecode".to_string(), true);
    result
}

// ─── Tier Terminal API ────────────────────────────────────────────────────────

#[tauri::command]
fn tier_terminal_start(
    session_id: String,
    tool: Option<String>,
    cols: u16,
    rows: u16,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = state.project_dir.lock().map_err(|e| e.to_string())?.clone();
    
    // Map the requested tool to an actual CLI command.
    // portable-pty handles ConPTY + environment properly, no shell wrapper needed.
    let (cmd, args): (String, Vec<String>) = match tool.as_deref() {
        Some("claude") => ("claude".to_string(), vec![]),
        Some("codex")  => ("codex".to_string(),  vec![]),
        Some("gemini") => ("gemini-cli".to_string(), vec![]),
        Some("openclaw") => ("openclaw".to_string(), vec![]),
        Some("freecode") => {
            // Strategy: bundled sidecar binary > claude in PATH
            // When bundled binary exists, use it (pre-built free-code).
            // Otherwise, fall back to the standard claude CLI.
            let sidecar_name = if cfg!(target_os = "windows") {
                "free-code.exe"
            } else {
                "free-code"
            };
            let bundled_path = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|p| p.join(sidecar_name)))
                .filter(|p| p.exists());
            match bundled_path {
                Some(path) => (path.to_string_lossy().to_string(), vec![]),
                None => {
                    // Fall back to claude CLI (same engine, different branding)
                    ("claude".to_string(), vec![])
                }
            }
        },
        _ => if cfg!(target_os = "windows") {
            ("powershell.exe".to_string(), vec!["-NoExit".to_string()])
        } else {
            ("bash".to_string(), vec!["-l".to_string(), "-i".to_string()])
        }
    };

    {
        let lock = state.terminal_session.lock().unwrap();
        if lock.contains_key(&session_id) {
            return Ok(()); // Session already running
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
        .join(".CoffeeMode");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("sessions.json")
}

#[tauri::command]
fn get_resumable_sessions(state: State<'_, AppState>) -> Result<Vec<SavedSession>, String> {
    // Also include live sessions that have captured tokens
    let mut result: Vec<SavedSession> = Vec::new();

    // Load from persisted file
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
            tier_terminal_start,
            tier_terminal_input,
            tier_terminal_raw_write,
            tier_terminal_kill,
            tier_terminal_resume,
            get_resumable_sessions,
            set_translation_lang,
            get_translation_entries,
            check_tools_installed,
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
