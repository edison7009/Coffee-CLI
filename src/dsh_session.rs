//! DeepSeek Harness desktop conversations: one `dsh --profile sdk` runtime per Coffee tab.
//! The SDK speaks newline JSON-RPC over stdio and streams native Session events; the
//! user's own model routes come from their Desktop profile, read-only, through a patch overlay.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Read, Write}, path::{Path, PathBuf}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::Duration};
use tauri::{Emitter, Manager, State};

type Reply = mpsc::Sender<Result<Value, String>>;
#[derive(Default)]
struct Protocol {
    pending: Mutex<HashMap<String, Reply>>,
    requests: Mutex<HashMap<String, Value>>,
}
impl Protocol {
    fn receive(&self, event: Value) -> Option<Value> {
        if let Some(id) = event.get("id") {
            if event.get("method").is_none() {
                if let Some(reply) = self.pending.lock().unwrap().remove(&id.to_string()) {
                    let result = if let Some(error) = event.get("error") { Err(error["message"].as_str().unwrap_or("DeepSeek Harness request failed").to_string()) }
                        else { Ok(event["result"].clone()) };
                    let _ = reply.send(result);
                }
                return None;
            }
            self.requests.lock().unwrap().insert(id.to_string(), event.clone());
        } else if event["method"] == "user-question.cancelled" {
            let request = &event["params"]["requestId"];
            self.requests.lock().unwrap().retain(|_, pending| pending["params"]["requestId"] != *request);
        }
        Some(event)
    }
}
struct Session {
    generation: String,
    native_id: String,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    protocol: Protocol,
    stderr: Mutex<String>,
}
#[derive(Default)]
pub struct DshSessions(Mutex<HashMap<String, Arc<Session>>>);

