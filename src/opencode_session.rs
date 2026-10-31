//! OpenCode desktop conversations: one private `opencode serve --stdio` server per Coffee tab.
//! This is the same private-server lease OpenCode's own `--standalone` TUI uses: the server prints
//! `{"url":…}` once it listens, accepts Basic auth with the password we hand it, and exits when its
//! stdin closes. Requests go over its HTTP API and events stream back from `/api/event` (SSE).
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Read}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex}, time::Duration};
use tauri::{Emitter, Manager, State};

struct Session {
    id: String,
    generation: String,
    native_id: Mutex<String>,
    child: Mutex<Child>,
    input: Mutex<Option<ChildStdin>>,
    url: String,
    auth: String,
    stderr: Arc<Mutex<String>>,
    closed: AtomicBool,
    launch_config: crate::tool_config::ToolConfigEntry,
    launch_cwd: PathBuf,
    /// Agent and model picked before a new conversation exists; its creation carries them. Held while creating.
    draft: Mutex<Value>,
}
#[derive(Default)]
pub struct OpenCodeSessions(Mutex<HashMap<String, Arc<Session>>>);

pub(crate) fn launch_context(app: &tauri::AppHandle, id: &str) -> Option<(crate::tool_config::ToolConfigEntry, String)> {
    let sessions = app.try_state::<OpenCodeSessions>()?;
    let map = sessions.0.lock().ok()?;
    let session = map.get(id)?;
    Some((session.launch_config.clone(), session.launch_cwd.to_string_lossy().into_owned()))
}

/// Requests target the private server on loopback only; never route them through a system proxy.
fn agent(read_timeout: Option<Duration>) -> ureq::Agent {
    let builder = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(5));
    match read_timeout { Some(timeout) => builder.timeout_read(timeout), None => builder }.build()
}

impl Session {
    fn stop(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Closing stdin ends the server's lease; it also reaches a server started through a .cmd launcher.
        if let Ok(mut input) = self.input.try_lock() { input.take(); }
        let _ = self.child.lock().unwrap().kill();
    }
    fn http(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let request = agent(Some(Duration::from_secs(60))).request(method, &format!("{}{path}", self.url))
            .set("Authorization", &self.auth).set("Accept", "application/json");
        let response = match body {
            Some(body) => request.set("Content-Type", "application/json").send_string(&body.to_string()),
            None => request.call(),
        };
        let text = match response {
            // Above ureq's own string limit: a page of a long session can carry inline media until strip_media runs.
            Ok(response) => {
                let mut text = String::new();
                response.into_reader().take(RESPONSE_LIMIT).read_to_string(&mut text).map_err(|e| e.to_string())?;
                text
            }
            Err(ureq::Error::Status(code, response)) => {
                let text = response.into_string().unwrap_or_default();
                let message = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["message"].as_str().map(str::to_owned)).unwrap_or(text);
                return Err(if message.trim().is_empty() { format!("OpenCode request failed ({code})") } else { message });
            }
            Err(error) => return Err(format!("OpenCode request failed: {error}")),
        };
        if text.trim().is_empty() { return Ok(Value::Null); }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}
fn get(sessions: &OpenCodeSessions, id: &str, generation: &str) -> Result<Arc<Session>, String> {
    let s = sessions.0.lock().unwrap().get(id).cloned().ok_or("OpenCode session is not running")?;
    if s.generation != generation { return Err("OpenCode session has changed".into()); }
    Ok(s)
}
fn emit(app: &tauri::AppHandle, id: &str, session: &Session, event: Value) {
    crate::orchestration::native_event(id, "opencode", &session.generation, &event);
    let _ = app.emit("opencode-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}

/// OpenCode IDs are a fixed prefix plus URL-safe characters; anything else never reaches a URL path.
const RESPONSE_LIMIT: u64 = 512 * 1024 * 1024;

fn valid_id(value: &str, prefix: &str) -> bool {
    value.len() > prefix.len() && value.len() <= 128 && value.starts_with(prefix) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn valid_cursor(value: &str) -> bool {
    !value.is_empty() && value.len() <= 2048 && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'=' | b'.'))
}

/// Server-sent events: `data:` lines up to a blank line form one JSON event; comments (`: heartbeat`) are skipped.
fn read_events(reader: impl std::io::Read, mut on_event: impl FnMut(Value)) {
    let mut data = String::new();
    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        if let Some(chunk) = line.strip_prefix("data:") {
            if !data.is_empty() { data.push('\n'); }
            data.push_str(chunk.strip_prefix(' ').unwrap_or(chunk));
            continue;
        }
        if !line.is_empty() || data.is_empty() { continue; }
        if let Ok(event) = serde_json::from_str::<Value>(&std::mem::take(&mut data)) { on_event(event); }
    }
}

