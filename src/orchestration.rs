use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Read, Write}, net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream}, path::Path, sync::{mpsc, Arc, Condvar, Mutex, OnceLock, atomic::{AtomicUsize, Ordering}}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { pub enabled: bool, #[serde(default = "default_agents")] pub agents: Vec<String>, pub tasks: Vec<Task>, pub revision: u64, #[serde(default, skip_deserializing)] pub coordinators: Vec<String> }
fn default_agents() -> Vec<String> { ["claude", "codex", "opencode"].into_iter().map(str::to_owned).collect() }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    id: String, parent_id: String, parent_native_id: Option<String>, session_id: String,
    #[serde(default = "claude_tool")] parent_tool: String,
    native_id: Option<String>, tool: String, title: String, cwd: String, phase: String,
    summary: Option<String>, question: Option<Question>, generation: Option<String>, activity: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Question { id: String, text: String, answer: Option<String> }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession { id: String, tool: String, cwd: String, generation: Option<String>, native_id: Option<String>, ready: bool, status: Option<String>, error: Option<String> }
#[derive(Clone)]
struct Parent { id: String, native_id: Option<String>, tool: String, agents: Vec<String>, connected: bool, cwd: String, generation: Option<String>, seen: bool }
fn claude_tool() -> String { "claude".into() }
struct Pending { parent: String, token: String, worker: Option<String>, deadline: Instant, sender: mpsc::Sender<Value> }
struct State {
    snapshot: Snapshot, live: HashMap<String, LiveSession>, parents: HashMap<String, Parent>,
    workers: HashMap<String, String>, pending: HashMap<String, Pending>, app: Option<AppHandle>, port: Option<u16>,
}
struct Hub { state: Mutex<State>, changed: Condvar }
static HUB: OnceLock<Hub> = OnceLock::new();

fn path() -> Result<std::path::PathBuf, String> { Ok(dirs::home_dir().ok_or("Home directory unavailable")?.join(".coffee-cli/orchestration.json")) }
fn hub() -> &'static Hub {
    HUB.get_or_init(|| {
        let mut snapshot = path().ok().and_then(|path| fs::read(path).ok()).filter(|bytes| bytes.len() < 2_000_000)
            .and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok()).unwrap_or_default();
        if !snapshot.enabled { snapshot.agents.clear(); }
        for task in &mut snapshot.tasks { if active(task) { task.phase = "closed".into(); } }
        Hub { state: Mutex::new(State { snapshot, live: HashMap::new(), parents: HashMap::new(), workers: HashMap::new(), pending: HashMap::new(), app: None, port: None }), changed: Condvar::new() }
    })
}
fn active(task: &Task) -> bool { matches!(task.phase.as_str(), "starting" | "running" | "uncertain") }
fn same_directory(left: &str, right: &str) -> bool {
    let key = |value: &str| {
        if value.as_bytes().get(1) == Some(&b':') || value.starts_with("\\\\") {
            value.replace('/', "\\").trim_end_matches('\\').to_lowercase()
        } else { value.trim_end_matches('/').to_string() }
    };
    key(left) == key(right)
}
fn save(snapshot: &Snapshot) -> Result<(), String> {
    let path = path()?; crate::tool_control::plain_path(&path)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temp = path.with_file_name(format!(".orchestration-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, serde_json::to_vec(snapshot).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let result = crate::agent::replace_file(&temp, &path);
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}
fn current_snapshot(state: &State) -> Snapshot {
    let mut snapshot = state.snapshot.clone();
    snapshot.coordinators = state.parents.iter().filter(|(token, owner)| owner.connected && owner.agents.len() == state.snapshot.agents.len() && owner.agents.iter().all(|agent| state.snapshot.agents.contains(agent)) && parent(state, token).is_ok()).map(|(_, owner)| owner.id.clone()).collect();
    snapshot.coordinators.sort(); snapshot.coordinators.dedup(); snapshot
}
fn publish(state: &mut State) {
    state.snapshot.revision += 1;
    if let Some(app) = &state.app { let _ = app.emit_to("main", "orchestration-updated", current_snapshot(state)); }
    hub().changed.notify_all();
}

#[tauri::command]
pub fn orchestration_get() -> Snapshot { current_snapshot(&hub().state.lock().unwrap()) }
#[tauri::command]
pub fn orchestration_set_agent(tool: String, enabled: bool) -> Result<Snapshot, String> {
    if !default_agents().contains(&tool) { return Err("Agent does not support orchestration yet".into()); }
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    let mut next = state.snapshot.clone(); next.agents.retain(|agent| agent != &tool);
    if enabled { next.agents.push(tool.clone()); }
    next.enabled = !next.agents.is_empty(); save(&next)?; state.snapshot = next;
    if !enabled { state.pending.retain(|_, pending| pending.worker.as_deref() != Some(&tool)); }
    if !state.snapshot.enabled { state.parents.clear(); state.pending.clear(); }
    publish(&mut state); Ok(current_snapshot(&state))
}
#[tauri::command]
pub fn orchestration_sync(sessions: Vec<LiveSession>) -> Result<(), String> {
    if sessions.len() > 256 { return Err("Too many sessions".into()); }
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    if sync_live(&mut state, sessions) { save(&state.snapshot)?; publish(&mut state); }
    Ok(())
}
fn sync_live(state: &mut State, sessions: Vec<LiveSession>) -> bool {
    let coordinators = current_snapshot(state).coordinators;
    state.live = sessions.into_iter().map(|session| (session.id.clone(), session)).collect();
    let live = state.live.clone();
    let state_enabled = state.snapshot.enabled;
    let agents = state.snapshot.agents.clone();
    state.parents.retain(|_, parent| {
        if let Some(session) = live.get(&parent.id) {
            parent.seen = true;
            if parent.native_id.is_none() { parent.native_id = session.native_id.clone(); }
            if parent.generation.is_none() && session.ready { parent.generation = session.generation.clone(); }
            parent.generation.is_none() || session.generation.is_none() || parent.generation == session.generation
        } else { !parent.seen }
    });
    let tokens = state.parents.keys().cloned().collect::<Vec<_>>();
    state.pending.retain(|_, pending| state_enabled && tokens.contains(&pending.token) && pending.deadline > Instant::now() && pending.worker.as_ref().is_none_or(|tool| agents.contains(tool)));
    let pending_children: Vec<String> = state.pending.values().map(|pending| pending.parent.clone()).collect();
    let mut changed = false;
    for task in &mut state.snapshot.tasks {
        if task.parent_native_id.is_none() {
            if let Some(native_id) = live.get(&task.parent_id).and_then(|parent| parent.native_id.clone()) { task.parent_native_id = Some(native_id); changed = true; }
        }
        if let Some(session) = live.get(&task.session_id) {
            if active(task) && task.generation.is_some() && session.generation.is_some() && task.generation != session.generation {
                task.phase = "closed".into(); changed = true;
            }
            if task.generation.is_none() && session.ready { task.generation = session.generation.clone(); changed = true; }
            if task.native_id.is_none() && session.native_id.is_some() { task.native_id = session.native_id.clone(); changed = true; }
            let activity = if session.error.is_some() { Some("error".into()) } else if session.ready { session.status.clone() } else if task.generation.is_some() { Some("disconnected".into()) } else { Some("starting".into()) };
            if task.activity != activity { task.activity = activity; changed = true; }
        } else if active(task) && task.phase != "starting" && !pending_children.contains(&task.parent_id) {
            task.phase = "closed".into(); changed = true;
        }
    }
    changed || coordinators != current_snapshot(state).coordinators
}

#[tauri::command]
pub fn orchestration_pending(request_id: String) -> bool {
    let state = hub().state.lock().unwrap();
    state.pending.get(&request_id).is_some_and(|pending| pending_allowed(&state, pending))
}
fn pending_allowed(state: &State, pending: &Pending) -> bool {
    pending.deadline > Instant::now() && parent(state, &pending.token).is_ok() && pending.worker.as_ref().is_none_or(|tool| state.snapshot.agents.contains(tool))
}
#[tauri::command]
pub fn orchestration_resolve(request_id: String, result: Value) -> Result<(), String> {
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    let pending = state.pending.remove(&request_id).ok_or("Request expired")?;
    pending.sender.send(result).map_err(|_| "Request expired".into())
}

fn initialize(app: &AppHandle) -> Result<u16, String> {
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    state.app = Some(app.clone());
    if let Some(port) = state.port { return Ok(port); }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port(); state.port = Some(port);
    std::thread::spawn(move || {
        let connections = Arc::new(AtomicUsize::new(0));
        for stream in listener.incoming().flatten() {
            if connections.fetch_add(1, Ordering::SeqCst) >= 64 { connections.fetch_sub(1, Ordering::SeqCst); continue; }
            let connections = connections.clone();
            std::thread::spawn(move || { let _ = serve_connection(stream); connections.fetch_sub(1, Ordering::SeqCst); });
        }
    });
    Ok(port)
}

/// Session-only MCP configuration: no hooks, project files or global agent settings are written.
pub fn parent_launch(app: &AppHandle, id: &str, native_id: &str, cwd: &Path) -> Result<Option<(String, String)>, String> {
    {
        let state = hub().state.lock().unwrap();
        if !state.snapshot.enabled || state.snapshot.agents.is_empty() || state.snapshot.tasks.iter().any(|task| task.session_id == id) { return Ok(None); }
    }
    let port = initialize(app)?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut state = hub().state.lock().unwrap();
    let agents = state.snapshot.agents.clone();
    state.parents.retain(|_, parent| parent.id != id);
    state.parents.insert(token.clone(), Parent { id: id.into(), native_id: Some(native_id.into()), tool: "claude".into(), agents: agents.clone(), connected: false, cwd: cwd.to_string_lossy().into_owned(), generation: None, seen: false });
    for task in &mut state.snapshot.tasks { if task.parent_native_id.as_deref() == Some(native_id) { task.parent_id = id.into(); } }
    publish(&mut state);
    let config = json!({"mcpServers":{"coffee-team":{"command":std::env::current_exe().map_err(|e| e.to_string())?,"args":["__team_mcp",port.to_string(),token]}}});
    Ok(Some((config.to_string(), coordinator_prompt(&agents))))
}

fn coordinator_prompt(agents: &[String]) -> String {
    format!("Coffee multi-agent orchestration is enabled. Available assistants: {}. You are the coordinator: decide for yourself whether delegation helps the user's task, which assistant to use, and how to divide the work. Handle simple tasks yourself. The user does not need to choose an executor or explicitly request delegation. Use coffee-team worker_start for useful, bounded tasks within the authorized project; each worker opens a visible child tab. Give clear goals and file ownership to avoid overlapping edits. Workers must not delegate further. Use worker_wait/worker_list to collect reports and questions; answer using worker_reply. Idle output is not task completion. Independently check worker results and summarize the overall outcome for the user; a worker report alone is not verification. Do not bypass user permission prompts or expand the user's authorized scope. On uncertain start/send, inspect worker_list rather than retrying automatically. Keep completed tabs available for the user. worker_list also returns the currently allowed assistants.", agents.join(", "))
}

fn parent(state: &State, token: &str) -> Result<Parent, String> {
    if !state.snapshot.enabled { return Err("Multi-agent orchestration is disabled".into()); }
    let parent = state.parents.get(token).ok_or("Coordinator session expired")?;
    let live = state.live.get(&parent.id).filter(|session| session.tool == parent.tool && session.ready && same_directory(&session.cwd, &parent.cwd) && (parent.native_id.is_none() || session.native_id == parent.native_id)).ok_or("Coordinator session is not ready or has closed")?;
    if parent.generation.is_some() && parent.generation != live.generation { return Err("Coordinator session restarted".into()); }
    Ok(parent.clone())
}
fn task_for(state: &State, parent_id: &str, task_id: &str) -> Result<Task, String> {
    state.snapshot.tasks.iter().find(|task| task.id == task_id && task.parent_id == parent_id).cloned().ok_or("Task does not belong to this coordinator".into())
}
fn text(args: &Value, key: &str, limit: usize) -> Result<String, String> {
    args[key].as_str().filter(|value| !value.trim().is_empty() && value.len() <= limit).map(str::to_owned).ok_or_else(|| format!("Invalid {key}"))
}
fn request_gui(token: &str, name: &str, arguments: Value, child_id: Option<&str>) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string(); let (sender, receiver) = mpsc::channel();
    {
        let mut state = hub().state.lock().unwrap();
        let owner = parent(&state, token)?;
        let worker = if name == "team_worker_start" { Some(text(&arguments, "tool", 32)?) } else { None };
        if worker.as_ref().is_some_and(|tool| !state.snapshot.agents.contains(tool)) { return Err("This worker is disabled in Agent configuration".into()); }
        let parent_id = &owner.id;
        let app = state.app.clone().ok_or("Coffee window unavailable")?;
        state.pending.insert(id.clone(), Pending { parent: parent_id.into(), token: token.into(), worker, deadline: Instant::now() + Duration::from_secs(80), sender });
        if app.emit_to("main", "orchestration-request", json!({"requestId":id,"name":name,"arguments":arguments,"parentId":parent_id,"sessionId":child_id,"background":true})).is_err() {
            state.pending.remove(&id); return Err("Coffee window unavailable".into());
        }
    }
    let result = receiver.recv_timeout(Duration::from_secs(80));
    hub().state.lock().unwrap().pending.remove(&id);
    let value = result.map_err(|_| "Execution is unconfirmed. Inspect worker_list; do not retry the operation automatically.")?;
    if value["ok"] != true { return Err(value["error"].as_str().unwrap_or("Operation failed").into()); }
    Ok(value["result"].clone())
}
fn worker_command(port: u16, token: &str) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    #[cfg(windows)] let executable = format!("& '{}'", exe.replace('\'', "''"));
    #[cfg(not(windows))] let executable = format!("'{}'", exe.replace('\'', "'\\''"));
    Ok(format!("{executable} __team_worker {port} {token}"))
}
pub fn log_args(args: &[String]) -> Vec<String> {
    args.iter().map(|arg| if arg.contains("__team_mcp") && arg.contains("coffee-team") { "[session coordination]".into() } else { arg.clone() }).collect()
}
fn worker_instructions(task: &Task, prompt: &str, command: &str) -> String {
    let shell_hint = if cfg!(windows) { "These examples use PowerShell. From Bash, invoke powershell.exe -NoProfile -Command with the entire command as its argument." } else { "These examples use a POSIX shell." };
    format!("You are a worker assigned from the parent session inside Coffee CLI. Task ID: {}. Work only on the task below and in the current project. Other workers may be editing it: coordinate file ownership and preserve their changes. Do not launch additional workers or change permissions.\n\n{shell_hint}\nReport exactly once using this local command, with a real concise summary:\n{command} complete --outcome succeeded --summary \"What changed, verification and remaining work\"\nUse --outcome failed when the task could not be completed. A final chat message alone does not reach the coordinator. For a blocking question, run:\n{command} ask --question \"Your question\"\nIf it returns pending, resume the same question with:\n{command} answer --question-id QUESTION_ID\nAfter reporting, stop and leave the tab open. If delivery is uncertain, do not resend automatically.\n\nTASK\n{prompt}", task.id)
}