impl Session {
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        let input = input.as_mut().ok_or("DeepSeek Harness connection is closed")?;
        serde_json::to_writer(&mut *input, value).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    fn stop(&self) {
        // A blocked stdin writer must not prevent process termination.
        let _ = self.child.lock().unwrap().kill();
        // .cmd launchers own a child runtime; closing the pipe ends it too.
        if let Ok(mut input) = self.input.try_lock() { input.take(); }
    }
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = Value::String(uuid::Uuid::new_v4().to_string());
        let (tx, rx) = mpsc::channel();
        self.protocol.pending.lock().unwrap().insert(id.to_string(), tx);
        let result = self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).and_then(|_| {
            rx.recv_timeout(timeout).map_err(|_| format!("DeepSeek Harness request timed out: {method}"))?
        });
        self.protocol.pending.lock().unwrap().remove(&id.to_string());
        result
    }
}
fn get(sessions: &DshSessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let s = sessions.0.lock().unwrap().get(id).cloned().ok_or("DeepSeek Harness session is not running")?;
    if s.generation != generation { return Err("DeepSeek Harness session has changed".into()); }
    Ok(s)
}
fn emit(app: &tauri::AppHandle, id: &str, session: &Session, event: Value) {
    let _ = app.emit("dsh-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}

fn dsh_home() -> PathBuf {
    std::env::var_os("DSH_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".dsh"))
}

/// The user's command override, then `dsh` on PATH, then the runtime bundled with DeepSeek Harness Desktop.
pub(crate) fn executable() -> Option<(String, Vec<String>)> {
    let (custom, args) = crate::tool_config::parse_command(&crate::tool_config::get("dsh").command);
    if let Some(custom) = custom { return Some((custom, args)); }
    #[cfg(windows)]
    let path = crate::windows_path::terminal_path();
    #[cfg(not(windows))]
    let path = std::env::var("PATH").unwrap_or_default();
    let names: &[&str] = if cfg!(windows) { &["dsh.cmd", "dsh.exe"] } else { &["dsh"] };
    for dir in std::env::split_paths(&path) {
        for name in names { let candidate = dir.join(name); if candidate.is_file() { return Some((candidate.to_string_lossy().into_owned(), args)); } }
    }
    let bundled = if cfg!(windows) {
        dirs::data_local_dir().map(|dir| dir.join(r"Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"))
    } else if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"))
    } else { None };
    bundled.filter(|p| p.is_file()).map(|p| (p.to_string_lossy().into_owned(), args))
}

/// Built-in routes of the SDK profile (`dsh-llm-deepseek`), shown alongside the user's own.
fn builtin_models() -> Vec<Value> {
    let efforts = json!(["off", "low", "high", "max"]);
    vec![
        json!({"provider":"deepseek-official","model":"deepseek-flash","name":"DeepSeek-V4.1-Flash","efforts":efforts}),
        json!({"provider":"deepseek-official","model":"deepseek-v4-pro","name":"DeepSeek-V4-Pro","efforts":efforts}),
    ]
}

struct Routes { patch: Option<PathBuf>, default: Option<(String, String)>, models: Vec<Value> }

/// Copies only the Desktop profile's model rows into a Coffee-owned patch, so the SDK runtime uses
/// the same providers and stored credentials without touching any DeepSeek Harness file.
fn desktop_routes(home: &Path, overlay: &Path) -> Routes {
    let mut routes = Routes { patch: None, default: None, models: builtin_models() };
    let Ok(text) = std::fs::read_to_string(home.join("profiles/desktop/cordis.patch.yml")) else { return routes };
    let Ok(serde_yaml_ng::Value::Sequence(rows)) = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&text) else { return routes };
    let id = |row: &serde_yaml_ng::Value| row.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let kept: Vec<_> = rows.into_iter().filter(|row| { let id = id(row); id == "agent-default-model" || id.starts_with("llm-") }).collect();
    for row in &kept {
        let Ok(row) = serde_json::to_value(row) else { continue };
        if row["id"] == "agent-default-model" {
            if let (Some(provider), Some(model)) = (row["config"]["provider"].as_str(), row["config"]["model"].as_str()) { routes.default = Some((provider.into(), model.into())); }
        }
        for (provider, entry) in row["config"]["providers"].as_object().into_iter().flatten() {
            for model in entry["models"].as_array().into_iter().flatten() {
                let Some(model_id) = model["id"].as_str() else { continue };
                let efforts: Vec<&String> = model["reasoningEfforts"].as_object().map(|e| e.keys().collect()).unwrap_or_default();
                routes.models.push(json!({"provider":provider,"model":model_id,"name":model["name"].as_str().unwrap_or(model_id),"efforts":efforts}));
            }
        }
    }
    if kept.is_empty() { return routes; }
    let written = std::fs::create_dir_all(overlay.parent().unwrap_or(overlay)).ok()
        .and_then(|_| serde_yaml_ng::to_string(&kept).ok())
        .and_then(|yaml| std::fs::write(overlay, format!("# Generated by Coffee CLI from the DeepSeek Harness Desktop profile; model rows only.\n{yaml}")).ok());
    if written.is_some() { routes.patch = Some(overlay.to_path_buf()); }
    routes
}

fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>, route: Option<Value>) -> Result<Value, String> {
    let config = crate::tool_config::get("dsh");
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    let (bin, prefix) = executable().ok_or("DeepSeek Harness is not installed")?;
    let home = dsh_home();
    let routes = desktop_routes(&home, &dirs::home_dir().unwrap_or_default().join(".coffee-cli/dsh/desktop-routes.patch.yml"));
    let mut command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command = if bin.to_ascii_lowercase().ends_with(".cmd") || bin.to_ascii_lowercase().ends_with(".bat") {
            let mut c = Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()));
            c.args(["/d", "/c", &bin]); c
        } else { Command::new(&bin) };
        command.creation_flags(0x08000000).env("PATH", crate::windows_path::terminal_path());
    }
    #[cfg(not(windows))]
    { command = Command::new(&bin); }
    command.args(prefix).args(["--profile", "sdk"]);
    if let Some(patch) = &routes.patch { command.arg("--patch").arg(patch); }
    command.args(&config.extra_args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("Could not start DeepSeek Harness: {e}")))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let input = child.stdin.take().unwrap();
    let native_id = resume_token.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("session-{}", uuid::Uuid::new_v4()));
    let session = Arc::new(Session { generation, native_id, child: Mutex::new(child), input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::new(String::new()) });
    {
        let sessions = app.state::<DshSessions>();
        let mut map = sessions.0.lock().unwrap();
        if map.contains_key(&id) { session.stop(); return Err("This tab already owns a DeepSeek Harness session".into()); }
        map.insert(id.clone(), session.clone());
    }
    let s = session.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut tail = s.stderr.lock().unwrap(); tail.push_str(&line); tail.push('\n');
            if tail.len() > 8192 { let cut = tail.char_indices().find(|(i, _)| *i >= tail.len() - 4096).map(|(i, _)| i).unwrap_or(0); tail.drain(..cut); }
        }
    });
    let s = session.clone(); let reader_app = app.clone(); let reader_id = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                if let Some(event) = s.protocol.receive(event) { emit(&reader_app, &reader_id, &s, event); }
            }
        }
    });
    let s = session.clone(); let watcher_app = app.clone(); let watcher_id = id.clone();
    std::thread::spawn(move || {
        let code = loop {
            // Release the process lock before sleeping so close can kill immediately.
            let status = s.child.lock().unwrap().try_wait();
            match status {
                Ok(Some(status)) => break status.code(), Err(_) => break None,
                _ => std::thread::sleep(Duration::from_millis(150)),
            }
        };
        for (_, tx) in s.protocol.pending.lock().unwrap().drain() { let _ = tx.send(Err("DeepSeek Harness process exited".into())); }
        emit(&watcher_app, &watcher_id, &s, json!({"method":"coffee/exit","params":{"code":code,"detail":s.stderr.lock().unwrap().as_str()}}));
        let sessions = watcher_app.state::<DshSessions>(); let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &s)) { map.remove(&watcher_id); }
    });
    let requested = route.unwrap_or(Value::Null);
    let (provider, model) = match (requested["provider"].as_str(), requested["model"].as_str()) {
        (Some(provider), Some(model)) => (provider.to_string(), model.to_string()),
        _ => routes.default.clone().unwrap_or_else(|| ("deepseek-official".into(), "deepseek-flash".into())),
    };
    let effort = requested["effort"].as_str().filter(|e| !e.is_empty()).map(String::from);
    let result = (|| {
        let mut params = json!({"cwd":cwd,"provider":provider,"model":model,"approvalRequests":true,"capabilities":{"userQuestions":true}});
        if let Some(effort) = &effort { params["reasoningEffort"] = json!(effort); }
        // Initialization waits for the plugin tree, including MCP discovery; first launch also prepares the profile.
        session.request("initialize", params, Duration::from_secs(180))?;
        if resume_token.is_some() { session.request("session/resume", json!({"sessionId":session.native_id}), Duration::from_secs(120))?; }
        Ok(json!({"sessionId":session.native_id,"cwd":cwd,"route":{"provider":provider,"model":model,"effort":effort},"models":routes.models}))
    })();
    if result.is_err() { session.stop(); }
    result
}