/// Events that belong to the tab's session. Each tab owns its server, but sub-agent sessions and
/// global forms (MCP elicitation) share the stream. A sub-agent's own requests still need an answer
/// from the person, or its parent's turn waits forever.
fn owned(event: &Value, native: &str) -> bool {
    let data = &event["data"];
    let Some(owner) = data["sessionID"].as_str().or_else(|| data["form"]["sessionID"].as_str()) else { return false };
    let request = event["type"].as_str().is_some_and(|kind| kind.starts_with("permission.") || kind.starts_with("form."));
    owner == native || (request && owner != "global")
}

/// Attachments and tool media carry their bytes inline (base64); the conversation only shows their names.
fn strip_media(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let media = map.contains_key("mime") || map.contains_key("uri") || map.contains_key("filename") || map.get("type").is_some_and(|t| t == "file" || t == "image");
            if media && map.get("data").and_then(Value::as_str).is_some_and(|data| data.len() > 1024) { map.remove("data"); }
            for child in map.values_mut() { strip_media(child); }
        }
        Value::Array(items) => for item in items { strip_media(item); },
        _ => {}
    }
}

/// Model and agent rows carry provider settings and request headers (API keys); only display fields leave Rust.
fn public_model(model: &Value) -> Value {
    json!({
        "id": model["id"], "providerID": model["providerID"], "name": model["name"],
        "variants": model["variants"].as_array().into_iter().flatten().filter_map(|v| v["id"].as_str()).collect::<Vec<_>>(),
        "context": model["limit"]["context"], "enabled": model["enabled"], "status": model["status"],
    })
}
fn public_agent(agent: &Value) -> Value {
    json!({"id":agent["id"],"name":agent["name"],"description":agent["description"],"mode":agent["mode"],"hidden":agent["hidden"]})
}

/// The user's command override, then `opencode` on PATH, then the CLI bundled with OpenCode Desktop.
fn executable() -> Option<(String, Vec<String>)> {
    let (custom, args) = crate::tool_config::parse_command(&crate::tool_config::get("opencode").command);
    let args = server_args(args);
    if let Some(custom) = custom.filter(|custom| custom != "opencode") {
        if std::path::Path::new(&custom).is_absolute() { return Some((custom, args)); }
        return find_on_path(&custom).map(|bin| (bin, args.clone())).or(Some((custom, vec![])));
    }
    if let Some(bin) = find_on_path("opencode") { return Some((bin, args)); }
    #[cfg(windows)]
    {
        let bundled = dirs::data_local_dir()?.join(r"Programs\ai.opencode.desktop\resources\opencode-cli.exe");
        if bundled.is_file() { return Some((bundled.to_string_lossy().into_owned(), args)); }
    }
    None
}
/// A command preset may hold terminal flags, which `serve` rejects. Auto-approval is applied by this client instead.
fn server_args(args: Vec<String>) -> Vec<String> {
    args.into_iter().filter(|arg| !matches!(arg.as_str(), "--auto" | "--standalone" | "--continue" | "-c")).collect()
}

fn find_on_path(bin: &str) -> Option<String> {
    #[cfg(windows)]
    let (path, names) = (crate::windows_path::terminal_path(), [format!("{bin}.exe"), format!("{bin}.cmd"), bin.to_string()]);
    #[cfg(not(windows))]
    let (path, names) = (std::env::var("PATH").unwrap_or_default(), [bin.to_string()]);
    std::env::split_paths(&path).flat_map(|dir| names.clone().map(|name| dir.join(name)))
        .find(|candidate| candidate.is_file()).map(|candidate| candidate.to_string_lossy().into_owned())
}