fn start_worker(token: &str, args: &Value) -> Result<Value, String> {
    parent(&hub().state.lock().unwrap(), token)?;
    let tool = text(args, "tool", 32)?;
    if !default_agents().contains(&tool) { return Err("Choose claude, codex or opencode".into()); }
    if !crate::tools::find(&tool).is_some_and(|tool| crate::server::binary_on_path(tool.binary_name)) { return Err("The requested tool is not installed".into()); }
    let title = text(args, "title", 160)?; let prompt = text(args, "prompt", 24_000)?;
    let worker_token = uuid::Uuid::new_v4().to_string();
    let (task, port) = {
        let mut state = hub().state.lock().unwrap(); let parent = parent(&state, token)?;
        let child_id = uuid::Uuid::new_v4().to_string();
        if !state.snapshot.agents.contains(&tool) { return Err("This worker is disabled in Agent configuration".into()); }
        if state.snapshot.tasks.iter().filter(|task| task.parent_id == parent.id && active(task)).count() >= 6 { return Err("This coordinator already has six active workers".into()); }
        crate::session_directory::validate(Path::new(&parent.cwd))?;
        let task = Task { id: uuid::Uuid::new_v4().to_string(), parent_id: parent.id, parent_native_id: parent.native_id, parent_tool: parent.tool, session_id: child_id, native_id: None, tool, title, cwd: parent.cwd, phase: "starting".into(), summary: None, question: None, generation: None, activity: None };
        if state.snapshot.tasks.len() >= 200 {
            if let Some(index) = state.snapshot.tasks.iter().position(|task| !active(task)) {
                let removed = state.snapshot.tasks.remove(index);
                state.workers.retain(|_, id| *id != removed.id);
            }
            else { return Err("Task history is full".into()); }
        }
        state.snapshot.tasks.push(task.clone());
        if let Err(error) = save(&state.snapshot) { state.snapshot.tasks.pop(); return Err(error); }
        state.workers.insert(worker_token.clone(), task.id.clone()); publish(&mut state);
        (task, state.port.ok_or("Coordinator not running")?)
    };
    let command = worker_command(port, &worker_token)?;
    let instructions = worker_instructions(&task, &prompt, &command);
    let result = request_gui(token, "team_worker_start", json!({"tool":task.tool,"cwd":task.cwd,"text":instructions,"title":task.title}), Some(&task.session_id));
    let mut state = hub().state.lock().unwrap();
    if let Some(record) = state.snapshot.tasks.iter_mut().find(|record| record.id == task.id) {
        if record.phase == "starting" {
            match &result { Ok(_) => record.phase = "running".into(), Err(error) => { record.phase = "uncertain".into(); record.summary = Some(error.clone()); } }
        }
    }
    save(&state.snapshot)?; publish(&mut state);
    Ok(json!({"task":task_for(&state, &task.parent_id, &task.id)?,"delivery":result.ok(),"note":"A created tab is not proof of task success. Read its state; do not repeat a start after uncertain delivery."}))
}

