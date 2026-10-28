//! Claude's bidirectional stream-json host. One owner per Coffee tab; no PTY scraping.
use serde_json::{json, Value};
use base64::Engine;
use std::{collections::HashMap, io::{BufRead, BufReader, Read, Seek, SeekFrom, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::Duration};
use tauri::{Emitter, Manager, State};

type Reply = mpsc::Sender<Result<Value, String>>;

struct Session {
    id: String,
    generation: String,
    native_id: String,
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, Reply>>,
    permissions: Mutex<HashMap<String, Value>>,
    stderr: Mutex<String>,
    history_path: std::path::PathBuf,
    launch_config: crate::tool_config::ToolConfigEntry,
    launch_cwd: std::path::PathBuf,
}

#[derive(Default)]
pub struct ClaudeSessions(Mutex<HashMap<String, Arc<Session>>>);

pub(crate) fn launch_context(app: &tauri::AppHandle, id: &str) -> Option<(crate::tool_config::ToolConfigEntry, String)> {
    let sessions = app.try_state::<ClaudeSessions>()?;
    let map = sessions.0.lock().ok()?;
    let session = map.get(id)?;
    Some((session.launch_config.clone(), session.launch_cwd.to_string_lossy().into_owned()))
}

impl Session {
    fn write(&self, value: &Value) -> Result<(), String> {
        self.write_with_delivery(value, None)
    }
    fn write_with_delivery(&self, value: &Value, delivery: Option<&str>) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        if value["type"] == "user" {
            let prompt = value["message"]["content"].as_array().into_iter().flatten().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
            crate::orchestration::native_input(&self.id, "claude", &self.generation, &prompt, value["uuid"].as_str().unwrap_or(""), delivery)?;
        } else if value["request"]["subtype"] == "interrupt" {
            crate::orchestration::native_stop(&self.id, "claude", &self.generation);
        }
        serde_json::to_writer(&mut *input, value).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }

    fn request(&self, request: Value) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        if let Err(error) = self.write(&json!({"type":"control_request","request_id":id,"request":request})) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let result = rx.recv_timeout(Duration::from_secs(60)).map_err(|_| "Claude 控制请求超时，请检查进程或连接".to_string());
        self.pending.lock().unwrap().remove(&id);
        result?
    }
}

fn get(sessions: &ClaudeSessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let session = sessions.0.lock().unwrap().get(id).cloned().ok_or("Claude 会话未启动")?;
    if session.generation != generation { return Err("Claude 会话已更换".into()); }
    Ok(session)
}

fn emit(app: &tauri::AppHandle, id: &str, session: &Session, event: Value) {
    crate::orchestration::native_event(id, "claude", &session.generation, &event);
    let _ = app.emit("claude-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}

fn executable(config: &crate::tool_config::ToolConfigEntry) -> (String, Vec<String>) {
    let (custom, args) = crate::tool_config::parse_command(&config.command);
    if let Some(custom) = custom { return (custom, args); }
    if let Some(home) = dirs::home_dir() {
        let native = home.join(".local/bin").join(if cfg!(windows) { "claude.exe" } else { "claude" });
        if native.is_file() { return (native.to_string_lossy().into_owned(), args); }
    }
    #[cfg(windows)]
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["claude.exe", "claude.cmd"] {
                let candidate = dir.join(name);
                if candidate.is_file() { return (candidate.to_string_lossy().into_owned(), args); }
            }
        }
    }
    ("claude".into(), args)
}

fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    let config = crate::tool_config::get("claude");
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    let (bin, prefix) = executable(&config);
    let mut command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command = if bin.to_ascii_lowercase().ends_with(".cmd") {
            let mut cmd = Command::new("cmd.exe"); cmd.args(["/d", "/c", &bin]); cmd
        } else { Command::new(&bin) };
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    { command = Command::new(&bin); }
    command.args(prefix).args(&config.extra_args)
        .args(["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--allow-dangerously-skip-permissions"])
        .env_remove("CLAUDECODE").env("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1")
        .current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let resume_token = resume_token.filter(|s| !s.is_empty());
    let is_resume = resume_token.is_some();
    let native_id = resume_token.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if uuid::Uuid::parse_str(&native_id).is_err() { return Err("无效的 Claude 会话 ID".into()); }
    // A known token resumes an idle native session; a fresh token is chosen before the first prompt.
    let history_path = claude_history_path(&cwd, &native_id);
    if is_resume { command.args(["--resume", &native_id]); }
    else { command.args(["--session-id", &native_id]); }
    if let Some((mcp, prompt)) = crate::orchestration::parent_launch(&app, &id, &native_id, &cwd)? {
        command.args(["--mcp-config", &mcp, "--append-system-prompt", &prompt]);
    }
    let mut child = command.spawn().map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("无法启动 Claude：{e}")))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let input = child.stdin.take().unwrap();
    let session = Arc::new(Session { id: id.clone(), generation, native_id, child: Mutex::new(child), input: Mutex::new(input), pending: Mutex::new(HashMap::new()), permissions: Mutex::new(HashMap::new()), stderr: Mutex::new(String::new()), history_path, launch_config: config.clone(), launch_cwd: cwd.clone() });
    let sessions = app.state::<ClaudeSessions>();
    {
        let mut map = sessions.0.lock().unwrap();
        if map.contains_key(&id) { let _ = session.child.lock().unwrap().kill(); return Err("该标签已拥有 Claude 会话".into()); }
        map.insert(id.clone(), session.clone());
    }
    let s = session.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut tail = s.stderr.lock().unwrap();
            tail.push_str(&line); tail.push('\n');
            if tail.len() > 8192 { let cut = tail.char_indices().find(|(i, _)| *i >= tail.len() - 4096).map(|(i, _)| i).unwrap_or(0); tail.drain(..cut); }
        }
    });
    let s = session.clone(); let app_reader = app.clone(); let reader_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            if event["type"] == "control_response" {
                if let Some(request_id) = event["response"]["request_id"].as_str() {
                    if let Some(tx) = s.pending.lock().unwrap().remove(request_id) {
                        let response = &event["response"];
                        let result = if response["subtype"] == "success" { Ok(response["response"].clone()) }
                            else { Err(response["error"].as_str().unwrap_or("Claude 拒绝了控制请求").into()) };
                        let _ = tx.send(result);
                    }
                }
                continue;
            }
            if event["type"] == "control_request" {
                if let Some(request_id) = event["request_id"].as_str() { s.permissions.lock().unwrap().insert(request_id.into(), event["request"].clone()); }
            } else if event["type"] == "control_cancel_request" {
                if let Some(request_id) = event["request_id"].as_str() { s.permissions.lock().unwrap().remove(request_id); }
            }
            emit(&app_reader, &reader_id, &s, event);
        }
    });
    let s = session.clone(); let app_watcher = app.clone(); let watcher_id = id.clone();
    std::thread::spawn(move || {
        let status = loop {
            // Release the process lock before sleeping so close can kill immediately.
            let status = s.child.lock().unwrap().try_wait();
            match status {
                Ok(Some(status)) => break Some(status),
                Err(_) => break None,
                _ => std::thread::sleep(Duration::from_millis(200)),
            }
        };
        for (_, tx) in s.pending.lock().unwrap().drain() { let _ = tx.send(Err("Claude 进程已退出".into())); }
        emit(&app_watcher, &watcher_id, &s, json!({"type":"coffee_exit","code":status.and_then(|s| s.code()),"detail":s.stderr.lock().unwrap().as_str()}));
        let sessions = app_watcher.state::<ClaudeSessions>();
        let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &s)) { map.remove(&watcher_id); }
    });
    match session.request(json!({"subtype":"initialize"})) {
        Ok(initialization) => {
            // Native JSONL is only a restoration source. Live UI always consumes stdout events.
            let history = history_page(&session.history_path, None).unwrap_or_else(|_| json!({"data":"","cursor":0}));
            Ok(json!({"sessionId":session.native_id,"initialization":initialization,"history":history,"bypassAvailable":true}))
        },
        Err(error) => { let _ = session.child.lock().unwrap().kill(); Err(error) }
    }
}

fn claude_history_path(cwd: &std::path::Path, native_id: &str) -> std::path::PathBuf {
    let root = std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".claude"));
    let key: String = cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    root.join("projects").join(key).join(format!("{native_id}.jsonl"))
}

fn history_page(path: &std::path::Path, before: Option<u64>) -> Result<Value, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let end = before.unwrap_or(file.metadata().map_err(|e| e.to_string())?.len());
    let start = end.saturating_sub(512 * 1024);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(end - start).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let skip = if start > 0 { bytes.iter().position(|b| *b == b'\n').map(|i| i + 1).unwrap_or(bytes.len()) } else { 0 };
    // A very large single record must still make backward progress.
    Ok(json!({"data":String::from_utf8_lossy(&bytes[skip..]),"cursor":if skip == bytes.len() { start } else { start + skip as u64 }}))
}

