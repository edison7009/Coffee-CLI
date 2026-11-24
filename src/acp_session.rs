//! Desktop conversations over ACP v1 (Agent Client Protocol) on stdio, for every tool that speaks it: one
//! owned `<tool> <acp args>` per tab. Antigravity's `agy acp` came first; the other tools take the arguments
//! the official ACP registry (cdn.agentclientprotocol.com) lists for them, on the binary Coffee CLI already detects.
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
                    let result = if let Some(error) = record.get("error") { Err(error["message"].as_str().unwrap_or("ACP request failed").to_string()) } else { Ok(record["result"].clone()) };
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
        let record = requests.get(request_id).ok_or("This request has ended")?;
        if let Some(option) = option_id {
            if !record["params"]["options"].as_array().is_some_and(|options| options.iter().any(|v| v["optionId"] == option)) { return Err("Unknown permission option".into()); }
        }
        let response = json!({"jsonrpc":"2.0", "id":record["id"], "result":{"outcome":match option_id { Some(option) => json!({"outcome":"selected","optionId":option}), None => json!({"outcome":"cancelled"}) }}});
        requests.remove(request_id);
        Ok(response)
    }
}
struct Session {
    tool: String,
    generation: String,
    native_id: Mutex<String>,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    protocol: Protocol,
    stderr: Mutex<String>,
    prompts: AtomicUsize,
}
#[derive(Default)]
pub struct AcpSessions(Mutex<HashMap<String, Arc<Session>>>);
impl Session {
    fn write(&self, record: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        let input = input.as_mut().ok_or("The ACP connection is closed")?;
        serde_json::to_writer(&mut *input, record).map_err(|e| e.to_string())?;
        input.write_all(b"\n").and_then(|_| input.flush()).map_err(|e| e.to_string())
    }
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = json!(uuid::Uuid::new_v4().to_string());
        let (tx, rx) = mpsc::channel();
        self.protocol.pending.lock().unwrap().insert(id.to_string(), tx);
        let result = self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).and_then(|_| rx.recv_timeout(timeout).map_err(|_| format!("ACP request timed out: {method}"))?);
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
fn get(sessions: &AcpSessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let session = sessions.0.lock().unwrap().get(id).cloned().ok_or("This desktop session is not running")?;
    if session.generation != generation { return Err("This desktop session has changed".into()); }
    Ok(session)
}
fn emit(app: &tauri::AppHandle, id: &str, s: &Session, event: Value) {
    let _ = app.emit("acp-session-event", json!({"id":id,"tool":s.tool,"generation":s.generation,"event":event}));
}
/// The arguments that start each tool's ACP server, as the official ACP registry lists them. A tool missing
/// here has no desktop conversation.
pub(crate) fn acp_args(tool: &str) -> Option<&'static [&'static str]> {
    Some(match tool {
        "antigravity" | "cursor" | "muse" | "goose" | "kilo" | "kimicode" => &["acp"],
        "kiro" => &["acp", "--agent-engine=v3"],
        "grok" => &["agent", "stdio"],
        "cline" | "codebuddy" | "copilot" => &["--acp"],
        "qwen" => &["--acp", "--experimental-skills"],
        _ => return None,
    })
}
/// The tool's program and any arguments before the ACP ones: its custom command in tool settings, else the
/// binary Coffee CLI detects for it (on the terminal PATH, or ~/.local/bin where installers often put it).
pub(crate) fn executable(tool: &str) -> Option<(String, Vec<String>)> {
    acp_args(tool)?;
    let (custom, args) = crate::tool_config::parse_command(&crate::tool_config::get(tool).command);
    if let Some(custom) = custom { return Some((custom, args)); }
    let binary = crate::tools::find(tool)?.binary_name;
    #[cfg(windows)]
    let path = crate::windows_path::terminal_path();
    #[cfg(not(windows))]
    let path = std::env::var("PATH").unwrap_or_default();
    let names: Vec<String> = if cfg!(windows) { ["exe", "cmd", "bat"].iter().map(|ext| format!("{binary}.{ext}")).collect() } else { vec![binary.to_string()] };
    let mut candidates: Vec<std::path::PathBuf> = std::env::split_paths(&path).flat_map(|dir| names.iter().map(move |name| dir.join(name))).collect();
    if let Some(home) = dirs::home_dir() {
        candidates.extend(names.iter().map(|name| home.join(".local/bin").join(name)));
        #[cfg(windows)]
        if let Some(local) = std::env::var_os("LOCALAPPDATA") { candidates.extend(names.iter().map(|name| std::path::PathBuf::from(&local).join(binary).join("bin").join(name))); }
    }
    candidates.into_iter().find(|p| p.is_file()).map(|p| (p.to_string_lossy().into_owned(), args))
}
fn start(app: tauri::AppHandle, id: String, generation: String, tool: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    let config = crate::tool_config::get(&tool);
    let acp = acp_args(&tool).ok_or("This tool has no desktop conversation")?;
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    let (bin, prefix) = executable(&tool).ok_or("This tool is not installed")?;
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
    command.args(prefix).args(acp).args(&config.extra_args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("Could not start {tool}: {e}"))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let (stdout, stderr, input) = (child.stdout.take().unwrap(), child.stderr.take().unwrap(), child.stdin.take().unwrap());
    let s = Arc::new(Session { tool: tool.clone(), generation, native_id: Mutex::default(), child: Mutex::new(child), input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::default(), prompts: AtomicUsize::new(0) });
    {
        let sessions = app.state::<AcpSessions>(); let mut map = sessions.0.lock().unwrap();
        if map.contains_key(&id) { s.stop(); return Err("This tab already owns a desktop session".into()); }
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
        for (_, tx) in watcher.protocol.pending.lock().unwrap().drain() { let _ = tx.send(Err("The ACP process exited".into())); }
        watcher.protocol.permissions.lock().unwrap().clear();
        emit(&watcher_app, &watcher_id, &watcher, json!({"type":"coffee_exit","code":code,"detail":watcher.stderr.lock().unwrap().as_str()}));
        let sessions = watcher_app.state::<AcpSessions>(); let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &watcher)) { map.remove(&watcher_id); }
    });
    let result = (|| {
        let init = s.request("initialize", json!({"protocolVersion":1,"clientInfo":{"name":"coffee-cli","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{}}), Duration::from_secs(60))?;
        let mut params = json!({"cwd":cwd,"mcpServers":[]});
        let resume = resume_token.filter(|v| !v.is_empty());
        // Reopening a conversation is optional in ACP: a tool that does not offer it says so rather than failing late.
        if resume.is_some() && !can_load(&init) { return Err(format!("{tool} cannot reopen a conversation in the desktop view; open it as a terminal instead")); }
        if let Some(token) = &resume { params["sessionId"] = json!(token); }
        let mut result = s.request(if resume.is_some() { "session/load" } else { "session/new" }, params, Duration::from_secs(90))?;
        let native_id = resume.unwrap_or_else(|| result["sessionId"].as_str().unwrap_or_default().to_string());
        if native_id.is_empty() { return Err("The tool returned no session ID".into()); }
        *s.native_id.lock().unwrap() = native_id.clone(); result["sessionId"] = json!(native_id); Ok(result)
    })();
    if result.is_err() { s.stop(); }
    result
}
/// Whether the agent can load a saved session (`agentCapabilities.loadSession`, which agy also spells `load_session`).
fn can_load(init: &Value) -> bool {
    let caps = &init["agentCapabilities"];
    caps["loadSession"] == true || caps["load_session"] == true
}
#[tauri::command]
pub async fn acp_session_start(app: tauri::AppHandle, id: String, generation: String, tool: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, tool, cwd, resume_token)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn acp_session_request(sessions: State<'_, AcpSessions>, id: String, generation: String, method: String, mut params: Value) -> Result<Value, String> {
    if !matches!(method.as_str(), "session/prompt" | "session/cancel" | "session/set_config_option" | "session/set_mode" | "session/set_model") { return Err("Unsupported ACP method".into()); }
    if !params.is_object() { return Err("ACP params must be an object".into()); }
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
pub async fn acp_session_respond(sessions: State<'_, AcpSessions>, id: String, generation: String, request_id: String, option_id: Option<String>) -> Result<(), String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || s.write(&s.protocol.response(&request_id, option_id.as_deref())?)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn acp_session_close(sessions: State<'_, AcpSessions>, id: String, generation: String) -> Result<(), String> {
    let session = { let mut map = sessions.0.lock().unwrap(); if map.get(&id).is_some_and(|s| s.generation == generation) { map.remove(&id) } else { None } };
    if let Some(s) = session { tauri::async_runtime::spawn_blocking(move || s.stop()).await.map_err(|e| e.to_string())?; } Ok(())
}
pub fn shutdown(sessions: &AcpSessions) {
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
    fn every_acp_tool_starts_with_its_registry_arguments_and_others_have_none() {
        assert_eq!(acp_args("antigravity"), Some(&["acp"][..]));
        assert_eq!(acp_args("kiro"), Some(&["acp", "--agent-engine=v3"][..]));
        assert_eq!(acp_args("grok"), Some(&["agent", "stdio"][..]));
        assert_eq!(acp_args("qwen"), Some(&["--acp", "--experimental-skills"][..]));
        for tool in ["cursor", "muse", "goose", "kilo", "kimicode", "cline", "codebuddy", "copilot"] { assert!(acp_args(tool).is_some(), "{tool}"); assert!(crate::tools::find(tool).is_some(), "{tool} is a known tool"); }
        for tool in ["claude", "codex", "opencode", "pi", "dsh", "aider", "minimax"] { assert!(acp_args(tool).is_none(), "{tool}"); assert!(executable(tool).is_none()); }
    }
    #[test]
    fn only_agents_that_offer_it_reopen_a_saved_session() {
        assert!(can_load(&json!({"agentCapabilities":{"loadSession":true}})));
        assert!(can_load(&json!({"agentCapabilities":{"load_session":true}})));
        assert!(!can_load(&json!({"agentCapabilities":{}})));
        assert!(!can_load(&json!({})));
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