fn parent_call(token: &str, action: &str, args: &Value) -> Result<Value, String> {
    if action == "worker_capabilities" {
        let mut state = hub().state.lock().unwrap();
        if !state.snapshot.enabled { return Err("Multi-agent orchestration is disabled".into()); }
        let owner = state.parents.get_mut(token).ok_or("Coordinator session expired")?;
        let changed = !owner.connected; owner.connected = true;
        if changed { publish(&mut state); }
        return Ok(json!({"agents":state.snapshot.agents}));
    }
    if action == "worker_start" { return start_worker(token, args); }
    let mut state = hub().state.lock().unwrap(); let owner = parent(&state, token)?;
    if matches!(action, "worker_list" | "worker_wait") {
        if action == "worker_wait" {
            let revision = args["revision"].as_u64().unwrap_or(state.snapshot.revision);
            let timeout = args["timeoutMs"].as_u64().unwrap_or(25_000).min(30_000);
            let deadline = Instant::now() + Duration::from_millis(timeout);
            while state.snapshot.revision <= revision && Instant::now() < deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                state = hub().changed.wait_timeout(state, remaining).map_err(|_| "Coordinator unavailable")?.0;
                parent(&state, token)?;
            }
        }
        return Ok(json!({"revision":state.snapshot.revision,"availableAgents":state.snapshot.agents,"tasks":state.snapshot.tasks.iter().filter(|task| task.parent_id == owner.id).collect::<Vec<_>>()}));
    }
    let task_id = text(args, "taskId", 80)?; let task = task_for(&state, &owner.id, &task_id)?;
    if action == "worker_reply" {
        let mut next = state.snapshot.clone();
        answer_question(&mut next, &task_id, args)?;
        save(&next)?; state.snapshot = next; publish(&mut state); return Ok(json!({"replied":true}));
    }
    if !matches!(action, "worker_read" | "worker_interrupt" | "worker_send") { return Err("Unknown coordination tool".into()); }
    let Some(live) = state.live.get(&task.session_id).filter(|session| session.ready && same_directory(&session.cwd, &task.cwd) && (task.generation.is_none() || session.generation == task.generation)).cloned() else {
        return Ok(json!({"task":task,"connected":false,"note":"The tab is closed or not ready. Do not create a replacement automatically."}));
    };
    if action != "worker_read" && !active(&task) { return Err("This dispatch has already settled".into()); }
    let generation = live.generation.ok_or("Worker is not ready")?;
    let message = if action == "worker_send" {
        let prompt = text(args, "text", 24_000)?;
        let token = state.workers.iter().find(|(_, id)| **id == task.id).map(|(token, _)| token).ok_or("Worker dispatch expired")?;
        Some(worker_instructions(&task, &prompt, &worker_command(state.port.ok_or("Coordinator unavailable")?, token)?))
    } else { None };
    drop(state);
    let name = if action == "worker_read" { "terminal_read_screen" } else if action == "worker_send" { "terminal_send" } else { "terminal_key" };
    let result = request_gui(token, name, json!({"sessionId":task.session_id,"generation":generation,"expectedCwd":task.cwd,"key":"CtrlC","text":message}), None)?;
    if matches!(action, "worker_interrupt" | "worker_send") {
        let mut state = hub().state.lock().unwrap();
        if let Some(task) = state.snapshot.tasks.iter_mut().find(|task| task.id == task_id && active(task)) {
            task.phase = if action == "worker_interrupt" { "interrupted" } else { "running" }.into(); task.summary = None;
        }
        save(&state.snapshot)?; publish(&mut state);
    }
    Ok(result)
}

