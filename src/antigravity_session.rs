//! Antigravity's official ACP v1 stdio adapter. One owned `agy acp` per tab.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc, atomic::{AtomicUsize, Ordering}}, time::Duration};
use tauri::{Emitter, Manager, State};

type Reply = mpsc::Sender<Result<Value, String>>;
#[derive(Default)]
struct Protocol {
    pending: Mutex<HashMap<String, Reply>>,
    permissions: Mutex<HashMap<String, Value>>,
}
impl Protocol {
    fn receive(&self, record: Value) -> Option<Value> {
        if let Some(id) = record.get("id") {
            if record.get("method").is_none() {
                if let Some(tx) = self.pending.lock().unwrap().remove(&id.to_string()) {
                    let result = if let Some(error) = record.get("error") { Err(error["message"].as_str().unwrap_or("Antigravity request failed").to_string()) } else { Ok(record["result"].clone()) };
                    let _ = tx.send(result);
                }
                return None;
            }
            if record["method"] == "session/request_permission" { self.permissions.lock().unwrap().insert(id.to_string(), record.clone()); }
        }
        Some(record)
    }
    fn response(&self, request_id: &str, option_id: Option<&str>) -> Result<Value, String> {
        let mut requests = self.permissions.lock().unwrap();
        let record = requests.get(request_id).ok_or("This Antigravity request has ended")?;
        if let Some(option) = option_id {
            if !record["params"]["options"].as_array().is_some_and(|options| options.iter().any(|v| v["optionId"] == option)) { return Err("Unknown Antigravity permission option".into()); }
        }
        let response = json!({"jsonrpc":"2.0", "id":record["id"], "result":{"outcome":match option_id { Some(option) => json!({"outcome":"selected","optionId":option}), None => json!({"outcome":"cancelled"}) }}});
        requests.remove(request_id);
        Ok(response)
    }
}
struct Session {
    generation: String,
    native_id: Mutex<String>,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    protocol: Protocol,
    stderr: Mutex<String>,
    prompts: AtomicUsize,
}
#[derive(Default)]
pub struct AntigravitySessions(Mutex<HashMap<String, Arc<Session>>>);
impl Session {
    fn write(&self, record: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        let input = input.as_mut().ok_or("Antigravity connection is closed")?;
        serde_json::to_writer(&mut *input, record).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = json!(uuid::Uuid::new_v4().to_string());
        let (tx, rx) = mpsc::channel();
        self.protocol.pending.lock().unwrap().insert(id.to_string(), tx);
        let result = self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).and_then(|_| rx.recv_timeout(timeout).map_err(|_| format!("Antigravity request timed out: {method}"))?);
        self.protocol.pending.lock().unwrap().remove(&id.to_string());
        result
    }
    fn stop(&self) {
        // Reap even a duplicate startup whose watcher has not been installed yet.
        let mut child = self.child.lock().unwrap();
        if child.kill().is_ok() { let _ = child.wait(); }
        drop(child);
        if let Ok(mut input) = self.input.try_lock() { input.take(); }
    }
}
fn get(sessions: &AntigravitySessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let session = sessions.0.lock().unwrap().get(id).cloned().ok_or("Antigravity session is not running")?;
    if session.generation != generation { return Err("Antigravity session has changed".into()); }
    Ok(session)
}
fn emit(app: &tauri::AppHandle, id: &str, s: &Session, event: Value) {
    let _ = app.emit("antigravity-session-event", json!({"id":id,"generation":s.generation,"event":event}));
}
pub(crate) fn executable() -> Option<(String, Vec<String>)> {
    let (custom, args) = crate::tool_config::parse_command(&crate::tool_config::get("antigravity").command);
    if let Some(custom) = custom { return Some((custom, args)); }
    #[cfg(windows)]
    let path = crate::windows_path::terminal_path();
    #[cfg(not(windows))]
    let path = std::env::var("PATH").unwrap_or_default();
    let name = if cfg!(windows) { "agy.exe" } else { "agy" };
    let mut candidates: Vec<_> = std::env::split_paths(&path).map(|dir| dir.join(name)).collect();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin").join(name));
        #[cfg(windows)]
        if let Some(local) = std::env::var_os("LOCALAPPDATA") { candidates.push(std::path::PathBuf::from(local).join("agy/bin").join(name)); }
    }
    candidates.into_iter().find(|p| p.is_file()).map(|p| (p.to_string_lossy().into_owned(), args))
}
fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    let config = crate::tool_config::get("antigravity");
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    let (bin, prefix) = executable().ok_or("Antigravity CLI is not installed")?;
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
    command.args(prefix).arg("acp").args(&config.extra_args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("Could not start Antigravity: {e}"))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let (stdout, stderr, input) = (child.stdout.take().unwrap(), child.stderr.take().unwrap(), child.stdin.take().unwrap());
    let s = Arc::new(Session { generation, native_id: Mutex::default(), child: Mutex::new(child), input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::default(), prompts: AtomicUsize::new(0) });
    {
        let sessions = app.state::<AntigravitySessions>(); let mut map = sessions.0.lock().unwrap();
        if map.contains_key(&id) { s.stop(); return Err("This tab already owns an Antigravity session".into()); }
        map.insert(id.clone(), s.clone());
    }
    let reader = s.clone();
    std::thread::spawn(move || { for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        let mut tail = reader.stderr.lock().unwrap(); tail.push_str(&line); tail.push('\n');
        if tail.len() > 8192 { let cut = tail.char_indices().find(|(i, _)| *i >= tail.len() - 4096).map(|(i, _)| i).unwrap_or(0); tail.drain(..cut); }
    }});
    let reader = s.clone(); let reader_app = app.clone(); let reader_id = id.clone();
    std::thread::spawn(move || { for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            if record.get("id").is_some() && record.get("method").is_some() && record["method"] != "session/request_permission" {
                let _ = reader.write(&json!({"jsonrpc":"2.0","id":record["id"],"error":{"code":-32601,"message":"Client method not supported"}}));
            } else if let Some(event) = reader.protocol.receive(record) { emit(&reader_app, &reader_id, &reader, event); }
        }
    }});
    let watcher = s.clone(); let watcher_app = app.clone(); let watcher_id = id.clone();
    std::thread::spawn(move || {
        let code = loop { match watcher.child.lock().unwrap().try_wait() { Ok(Some(status)) => break status.code(), Err(_) => break None, _ => {} } std::thread::sleep(Duration::from_millis(150)); };
        for (_, tx) in watcher.protocol.pending.lock().unwrap().drain() { let _ = tx.send(Err("Antigravity process exited".into())); }
        watcher.protocol.permissions.lock().unwrap().clear();
        emit(&watcher_app, &watcher_id, &watcher, json!({"type":"coffee_exit","code":code,"detail":watcher.stderr.lock().unwrap().as_str()}));
        let sessions = watcher_app.state::<AntigravitySessions>(); let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &watcher)) { map.remove(&watcher_id); }
    });
    let result = (|| {
        s.request("initialize", json!({"protocolVersion":1,"clientInfo":{"name":"coffee-cli","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{}}), Duration::from_secs(60))?;
        let mut params = json!({"cwd":cwd,"mcpServers":[]});
        let resume = resume_token.filter(|v| !v.is_empty());
        if let Some(token) = &resume { params["sessionId"] = json!(token); }
        let mut result = s.request(if resume.is_some() { "session/load" } else { "session/new" }, params, Duration::from_secs(90))?;
        let native_id = resume.unwrap_or_else(|| result["sessionId"].as_str().unwrap_or_default().to_string());
        if native_id.is_empty() { return Err("Antigravity returned no session ID".into()); }
        *s.native_id.lock().unwrap() = native_id.clone(); result["sessionId"] = json!(native_id); Ok(result)
    })();
    if result.is_err() { s.stop(); }
    result
}
#[tauri::command]
pub async fn antigravity_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn antigravity_session_request(sessions: State<'_, AntigravitySessions>, id: String, generation: String, method: String, mut params: Value) -> Result<Value, String> {
    if !matches!(method.as_str(), "session/prompt" | "session/cancel" | "session/set_config_option" | "session/set_mode" | "session/set_model") { return Err("Unsupported Antigravity method".into()); }
    if !params.is_object() { return Err("Antigravity params must be an object".into()); }
    let s = get(&sessions, &id, &generation)?;
    params["sessionId"] = json!(s.native_id.lock().unwrap().as_str());
    tauri::async_runtime::spawn_blocking(move || {
        if method == "session/cancel" { return s.write(&json!({"jsonrpc":"2.0","method":method,"params":params})).map(|_| Value::Null); }
        if method == "session/prompt" { s.prompts.fetch_add(1, Ordering::SeqCst); }
        let result = s.request(&method, params, Duration::from_secs(if method == "session/prompt" { 3600 } else { 60 }));
        if method == "session/prompt" && s.prompts.fetch_sub(1, Ordering::SeqCst) == 1 { s.protocol.permissions.lock().unwrap().clear(); }
        result
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn antigravity_session_respond(sessions: State<'_, AntigravitySessions>, id: String, generation: String, request_id: String, option_id: Option<String>) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || s.write(&s.protocol.response(&request_id, option_id.as_deref())?)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn antigravity_session_close(sessions: State<'_, AntigravitySessions>, id: String, generation: String) -> Result<(), String> {
    let session = { let mut map = sessions.0.lock().unwrap(); if map.get(&id).is_some_and(|s| s.generation == generation) { map.remove(&id) } else { None } };
    if let Some(s) = session { tauri::async_runtime::spawn_blocking(move || s.stop()).await.map_err(|e| e.to_string())?; } Ok(())
}
pub fn shutdown(sessions: &AntigravitySessions) {
    for (_, s) in sessions.0.lock().unwrap().drain() { s.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permissions_preserve_numeric_ids_and_reject_stale_or_unknown_options() {
        let p = Protocol::default();
        p.receive(json!({"jsonrpc":"2.0","id":42,"method":"session/request_permission","params":{"options":[{"optionId":"allow-once"},{"optionId":"reject-once"}]}}));
        assert!(p.response("42", Some("invented")).is_err());
        let result = p.response("42", Some("reject-once")).unwrap();
        assert_eq!(result["id"], 42);
        assert_eq!(result["result"]["outcome"]["optionId"], "reject-once");
        assert!(p.response("42", Some("allow-once")).is_err());
    }
    #[test]
    fn replies_settle_only_the_matching_request() {
        let p = Protocol::default(); let (tx, rx) = mpsc::channel();
        p.pending.lock().unwrap().insert("\"request\"".into(), tx);
        assert!(p.receive(json!({"id":"other","result":{}})).is_none());
        p.receive(json!({"id":"request","error":{"code":-32000,"message":"Authentication required"}}));
        assert_eq!(rx.recv().unwrap().unwrap_err(), "Authentication required");
    }
}