fn spawn(bin: &str, prefix: &[String], cwd: &std::path::Path, password: &str) -> std::io::Result<Child> {
    let mut command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let lower = bin.to_ascii_lowercase();
        command = if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut c = Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()));
            c.args(["/d", "/c", bin]); c
        } else { Command::new(bin) };
        command.creation_flags(0x08000000).env("PATH", crate::windows_path::terminal_path());
    }
    #[cfg(not(windows))]
    { command = Command::new(bin); }
    // The server reads OPENCODE_PASSWORD as its lease credential and removes it from the environment tools inherit.
    command.args(prefix).args(["serve", "--stdio", "--port", "0"]).env("OPENCODE_PASSWORD", password)
        .env_remove("OPENCODE_SERVER_PASSWORD")
        .current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
}

fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    let config = crate::tool_config::get("opencode");
    let auto_approve = config.command.split_whitespace().any(|arg| arg == "--auto");
    let cwd = cwd.filter(|p| !p.trim().is_empty()).or_else(|| (!config.default_cwd.is_empty()).then(|| config.default_cwd.clone()))
        .map(|p| crate::tool_config::expand_path(&p)).unwrap_or_else(|| dirs::home_dir().unwrap_or_default());
    crate::session_directory::validate(&cwd)?;
    if resume_token.as_deref().is_some_and(|token| !valid_id(token, "ses_")) { return Err("Invalid OpenCode session ID".into()); }
    let (bin, prefix) = executable().ok_or("OpenCode is not installed")?;
    let password = uuid::Uuid::new_v4().simple().to_string();
    let mut child = spawn(&bin, &prefix, &cwd, &password)
        .map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("Could not start OpenCode: {e}")))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let (stdout, stderr, input) = (child.stdout.take().unwrap(), child.stderr.take().unwrap(), child.stdin.take().unwrap());
    let tail = Arc::new(Mutex::new(String::new()));
    let sink = tail.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut tail = sink.lock().unwrap(); tail.push_str(&line); tail.push('\n');
            if tail.len() > 8192 { let cut = tail.char_indices().find(|(i, _)| *i >= tail.len() - 4096).map(|(i, _)| i).unwrap_or(0); tail.drain(..cut); }
        }
    });
    // The first stdout line announces the URL; keep draining afterwards so later writes never block the server.
    let (ready_tx, ready_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines().map_while(Result::ok);
        if let Some(line) = lines.next() { let _ = ready_tx.send(line); }
        for _ in lines {}
    });
    let fail = |child: &mut Child, message: String| { let _ = child.kill(); message };
    let line = match ready_rx.recv_timeout(Duration::from_secs(45)) {
        Ok(line) => line,
        Err(_) => {
            std::thread::sleep(Duration::from_millis(200));
            let detail = tail.lock().unwrap().trim().to_string();
            return Err(fail(&mut child, if detail.is_empty() { "OpenCode did not start its server. Desktop conversations need OpenCode 2.0 or later.".into() } else { detail }));
        }
    };
    let url = match serde_json::from_str::<Value>(&line).ok().and_then(|v| v["url"].as_str().map(str::to_owned)) {
        Some(url) if url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:") || url.starts_with("http://[::1]:") => url,
        _ => return Err(fail(&mut child, "This OpenCode version cannot host desktop conversations. Update to OpenCode 2.0 or later.".into())),
    };
    use base64::Engine;
    let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}")));
    let session = Arc::new(Session { id: id.clone(), generation, native_id: Mutex::new(String::new()), child: Mutex::new(child), input: Mutex::new(Some(input)), url, auth, stderr: tail, closed: AtomicBool::new(false), launch_config: config, launch_cwd: cwd, draft: Mutex::new(json!({})) });
    {
        let sessions = app.state::<OpenCodeSessions>();
        let mut map = sessions.0.lock().unwrap();
        if map.contains_key(&id) { session.stop(); return Err("This tab already owns an OpenCode session".into()); }
        map.insert(id.clone(), session.clone());
    }
    // Subscribe before creating or resuming, so no event of this session is missed.
    let (connected_tx, connected_rx) = mpsc::channel::<Result<(), String>>();
    let s = session.clone(); let reader_app = app.clone(); let reader_id = id.clone();
    std::thread::spawn(move || {
        let response = agent(None).get(&format!("{}/api/event", s.url)).set("Authorization", &s.auth).set("Accept", "text/event-stream").call();
        let reader = match response { Ok(response) => response.into_reader(), Err(error) => { let _ = connected_tx.send(Err(format!("OpenCode event stream failed: {error}"))); return; } };
        read_events(reader, |mut event| {
            if event["type"] == "server.connected" { let _ = connected_tx.send(Ok(())); return; }
            let native = s.native_id.lock().unwrap().clone();
            if !native.is_empty() && owned(&event, &native) { strip_media(&mut event); emit(&reader_app, &reader_id, &s, event); }
        });
        // A dropped stream would silently freeze the conversation; end the session so the tab offers a reconnect.
        if !s.closed.load(Ordering::SeqCst) { let _ = s.child.lock().unwrap().kill(); }
    });
    let s = session.clone(); let watcher_app = app.clone(); let watcher_id = id.clone();
    std::thread::spawn(move || {
        let code = loop {
            let status = s.child.lock().unwrap().try_wait();
            match status { Ok(Some(status)) => break status.code(), Err(_) => break None, _ => std::thread::sleep(Duration::from_millis(150)) }
        };
        let detail = s.stderr.lock().unwrap().clone();
        emit(&watcher_app, &watcher_id, &s, json!({"type":"coffee.exit","data":{"sessionID":s.native_id.lock().unwrap().clone(),"code":code,"detail":detail}}));
        let sessions = watcher_app.state::<OpenCodeSessions>(); let mut map = sessions.0.lock().unwrap();
        if map.get(&watcher_id).is_some_and(|live| Arc::ptr_eq(live, &s)) { map.remove(&watcher_id); }
    });
    let result = (|| {
        connected_rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "OpenCode event stream did not connect".to_string())??;
        // A new conversation is created by its first prompt or command, as in OpenCode's own clients, so a
        // tab opened and closed unused leaves no empty session behind.
        let (info, native) = match &resume_token {
            Some(token) => {
                let info = session.http("GET", &format!("/api/session/{token}"), None)?;
                let native = info["data"]["id"].as_str().filter(|id| valid_id(id, "ses_")).ok_or("OpenCode returned no session ID")?.to_string();
                *session.native_id.lock().unwrap() = native.clone();
                (info, native)
            }
            None => (Value::Null, String::new()),
        };
        let models = session.http("GET", "/api/model", None)?;
        let default = session.http("GET", "/api/model/default", None).unwrap_or(Value::Null);
        let agents = session.http("GET", "/api/agent", None)?;
        let commands = session.http("GET", "/api/command", None).unwrap_or(Value::Null);
        let (mut messages, permissions, forms, active) = if native.is_empty() { (json!({"data":[]}), Value::Null, Value::Null, Value::Null) } else { (
            session.http("GET", &format!("/api/session/{native}/message?limit=60&order=desc"), None)?,
            session.http("GET", &format!("/api/session/{native}/permission"), None).unwrap_or(Value::Null),
            session.http("GET", &format!("/api/session/{native}/form"), None).unwrap_or(Value::Null),
            session.http("GET", "/api/session/active", None).unwrap_or(Value::Null),
        ) };
        strip_media(&mut messages);
        Ok(json!({
            "session": info["data"],
            "models": models["data"].as_array().into_iter().flatten().filter(|m| m["enabled"] != false).map(public_model).collect::<Vec<_>>(),
            "defaultModel": default.get("data").map(public_model),
            "agents": agents["data"].as_array().into_iter().flatten().map(public_agent).collect::<Vec<_>>(),
            "commands": commands["data"].as_array().into_iter().flatten().map(|c| json!({"name":c["name"],"description":c["description"]})).collect::<Vec<_>>(),
            "messages": messages["data"], "cursor": messages["cursor"]["next"],
            "permissions": permissions["data"], "forms": forms["data"],
            "running": !native.is_empty() && active["data"].get(&native).is_some(),
            "autoApprove": auto_approve,
        }))
    })();
    if result.is_err() { session.stop(); }
    result
}

