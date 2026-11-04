//! Pi desktop conversations: one `pi --mode rpc` runtime per Coffee tab.
//! Pi reads JSONL commands on stdin and writes responses, session events and extension
//! dialog requests on stdout; every tab owns its Session through `--session-id`.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Write}, path::Path, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc}, time::Duration};
use tauri::{Emitter, Manager, State};

type Reply = mpsc::Sender<Result<Value, String>>;
struct Session {
    generation: String,
    native_id: String,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Reply>>,
    /// Extension dialogs waiting for an answer, so a stale or repeated reply is refused.
    dialogs: Mutex<std::collections::HashSet<String>>,
    stderr: Mutex<String>,
}
#[derive(Default)]
pub struct PiSessions(Mutex<HashMap<String, Arc<Session>>>);

impl Session {
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        let input = input.as_mut().ok_or("Pi connection is closed")?;
        serde_json::to_writer(&mut *input, value).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    fn stop(&self) {
        // A blocked stdin writer must not prevent process termination.
        let _ = self.child.lock().unwrap().kill();
        // .cmd launchers own a child runtime; closing the pipe ends it too.
        if let Ok(mut input) = self.input.try_lock() { input.take(); }
    }
    fn request(&self, mut command: Value, timeout: Duration) -> Result<Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let kind = command["type"].as_str().unwrap_or("command").to_string();
        command["id"] = json!(id);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let result = self.write(&command).and_then(|_| rx.recv_timeout(timeout).map_err(|_| format!("Pi request timed out: {kind}"))?);
        self.pending.lock().unwrap().remove(&id);
        result
    }
    /// Routes one stdout record: responses settle their request, everything else is an event for the tab.
    fn receive(&self, record: Value) -> Option<Value> {
        if record["type"] == "response" {
            if let Some(reply) = record["id"].as_str().and_then(|id| self.pending.lock().unwrap().remove(id)) {
                let result = if record["success"] == true { Ok(record["data"].clone()) }
                    else { Err(record["error"].as_str().unwrap_or("Pi request failed").to_string()) };
                let _ = reply.send(result);
                return None;
            }
            // A parse failure has no id; there is nothing to settle.
            return None;
        }
        if record["type"] == "extension_ui_request" && DIALOGS.contains(&record["method"].as_str().unwrap_or("")) {
            if let Some(id) = record["id"].as_str() { self.dialogs.lock().unwrap().insert(id.to_string()); }
        }
        Some(record)
    }
}
/// Extension dialog methods that block Pi until the client answers.
const DIALOGS: [&str; 4] = ["select", "confirm", "input", "editor"];
/// Commands the conversation sends. Session switching, export and raw bash stay out of the webview's reach.
const COMMANDS: [&str; 15] = ["prompt", "steer", "follow_up", "abort", "get_state", "get_messages", "get_session_stats", "get_available_models",
    "get_available_thinking_levels", "set_model", "set_thinking_level", "compact", "get_commands", "set_session_name", "new_session"];

