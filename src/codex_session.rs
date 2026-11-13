//! One local app-server connection per Coffee conversation tab.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Read, Seek, SeekFrom, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::Duration};
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
    id: String,
    generation: String,
    native_id: Mutex<String>,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    protocol: Protocol,
    stderr: Mutex<String>,
}
#[derive(Default)]
pub struct CodexSessions(Mutex<HashMap<String, Arc<Session>>>);

impl Session {
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        let input = input.as_mut().ok_or("Codex connection is closed")?;
        if value["method"] == "turn/start" {
            let prompt = value["params"]["input"].as_array().into_iter().flatten().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
            crate::orchestration::native_input(&self.id, "codex", &self.generation, &prompt, value["id"].as_str().unwrap_or(""), None)?;
        } else if value["method"] == "turn/steer" {
            let prompt = value["params"]["input"].as_array().into_iter().flatten().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
            crate::orchestration::native_steer(&self.id, "codex", &self.generation, &prompt)?;
        } else if value["method"] == "turn/interrupt" {
            crate::orchestration::native_stop(&self.id, "codex", &self.generation);
        }
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
    if event["params"]["threadId"].as_str().is_none_or(|thread| thread == session.native_id.lock().unwrap().as_str()) {
        crate::orchestration::native_event(id, "codex", &session.generation, &event);
    }
    let _ = app.emit("codex-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}
fn codex_home() -> std::path::PathBuf {
    std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".codex"))
}

/// A new thread continuing an idle one starts from a pointer instead of its history. Only a rollout of
/// that thread under Codex's own home is accepted, since the path comes back through the webview.
fn previous_rollout(from: &Value, home: &std::path::Path) -> Option<String> {
    let token = from["token"].as_str().filter(|token| uuid::Uuid::parse_str(token).is_ok())?;
    // Threads do not always report their rollout path, so it is looked up by thread ID.
    let path = match from["path"].as_str().filter(|path| !path.is_empty()) {
        Some(path) => std::path::PathBuf::from(path),
        None => find_rollout(&home.join("sessions"), token, 4)?,
    }.canonicalize().ok()?;
    let inside = path.starts_with(home.canonicalize().ok()?) && path.is_file() && path.file_name()?.to_string_lossy().contains(token);
    inside.then(|| crate::claude_session::previous_conversation_text(token, &dunce::simplified(&path), from))
}

fn find_rollout(dir: &std::path::Path, token: &str, depth: u8) -> Option<std::path::PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        if path.is_dir() { if depth > 0 { find_rollout(&path, token, depth - 1) } else { None } }
        else { path.file_name()?.to_string_lossy().contains(token).then_some(path) }
    })
}

/// Tokens the latest request carried, from the tail of the rollout; 0 when it is unknown or was compacted since.
fn last_context_tokens(path: &std::path::Path) -> u64 {
    const TAIL: u64 = 2 * 1024 * 1024;
    let Ok(mut file) = std::fs::File::open(path) else { return 0 };
    let start = file.metadata().map(|meta| meta.len().saturating_sub(TAIL)).unwrap_or(0);
    let mut text = String::new();
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_end(&mut bytes).is_err() { return 0; }
    text.push_str(&String::from_utf8_lossy(&bytes));
    for line in text.lines().rev() {
        if !line.contains("token_count") && !line.contains("compacted") { continue; }
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        if row["type"] == "compacted" || row["payload"]["type"] == "context_compacted" { return 0; }
        if row["payload"]["type"] == "token_count" {
            if let Some(tokens) = row["payload"]["info"]["last_token_usage"]["input_tokens"].as_u64() { return tokens; }
        }
    }
    0
}

fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>, continue_from: Option<Value>) -> Result<Value, String> {
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
    let session = Arc::new(Session { id: id.clone(), generation, native_id: Mutex::new(String::new()), child: Mutex::new(child), input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::new(String::new()) });
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
        session.request("initialize", json!({"clientInfo":{"name":"coffee_cli","title":"Coffee CLI","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))?;
        session.write(&json!({"method":"initialized","params":{}}))?;
        let models = session.request("model/list", json!({}))?;
        let mut thread = if let Some(token) = resume_token {
            session.request("thread/resume", json!({"threadId":token,"cwd":cwd,"excludeTurns":false}))?
        } else {
            let mut params = json!({"cwd":cwd});
            if let Some(pointer) = continue_from.as_ref().and_then(|from| previous_rollout(from, &codex_home())) { params["developerInstructions"] = json!(pointer); }
            session.request("thread/start", params)?
        };
        thread["lastContextTokens"] = json!(thread["thread"]["path"].as_str().map(|path| last_context_tokens(std::path::Path::new(path))).unwrap_or(0));
        *session.native_id.lock().unwrap() = thread["thread"]["id"].as_str().ok_or("Codex returned no thread ID")?.into();
        thread["models"] = models["data"].clone();
        Ok(thread)
    })();
    if result.is_err() { session.stop(); }
    result
}

#[tauri::command]
pub async fn codex_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>, continue_from: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token, continue_from)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn codex_session_request(sessions: State<'_, CodexSessions>, id: String, generation: String, method: String, params: Value) -> Result<Value, String> {
    if !matches!(method.as_str(), "turn/start" | "turn/steer" | "turn/interrupt" | "thread/items/list" | "thread/turns/list" | "thread/compact/start" | "review/start" | "skills/list" | "mcpServerStatus/list" | "account/rateLimits/read" | "collaborationMode/list") { return Err("Unsupported Codex request".into()); }
    let s = get(&sessions, &id, &generation)?;
    // Account usage and mode discovery do not address a thread.
    let threadless = matches!(method.as_str(), "account/rateLimits/read" | "collaborationMode/list");
    let params = if threadless { json!({}) } else { params };
    if !threadless && params["threadId"].as_str() != Some(s.native_id.lock().unwrap().as_str()) { return Err("Codex thread does not belong to this tab".into()); }
    tauri::async_runtime::spawn_blocking(move || s.request(&method, params)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn codex_session_respond(sessions: State<'_, CodexSessions>, id: String, generation: String, request_id: Value, response: Value, reject: bool) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut requests = s.protocol.requests.lock().unwrap();
        if !requests.contains_key(&request_id.to_string()) { return Err("This Codex request has ended".into()); }
        s.write(&if reject { json!({"id":request_id,"error":{"code":-32601,"message":"Request is not supported by this client"}}) } else { json!({"id":request_id,"result":response}) })?;
        requests.remove(&request_id.to_string());
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn codex_session_close(sessions: State<'_, CodexSessions>, id: String, generation: String) -> Result<(), String> {
    let session = {
        let mut map = sessions.0.lock().unwrap();
        if map.get(&id).is_some_and(|s| s.generation == generation) { map.remove(&id) } else { None }
    };
    if let Some(s) = session {
        tauri::async_runtime::spawn_blocking(move || s.stop()).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn shutdown(sessions: &CodexSessions) {
    let sessions: Vec<_> = sessions.0.lock().unwrap().drain().map(|(_, session)| session).collect();
    for s in sessions { s.stop(); }
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
            id: "test".into(), generation: String::new(), native_id: Mutex::new(String::new()), child: Mutex::new(child),
            input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::new(String::new()),
           
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
    fn rollouts_report_context_and_only_their_own_thread_is_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let token = "11111111-1111-4111-8111-111111111111";
        let path = dir.path().join(format!("rollout-2026-{token}.jsonl"));
        let usage = |tokens: u64| json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":tokens}}}}).to_string();
        std::fs::write(&path, format!("{}\n{}\npartial", usage(5), usage(446000))).unwrap();
        assert_eq!(last_context_tokens(&path), 446000);
        std::fs::write(&path, format!("{}\n{}\n", usage(446000), json!({"type":"compacted","payload":{}}))).unwrap();
        assert_eq!(last_context_tokens(&path), 0, "compaction replaces the history");
        assert_eq!(last_context_tokens(&dir.path().join("missing.jsonl")), 0);
        let from = |path: &std::path::Path, token: &str| json!({"token":token,"path":path.to_string_lossy(),"prompt":"Earlier"});
        assert!(previous_rollout(&from(&path, token), dir.path()).unwrap().contains("rollout-2026"));
        assert!(previous_rollout(&from(&path, "22222222-2222-4222-8222-222222222222"), dir.path()).is_none(), "another thread's file");
        assert!(previous_rollout(&from(&path, token), &dir.path().join("elsewhere")).is_none());
        let dated = dir.path().join("sessions/2026/10/31");
        std::fs::create_dir_all(&dated).unwrap();
        std::fs::write(dated.join(format!("rollout-{token}.jsonl")), "").unwrap();
        assert!(previous_rollout(&json!({"token":token,"prompt":"Earlier"}), dir.path()).unwrap().contains("sessions"), "a thread without a reported path is found by ID");
        let other = tempfile::tempdir().unwrap();
        assert!(previous_rollout(&from(&path, token), other.path()).is_none(), "outside Codex's home");
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