#[tauri::command]
pub async fn claude_session_history(sessions: State<'_, ClaudeSessions>, id: String, generation: String, before: u64) -> Result<Value, String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || history_page(&s.history_path, Some(before))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_session_send(sessions: State<'_, ClaudeSessions>, id: String, generation: String, text: String, orchestration_delivery: Option<String>) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    if text.trim().is_empty() { return Err("消息不能为空".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let content = if orchestration_delivery.is_some() { json!([{"type":"text","text":text}]) } else { user_content(&text)? };
        s.write_with_delivery(&json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"session_id":s.native_id,"parent_tool_use_id":null,"message":{"role":"user","content":content}}), orchestration_delivery.as_deref())
    }).await.map_err(|e| e.to_string())?
}

fn user_content(text: &str) -> Result<Value, String> {
    let paths = regex::Regex::new(r#"(?i)"((?:[a-z]:[\\/]|/)[^"\r\n]+\.(?:png|jpe?g|gif|webp))"|((?:[a-z]:[\\/]|/)[^\s"<>]+\.(?:png|jpe?g|gif|webp))"#).unwrap();
    let mut content = vec![json!({"type":"text","text":text})];
    let mut seen = std::collections::HashSet::new();
    for capture in paths.captures_iter(text) {
        let path = capture.get(1).or_else(|| capture.get(2)).unwrap().as_str();
        if !seen.insert(path) { continue; }
        let path = std::path::Path::new(path);
        let Ok(metadata) = path.metadata() else { continue };
        if metadata.len() > 20 * 1024 * 1024 { return Err("图片超过 20 MiB，请缩小后重试".into()); }
        let bytes = std::fs::read(path).map_err(|e| format!("无法读取图片：{e}"))?;
        let extension = path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
        let media = if extension == "jpg" || extension == "jpeg" { "image/jpeg".into() } else { format!("image/{extension}") };
        content.push(json!({"type":"image","source":{"type":"base64","media_type":media,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
    }
    Ok(Value::Array(content))
}

#[tauri::command]
pub async fn claude_session_control(sessions: State<'_, ClaudeSessions>, id: String, generation: String, request: Value) -> Result<Value, String> {
    if !matches!(request["subtype"].as_str(), Some("set_model" | "set_permission_mode" | "apply_flag_settings" | "interrupt" | "get_settings" | "set_max_thinking_tokens")) { return Err("不支持的 Claude 控制请求".into()); }
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || s.request(request)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_session_respond(sessions: State<'_, ClaudeSessions>, id: String, generation: String, request_id: String, response: Value) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !s.permissions.lock().unwrap().contains_key(&request_id) { return Err("该请求已结束".into()); }
        s.write(&json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}}))?;
        s.permissions.lock().unwrap().remove(&request_id);
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_session_close(sessions: State<'_, ClaudeSessions>, id: String, generation: String) -> Result<(), String> {
    let session = {
        let mut map = sessions.0.lock().unwrap();
        if map.get(&id).is_some_and(|s| s.generation == generation) { map.remove(&id) } else { None }
    };
    if let Some(s) = session {
        tauri::async_runtime::spawn_blocking(move || { let _ = s.child.lock().unwrap().kill(); }).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn shutdown(sessions: &ClaudeSessions) {
    let sessions: Vec<_> = sessions.0.lock().unwrap().drain().map(|(_, session)| session).collect();
    for session in sessions { let _ = session.child.lock().unwrap().kill(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_pages_preserve_complete_rows_across_boundaries() {
        let path = std::env::temp_dir().join(format!("coffee-claude-{}.jsonl", uuid::Uuid::new_v4()));
        let data: String = (0..700).map(|id| format!("{}\n", json!({"id":id,"text":"字".repeat(500)}))).collect();
        std::fs::write(&path, data).unwrap();
        let mut cursor = None;
        let mut ids = std::collections::HashSet::new();
        loop {
            let page = history_page(&path, cursor).unwrap();
            for line in page["data"].as_str().unwrap().lines() {
                let row: Value = serde_json::from_str(line).unwrap();
                assert!(ids.insert(row["id"].as_u64().unwrap()), "duplicate history row");
            }
            let next = page["cursor"].as_u64().unwrap();
            if next == 0 { break; }
            assert!(cursor.is_none_or(|previous| next < previous));
            cursor = Some(next);
        }
        assert_eq!(ids.len(), 700);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn images_with_spaces_are_attached_once_without_changing_prompt() {
        let path = std::env::temp_dir().join(format!("coffee image {}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, [137, 80, 78, 71]).unwrap();
        let prompt = format!("Look at \"{}\" and \"{}\"", path.display(), path.display());
        let content = user_content(&prompt).unwrap();
        assert_eq!(content.as_array().unwrap().len(), 2);
        assert_eq!(content[0]["text"], prompt);
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "iVBORw==");
        std::fs::remove_file(path).unwrap();
    }
}