fn answer_question(snapshot: &mut Snapshot, task_id: &str, args: &Value) -> Result<(), String> {
    let id = text(args, "questionId", 80)?; let answer = text(args, "answer", 8000)?;
    let task = snapshot.tasks.iter_mut().find(|task| task.id == task_id && active(task)).ok_or("Task has settled")?;
    let question = task.question.as_mut().filter(|question| question.id == id && question.answer.is_none()).ok_or("Question is no longer pending")?;
    question.answer = Some(answer); Ok(())
}
fn apply_report(snapshot: &mut Snapshot, id: &str, args: &Value) -> Result<(), String> {
    let outcome = text(args, "outcome", 32)?;
    if !matches!(outcome.as_str(), "succeeded" | "failed") { return Err("Use succeeded or failed".into()); }
    let summary = text(args, "summary", 12_000)?;
    let task = snapshot.tasks.iter_mut().find(|task| task.id == id && active(task)).ok_or("This dispatch has already settled; do not report again")?;
    task.phase = if outcome == "succeeded" { "completed" } else { "failed" }.into(); task.summary = Some(summary); task.question = None;
    Ok(())
}
fn worker_call(token: &str, action: &str, args: &Value) -> Result<Value, String> {
    let mut state = hub().state.lock().unwrap();
    let id = state.workers.get(token).cloned().ok_or("Worker token expired")?;
    let task = state.snapshot.tasks.iter().find(|task| task.id == id).ok_or("Task not found")?;
    if !active(task) { return Err("This dispatch has already settled; do not report again".into()); }
    if action == "complete" {
        let mut next = state.snapshot.clone(); apply_report(&mut next, &id, args)?;
        save(&next)?; state.snapshot = next; publish(&mut state); return Ok(json!({"accepted":true,"note":"Return to idle and leave the tab open."}));
    }
    if !matches!(action, "ask" | "answer") { return Err("Unknown worker operation".into()); }
    if !state.snapshot.enabled { return Err("Coordination has been disabled".into()); }
    let question_id = if action == "ask" {
        let question = text(args, "question", 8000)?;
        let task = state.snapshot.tasks.iter_mut().find(|task| task.id == id).unwrap();
        if task.question.as_ref().is_some_and(|q| q.answer.is_none()) { return Err("A question is already pending; wait for its answer".into()); }
        let question_id = uuid::Uuid::new_v4().to_string();
        task.question = Some(Question { id: question_id.clone(), text: question, answer: None }); save(&state.snapshot)?; publish(&mut state); question_id
    } else { text(args, "questionId", 80)? };
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let task = state.snapshot.tasks.iter().find(|task| task.id == id).ok_or("Task not found")?;
        if !active(task) || !state.snapshot.enabled { return Err("Task or coordinator has stopped".into()); }
        let question = task.question.as_ref().filter(|question| question.id == question_id).ok_or("Question no longer exists")?;
        if let Some(answer) = &question.answer { return Ok(json!({"questionId":question_id,"answer":answer})); }
        if Instant::now() >= deadline { return Ok(json!({"questionId":question_id,"pending":true,"note":"Use the answer command with this question ID; do not create a duplicate question."})); }
        state = hub().changed.wait_timeout(state, deadline.saturating_duration_since(Instant::now())).map_err(|_| "Coordinator unavailable")?.0;
    }
}