#[tauri::command]
pub async fn opencode_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token)).await.map_err(|e| e.to_string())?
}

/// Session operations by name; every path is built here and scoped to the tab's own session, or for a
/// request's reply to the sub-agent session that asked. The server is private to the tab.
fn route(native: &str, op: &str, params: &Value) -> Result<(&'static str, String, Option<Value>), String> {
    let id = |key: &str, prefix: &str| params[key].as_str().filter(|v| valid_id(v, prefix)).map(str::to_owned).ok_or_else(|| format!("Invalid {key}"));
    let base = format!("/api/session/{native}");
    let asker = format!("/api/session/{}", params["sessionID"].as_str().filter(|v| valid_id(v, "ses_")).unwrap_or(native));
    Ok(match op {
        "prompt" => {
            let text = params["text"].as_str().filter(|t| !t.trim().is_empty()).ok_or("Message is empty")?;
            // Local files go as file URLs; the server reads and inlines them, as OpenCode's own TUI does.
            let files = params["paths"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|path| {
                let path = std::path::Path::new(path);
                let uri = url::Url::from_file_path(path).map_err(|_| format!("Invalid attachment path: {}", path.display()))?;
                Ok(json!({"uri":uri.as_str(),"name":path.file_name().map(|n| n.to_string_lossy().into_owned())}))
            }).collect::<Result<Vec<_>, String>>()?;
            ("POST", format!("{base}/prompt"), Some(if files.is_empty() { json!({"text":text}) } else { json!({"text":text,"files":files}) }))
        }
        "interrupt" => ("POST", format!("{base}/interrupt"), None),
        "messages" => {
            let cursor = params["cursor"].as_str().filter(|c| valid_cursor(c)).ok_or("Invalid cursor")?;
            ("GET", format!("{base}/message?limit=60&cursor={cursor}"), None)
        }
        "session" => ("GET", base, None),
        "permission.reply" => {
            let decision = params["decision"].as_str().filter(|d| matches!(*d, "once" | "always" | "reject")).ok_or("Invalid decision")?;
            ("POST", format!("{asker}/permission/{}/reply", id("requestID", "per_")?), Some(json!({"decision":decision})))
        }
        "form.reply" => ("POST", format!("{asker}/form/{}/reply", id("formID", "frm_")?), Some(json!({"answer":params["answer"]}))),
        "form.cancel" => ("DELETE", format!("{asker}/form/{}", id("formID", "frm_")?), None),
        "model" => {
            // The server takes a variant or no field at all: null is rejected, and leaving it out picks the model's default.
            let mut model = json!({"id":params["id"],"providerID":params["providerID"]});
            if let Some(variant) = params["variant"].as_str().filter(|variant| !variant.is_empty()) { model["variant"] = json!(variant); }
            ("POST", format!("{base}/model"), Some(json!({"model":model})))
        }
        "agent" => ("POST", format!("{base}/agent"), Some(json!({"agent":params["agent"]}))),
        "compact" => ("POST", format!("{base}/compact"), Some(json!({}))),
        "command" => {
            let name = params["name"].as_str().filter(|n| !n.is_empty() && n.len() <= 128).ok_or("Invalid command")?;
            ("POST", format!("{base}/command"), Some(json!({"name":name,"text":params["text"].as_str().unwrap_or("")})))
        }
        _ => return Err("Unsupported OpenCode request".into()),
    })
}