#[tauri::command]
pub async fn dsh_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>, route: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token, route)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dsh_session_request(sessions: State<'_, DshSessions>, id: String, generation: String, method: String, params: Value) -> Result<Value, String> {
    if !matches!(method.as_str(), "session/prompt" | "session/query" | "session/working-directory/get") { return Err("Unsupported DeepSeek Harness request".into()); }
    let s = get(&sessions, &id, &generation)?;
    // Requests always address this tab's own Session.
    let mut params = params; params["sessionId"] = json!(s.native_id);
    // Commands such as /compact run an auxiliary model request before answering.
    let timeout = Duration::from_secs(if method == "session/query" { 900 } else { 60 });
    tauri::async_runtime::spawn_blocking(move || s.request(&method, params, timeout)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dsh_session_respond(sessions: State<'_, DshSessions>, id: String, generation: String, request_id: Value, result: Value) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut requests = s.protocol.requests.lock().unwrap();
        if !requests.contains_key(&request_id.to_string()) { return Err("This DeepSeek Harness request has ended".into()); }
        s.write(&json!({"jsonrpc":"2.0","id":request_id,"result":result}))?;
        requests.remove(&request_id.to_string());
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dsh_session_close(sessions: State<'_, DshSessions>, id: String, generation: String) -> Result<(), String> {
    let session = {
        let mut map = sessions.0.lock().unwrap();
        if map.get(&id).is_some_and(|s| s.generation == generation) { map.remove(&id) } else { None }
    };
    if let Some(s) = session {
        tauri::async_runtime::spawn_blocking(move || s.stop()).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn shutdown(sessions: &DshSessions) {
    let sessions: Vec<_> = sessions.0.lock().unwrap().drain().map(|(_, session)| session).collect();
    for s in sessions { s.stop(); }
}

/// The newest-format log of one persisted Session, wherever its workspace folder is.
fn session_log(home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || session_id.contains(['/', '\\']) || session_id.contains("..") { return None; }
    std::fs::read_dir(home.join("sessions")).ok()?.flatten()
        .filter_map(|workspace| std::fs::read_dir(workspace.path().join(session_id)).ok())
        .flat_map(|entries| entries.flatten().map(|entry| entry.path()))
        .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|name| name.starts_with("session.v") && (name.ends_with(".jsonl.zstd") || name.ends_with(".jsonl"))))
        .max_by_key(|path| path.file_name().and_then(|n| n.to_str()).and_then(|name| name.trim_start_matches("session.v").split('.').next()?.parse::<u32>().ok()).unwrap_or(0))
}

/// Decodes a concatenated-frame zstd log; a torn final frame (a write in progress) keeps every complete row.
fn read_log(path: &Path) -> Result<Vec<Value>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut text = Vec::new();
    if path.extension().is_some_and(|e| e == "zstd") {
        let mut decoder = zstd::stream::read::Decoder::new(bytes.as_slice()).map_err(|e| e.to_string())?;
        let mut chunk = [0u8; 64 * 1024];
        loop { match decoder.read(&mut chunk) { Ok(0) | Err(_) => break, Ok(n) => text.extend_from_slice(&chunk[..n]) } }
    } else { text = bytes; }
    let text = String::from_utf8_lossy(&text);
    // Only newline-terminated rows are complete.
    let complete = text.rfind('\n').map(|end| &text[..end]).unwrap_or("");
    Ok(complete.lines().filter_map(|line| serde_json::from_str(line).ok()).collect())
}

#[tauri::command]
pub async fn dsh_session_history(session_id: String) -> Result<Vec<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || match session_log(&dsh_home(), &session_id) { Some(path) => read_log(&path), None => Ok(Vec::new()) })
        .await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_routes_keep_only_model_rows_and_list_their_models() {
        let root = std::env::temp_dir().join(format!("coffee-dsh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("profiles/desktop")).unwrap();
        std::fs::write(root.join("profiles/desktop/cordis.patch.yml"), "- id: agent-default-model\n  config:\n    provider: relay\n    model: auto\n- id: ui-chat\n  config:\n    transcriptView: standard\n- id: llm-pi-ai\n  config:\n    providers:\n      relay:\n        apiKeyEnv: RELAY_KEY\n        models:\n          - id: auto\n            name: Relay Auto\n            reasoningEfforts:\n              high: high\n              low: low\n").unwrap();
        let overlay = root.join("out/routes.patch.yml");
        let routes = desktop_routes(&root, &overlay);
        assert_eq!(routes.default, Some(("relay".into(), "auto".into())));
        assert!(routes.models.iter().any(|m| m["provider"] == "relay" && m["name"] == "Relay Auto"));
        assert!(routes.models.iter().any(|m| m["model"] == "deepseek-flash"));
        let written = std::fs::read_to_string(&overlay).unwrap();
        assert!(written.contains("llm-pi-ai") && written.contains("agent-default-model") && !written.contains("ui-chat"));
        assert!(!desktop_routes(&root.join("missing"), &root.join("none.yml")).patch.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn logs_decode_concatenated_frames_and_drop_a_torn_tail() {
        let root = std::env::temp_dir().join(format!("coffee-dsh-log-{}", uuid::Uuid::new_v4()));
        let dir = root.join("sessions/--D-repo--/session-1"); std::fs::create_dir_all(&dir).unwrap();
        let mut bytes = zstd::encode_all(&b"{\"type\":\"session\",\"id\":\"session-1\"}\n"[..], 3).unwrap();
        bytes.extend(zstd::encode_all(&b"{\"type\":\"user/message\",\"seq\":1}\n{\"type\":\"turn/end\",\"seq\":2}\n"[..], 3).unwrap());
        let torn = zstd::encode_all(&b"{\"type\":\"assistant/message\",\"seq\":3}\n"[..], 3).unwrap();
        bytes.extend(&torn[..torn.len() / 2]);
        std::fs::write(dir.join("session.v4.jsonl.zstd"), &bytes).unwrap();
        let path = session_log(&root, "session-1").unwrap();
        let rows = read_log(&path).unwrap();
        assert_eq!(rows.iter().map(|r| r["type"].as_str().unwrap()).collect::<Vec<_>>(), ["session", "user/message", "turn/end"]);
        assert!(session_log(&root, "../escape").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn question_cancellation_retires_its_pending_request() {
        let p = Protocol::default();
        p.receive(json!({"id":5,"method":"user-question/ask","params":{"requestId":"q1"}}));
        p.receive(json!({"id":6,"method":"approval/request","params":{"sessionId":"s"}}));
        p.receive(json!({"method":"user-question.cancelled","params":{"requestId":"q1"}}));
        assert_eq!(p.requests.lock().unwrap().len(), 1);
    }
}