fn serve_connection(mut stream: TcpStream) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let mut line = String::new(); BufReader::new(&stream).take(100_001).read_line(&mut line).map_err(|e| e.to_string())?;
    if line.len() > 100_000 { return Err("Request too large".into()); }
    let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let token = text(&request, "token", 80)?; let action = text(&request, "action", 80)?;
    let result = if request["worker"] == true { worker_call(&token, &action, &request["arguments"]) } else { parent_call(&token, &action, &request["arguments"]) };
    writeln!(stream, "{}", match result { Ok(value) => json!({"ok":true,"result":value}), Err(error) => json!({"ok":false,"error":error}) }).map_err(|e| e.to_string())
}
fn client(port: u16, token: &str, action: &str, arguments: Value, worker: bool) -> Result<Value, String> {
    let mut stream = TcpStream::connect_timeout(&SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(), Duration::from_secs(3)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(90))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    writeln!(stream, "{}", json!({"token":token,"action":action,"arguments":arguments,"worker":worker})).map_err(|e| e.to_string())?;
    let mut text = String::new(); BufReader::new(stream).take(1_000_001).read_line(&mut text).map_err(|e| e.to_string())?;
    if text.len() > 1_000_000 { return Err("Response too large".into()); }
    let response: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if response["ok"] != true { return Err(response["error"].as_str().unwrap_or("Coordination failed").into()); }
    Ok(response["result"].clone())
}
fn definitions(agents: &Value) -> Value {
    let string = json!({"type":"string"});
    let tools = [
        ("worker_start", "Delegate a bounded part of the user's authorized task to one available assistant in a visible child tab. Decide whether delegation is useful; handle simple tasks yourself. Do not repeat an uncertain start; inspect worker_list.", json!({"tool":{"type":"string","enum":agents},"title":string,"prompt":string}), vec!["tool","title","prompt"]),
        ("worker_list", "Read only this coordinator's tasks, reports and questions. A completed phase is the worker's report; inspect results before claiming success.", json!({}), vec![]),
        ("worker_wait", "Wait for task or question changes. Use the revision from worker_list or the last wait. No polling loop is needed inside workers.", json!({"revision":{"type":"integer"},"timeoutMs":{"type":"integer","maximum":30000}}), vec![]),
        ("worker_read", "Read the existing worker session. Does not resume or replace closed sessions.", json!({"taskId":string}), vec!["taskId"]),
        ("worker_send", "Send a follow-up to an existing active worker after reading it. Never use this to approve prompts or automatically retry uncertain delivery. A worker awaiting initial setup has received no task; include the task and reporting instructions when explicitly resuming it.", json!({"taskId":string,"text":string}), vec!["taskId","text"]),
        ("worker_reply", "Answer a pending worker question. Do not approve permission prompts on the user's behalf.", json!({"taskId":string,"questionId":string,"answer":string}), vec!["taskId","questionId","answer"]),
        ("worker_interrupt", "Interrupt an active worker while leaving its visible tab available.", json!({"taskId":string}), vec!["taskId"]),
    ].into_iter().map(|(name, description, properties, required)| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect::<Vec<_>>();
    json!({"tools":tools})
}
fn mcp_response(port: u16, token: &str, request: &Value) -> Value {
    let id = request["id"].clone();
    let result = match request["method"].as_str() {
        Some("initialize") => json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"Coffee Team","version":env!("CARGO_PKG_VERSION")}}),
        Some("ping") => json!({}), Some("tools/list") => match client(port, token, "worker_capabilities", json!({}), false) {
            Ok(value) => definitions(&value["agents"]),
            Err(error) => return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error}}),
        },
        Some("tools/call") => {
            let result = client(port, token, request["params"]["name"].as_str().unwrap_or(""), request["params"].get("arguments").cloned().unwrap_or(json!({})), false);
            match result { Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}), Err(error) => json!({"isError":true,"content":[{"type":"text","text":error}]}) }
        }
        _ => return json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unknown method"}}),
    };
    json!({"jsonrpc":"2.0","id":id,"result":result})
}
pub fn mcp(port: u16, token: &str) -> Result<(), String> {
    fn write(value: Value) {
        let mut output = std::io::stdout().lock();
        let _ = writeln!(output, "{value}"); let _ = output.flush();
    }
    let mut input = std::io::stdin().lock();
    let calls = AtomicUsize::new(0);
    std::thread::scope(|scope| -> Result<(), String> {
        loop {
            let mut line = String::new();
            if Read::by_ref(&mut input).take(100_001).read_line(&mut line).map_err(|e| e.to_string())? == 0 { break; }
            if line.len() > 100_000 { return Err("Request too large".into()); }
            let Ok(request) = serde_json::from_str::<Value>(&line) else { continue; };
            if request.get("id").is_none() { continue; }
            if request["method"] != "tools/call" { write(mcp_response(port, token, &request)); continue; }
            if calls.fetch_add(1, Ordering::SeqCst) >= 16 {
                calls.fetch_sub(1, Ordering::SeqCst);
                write(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"Too many pending coordination requests"}})); continue;
            }
            let calls = &calls;
            scope.spawn(move || { write(mcp_response(port, token, &request)); calls.fetch_sub(1, Ordering::SeqCst); });
        }
        Ok(())
    })
}