/// The tab's session, created on the first prompt or command. Before that, agent and model picks are kept
/// for the creation (as OpenCode's own clients do) and other requests answer as for an empty conversation.
/// `Ok(Err(reply))` answers the request without a session.
fn native_or_draft(app: &tauri::AppHandle, s: &Session, op: &str, params: &Value) -> Result<Result<String, Value>, String> {
    let native = s.native_id.lock().unwrap().clone();
    if !native.is_empty() { return Ok(Ok(native)); }
    let mut draft = s.draft.lock().unwrap();
    // Another request may have created it while this one waited for the draft.
    let native = s.native_id.lock().unwrap().clone();
    if !native.is_empty() { return Ok(Ok(native)); }
    match op {
        "model" => {
            let mut model = json!({"id":params["id"],"providerID":params["providerID"]});
            if let Some(variant) = params["variant"].as_str().filter(|variant| !variant.is_empty()) { model["variant"] = json!(variant); }
            draft["model"] = model;
            Ok(Err(Value::Null))
        }
        "agent" => { draft["agent"] = params["agent"].clone(); Ok(Err(Value::Null)) }
        "interrupt" => Ok(Err(Value::Null)),
        "messages" => Ok(Err(json!({"data":[]}))),
        "prompt" | "command" => {
            let info = s.http("POST", "/api/session", Some(&draft))?;
            let native = info["data"]["id"].as_str().filter(|id| valid_id(id, "ses_")).ok_or("OpenCode returned no session ID")?.to_string();
            *s.native_id.lock().unwrap() = native.clone();
            // Before the prompt goes out, so the tab takes this session's events from the first one on.
            emit(app, &s.id, s, json!({"type":"coffee.session","data":{"sessionID":native,"session":info["data"]}}));
            Ok(Ok(native))
        }
        _ => Err("OpenCode has no conversation yet".to_string()),
    }
}