fn get(sessions: &PiSessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let s = sessions.0.lock().unwrap().get(id).cloned().ok_or("Pi session is not running")?;
    if s.generation != generation { return Err("Pi session has changed".into()); }
    Ok(s)
}
fn emit(app: &tauri::AppHandle, id: &str, session: &Session, event: Value) {
    // Worker results read only these; streaming deltas need not take the coordinator's lock.
    if matches!(event["type"].as_str(), Some("message_end" | "agent_end" | "agent_settled")) { crate::orchestration::native_event(id, "pi", &session.generation, &event); }
    let _ = app.emit("pi-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}

fn find_on_path(bin: &str) -> Option<String> {
    #[cfg(windows)]
    let (path, names) = (crate::windows_path::terminal_path(), vec![format!("{bin}.cmd"), format!("{bin}.exe"), bin.to_string()]);
    #[cfg(not(windows))]
    let (path, names) = (std::env::var("PATH").unwrap_or_default(), vec![bin.to_string()]);
    std::env::split_paths(&path).flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| candidate.is_file()).map(|candidate| candidate.to_string_lossy().into_owned())
}

/// A command preset may hold terminal session flags; this client picks the Session itself.
fn rpc_args(args: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip = false;
    for arg in args {
        if std::mem::take(&mut skip) { continue; }
        match arg.as_str() {
            "-c" | "--continue" | "-r" | "--resume" | "--no-session" => {}
            "--session" | "--session-id" | "--fork" | "--mode" => skip = true,
            _ if arg.starts_with("--session=") || arg.starts_with("--session-id=") || arg.starts_with("--fork=") || arg.starts_with("--mode=") => {}
            _ => out.push(arg),
        }
    }
    out
}

/// The user's command override, then `pi` on PATH.
fn executable() -> Option<(String, Vec<String>)> {
    let (custom, args) = crate::tool_config::parse_command(&crate::tool_config::get("pi").command);
    let args = rpc_args(args);
    if let Some(custom) = custom.filter(|custom| custom != "pi") {
        if Path::new(&custom).is_absolute() { return Some((custom, args)); }
        return find_on_path(&custom).map(|bin| (bin, args.clone())).or(Some((custom, vec![])));
    }
    find_on_path("pi").map(|bin| (bin, args))
}

/// Pi session IDs: letters, numbers, `.`, `_` and `-`.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    let config = crate::tool_config::get("pi");
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    let resume_token = resume_token.filter(|t| !t.trim().is_empty());
    if resume_token.as_deref().is_some_and(|token| !valid_id(token)) { return Err("Invalid Pi session ID".into()); }
    let (bin, prefix) = executable().ok_or("Pi is not installed")?;
    // `--session-id` opens this folder's Session with the ID or creates it, so a tab restored before
    // its first message (no session file yet) still starts.
    let native_id = resume_token.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let lower = bin.to_ascii_lowercase();
        command = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut c = Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()));
            c.args(["/d", "/c", &bin]); c
        } else { Command::new(&bin) };
        command.creation_flags(0x08000000).env("PATH", crate::windows_path::terminal_path());
    }
    #[cfg(not(windows))]
    { command = Command::new(&bin); }
    command.args(&prefix).args(["--mode", "rpc", "--session-id", &native_id]).args(&config.extra_args)
        .current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("Could not start Pi: {e}")))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let (stdout, stderr, input) = (child.stdout.take().unwrap(), child.stderr.take().unwrap(), child.stdin.take().unwrap());
    let session = Arc::new(Session { generation, native_id, child: Mutex::new(child), input: Mutex::new(Some(input)), pending: Mutex::default(), dialogs: Mutex::default(), stderr: Mutex::new(String::new()) });
    {
        let sessions = app.state::<PiSessions>();
        let mut map = sessions.0.lock().unwrap();
        if map.contains_key(&id) { session.stop(); return Err("This tab already owns a Pi session".into()); }
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
        // RPC framing splits records on LF only, which `lines()` does; a stray CR is trimmed.
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(record) = serde_json::from_str::<Value>(line.trim_end_matches('\r')) {
                if let Some(event) = s.receive(record) { emit(&reader_app, &reader_id, &s, event); }
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
        for (_, tx) in s.pending.lock().unwrap().drain() { let _ = tx.send(Err("Pi process exited".into())); }
        crate::orchestration::native_exit(&watcher_id, "pi", &s.generation);
        let _ = watcher_app.emit("pi-session-event", json!({"id":watcher_id,"generation":s.generation,"event":{"type":"coffee_exit","code":code,"detail":s.stderr.lock().unwrap().as_str()}}));
        let sessions = watcher_app.state::<PiSessions>(); let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &s)) { map.remove(&watcher_id); }
    });
    let result = (|| {
        // The first answer waits for Pi to load its extensions, packages and models.
        let state = session.request(json!({"type":"get_state"}), Duration::from_secs(90))?;
        let models = session.request(json!({"type":"get_available_models"}), Duration::from_secs(30)).map(|data| data["models"].clone()).unwrap_or(json!([]));
        let messages = if resume_token.is_some() { session.request(json!({"type":"get_messages"}), Duration::from_secs(60)).map(|data| data["messages"].clone()).unwrap_or(json!([])) } else { json!([]) };
        Ok(json!({"sessionId":session.native_id,"cwd":cwd,"state":state,"models":models,"messages":messages}))
    })();
    if result.is_err() { session.stop(); }
    result.map_err(|error: String| {
        let detail = session.stderr.lock().unwrap().trim().to_string();
        if error.contains("exited") && !detail.is_empty() { detail } else { error }
    })
}

