//! One local app-server connection per Coffee conversation tab.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::Duration};
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
                    let result = if let Some(error) = event.get("error") { Err(error["message"].as_str().unwrap_or("Codex request failed").to_string()) }
                        else { Ok(event["result"].clone()) };
                    let _ = reply.send(result);
                }
                return None;
            }
            self.requests.lock().unwrap().insert(id.to_string(), event.clone());
        }
        if event["method"] == "serverRequest/resolved" {
            self.requests.lock().unwrap().remove(&event["params"]["requestId"].to_string());
        } else if event["method"] == "turn/completed" {
            let turn = &event["params"]["turn"]["id"];
            self.requests.lock().unwrap().retain(|_, request| request["params"]["turnId"] != *turn);
        }
        Some(event)
    }
}
struct Session {
    generation: String,
    native_id: Mutex<String>,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    protocol: Protocol,
    stderr: Mutex<String>,
    launch_config: crate::tool_config::ToolConfigEntry,
    launch_cwd: std::path::PathBuf,
}
#[derive(Default)]
pub struct CodexSessions(Mutex<HashMap<String, Arc<Session>>>);

pub(crate) fn launch_context(app: &tauri::AppHandle, id: &str) -> Option<(crate::tool_config::ToolConfigEntry, String)> {
    let sessions = app.try_state::<CodexSessions>()?;
    let map = sessions.0.lock().ok()?;
    let session = map.get(id)?;
    Some((session.launch_config.clone(), session.launch_cwd.to_string_lossy().into_owned()))
}