pub fn worker_cli(port: u16, token: &str, arguments: &[String]) -> Result<(), String> {
    let action = arguments.first().ok_or("Worker action missing")?;
    let mut payload = json!({});
    if arguments.len() % 2 != 1 { return Err("Use named worker flags".into()); }
    for pair in arguments[1..].chunks_exact(2) {
        let key = match pair[0].as_str() { "--outcome" => "outcome", "--summary" => "summary", "--question" => "question", "--question-id" => "questionId", _ => return Err("Unknown worker flag".into()) };
        payload[key] = json!(pair[1]);
    }
    println!("{}", client(port, token, action, payload, true)?); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> State {
        let task = Task { id: "task".into(), parent_id: "parent".into(), parent_native_id: Some("native-parent".into()), session_id: "child".into(), parent_tool: "claude".into(), native_id: None, tool: "codex".into(), title: "Review".into(), cwd: "D:\\Project".into(), phase: "running".into(), summary: None, question: None, generation: None, activity: None };
        State { snapshot: Snapshot { enabled: true, agents: default_agents(), tasks: vec![task], revision: 0, coordinators: vec![] }, live: HashMap::new(), parents: HashMap::from([("token".into(), Parent { id: "parent".into(), native_id: Some("native-parent".into()), tool: "claude".into(), agents: default_agents(), connected: false, cwd: "D:\\Project".into(), generation: None, seen: false })]), workers: HashMap::new(), pending: HashMap::new(), app: None, port: None }
    }
    fn live(id: &str, tool: &str, generation: &str) -> LiveSession {
        LiveSession { id: id.into(), tool: tool.into(), cwd: "D:\\Project".into(), generation: Some(generation.into()), native_id: Some(format!("native-{id}")), ready: true, status: Some("idle".into()), error: None }
    }
    #[test]
    fn disabled_by_default_and_auth_scoped_to_live_claude_generation() {
        assert!(!Snapshot::default().enabled);
        let mut state = fixture(); sync_live(&mut state, vec![live("parent", "claude", "g1")]);
        assert!(parent(&state, "token").is_ok()); assert!(parent(&state, "other-token").is_err());
        state.snapshot.enabled = false; assert!(parent(&state, "token").is_err()); state.snapshot.enabled = true;
        state.live.get_mut("parent").unwrap().tool = "codex".into(); assert!(parent(&state, "token").is_err());
        sync_live(&mut state, vec![live("parent", "claude", "g2")]); assert!(parent(&state, "token").is_err());
    }
    #[test]
    fn coordinator_requires_same_directory_and_native_session() {
        let mut state = fixture(); sync_live(&mut state, vec![live("parent", "claude", "g1")]);
        state.live.get_mut("parent").unwrap().cwd = "d:/project/".into(); assert!(parent(&state, "token").is_ok());
        state.live.get_mut("parent").unwrap().cwd = "D:\\Other".into(); assert!(parent(&state, "token").is_err());
        state.live.get_mut("parent").unwrap().cwd = "D:\\Project".into(); state.live.get_mut("parent").unwrap().native_id = Some("different".into()); assert!(parent(&state, "token").is_err());
        assert!(!same_directory("/Project", "/project"));
    }
    #[test]
    fn coordinator_is_independent_of_selected_worker_types() {
        let mut state = fixture(); state.snapshot.agents = vec!["codex".into()];
        sync_live(&mut state, vec![live("parent", "claude", "g1")]);
        assert!(parent(&state, "token").is_ok());
        let prompt = coordinator_prompt(&state.snapshot.agents);
        assert!(prompt.contains("Available assistants: codex."));
        assert!(prompt.contains("Handle simple tasks yourself"));
        assert!(prompt.contains("Independently check worker results"));
        assert!(!prompt.contains("when the user asks to delegate"));
        let old: Snapshot = serde_json::from_value(json!({"enabled":true,"tasks":[],"revision":0,"coordinators":["stale"]})).unwrap();
        assert_eq!(old.agents, default_agents()); assert!(old.coordinators.is_empty());
    }
    #[test]
    fn enabled_badge_requires_discovery_live_session_and_current_assistant_pool() {
        let mut state = fixture();
        assert!(current_snapshot(&state).coordinators.is_empty());
        state.parents.get_mut("token").unwrap().connected = true;
        assert!(current_snapshot(&state).coordinators.is_empty());
        assert!(sync_live(&mut state, vec![live("parent", "claude", "g1")]));
        assert_eq!(current_snapshot(&state).coordinators, vec!["parent"]);
        state.snapshot.agents = vec!["codex".into()];
        assert!(current_snapshot(&state).coordinators.is_empty());
        state.snapshot.agents = default_agents();
        let mut disconnected = live("parent", "claude", "g1"); disconnected.ready = false;
        assert!(sync_live(&mut state, vec![disconnected]));
        assert!(current_snapshot(&state).coordinators.is_empty());
    }
    #[test]
    fn late_native_identity_attaches_to_source_and_child_history_without_expiring_dispatch() {
        let mut state = fixture(); state.parents.get_mut("token").unwrap().native_id = None; state.snapshot.tasks[0].parent_native_id = None;
        let mut source = live("parent", "claude", "g1"); source.native_id = None;
        sync_live(&mut state, vec![source.clone()]); assert!(parent(&state, "token").is_ok());
        source.native_id = Some("assigned-later".into()); sync_live(&mut state, vec![source]);
        assert!(parent(&state, "token").is_ok());
        assert_eq!(state.snapshot.tasks[0].parent_native_id.as_deref(), Some("assigned-later"));
    }
    #[test]
    fn task_access_is_limited_to_owner_and_idle_is_not_completion() {
        let mut state = fixture(); sync_live(&mut state, vec![live("child", "codex", "g1")]);
        let task = task_for(&state, "parent", "task").unwrap();
        assert_eq!(task.phase, "running"); assert_eq!(task.activity.as_deref(), Some("idle"));
        assert!(task_for(&state, "other-parent", "task").is_err());
    }
    #[test]
    fn worker_generation_change_retires_dispatch_without_rebinding() {
        let mut state = fixture(); sync_live(&mut state, vec![live("child", "codex", "g1")]);
        sync_live(&mut state, vec![live("child", "codex", "g2")]);
        assert_eq!(state.snapshot.tasks[0].phase, "closed"); assert_eq!(state.snapshot.tasks[0].generation.as_deref(), Some("g1"));
        assert!(apply_report(&mut state.snapshot, "task", &json!({"outcome":"succeeded","summary":"late"})).is_err());
    }
    #[test]
    fn closing_coordinator_revokes_pending_requests_and_closing_child_retires_task() {
        let mut state = fixture(); sync_live(&mut state, vec![live("parent", "claude", "g1"), live("child", "codex", "g1")]);
        let (sender, receiver) = mpsc::channel();
        state.pending.insert("request".into(), Pending { parent: "parent".into(), token: "token".into(), worker: Some("codex".into()), deadline: Instant::now() + Duration::from_secs(80), sender });
        sync_live(&mut state, vec![live("child", "codex", "g1")]);
        assert!(state.parents.is_empty()); assert!(state.pending.is_empty()); assert!(receiver.recv().is_err());
        assert_eq!(state.snapshot.tasks[0].phase, "running");
        sync_live(&mut state, vec![]); assert_eq!(state.snapshot.tasks[0].phase, "closed");
    }
    #[test]
    fn disabling_a_worker_cancels_its_start_but_preserves_existing_session_controls() {
        let mut state = fixture(); sync_live(&mut state, vec![live("parent", "claude", "g1")]);
        let (sender, _) = mpsc::channel();
        let mut pending = Pending { parent: "parent".into(), token: "token".into(), worker: Some("codex".into()), deadline: Instant::now() + Duration::from_secs(80), sender };
        assert!(pending_allowed(&state, &pending));
        state.snapshot.agents.retain(|tool| tool != "codex");
        assert!(!pending_allowed(&state, &pending));
        pending.worker = None; assert!(pending_allowed(&state, &pending));
    }
    #[test]
    fn startup_registry_lag_does_not_close_child_and_uncertain_missing_child_eventually_closes() {
        let mut state = fixture(); state.snapshot.tasks[0].phase = "starting".into();
        sync_live(&mut state, vec![]); assert_eq!(state.snapshot.tasks[0].phase, "starting");
        state.snapshot.tasks[0].phase = "uncertain".into(); sync_live(&mut state, vec![]); assert_eq!(state.snapshot.tasks[0].phase, "closed");
    }
    #[test]
    fn explicit_report_is_once_only_and_preserves_visible_session() {
        let mut state = fixture();
        apply_report(&mut state.snapshot, "task", &json!({"outcome":"succeeded","summary":"Verified tests"})).unwrap();
        assert_eq!(state.snapshot.tasks[0].phase, "completed"); assert_eq!(state.snapshot.tasks[0].session_id, "child");
        assert!(apply_report(&mut state.snapshot, "task", &json!({"outcome":"failed","summary":"duplicate"})).is_err());
        sync_live(&mut state, vec![]); assert_eq!(state.snapshot.tasks[0].phase, "completed");
        state.snapshot.tasks[0].phase = "running".into();
        assert!(apply_report(&mut state.snapshot, "task", &json!({"outcome":"unknown","summary":"x"})).is_err());
        assert!(apply_report(&mut state.snapshot, "task", &json!({"outcome":"succeeded","summary":" "})).is_err());
    }
    #[test]
    fn questions_have_single_matching_answer_and_are_cleared_on_report() {
        let mut state = fixture(); state.snapshot.tasks[0].question = Some(Question { id: "question".into(), text: "Which file?".into(), answer: None });
        assert!(answer_question(&mut state.snapshot, "task", &json!({"questionId":"wrong","answer":"A"})).is_err());
        answer_question(&mut state.snapshot, "task", &json!({"questionId":"question","answer":"A"})).unwrap();
        assert_eq!(state.snapshot.tasks[0].question.as_ref().unwrap().answer.as_deref(), Some("A"));
        assert!(answer_question(&mut state.snapshot, "task", &json!({"questionId":"question","answer":"B"})).is_err());
        apply_report(&mut state.snapshot, "task", &json!({"outcome":"failed","summary":"Cannot proceed"})).unwrap();
        assert!(state.snapshot.tasks[0].question.is_none());
    }
    #[test]
    fn loopback_transport_round_trip_keeps_role_and_payload() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap(); let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap(); let mut line = String::new(); BufReader::new(&stream).read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap(); assert_eq!(request["token"], "secret"); assert_eq!(request["worker"], true); assert_eq!(request["arguments"]["summary"], "测试完成");
            writeln!(stream, "{}", json!({"ok":true,"result":{"accepted":true}})).unwrap();
        });
        assert_eq!(client(port, "secret", "complete", json!({"summary":"测试完成"}), true).unwrap()["accepted"], true); server.join().unwrap();
    }
    #[test]
    fn mcp_handshake_and_tools_do_not_offer_unrelated_session_access() {
        let result = mcp_response(1, "unused", &json!({"id":1,"method":"initialize"}));
        assert_eq!(result["result"]["capabilities"]["tools"], json!({}));
        let tools = definitions(&json!(["codex","opencode"])); let tools = tools["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 7); assert!(tools.iter().all(|tool| tool["name"].as_str().unwrap().starts_with("worker_")));
        let start = tools.iter().find(|tool| tool["name"] == "worker_start").unwrap();
        assert_eq!(start["inputSchema"]["properties"]["tool"]["enum"], json!(["codex","opencode"])); assert!(start["inputSchema"]["properties"].get("cwd").is_none());
    }
    #[test]
    fn generated_worker_prompt_uses_existing_dispatch_and_auth_is_redacted_in_logs() {
        let state = fixture(); let prompt = worker_instructions(&state.snapshot.tasks[0], "Review only", "worker-command");
        assert!(prompt.contains("Task ID: task")); assert!(prompt.contains("worker-command complete")); assert!(prompt.ends_with("TASK\nReview only"));
        let config = json!({"mcpServers":{"coffee-team":{"args":["__team_mcp",1234,"secret-token"]}}}).to_string();
        assert!(!log_args(&["--mcp-config".into(), config]).join(" ").contains("secret-token"));
        assert_eq!(log_args(&["--model".into(), "model-id".into()]), vec!["--model", "model-id"]);
    }
}