#[tauri::command]
pub async fn pi_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pi_session_request(sessions: State<'_, PiSessions>, id: String, generation: String, command: Value) -> Result<Value, String> {
    let kind = command["type"].as_str().unwrap_or("").to_string();
    if !COMMANDS.contains(&kind.as_str()) { return Err("Unsupported Pi command".into()); }
    let s = get(&sessions, &id, &generation)?;
    let message = command["message"].as_str().unwrap_or("").to_string();
    match kind.as_str() {
        "prompt" => crate::orchestration::native_input(&id, "pi", &s.generation, &message, &uuid::Uuid::new_v4().to_string(), None)?,
        "steer" | "follow_up" => { if message.trim().is_empty() { return Err("Message is empty".into()); } crate::orchestration::native_steer(&id, "pi", &s.generation, &message)?; }
        _ => {}
    }
    // A prompt answers once accepted; compaction runs a model request before answering.
    let timeout = Duration::from_secs(if kind == "compact" { 900 } else { 60 });
    tauri::async_runtime::spawn_blocking(move || s.request(command, timeout)).await.map_err(|e| e.to_string())?
}
/// Answers an extension dialog (`select`, `confirm`, `input`, `editor`).
#[tauri::command]
pub async fn pi_session_respond(sessions: State<'_, PiSessions>, id: String, generation: String, request_id: String, response: Value) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !s.dialogs.lock().unwrap().remove(&request_id) { return Err("This Pi request has ended".into()); }
        let mut record = json!({"type":"extension_ui_response","id":request_id});
        for key in ["value", "confirmed", "cancelled"] { if let Some(value) = response.get(key) { record[key] = value.clone(); } }
        s.write(&record)
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pi_session_close(sessions: State<'_, PiSessions>, id: String, generation: String) -> Result<(), String> {
    let session = {
        let mut map = sessions.0.lock().unwrap();
        if map.get(&id).is_some_and(|s| s.generation == generation) { map.remove(&id) } else { None }
    };
    if let Some(s) = session {
        crate::orchestration::native_stop(&id, "pi", &generation);
        tauri::async_runtime::spawn_blocking(move || s.stop()).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn shutdown(sessions: &PiSessions) {
    let sessions: Vec<_> = sessions.0.lock().unwrap().drain().map(|(_, session)| session).collect();
    for s in sessions { s.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_session_flags_are_dropped_from_presets() {
        let args = |list: &[&str]| rpc_args(list.iter().map(|s| s.to_string()).collect());
        assert_eq!(args(&["--continue", "--provider", "openai", "--session", "abc", "--model=gpt", "--mode", "json"]), ["--provider", "openai", "--model=gpt"]);
        assert_eq!(args(&["-r", "--session-id=x", "--no-session", "--fork", "f", "--thinking", "high"]), ["--thinking", "high"]);
    }
    #[test]
    fn session_ids_accept_only_pi_characters() {
        assert!(valid_id("01a1a55b-5840-722d-b93a-3172232f0e8b"));
        assert!(valid_id("my_session.2"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id("a b"));
        assert!(!valid_id(""));
    }
    #[test]
    fn responses_settle_requests_and_dialogs_are_tracked() {
        let session = Session { generation: "g".into(), native_id: "n".into(), child: Mutex::new(Command::new(if cfg!(windows) { "cmd" } else { "true" }).spawn().unwrap()), input: Mutex::new(None), pending: Mutex::default(), dialogs: Mutex::default(), stderr: Mutex::default() };
        let (tx, rx) = mpsc::channel();
        session.pending.lock().unwrap().insert("r1".into(), tx);
        assert!(session.receive(json!({"id":"r1","type":"response","command":"get_state","success":true,"data":{"ok":1}})).is_none());
        assert_eq!(rx.recv().unwrap().unwrap()["ok"], 1);
        let (tx, rx) = mpsc::channel();
        session.pending.lock().unwrap().insert("r2".into(), tx);
        session.receive(json!({"id":"r2","type":"response","command":"set_model","success":false,"error":"Model not found"}));
        assert_eq!(rx.recv().unwrap().unwrap_err(), "Model not found");
        assert!(session.receive(json!({"type":"response","command":"parse","success":false,"error":"bad"})).is_none());
        assert!(session.receive(json!({"type":"extension_ui_request","id":"d1","method":"confirm"})).is_some());
        assert!(session.receive(json!({"type":"extension_ui_request","id":"n1","method":"notify"})).is_some());
        assert!(session.dialogs.lock().unwrap().contains("d1") && !session.dialogs.lock().unwrap().contains("n1"));
        assert!(session.receive(json!({"type":"agent_start"})).is_some());
        session.stop();
    }
}