impl Session {
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        let input = input.as_mut().ok_or("Codex connection is closed")?;
        serde_json::to_writer(&mut *input, value).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    fn stop(&self) {
        // A blocked stdin writer must not prevent process termination.
        let _ = self.child.lock().unwrap().kill();
        // Close an available protocol pipe too: .cmd launchers can own a child server.
        if let Ok(mut input) = self.input.try_lock() { input.take(); }
    }
    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = Value::String(uuid::Uuid::new_v4().to_string());
        let (tx, rx) = mpsc::channel();
        self.protocol.pending.lock().unwrap().insert(id.to_string(), tx);
        let result = self.write(&json!({"id":id,"method":method,"params":params})).and_then(|_| {
            rx.recv_timeout(Duration::from_secs(30)).map_err(|_| format!("Codex request timed out: {method}"))?
        });
        self.protocol.pending.lock().unwrap().remove(&id.to_string());
        result
    }
}
fn get(sessions: &CodexSessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let s = sessions.0.lock().unwrap().get(id).cloned().ok_or("Codex session is not running")?;
    if s.generation != generation { return Err("Codex session has changed".into()); }
    Ok(s)
}
fn emit(app: &tauri::AppHandle, id: &str, session: &Session, event: Value) {
    let _ = app.emit("codex-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}
fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    let config = crate::tool_config::get("codex");
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    if resume_token.as_ref().is_some_and(|token| uuid::Uuid::parse_str(token).is_err()) { return Err("Invalid Codex thread ID".into()); }
    let (custom, prefix) = crate::tool_config::parse_command(&config.command);
    let bin = custom.unwrap_or_else(|| "codex".into());
    #[cfg(windows)]
    let bin = {
        let path = crate::windows_path::terminal_path();
        if std::path::Path::new(&bin).is_absolute() { bin } else {
            path.split(';').flat_map(|dir| [format!("{bin}.exe"), format!("{bin}.cmd"), bin.clone()].map(|name| std::path::Path::new(dir).join(name)))
                .find(|path| path.is_file()).map(|path| path.to_string_lossy().into_owned()).unwrap_or(bin)
        }
    };
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
    command.args(prefix).args(&config.extra_args).args(["app-server", "--listen", "stdio://"])
        .current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("Could not start Codex: {e}")))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let input = child.stdin.take().unwrap();
    let session = Arc::new(Session { generation, native_id: Mutex::new(String::new()), child: Mutex::new(child), input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::new(String::new()), launch_config: config.clone(), launch_cwd: cwd.clone() });
    {
        let sessions = app.state::<CodexSessions>();
        let mut map = sessions.0.lock().unwrap();
        if map.contains_key(&id) { session.stop(); return Err("This tab already owns a Codex session".into()); }
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
        for (_, tx) in s.protocol.pending.lock().unwrap().drain() { let _ = tx.send(Err("Codex process exited".into())); }
        emit(&watcher_app, &watcher_id, &s, json!({"method":"coffee/exit","params":{"code":code,"detail":s.stderr.lock().unwrap().as_str()}}));
        let sessions = watcher_app.state::<CodexSessions>(); let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &s)) { map.remove(&watcher_id); }
    });
    let result = (|| {
        session.request("initialize", json!({"clientInfo":{"name":"coffee_cli","title":"Coffee CLI","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}))?;
        session.write(&json!({"method":"initialized","params":{}}))?;
        let models = session.request("model/list", json!({}))?;
        let mut thread = if let Some(token) = resume_token {
            session.request("thread/resume", json!({"threadId":token,"cwd":cwd,"excludeTurns":false}))?
        } else { session.request("thread/start", json!({"cwd":cwd}))? };
        *session.native_id.lock().unwrap() = thread["thread"]["id"].as_str().ok_or("Codex returned no thread ID")?.into();
        thread["models"] = models["data"].clone();
        Ok(thread)
    })();
    if result.is_err() { session.stop(); }
    result
}

#[tauri::command]
pub async fn codex_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn codex_session_request(sessions: State<'_, CodexSessions>, id: String, generation: String, method: String, params: Value) -> Result<Value, String> {
    if !matches!(method.as_str(), "turn/start" | "turn/interrupt" | "thread/items/list" | "thread/turns/list" | "thread/compact/start" | "review/start" | "skills/list" | "mcpServerStatus/list") { return Err("Unsupported Codex request".into()); }
    let s = get(&sessions, &id, &generation)?;
    if params["threadId"].as_str() != Some(s.native_id.lock().unwrap().as_str()) { return Err("Codex thread does not belong to this tab".into()); }
    tauri::async_runtime::spawn_blocking(move || s.request(&method, params)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn codex_session_respond(sessions: State<CodexSessions>, id: String, generation: String, request_id: Value, response: Value, reject: bool) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    let mut requests = s.protocol.requests.lock().unwrap();
    if !requests.contains_key(&request_id.to_string()) { return Err("This Codex request has ended".into()); }
    s.write(&if reject { json!({"id":request_id,"error":{"code":-32601,"message":"Request is not supported by this client"}}) } else { json!({"id":request_id,"result":response}) })?;
    requests.remove(&request_id.to_string());
    Ok(())
}
#[tauri::command]
pub fn codex_session_close(sessions: State<CodexSessions>, id: String, generation: String) {
    let mut map = sessions.0.lock().unwrap();
    if map.get(&id).is_some_and(|s| s.generation == generation) {
        if let Some(s) = map.remove(&id) { s.stop(); }
    }
}
pub fn shutdown(sessions: &CodexSessions) {
    for (_, s) in sessions.0.lock().unwrap().drain() { s.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_does_not_wait_for_a_busy_input_pipe() {
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/c", "pause"]).creation_flags(0x08000000);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "read line"]);
            command
        };
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let session = Arc::new(Session {
            generation: String::new(), native_id: Mutex::new(String::new()), child: Mutex::new(child),
            input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::new(String::new()),
            launch_config: Default::default(), launch_cwd: Default::default(),
        });
        let writing = session.input.lock().unwrap();
        let stopping = session.clone();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || { stopping.stop(); let _ = tx.send(()); });
        let stopped = rx.recv_timeout(Duration::from_secs(2)).is_ok();
        drop(writing);
        worker.join().unwrap();
        session.stop();
        session.child.lock().unwrap().wait().unwrap();
        assert!(stopped, "closing must not wait for a thread holding the input pipe");
        assert!(session.input.lock().unwrap().is_none());
    }

    #[test]
    fn responses_and_native_request_ids_remain_distinct() {
        let p = Protocol::default(); let (tx, rx) = mpsc::channel();
        p.pending.lock().unwrap().insert("\"request\"".into(), tx);
        assert!(p.receive(json!({"id":"request","result":{"ok":true}})).is_none());
        assert_eq!(rx.recv().unwrap().unwrap(), json!({"ok":true}));
        p.receive(json!({"id":7,"method":"item/fileChange/requestApproval","params":{"turnId":"a"}}));
        p.receive(json!({"id":"7","method":"item/fileChange/requestApproval","params":{"turnId":"b"}}));
        p.receive(json!({"method":"serverRequest/resolved","params":{"requestId":7}}));
        assert_eq!(p.requests.lock().unwrap().len(), 1);
        p.receive(json!({"method":"turn/completed","params":{"turn":{"id":"b"}}}));
        assert!(p.requests.lock().unwrap().is_empty());
    }
}