#[tauri::command]
pub async fn opencode_session_request(app: tauri::AppHandle, sessions: State<'_, OpenCodeSessions>, id: String, generation: String, op: String, params: Value) -> Result<Value, String> {
    let s = get(&sessions, &id, &generation)?;
    tauri::async_runtime::spawn_blocking(move || {
        let native = match native_or_draft(&app, &s, &op, &params)? {
            Ok(native) => native,
            Err(reply) => return Ok(reply),
        };
        let (method, path, body) = route(&native, &op, &params)?;
        if op == "prompt" { crate::orchestration::native_input(&s.id, "opencode", &s.generation, params["text"].as_str().unwrap_or(""), params["requestId"].as_str().unwrap_or(""), None)?; }
        else if op == "interrupt" { crate::orchestration::native_stop(&s.id, "opencode", &s.generation); }
        let mut result = s.http(method, &path, body.as_ref())?;
        strip_media(&mut result);
        Ok(result)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn opencode_session_close(sessions: State<'_, OpenCodeSessions>, id: String, generation: String) -> Result<(), String> {
    let session = {
        let mut map = sessions.0.lock().unwrap();
        if map.get(&id).is_some_and(|s| s.generation == generation) { map.remove(&id) } else { None }
    };
    if let Some(s) = session { tauri::async_runtime::spawn_blocking(move || s.stop()).await.map_err(|e| e.to_string())?; }
    Ok(())
}
pub fn shutdown(sessions: &OpenCodeSessions) {
    let sessions: Vec<_> = sessions.0.lock().unwrap().drain().map(|(_, session)| session).collect();
    for s in sessions { s.stop(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_and_cursors_cannot_escape_the_session_path() {
        assert!(valid_id("ses_e6dc7b23effeDN7H0j9HAALm7v", "ses_"));
        assert!(!valid_id("ses_", "ses_"));
        assert!(!valid_id("ses_../../api/session", "ses_"));
        assert!(!valid_id("per_abc", "ses_"));
        assert!(valid_cursor("eyJpZCI6Im1zZ18xOTIy"));
        assert!(!valid_cursor("abc&limit=200"));
        assert!(route("ses_a", "permission.reply", &json!({"requestID":"per_x/../y","decision":"once"})).is_err());
        assert!(route("ses_a", "permission.reply", &json!({"requestID":"per_x","decision":"approve"})).is_err());
        assert_eq!(route("ses_a", "form.reply", &json!({"formID":"frm_1","answer":{"q0":"Blue"}})).unwrap().1, "/api/session/ses_a/form/frm_1/reply");
        assert_eq!(route("ses_a", "permission.reply", &json!({"requestID":"per_x","decision":"once","sessionID":"ses_child"})).unwrap().1, "/api/session/ses_child/permission/per_x/reply");
        assert_eq!(route("ses_a", "permission.reply", &json!({"requestID":"per_x","decision":"once","sessionID":"ses_../x"})).unwrap().1, "/api/session/ses_a/permission/per_x/reply");
        assert!(route("ses_a", "session.remove", &json!({})).is_err());
        let body = |params: Value| route("ses_a", "model", &params).unwrap().2.unwrap();
        assert!(body(json!({"id":"m","providerID":"p"}))["model"].get("variant").is_none(), "no variant means no field, never null");
        assert!(body(json!({"id":"m","providerID":"p","variant":null}))["model"].get("variant").is_none());
        assert_eq!(body(json!({"id":"m","providerID":"p","variant":"high"}))["model"]["variant"], "high");
    }
    #[test]
    fn models_and_agents_drop_provider_secrets() {
        let model = public_model(&json!({"id":"m","providerID":"p","name":"M","settings":{"apiKey":"sk-secret"},"variants":[{"id":"high","settings":{"effort":"high"}}],"limit":{"context":200000},"enabled":true}));
        assert!(!model.to_string().contains("sk-secret"));
        assert_eq!(model["variants"], json!(["high"]));
        let agent = public_agent(&json!({"id":"build","name":"Build","request":{"headers":{"Authorization":"Bearer secret"}}}));
        assert!(!agent.to_string().contains("secret"));
    }
    #[test]
    fn attachment_bytes_are_dropped_but_names_kept() {
        let big = "A".repeat(4096);
        let mut message = json!({"type":"user","files":[{"data":big,"mime":"image/png","filename":"pic.png"}],"content":[{"type":"text","text":big}]});
        strip_media(&mut message);
        assert!(message["files"][0].get("data").is_none());
        assert_eq!(message["files"][0]["filename"], "pic.png");
        assert_eq!(message["content"][0]["text"].as_str().unwrap().len(), 4096);
        let (_, _, body) = route("ses_a", "prompt", &json!({"text":"Look","paths":[if cfg!(windows) { r"D:\tmp\pic.png" } else { "/tmp/pic.png" }]})).unwrap();
        assert!(body.unwrap()["files"][0]["uri"].as_str().unwrap().starts_with("file:///"));
    }
    #[test]
    fn event_stream_frames_skip_heartbeats_and_split_on_blank_lines() {
        let stream = "data: {\"type\":\"server.connected\"}\n\n: heartbeat\n\ndata: {\"type\":\"a\",\ndata: \"n\":1}\n\ndata: not json\n\ndata: {\"type\":\"b\"}\n\n";
        let mut seen = vec![];
        read_events(stream.as_bytes(), |event| seen.push(event["type"].as_str().unwrap_or("").to_string()));
        assert_eq!(seen, ["server.connected", "a", "b"]);
    }
    /// Real OpenCode 2.x: `cargo test --bin coffee-cli opencode_live -- --ignored`. Creates and deletes one session.
    #[test]
    #[ignore]
    fn opencode_live_private_server_round_trip() {
        let (bin, prefix) = executable().expect("OpenCode is not installed");
        let dir = tempfile::tempdir().unwrap();
        let password = uuid::Uuid::new_v4().simple().to_string();
        let mut child = spawn(&bin, &prefix, dir.path(), &password).unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let ready: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
        let url = ready["url"].as_str().unwrap().to_string();
        use base64::Engine;
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}")));
        let session = Session { id: "test".into(), generation: String::new(), native_id: Mutex::new(String::new()), input: Mutex::new(child.stdin.take()), child: Mutex::new(child), url: url.clone(), auth: auth.clone(), stderr: Default::default(), closed: AtomicBool::new(false), launch_config: Default::default(), launch_cwd: dir.path().into(), draft: Mutex::new(json!({})) };
        assert!(agent(Some(Duration::from_secs(5))).get(&format!("{url}/api/model")).call().is_err(), "the server must require its password");
        let (tx, rx) = mpsc::channel();
        let stream = agent(None).get(&format!("{url}/api/event")).set("Authorization", &auth).call().unwrap().into_reader();
        std::thread::spawn(move || read_events(stream, |event| { let _ = tx.send(event); }));
        assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap()["type"], "server.connected");
        let created = session.http("POST", "/api/session", Some(&json!({}))).unwrap();
        let id = created["data"]["id"].as_str().unwrap().to_string();
        assert!(valid_id(&id, "ses_"));
        assert!(dunce::simplified(std::path::Path::new(created["data"]["location"]["directory"].as_str().unwrap())) == dunce::simplified(&dir.path().canonicalize().unwrap()), "sessions open in the tab's folder");
        let event = std::iter::from_fn(|| rx.recv_timeout(Duration::from_secs(10)).ok()).find(|e| owned(e, &id)).unwrap();
        assert_eq!(event["type"], "session.created");
        assert!(session.http("GET", "/api/model", None).unwrap()["data"].is_array());
        // Every effort the composer can pick has to pass the server's own validation.
        let models = session.http("GET", "/api/model", None).unwrap();
        let model = models["data"].as_array().unwrap().iter().find(|m| m["variants"].as_array().is_some_and(|v| !v.is_empty())).expect("a model with variants");
        let variants = model["variants"].as_array().unwrap().iter().map(|v| v["id"].clone()).collect::<Vec<_>>();
        for variant in variants.into_iter().chain([Value::Null]) {
            let (method, path, body) = route(&id, "model", &json!({"id":model["id"],"providerID":model["providerID"],"variant":variant})).unwrap();
            session.http(method, &path, body.as_ref()).unwrap_or_else(|error| panic!("{variant}: {error}"));
        }
        // A new tab's agent and model picks travel with the session creation its first prompt makes.
        let agents = session.http("GET", "/api/agent", None).unwrap();
        let picked = agents["data"].as_array().unwrap().iter().rev().find(|a| a["mode"] != "subagent" && a["hidden"] != true).expect("a primary agent")["id"].clone();
        let draft = json!({"agent":picked,"model":{"id":model["id"],"providerID":model["providerID"],"variant":model["variants"][0]["id"]}});
        let drafted = session.http("POST", "/api/session", Some(&draft)).unwrap_or_else(|error| panic!("draft creation: {error}"));
        assert_eq!(drafted["data"]["agent"], picked);
        assert_eq!(drafted["data"]["model"]["id"], model["id"]);
        session.http("DELETE", &format!("/api/session/{}", drafted["data"]["id"].as_str().unwrap()), None).unwrap();
        let (method, path, _) = route(&id, "messages", &json!({"cursor":"eyJ4IjoxfQ"})).unwrap();
        assert_eq!(method, "GET"); assert!(path.contains(&id));
        session.http("DELETE", &format!("/api/session/{id}"), None).unwrap();
        session.stop();
        let exited = (0..50).any(|_| { std::thread::sleep(Duration::from_millis(100)); session.child.lock().unwrap().try_wait().ok().flatten().is_some() });
        assert!(exited, "closing the lease ends the server");
    }
    #[test]
    fn terminal_flags_never_reach_the_server() {
        let args = |list: &[&str]| server_args(list.iter().map(|arg| arg.to_string()).collect());
        assert!(args(&["--auto"]).is_empty());
        assert_eq!(args(&["--auto", "--print-logs"]), ["--print-logs"]);
        assert_eq!(args(&["opencode"]), ["opencode"], "a launcher's own arguments stay");
    }
    #[test]
    fn only_the_tabs_session_events_are_forwarded() {
        assert!(owned(&json!({"type":"session.text.delta","data":{"sessionID":"ses_a"}}), "ses_a"));
        assert!(owned(&json!({"type":"form.created","data":{"form":{"sessionID":"ses_a"}}}), "ses_a"));
        assert!(!owned(&json!({"type":"session.text.delta","data":{"sessionID":"ses_child"}}), "ses_a"));
        assert!(!owned(&json!({"type":"form.created","data":{"form":{"sessionID":"global"}}}), "ses_a"));
        assert!(owned(&json!({"type":"permission.asked","data":{"sessionID":"ses_child"}}), "ses_a"));
        assert!(owned(&json!({"type":"form.created","data":{"form":{"sessionID":"ses_child"}}}), "ses_a"));
    }
}
