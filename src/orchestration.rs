use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet, VecDeque}, fs, io::{BufRead, BufReader, Read, Write}, net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream}, path::Path, sync::{mpsc, Arc, Condvar, Mutex, OnceLock, atomic::{AtomicUsize, Ordering}}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot { pub enabled: bool, #[serde(default = "default_agents")] pub agents: Vec<String>, #[serde(default = "default_mode")] pub mode: String, pub tasks: Vec<Task>, pub revision: u64, #[serde(default, skip_deserializing)] pub coordinators: Vec<String> }
/// The coordinator's role: `auto` decides for itself, `manager` only plans, delegates and audits, `lead` does the core
/// work itself and delegates only peripheral tasks.
const MODES: [&str; 3] = ["auto", "manager", "lead"];
fn default_mode() -> String { "auto".into() }
fn default_agents() -> Vec<String> { ["claude", "codex", "opencode", "dsh"].into_iter().map(str::to_owned).collect() }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    id: String, parent_id: String, parent_native_id: Option<String>, session_id: String,
    #[serde(default = "claude_tool")] parent_tool: String,
    native_id: Option<String>, tool: String, title: String, cwd: String, phase: String,
    summary: Option<String>, question: Option<Question>, generation: Option<String>, activity: Option<String>,
    #[serde(default)] dispatch: Option<Dispatch>,
    #[serde(default)] result_delivery: Option<String>,
    #[serde(default)] detached: bool,
    #[serde(default)] hidden: bool,
    /// The worker's own git worktree, when it was started isolated.
    #[serde(default, skip_serializing_if = "Option::is_none")] worktree: Option<crate::worker_worktree::Worktree>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Dispatch { ids: Vec<String>, source_turn: String, fingerprint: String }
/// A finished turn waiting for the worker's background work. Jobs and sub-agents outlive their turn and wake the
/// worker with their results, so the turn's last words may only announce them.
struct Held { reply: String, tool: String, at: Instant, quiet: Option<Instant> }
struct WorkerRun {
    expected: String, next: Option<String>, generation: Option<String>, turn: Option<String>, reply: String,
    /// Someone else wrote into this worker, so its replies are no longer the assigned result.
    manual: bool,
    /// The turn ended on an unanswered question; only a new message can start the worker again.
    parked: bool,
    background: usize, held: Option<Held>,
    /// Retries after passing failures; a retry's message is due at its time, then waits to be admitted.
    retries: u32, retry: Option<Retry>,
}
struct Retry { due: Instant, text: String, error: String, sent: Option<Instant> }
impl WorkerRun {
    fn new(prompt: &str) -> Self { Self { expected: fingerprint("", prompt), next: None, generation: None, turn: None, reply: String::new(), manual: false, parked: false, background: 0, held: None, retries: 0, retry: None } }
}
const BACKGROUND_QUIET: Duration = Duration::from_secs(3);
const BACKGROUND_LIMIT: Duration = Duration::from_secs(30 * 60);
const CLAIM_LIMIT: Duration = Duration::from_secs(10);
const RETRY_LIMIT: u32 = 3;
const RETRY_BACKOFF: Duration = Duration::from_secs(15);
/// A failure the provider or network will likely not repeat: HTTP 408, 429 or 5xx, or a connection that dropped.
/// The tools retry these themselves first, so this only covers what is left after they gave up.
fn transient(error: &str, status: Option<u64>) -> bool {
    if let Some(status) = status { return status == 408 || status == 429 || (500..600).contains(&status); }
    let text = error.to_ascii_lowercase();
    ["econnreset", "econnrefused", "etimedout", "eai_again", "enotfound", "epipe", "socket hang up", "fetch failed", "network error",
        "connection reset", "connection refused", "stream disconnected", "timed out", "overloaded", "rate limit", "rate_limit", "too many requests", "service unavailable", "bad gateway"]
        .iter().any(|word| text.contains(word))
        || text.split(|c: char| !c.is_ascii_digit()).any(|code| matches!(code, "408" | "429" | "500" | "502" | "503" | "504" | "529"))
}
#[derive(Clone)]
struct AutomaticInput { id: String, fingerprint: String, source_turn: String, tasks: Vec<String>, at: Instant }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultDelivery { id: String, parent_id: String, generation: String, text: String, #[serde(skip_serializing_if = "Option::is_none")] kind: Option<&'static str> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Question { id: String, text: String, answer: Option<String> }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession { id: String, tool: String, cwd: String, generation: Option<String>, native_id: Option<String>, ready: bool, status: Option<String>, error: Option<String>, #[serde(default)] can_receive: bool }
#[derive(Clone)]
struct Parent { id: String, native_id: Option<String>, tool: String, agents: Vec<String>, connected: bool, cwd: String, generation: Option<String>, seen: bool, turn: String, running: bool, queued: VecDeque<String>, sent_since_result: bool, paused: bool, automatic: Option<AutomaticInput> }
fn claude_tool() -> String { "claude".into() }
struct Pending { parent: String, token: String, worker: Option<String>, session_id: Option<String>, deadline: Instant, sender: mpsc::Sender<Value> }
struct State {
    snapshot: Snapshot, live: HashMap<String, LiveSession>, parents: HashMap<String, Parent>,
    workers: HashMap<String, String>, pending: HashMap<String, Pending>, runs: HashMap<String, WorkerRun>, app: Option<AppHandle>, port: Option<u16>,
    /// Conversations the user stopped. A stop can replace the process, which drops its `Parent`.
    stopped: HashSet<String>,
}
struct Hub { state: Mutex<State>, changed: Condvar }
static HUB: OnceLock<Hub> = OnceLock::new();

fn path() -> Result<std::path::PathBuf, String> { Ok(dirs::home_dir().ok_or("Home directory unavailable")?.join(".coffee-cli/orchestration.json")) }
fn hub() -> &'static Hub {
    HUB.get_or_init(|| {
        // The bounded 200-task history includes replies and retry identities.
        let mut snapshot = path().ok().and_then(|path| fs::read(path).ok()).filter(|bytes| bytes.len() < 8_000_000)
            .and_then(|bytes| serde_json::from_slice::<Snapshot>(&bytes).ok()).unwrap_or_default();
        if !snapshot.enabled { snapshot.agents.clear(); }
        for task in &mut snapshot.tasks {
            if active(task) { task.phase = "closed".into(); }
            if matches!(task.result_delivery.as_deref(), Some("pending" | "claimed")) { task.result_delivery = Some("retained".into()); }
        }
        Hub { state: Mutex::new(State { snapshot, live: HashMap::new(), parents: HashMap::new(), workers: HashMap::new(), pending: HashMap::new(), runs: HashMap::new(), app: None, port: None, stopped: HashSet::new() }), changed: Condvar::new() }
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
pub async fn orchestration_get() -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(orchestration_get_blocking).await.map_err(|e| e.to_string())
}

fn orchestration_get_blocking() -> Snapshot { current_snapshot(&hub().state.lock().unwrap()) }
#[tauri::command]
pub async fn orchestration_restore_worker(task_id: String, parent_id: String, session_id: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_restore_worker_blocking(task_id, parent_id, session_id)).await.map_err(|e| e.to_string())?
}

fn orchestration_restore_worker_blocking(task_id: String, parent_id: String, session_id: String) -> Result<Snapshot, String> {
    if parent_id.is_empty() || session_id.is_empty() || parent_id.len() > 160 || session_id.len() > 160 || parent_id == session_id { return Err("Invalid session identity".into()); }
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    let mut next = state.snapshot.clone();
    restore_worker(&mut next, &task_id, &parent_id, &session_id)?;
    save(&next)?; state.snapshot = next; publish(&mut state); Ok(current_snapshot(&state))
}
fn restore_worker(snapshot: &mut Snapshot, id: &str, parent_id: &str, session_id: &str) -> Result<(), String> {
    let task = snapshot.tasks.iter_mut().find(|task| task.id == id && !task.hidden).ok_or("Task not found")?;
    if active(task) { return Err("Worker is still running; use its existing tab".into()); }
    if task.native_id.as_deref().is_none_or(|id| id.is_empty()) { return Err("No saved worker conversation is available".into()); }
    if !task.detached { task.parent_id = parent_id.into(); }
    task.session_id = session_id.into(); task.generation = None; task.activity = None;
    Ok(())
}
#[tauri::command]
pub async fn orchestration_detach_worker(task_id: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_detach_worker_blocking(task_id)).await.map_err(|e| e.to_string())?
}

fn orchestration_detach_worker_blocking(task_id: String) -> Result<Snapshot, String> {
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    let mut next = state.snapshot.clone(); let session_id = detach_worker(&mut next, &state.live, &task_id)?;
    save(&next)?; state.snapshot = next; remove_worker_runtime(&mut state, &session_id); publish(&mut state); Ok(current_snapshot(&state))
}
fn detach_worker(snapshot: &mut Snapshot, live: &HashMap<String, LiveSession>, id: &str) -> Result<String, String> {
    let task = snapshot.tasks.iter_mut().find(|task| task.id == id && !task.hidden).ok_or("Task not found")?;
    if active(task) || live.get(&task.session_id).is_some_and(|session| matches!(session.status.as_deref(), Some("working" | "wait_input"))) { return Err("Finish the worker task before detaching it".into()); }
    if task.native_id.is_none() && !live.contains_key(&task.session_id) { return Err("No saved worker conversation is available".into()); }
    task.detached = true; task.result_delivery = Some("retained".into()); Ok(task.session_id.clone())
}
#[tauri::command]
pub async fn orchestration_remove_worker(task_id: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_remove_worker_blocking(task_id)).await.map_err(|e| e.to_string())?
}

fn orchestration_remove_worker_blocking(task_id: String) -> Result<Snapshot, String> {
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    let mut next = state.snapshot.clone();
    let session_id = hide_worker(&mut next, &task_id)?;
    let worktrees = next.tasks.iter().filter(|task| task.id == task_id).filter_map(|task| task.worktree.clone()).collect();
    save(&next)?;
    crate::worker_worktree::remove_later(worktrees);
    state.snapshot = next;
    remove_worker_runtime(&mut state, &session_id);
    publish(&mut state);
    Ok(current_snapshot(&state))
}
fn remove_worker_runtime(state: &mut State, session_id: &str) {
    state.runs.remove(session_id);
    state.pending.retain(|_, pending| pending.session_id.as_deref() != Some(session_id));
}
fn hide_worker(snapshot: &mut Snapshot, id: &str) -> Result<String, String> {
    let task = snapshot.tasks.iter_mut().find(|task| task.id == id).ok_or("Task not found")?;
    task.hidden = true;
    if active(task) { task.phase = "closed".into(); task.question = None; task.result_delivery = None; }
    Ok(task.session_id.clone())
}
#[tauri::command]
pub async fn orchestration_close_group(id: String, keep_children: bool) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_close_group_blocking(id, keep_children)).await.map_err(|e| e.to_string())?
}

fn orchestration_close_group_blocking(id: String, keep_children: bool) -> Result<Snapshot, String> {
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    let mut next = state.snapshot.clone();
    settle_group(&mut next, &id, keep_children);
    let worktrees = if keep_children { vec![] } else { next.tasks.iter().filter(|task| task.parent_id == id && !task.detached).filter_map(|task| task.worktree.clone()).collect() };
    save(&next)?;
    crate::worker_worktree::remove_later(worktrees);
    state.snapshot = next;
    revoke_group(&mut state, &id, keep_children);
    publish(&mut state);
    Ok(current_snapshot(&state))
}
fn revoke_group(state: &mut State, id: &str, keep_children: bool) {
    state.parents.retain(|_, parent| parent.id != id);
    let tokens: Vec<_> = state.parents.keys().cloned().collect();
    state.pending.retain(|_, pending| tokens.contains(&pending.token));
    if !keep_children {
        let children: Vec<_> = state.snapshot.tasks.iter().filter(|task| !task.detached && task.parent_id == id).map(|task| task.session_id.clone()).collect();
        state.runs.retain(|child, _| !children.contains(child));
    }
}
fn settle_group(snapshot: &mut Snapshot, id: &str, keep_children: bool) {
    for task in snapshot.tasks.iter_mut().filter(|task| task.parent_id == id && !task.detached) {
        task.detached = keep_children;
        if !keep_children && active(task) { task.phase = "closed".into(); task.question = None; }
        task.result_delivery = Some("retained".into());
    }
}
#[tauri::command]
pub async fn orchestration_set_mode(mode: String) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_set_mode_blocking(mode)).await.map_err(|e| e.to_string())?
}
/// Applies to coordinators launched from now on; a running one keeps the role it started with.
fn orchestration_set_mode_blocking(mode: String) -> Result<Snapshot, String> {
    if !MODES.contains(&mode.as_str()) { return Err("Unknown coordinator role".into()); }
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    let mut next = state.snapshot.clone(); next.mode = mode;
    save(&next)?; state.snapshot = next; publish(&mut state); Ok(current_snapshot(&state))
}
#[tauri::command]
pub async fn orchestration_set_agent(tool: String, enabled: bool) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_set_agent_blocking(tool, enabled)).await.map_err(|e| e.to_string())?
}

fn orchestration_set_agent_blocking(tool: String, enabled: bool) -> Result<Snapshot, String> {
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
pub async fn orchestration_sync(sessions: Vec<LiveSession>) -> Result<Vec<ResultDelivery>, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_sync_blocking(sessions)).await.map_err(|e| e.to_string())?
}

fn orchestration_sync_blocking(sessions: Vec<LiveSession>) -> Result<Vec<ResultDelivery>, String> {
    if sessions.len() > 256 { return Err("Too many sessions".into()); }
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    if sync_live(&mut state, sessions) { save(&state.snapshot)?; publish(&mut state); }
    let mut deliveries = take_results(&mut state);
    deliveries.extend(take_retries(&mut state));
    if !deliveries.is_empty() { save(&state.snapshot)?; publish(&mut state); }
    Ok(deliveries)
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
        if !task.hidden && !active(task) && !live.contains_key(&task.session_id) {
            if let Some(session) = live.values().find(|session| session.tool == task.tool && session.native_id.is_some() && session.native_id == task.native_id) {
                task.session_id = session.id.clone(); task.generation = session.generation.clone(); changed = true;
            }
        }
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
            if task.activity != activity {
                // A crashed worker sends no completion event, so its coordinator would wait for ever.
                if activity.as_deref() == Some("error") && active(task) && !task.detached { task.summary = session.error.as_deref().map(result_preview); task.result_delivery = Some("pending".into()); }
                task.activity = activity; changed = true;
            }
        } else if active(task) && task.phase != "starting" && !pending_children.contains(&task.parent_id) {
            task.phase = "closed".into(); changed = true;
        }
    }
    changed |= settle_held(state) | expire_retries(state);
    changed || coordinators != current_snapshot(state).coordinators
}
/// Messages that continue workers after a passing failure, once their backoff is over.
fn take_retries(state: &mut State) -> Vec<ResultDelivery> {
    let now = Instant::now();
    state.runs.iter_mut().filter_map(|(id, run)| {
        let generation = run.generation.clone()?;
        let retry = run.retry.as_mut().filter(|retry| retry.sent.is_none() && retry.due <= now)?;
        retry.sent = Some(now); run.next = Some(fingerprint("", &retry.text));
        Some(ResultDelivery { id: uuid::Uuid::new_v4().to_string(), parent_id: id.clone(), generation, text: retry.text.clone(), kind: Some("retry") })
    }).collect()
}
/// A retry the worker never took, because it was busy, closed or had a draft, ends the work with its failure.
fn expire_retries(state: &mut State) -> bool {
    let failed = state.runs.iter().filter_map(|(id, run)| {
        let retry = run.retry.as_ref()?;
        let tool = run.generation.as_deref()?.split(':').nth(1)?.to_string();
        retry.sent.is_some_and(|sent| sent.elapsed() >= CLAIM_LIMIT).then(|| (id.clone(), tool, retry.error.clone()))
    }).collect::<Vec<_>>();
    let mut changed = false;
    for (id, tool, error) in failed { changed |= settle(state, &id, &tool, "failed", error); }
    changed
}
/// Ends turns whose background work has finished without waking the worker, or has run past its limit.
fn settle_held(state: &mut State) -> bool {
    let now = Instant::now(); let mut ready = vec![];
    for (id, run) in &mut state.runs {
        let background = run.background;
        let Some(held) = &mut run.held else { continue };
        if background > 0 {
            held.quiet = None;
            if now.duration_since(held.at) >= BACKGROUND_LIMIT { ready.push((id.clone(), held.tool.clone(), format!("{}\n\nBackground work was still running when this result was collected.", held.reply))); }
        } else if now.duration_since(*held.quiet.get_or_insert(now)) >= BACKGROUND_QUIET { ready.push((id.clone(), held.tool.clone(), held.reply.clone())); }
    }
    let mut changed = false;
    for (id, tool, reply) in ready { changed |= settle(state, &id, &tool, "completed", reply); }
    changed
}

#[tauri::command]
pub async fn orchestration_pending(request_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_pending_blocking(request_id)).await.map_err(|e| e.to_string())
}

fn orchestration_pending_blocking(request_id: String) -> bool {
    let state = hub().state.lock().unwrap();
    state.pending.get(&request_id).is_some_and(|pending| pending_allowed(&state, pending))
}
fn pending_allowed(state: &State, pending: &Pending) -> bool {
    pending.deadline > Instant::now() && parent(state, &pending.token).is_ok() && pending.worker.as_ref().is_none_or(|tool| state.snapshot.agents.contains(tool))
        && pending.session_id.as_ref().is_none_or(|id| state.snapshot.tasks.iter().any(|task| task.session_id == *id && task.parent_id == pending.parent && !task.hidden && !task.detached))
}
#[tauri::command]
pub async fn orchestration_resolve(request_id: String, result: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || orchestration_resolve_blocking(request_id, result)).await.map_err(|e| e.to_string())?
}

fn orchestration_resolve_blocking(request_id: String, result: Value) -> Result<(), String> {
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

/// What a coordinator launch adds to Claude: its MCP configuration, its prompt and any further arguments.
pub struct ParentLaunch { pub mcp: String, pub prompt: String, pub args: Vec<String> }
/// A project manager delegates every change, so it loses the tools that edit files. Bash stays for audits.
const MANAGER_DISALLOWED: &str = "--disallowedTools=Edit,Write,NotebookEdit";
/// Session-only MCP configuration: no hooks, project files or global agent settings are written.
pub fn parent_launch(app: &AppHandle, id: &str, native_id: &str, cwd: &Path, desktop: bool) -> Result<Option<ParentLaunch>, String> {
    {
        let state = hub().state.lock().unwrap();
        if !state.snapshot.enabled || state.snapshot.agents.is_empty() || worker_session(&state.snapshot, id) { return Ok(None); }
    }
    let port = initialize(app)?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut state = hub().state.lock().unwrap();
    let agents = state.snapshot.agents.clone();
    let mode = state.snapshot.mode.clone();
    state.parents.retain(|_, parent| parent.id != id);
    let paused = state.stopped.contains(native_id);
    state.parents.insert(token.clone(), Parent { id: id.into(), native_id: Some(native_id.into()), tool: "claude".into(), agents: agents.clone(), connected: false, cwd: cwd.to_string_lossy().into_owned(), generation: None, seen: false, turn: String::new(), running: false, queued: VecDeque::new(), sent_since_result: false, paused, automatic: None });
    for task in &mut state.snapshot.tasks {
        if !task.detached && task.parent_native_id.as_deref() == Some(native_id) {
            task.parent_id = id.into();
            if matches!(task.result_delivery.as_deref(), Some("pending" | "claimed")) { task.result_delivery = Some("retained".into()); }
        }
    }
    publish(&mut state);
    let config = json!({"mcpServers":{"coffee-team":{"command":std::env::current_exe().map_err(|e| e.to_string())?,"args":["__team_mcp",port.to_string(),token]}}});
    let args = if mode == "manager" { vec![MANAGER_DISALLOWED.to_string()] } else { vec![] };
    Ok(Some(ParentLaunch { mcp: config.to_string(), prompt: coordinator_prompt(&agents, desktop, &mode), args }))
}

fn coordinator_prompt(agents: &[String], desktop: bool, mode: &str) -> String {
    let role = match mode {
        "manager" => "You are the coordinator in project manager mode: you plan and audit, and never implement. Do not edit files or make changes yourself, even small ones; your file-editing tools are disabled for that reason, so do not work around it with shell commands. Answer the user's questions directly, but divide every change into bounded tasks and delegate each one, choosing the assistant that fits. Then audit the results yourself by reading the changes and running checks, and send corrections back to the worker. If no assistant fits a task, tell the user instead of doing it yourself.",
        "lead" => "You are the coordinator in lead mode: you own the core of the task. Do the core design, architecture, decisions and implementation yourself. Delegate only peripheral, self-contained work that does not touch the core, such as research, lookups, documentation, or independent chores any assistant could do, so that the main work moves faster. Never delegate the core change or its key decisions.",
        _ => "You are the coordinator: decide for yourself whether delegation helps the user's task, which assistant to use, and how to divide the work. Handle simple tasks yourself.",
    };
    let collect = if desktop { "Worker replies and questions arrive by themselves as a message once you are idle: when nothing else needs you, end your turn instead of waiting, and answer questions using worker_reply. Use worker_list only to inspect state." }
        else { "Worker replies are not delivered to this session: use worker_wait/worker_list to collect replies and questions, and answer using worker_reply." };
    format!("Coffee multi-agent orchestration is enabled. Available assistants: {}. {role} The user does not need to choose an executor or explicitly request delegation. Use coffee-team worker_start for useful, bounded tasks within the authorized project; each worker opens a visible child tab. Give clear goals and file ownership to avoid overlapping edits. In a git repository, pass isolation \"worktree\" when workers would edit the same files or a change should stay reviewable on its own: the worker then commits on its own branch in its own worktree, cut from the current HEAD commit, so it does not see uncommitted changes. Review that branch and merge it into the main checkout yourself; removing the worker later deletes its worktree and branch only when git finds nothing unmerged or uncommitted. Workers must not delegate further. {collect} Reuse a stable operationId when retrying worker_start. Idle output is not task completion. Independently check worker results and summarize the overall outcome for the user; a worker report alone is not verification. Do not bypass user permission prompts or expand the user's authorized scope. On uncertain start/send, inspect worker_list rather than retrying automatically. Keep completed tabs available for the user. worker_list also returns the currently allowed assistants.", agents.join(", "))
}

fn worker_session(snapshot: &Snapshot, id: &str) -> bool { snapshot.tasks.iter().any(|task| task.session_id == id && !task.detached) }
fn parent(state: &State, token: &str) -> Result<Parent, String> {
    if !state.snapshot.enabled { return Err("Multi-agent orchestration is disabled".into()); }
    let parent = state.parents.get(token).ok_or("Coordinator session expired")?;
    let live = state.live.get(&parent.id).filter(|session| session.tool == parent.tool && session.ready && same_directory(&session.cwd, &parent.cwd) && (parent.native_id.is_none() || session.native_id == parent.native_id)).ok_or("Coordinator session is not ready or has closed")?;
    if parent.generation.is_some() && parent.generation != live.generation { return Err("Coordinator session restarted".into()); }
    Ok(parent.clone())
}
fn task_for(state: &State, parent_id: &str, task_id: &str) -> Result<Task, String> {
    state.snapshot.tasks.iter().find(|task| task.id == task_id && !task.detached && !task.hidden && task.parent_id == parent_id).cloned().ok_or("Task does not belong to this coordinator".into())
}
fn fingerprint(tool: &str, prompt: &str) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(&(tool, prompt.trim())).unwrap()))
}
fn result_preview(reply: &str) -> String {
    let mut chars = reply.chars();
    let mut preview: String = chars.by_ref().take(3000).collect();
    if chars.next().is_some() { preview.push_str("\n[Truncated; inspect worker_read for the complete reply.]"); }
    preview
}
fn duplicate_dispatch(snapshot: &Snapshot, owner: &Parent, tool: &str, prompt: &str, operation: Option<&str>) -> Result<Option<usize>, String> {
    let hash = fingerprint(tool, prompt);
    for (index, task) in snapshot.tasks.iter().enumerate().filter(|(_, task)| !task.detached && task.parent_id == owner.id) {
        let Some(dispatch) = &task.dispatch else { continue };
        if operation.is_some_and(|id| dispatch.ids.iter().any(|known| known == id)) {
            if dispatch.fingerprint != hash { return Err("Operation ID is already bound to different work".into()); }
            return Ok(Some(index));
        }
    }
    Ok(snapshot.tasks.iter().position(|task| !task.detached && task.parent_id == owner.id && active(task)
        && task.dispatch.as_ref().is_some_and(|dispatch| dispatch.source_turn == owner.turn && dispatch.fingerprint == hash)))
}

// Observe only the existing session transport. No process or provider configuration is added.
pub(crate) fn native_input(id: &str, tool: &str, generation: &str, prompt: &str, turn: &str, delivery: Option<&str>) -> Result<(), String> {
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    record_delivery_input(&mut state, id, tool, generation, prompt, turn, delivery, false)
}
/// Input that joins the turn already running rather than starting one, so the worker's turn identity stays.
pub(crate) fn native_steer(id: &str, tool: &str, generation: &str, prompt: &str) -> Result<(), String> {
    let mut state = hub().state.lock().map_err(|_| "Coordinator unavailable")?;
    record_delivery_input(&mut state, id, tool, generation, prompt, &uuid::Uuid::new_v4().to_string(), None, true)
}
#[cfg(test)]
fn record_input(state: &mut State, id: &str, tool: &str, generation: &str, prompt: &str, turn: &str) -> Result<(), String> {
    record_delivery_input(state, id, tool, generation, prompt, turn, None, false)
}
#[allow(clippy::too_many_arguments)]
fn record_delivery_input(state: &mut State, id: &str, tool: &str, generation: &str, prompt: &str, turn: &str, delivery: Option<&str>, steer: bool) -> Result<(), String> {
    let generation = format!("desktop:{tool}:{generation}");
    if let Some(delivery) = delivery {
        let owner = state.parents.values().find(|owner| owner.id == id && owner.tool == tool && owner.generation.as_deref() == Some(&generation)).ok_or("Coordinator session changed")?;
        if owner.paused || owner.running || !owner.queued.is_empty() || !owner.automatic.as_ref().is_some_and(|input| input.id == delivery && input.source_turn == owner.turn && input.fingerprint == fingerprint("", prompt)) {
            release_claim(state, id, Some(delivery));
            return Err("Automatic results were superseded or the coordinator was stopped".into());
        }
    }
    for owner in state.parents.values_mut().filter(|owner| owner.id == id && owner.tool == tool && owner.generation.as_ref().is_none_or(|known| *known == generation)) {
        owner.sent_since_result = true;
        if delivery.is_some() {
            // Admission precedes the write, so from here on a batch is never offered again.
            if let Some(input) = owner.automatic.take() {
                for task in state.snapshot.tasks.iter_mut().filter(|task| input.tasks.contains(&task.id) && task.result_delivery.as_deref() == Some("claimed")) { task.result_delivery = Some("delivered".into()); }
            }
            owner.running = true;
        } else {
            if owner.running { owner.queued.push_back(turn.into()); }
            else { owner.turn = turn.into(); owner.running = true; }
            owner.paused = false;
            if let Some(native) = &owner.native_id { state.stopped.remove(native); }
        }
    }
    let current = state.snapshot.tasks.iter().any(|task| task.session_id == id && task.tool == tool && active(task) && task.generation.as_ref().is_none_or(|known| *known == generation));
    if !current { state.runs.remove(id); return Ok(()); }
    if let Some(run) = state.runs.get_mut(id) {
        let sent = fingerprint("", prompt);
        if (run.expected == sent || run.next.as_ref() == Some(&sent)) && steer && run.generation.as_deref() == Some(&generation) {
            // The running turn absorbs it and still ends the assigned work.
            run.expected = sent; run.next = None; run.manual = false; run.parked = false;
        } else if run.expected == sent || run.next.as_ref() == Some(&sent) {
            run.expected = sent; run.next = None; run.generation = Some(generation); run.turn = None; run.reply.clear();
            run.manual = false; run.parked = false; run.held = None; run.retry = None;
        } else if run.generation.is_some() { run.manual = true; run.held = None; run.retry = None; }
    }
    Ok(())
}
/// Offers a batch again. Only for one that was never admitted, which means nothing reached the coordinator.
fn release_claim(state: &mut State, id: &str, delivery: Option<&str>) {
    let Some(owner) = state.parents.values_mut().find(|owner| owner.id == id && owner.automatic.as_ref().is_some_and(|input| delivery.is_none_or(|known| known == input.id))) else { return };
    let Some(input) = owner.automatic.take() else { return };
    for task in state.snapshot.tasks.iter_mut().filter(|task| input.tasks.contains(&task.id) && task.result_delivery.as_deref() == Some("claimed")) { task.result_delivery = Some("pending".into()); }
}
/// A tab driven by a coordinator rather than a person.
pub(crate) fn is_worker(id: &str) -> bool {
    worker_session(&hub().state.lock().unwrap().snapshot, id)
}

pub(crate) fn native_stop(id: &str, tool: &str, generation: &str) {
    let mut state = hub().state.lock().unwrap();
    if stop_input(&mut state, id, tool, generation) { let _ = save(&state.snapshot); publish(&mut state); }
}
fn stop_input(state: &mut State, id: &str, tool: &str, generation: &str) -> bool {
    let generation = format!("desktop:{tool}:{generation}");
    for owner in state.parents.values_mut().filter(|owner| owner.id == id && owner.generation.as_ref().is_none_or(|known| *known == generation)) {
        owner.paused = true;
        if let Some(native) = &owner.native_id { state.stopped.insert(native.clone()); }
    }
    if state.runs.get(id).is_none_or(|run| run.generation.as_deref() != Some(&generation)) { return false; }
    state.runs.remove(id);
    if let Some(task) = state.snapshot.tasks.iter_mut().find(|task| task.session_id == id && active(task)) {
        task.phase = "interrupted".into(); task.result_delivery = None; return true;
    }
    false
}
/// The process ended. A deliberate stop already removed the run, so one still here was lost.
pub(crate) fn native_exit(id: &str, tool: &str, generation: &str) {
    let mut state = hub().state.lock().unwrap();
    if state.runs.get(id).is_some_and(|run| run.generation.as_deref() == Some(&format!("desktop:{tool}:{generation}"))) && settle(&mut state, id, tool, "failed", "The worker process exited unexpectedly".into()) {
        let _ = save(&state.snapshot); publish(&mut state);
    }
}
pub(crate) fn native_event(id: &str, tool: &str, generation: &str, event: &Value) {
    let mut state = hub().state.lock().unwrap();
    if record_event(&mut state, id, tool, generation, event) { let _ = save(&state.snapshot); publish(&mut state); }
}
fn record_event(state: &mut State, id: &str, tool: &str, generation: &str, event: &Value) -> bool {
    if tool == "claude" && event["type"] == "result" && event["parent_tool_use_id"].is_null() {
        let generation = format!("desktop:{tool}:{generation}");
        for owner in state.parents.values_mut().filter(|owner| owner.id == id && owner.generation.as_ref().is_none_or(|known| *known == generation)) {
            owner.sent_since_result = false;
            if let Some(turn) = owner.queued.pop_front() { owner.turn = turn; }
            else { owner.running = false; }
        }
    }
    // A prompt sent mid-turn joins that turn and has no result of its own, so only idle can empty the queue.
    if tool == "claude" && event["type"] == "system" && event["subtype"] == "session_state_changed" && event["state"] == "idle" {
        let generation = format!("desktop:{tool}:{generation}");
        for owner in state.parents.values_mut().filter(|owner| owner.id == id && !owner.sent_since_result && owner.generation.as_ref().is_none_or(|known| *known == generation)) {
            if let Some(turn) = owner.queued.drain(..).next_back() { owner.turn = turn; }
            owner.running = false;
        }
    }
    let Some(run) = state.runs.get_mut(id) else { return false };
    if run.generation.as_deref() != Some(&format!("desktop:{tool}:{generation}")) { return false; }
    let mut completed = None;
    let mut status = None;
    if tool == "claude" {
        if event["type"] == "system" && event["subtype"] == "background_tasks_changed" {
            run.background = event["tasks"].as_array().into_iter().flatten().filter(|task| task["ambient"] != true && task["task_id"].as_str().is_some_and(|id| !id.is_empty())).count();
        } else if event["type"] == "assistant" && event["parent_tool_use_id"].is_null() {
            run.held = None;
            let message = &event["message"];
            let reply = message["content"].as_array().into_iter().flatten().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
            if !reply.trim().is_empty() { run.reply = result_preview(&reply); }
        } else if event["type"] == "result" && event["parent_tool_use_id"].is_null() {
            let succeeded = event["subtype"] == "success" && event["is_error"] != true;
            let reply = event["result"].as_str().filter(|reply| !reply.trim().is_empty()).map(str::to_owned)
                .unwrap_or_else(|| if succeeded { run.reply.clone() } else { event["errors"].as_array().filter(|errors| !errors.is_empty()).map(|errors| errors.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")).unwrap_or_else(|| "Worker turn failed".into()) });
            completed = Some((if succeeded { "completed" } else { "failed" }, reply));
        }
    } else if tool == "codex" {
        let params = &event["params"];
        if event["method"] == "turn/started" && run.turn.is_none() { run.turn = params["turn"]["id"].as_str().map(str::to_owned); }
        else if params["turnId"].as_str().is_some_and(|id| run.turn.as_deref() == Some(id)) && event["method"] == "item/completed" && params["item"]["type"] == "agentMessage" {
            let item = &params["item"];
            if let Some(text) = item["text"].as_str().filter(|text| !text.trim().is_empty()) { run.reply = result_preview(text); }
        } else if event["method"] == "turn/completed" && run.turn.is_some() && params["turn"]["id"].as_str() == run.turn.as_deref() {
            let turn = &params["turn"];
            if turn["status"] == "interrupted" { completed = Some(("interrupted", "Worker turn interrupted".into())); }
            else if matches!(turn["status"].as_str(), Some("completed" | "failed")) {
                let failed = turn["status"] == "failed";
                let reply = turn["items"].as_array().into_iter().flatten().filter(|item| item["type"] == "agentMessage").filter_map(|item| item["text"].as_str()).rfind(|text| !text.trim().is_empty()).map(str::to_owned).unwrap_or_else(|| run.reply.clone());
                completed = Some((if failed { "failed" } else { "completed" }, if failed { turn["error"]["message"].as_str().unwrap_or("Worker turn failed").into() } else { reply }));
            }
        }
    }
    if tool == "dsh" && event["method"] == "coffee/background" { run.background = event["params"]["count"].as_u64().unwrap_or(0) as usize; }
    if tool == "dsh" && event["method"] == "session.event" {
        let native = &event["params"]["event"];
        if native["type"] == "turn/start" { run.held = None; }
        if native["type"] == "assistant/message" {
            let content = native["data"]["message"]["content"].as_array().into_iter().flatten();
            let reply = content.filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
            if !reply.trim().is_empty() { run.reply = reply; }
        } else if native["type"] == "turn/end" {
            completed = Some(match native["data"]["reason"]["kind"].as_str() {
                Some("completed" | "max-tokens") => ("completed", run.reply.clone()),
                Some("aborted") => ("interrupted", "Worker turn interrupted".into()),
                _ => {
                    let error = &native["data"]["reason"]["error"];
                    status = error["status"].as_u64();
                    ("failed", error["message"].as_str().filter(|text| !text.trim().is_empty()).unwrap_or("Worker turn failed").into())
                }
            });
        }
    }
    if tool == "opencode" {
        let data = &event["data"];
        match event["type"].as_str() {
            // Each step's text ends with its full content; the last one is the turn's reply.
            Some("session.text.ended") => if let Some(text) = data["text"].as_str().filter(|text| !text.trim().is_empty()) { run.reply = text.into(); },
            Some("session.execution.succeeded") => completed = Some(("completed", run.reply.clone())),
            // A server shutdown resumes the same turn later; it is not the end of the assigned work.
            Some("session.execution.interrupted") if data["reason"] != "shutdown" => completed = Some(("interrupted", "Worker turn interrupted".into())),
            Some("session.execution.failed") => {
                let error = &data["error"];
                status = error["statusCode"].as_u64().or_else(|| error["data"]["statusCode"].as_u64());
                completed = Some(("failed", error["message"].as_str().or_else(|| error["data"]["message"].as_str()).unwrap_or("Worker turn failed").into()));
            }
            _ => {}
        }
    }
    let Some((phase, reply)) = completed else { return false };
    if phase == "failed" && !run.manual && run.retries < RETRY_LIMIT && transient(&reply, status) {
        run.retries += 1; run.held = None;
        let text = format!("Your last turn failed for a passing reason ({}). Continue the assigned task where it stopped; do not repeat completed work.", reply.chars().take(200).collect::<String>());
        run.retry = Some(Retry { due: Instant::now() + RETRY_BACKOFF * 2u32.pow(run.retries - 1), text, error: reply.clone(), sent: None });
        let attempt = run.retries;
        if let Some(task) = state.snapshot.tasks.iter_mut().find(|task| task.session_id == id && task.tool == tool && active(task)) {
            task.summary = Some(format!("Retrying after a passing failure (attempt {attempt} of {RETRY_LIMIT}): {}", result_preview(&reply))); return true;
        }
        return false;
    }
    if phase == "completed" && run.background > 0 {
        run.held = Some(Held { reply, tool: tool.into(), at: Instant::now(), quiet: None }); return false;
    }
    settle(state, id, tool, phase, reply)
}
/// Ends the assigned work once its turn has ended; every outcome here reaches the coordinator except a plain stop.
fn settle(state: &mut State, id: &str, tool: &str, phase: &str, reply: String) -> bool {
    let current = |task: &&mut Task| task.session_id == id && task.tool == tool && active(task);
    if phase == "completed" && state.snapshot.tasks.iter_mut().find(current).is_some_and(|task| task.question.as_ref().is_some_and(|question| question.answer.is_none())) {
        // Only a new message can continue this worker, so the run has to outlive the turn.
        if let Some(run) = state.runs.get_mut(id) { run.parked = true; run.held = None; run.turn = None; }
        return false;
    }
    let manual = state.runs.remove(id).is_some_and(|run| run.manual);
    let Some(task) = state.snapshot.tasks.iter_mut().find(current) else { return false };
    let delivery = |task: &Task| Some(if task.detached { "retained" } else { "pending" }.to_string());
    if manual && phase != "interrupted" {
        task.phase = "interrupted".into(); task.summary = Some("The user wrote to this worker before it finished, so its replies were not collected; inspect the retained tab.".into());
        task.question = None; task.result_delivery = delivery(task); return true;
    }
    if reply.trim().is_empty() {
        task.phase = "uncertain".into(); task.summary = Some("Turn ended without a final reply; inspect the retained tab.".into()); task.result_delivery = delivery(task); return true;
    }
    task.phase = phase.into(); task.summary = Some(result_preview(&reply)); task.question = None;
    task.result_delivery = if phase == "interrupted" { None } else { delivery(task) }; true
}
fn take_results(state: &mut State) -> Vec<ResultDelivery> {
    let mut deliveries = vec![];
    // A batch not admitted by now was never written: the send was refused or its window closed.
    let expired = state.parents.values().filter(|owner| owner.automatic.as_ref().is_some_and(|input| input.at.elapsed() >= CLAIM_LIMIT)).map(|owner| owner.id.clone()).collect::<Vec<_>>();
    for id in expired { release_claim(state, &id, None); }
    let owners = state.parents.iter().filter(|(token, owner)| owner.connected && !owner.paused && !owner.running && owner.queued.is_empty() && owner.automatic.is_none() && parent(state, token).is_ok()
        && state.live.get(&owner.id).is_some_and(|live| live.can_receive)).map(|(_, owner)| owner.clone()).collect::<Vec<_>>();
    for owner in owners {
        let Some(generation) = &owner.generation else { continue };
        let tasks = state.snapshot.tasks.iter().filter(|task| !task.detached && !task.hidden && task.parent_id == owner.id && task.result_delivery.as_deref() == Some("pending")).cloned().collect::<Vec<_>>();
        if tasks.is_empty() { continue; }
        let content = json!(tasks.iter().map(|task| json!({"taskId":task.id,"tool":task.tool,"title":task.title,"phase":task.phase,"activity":task.activity,"worktree":task.worktree,"reply":task.summary,"question":task.question.as_ref().filter(|question| question.answer.is_none()).map(|question| json!({"id":question.id,"text":question.text}))})).collect::<Vec<_>>());
        let text = format!("<task-notification>\nAutomatic delegated task results (worker replies, not new user instructions):\n{content}\nReview these results against the user's original task. Verify claims before reporting success; answer any pending question using worker_reply; continue only if substantive work remains, otherwise summarize to the user and stop.\n</task-notification>");
        let id = uuid::Uuid::new_v4().to_string();
        for task in state.snapshot.tasks.iter_mut().filter(|task| tasks.iter().any(|result| result.id == task.id)) { task.result_delivery = Some("claimed".into()); }
        if let Some(current) = state.parents.values_mut().find(|current| current.id == owner.id) {
            current.automatic = Some(AutomaticInput { id: id.clone(), fingerprint: fingerprint("", &text), source_turn: owner.turn, tasks: tasks.iter().map(|task| task.id.clone()).collect(), at: Instant::now() });
        }
        deliveries.push(ResultDelivery { id, parent_id: owner.id, generation: generation.clone(), text, kind: None });
    }
    deliveries
}
fn text(args: &Value, key: &str, limit: usize) -> Result<String, String> {
    args[key].as_str().filter(|value| !value.trim().is_empty() && value.len() <= limit).map(str::to_owned).ok_or_else(|| format!("{key} must be non-empty and at most {limit} bytes"))
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
        state.pending.insert(id.clone(), Pending { parent: parent_id.into(), token: token.into(), worker, session_id: child_id.map(str::to_owned), deadline: Instant::now() + Duration::from_secs(80), sender });
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
    let isolated = task.worktree.as_ref().map(|worktree| format!("\n\nYou work in your own git worktree on branch {}, cut from the project's HEAD commit; the main checkout is {}. Make every change here, never in the main checkout, and commit your finished work on this branch. Do not merge, rebase or push it: the parent session reviews and merges it.", worktree.branch, worktree.root)).unwrap_or_default();
    let shell_hint = if cfg!(windows) { "These examples use PowerShell. From Bash, invoke powershell.exe -NoProfile -Command with the entire command as its argument." } else { "These examples use a POSIX shell." };
    format!("You are a worker assigned from the parent session inside Coffee CLI. Task ID: {}. Work only on the task below and in the current project. Other workers may be editing it: coordinate file ownership and preserve their changes. Do not launch additional workers or change permissions.{isolated}\n\n{shell_hint}\nFinish with a concise final response describing changes, verification and remaining work. Desktop-session replies are collected automatically. For terminal sessions, or to explicitly report, use this local command exactly once:\n{command} complete --outcome succeeded --summary \"What changed, verification and remaining work\"\nUse --outcome failed when the task could not be completed. A terminal final message without a structured completion event needs the report command. For a blocking question, run:\n{command} ask --question \"Your question\"\nIf it returns pending, resume the same question with:\n{command} answer --question-id QUESTION_ID\nAfter reporting, stop and leave the tab open. If delivery is uncertain, do not resend automatically.\n\nTASK\n{prompt}", task.id)
}

fn start_worker(token: &str, args: &Value) -> Result<Value, String> {
    parent(&hub().state.lock().unwrap(), token)?;
    let tool = text(args, "tool", 32)?;
    if !default_agents().contains(&tool) { return Err("Choose claude, codex, opencode or dsh".into()); }
    if !crate::tools::find(&tool).is_some_and(|tool| crate::server::binary_on_path(tool.binary_name)) { return Err("The requested tool is not installed".into()); }
    let title = text(args, "title", 160)?; let prompt = text(args, "prompt", 24_000)?;
    let operation = args.get("operationId").map(|value| value.as_str().filter(|id| !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))).ok_or("Invalid operationId")).transpose()?;
    let isolated = match args.get("isolation").and_then(Value::as_str) { None | Some("shared") => false, Some("worktree") => true, Some(_) => return Err("isolation must be shared or worktree".into()) };
    let worker_token = uuid::Uuid::new_v4().to_string();
    // Git runs outside the lock, so the admission checks run again once the worktree exists; a worktree that ends up
    // unused is removed again.
    let mut created: Option<(crate::worker_worktree::Worktree, String)> = None;
    let admitted = loop {
        let attempt = admit_worker(token, &tool, &title, &prompt, operation, isolated, &mut created, &worker_token);
        match attempt {
            Ok(Admission::Worktree(cwd)) => match crate::worker_worktree::create(Path::new(&cwd), &title) {
                Ok((worktree, path)) => created = Some((worktree, path.to_string_lossy().into_owned())),
                Err(error) => break Err(error),
            },
            other => break other,
        }
    };
    if !matches!(admitted, Ok(Admission::Started(..))) { if let Some((worktree, _)) = created.take() { crate::worker_worktree::remove_later(vec![worktree]); } }
    let (task, port) = match admitted? {
        Admission::Reused(value) => return Ok(value),
        Admission::Started(task, port) => (*task, port),
        Admission::Worktree(_) => unreachable!("worktree creation loops until admission settles"),
    };
    let command = worker_command(port, &worker_token)?;
    let instructions = worker_instructions(&task, &prompt, &command);
    hub().state.lock().unwrap().runs.insert(task.session_id.clone(), WorkerRun::new(&instructions));
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
enum Admission { Reused(Value), Worktree(String), Started(Box<Task>, u16) }
/// Admits a new worker, or returns the dispatch it repeats. An isolated start first asks for its worktree.
#[allow(clippy::too_many_arguments)]
fn admit_worker(token: &str, tool: &str, title: &str, prompt: &str, operation: Option<&str>, isolated: bool, created: &mut Option<(crate::worker_worktree::Worktree, String)>, worker_token: &str) -> Result<Admission, String> {
    let (tool, title, prompt) = (tool.to_string(), title.to_string(), prompt.to_string());
    let worker_token = worker_token.to_string();
    {
        let mut state = hub().state.lock().unwrap(); let parent = parent(&state, token)?;
        if let Some(index) = duplicate_dispatch(&state.snapshot, &parent, &tool, &prompt, operation)? {
            let mut changed = false;
            if let Some(id) = operation {
                let dispatch = state.snapshot.tasks[index].dispatch.as_mut().unwrap();
                if !dispatch.ids.iter().any(|known| known == id) {
                    if dispatch.ids.len() >= 32 { return Err("Too many retry identities; inspect the existing task".into()); }
                    dispatch.ids.push(id.into()); changed = true;
                }
            }
            if state.snapshot.tasks[index].result_delivery.as_deref() == Some("pending") {
                state.snapshot.tasks[index].result_delivery = Some("read".into()); changed = true;
            }
            if changed { save(&state.snapshot)?; publish(&mut state); }
            return Ok(Admission::Reused(json!({"task":state.snapshot.tasks[index],"reused":true,"note":"Existing dispatch retained. Do not send the task again."})));
        }
        if parent.paused { return Err("Coordinator was stopped; wait for new user input".into()); }
        let child_id = uuid::Uuid::new_v4().to_string();
        if !state.snapshot.agents.contains(&tool) { return Err("This worker is disabled in Agent configuration".into()); }
        if state.snapshot.tasks.iter().filter(|task| !task.detached && task.parent_id == parent.id && active(task)).count() >= 6 { return Err("This coordinator already has six active workers".into()); }
        crate::session_directory::validate(Path::new(&parent.cwd))?;
        if isolated && created.is_none() { return Ok(Admission::Worktree(parent.cwd)); }
        // Every refusal comes before the worktree is taken, so the caller still holds it to remove.
        let port = state.port.ok_or("Coordinator not running")?;
        if state.snapshot.tasks.len() >= 200 && !state.snapshot.tasks.iter().any(|task| !active(task)) { return Err("Task history is full".into()); }
        let (worktree, cwd) = match created.take() { Some((worktree, cwd)) => (Some(worktree), cwd), None => (None, parent.cwd) };
        let dispatch = Dispatch { ids: operation.into_iter().map(str::to_owned).collect(), source_turn: parent.turn, fingerprint: fingerprint(&tool, &prompt) };
        let task = Task { id: uuid::Uuid::new_v4().to_string(), parent_id: parent.id, parent_native_id: parent.native_id, parent_tool: parent.tool, session_id: child_id, native_id: None, tool, title, cwd, phase: "starting".into(), summary: None, question: None, generation: None, activity: None, dispatch: Some(dispatch), result_delivery: None, detached: false, hidden: false, worktree };
        if state.snapshot.tasks.len() >= 200 {
            let index = state.snapshot.tasks.iter().position(|task| !active(task)).expect("checked above");
            let removed = state.snapshot.tasks.remove(index);
            state.workers.retain(|_, id| *id != removed.id);
            state.runs.remove(&removed.session_id);
        }
        state.snapshot.tasks.push(task.clone());
        if let Err(error) = save(&state.snapshot) { let task = state.snapshot.tasks.pop(); *created = task.and_then(|task| task.worktree.map(|worktree| (worktree, task.cwd))); return Err(error); }
        state.workers.insert(worker_token, task.id.clone()); publish(&mut state);
        Ok(Admission::Started(Box::new(task), port))
    }
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
        let mut read = false;
        for task in state.snapshot.tasks.iter_mut().filter(|task| !task.detached && !task.hidden && task.parent_id == owner.id && task.result_delivery.as_deref() == Some("pending")) {
            task.result_delivery = Some("read".into()); read = true;
        }
        if read { save(&state.snapshot)?; publish(&mut state); }
        return Ok(json!({"revision":state.snapshot.revision,"availableAgents":state.snapshot.agents,"tasks":state.snapshot.tasks.iter().filter(|task| !task.detached && !task.hidden && task.parent_id == owner.id).collect::<Vec<_>>()}));
    }
    let task_id = text(args, "taskId", 80)?; let task = task_for(&state, &owner.id, &task_id)?;
    if action == "worker_reply" {
        let mut next = state.snapshot.clone();
        answer_question(&mut next, &task_id, args)?;
        save(&next)?; state.snapshot = next; publish(&mut state);
        if state.runs.get(&task.session_id).is_some_and(|run| run.parked) {
            return Ok(json!({"replied":true,"note":"This worker ended its turn while waiting and will not see the answer. Send the answer and the remaining work with worker_send."}));
        }
        return Ok(json!({"replied":true}));
    }
    if !matches!(action, "worker_read" | "worker_interrupt" | "worker_send") { return Err("Unknown coordination tool".into()); }
    let Some(live) = state.live.get(&task.session_id).filter(|session| session.ready && same_directory(&session.cwd, &task.cwd) && (task.generation.is_none() || session.generation == task.generation)).cloned() else {
        return Ok(json!({"task":task,"connected":false,"note":"The tab is closed or not ready. Do not create a replacement automatically."}));
    };
    if action != "worker_read" && !active(&task) { return Err("This dispatch has already settled".into()); }
    let generation = live.generation.ok_or("Worker is not ready")?;
    let mut created = false;
    let message = if action == "worker_send" {
        let prompt = text(args, "text", 24_000)?;
        let token = state.workers.iter().find(|(_, id)| **id == task.id).map(|(token, _)| token).ok_or("Worker dispatch expired")?;
        let message = worker_instructions(&task, &prompt, &worker_command(state.port.ok_or("Coordinator unavailable")?, token)?);
        // The turn in flight stays tracked until this send is actually admitted.
        match state.runs.get_mut(&task.session_id) {
            Some(run) => run.next = Some(fingerprint("", &message)),
            None => { state.runs.insert(task.session_id.clone(), WorkerRun::new(&message)); created = true; }
        }
        Some(message)
    } else { None };
    drop(state);
    let name = if action == "worker_read" { "terminal_read_screen" } else if action == "worker_send" { "terminal_send" } else { "terminal_key" };
    let result = request_gui(token, name, json!({"sessionId":task.session_id,"generation":generation,"expectedCwd":task.cwd,"key":"CtrlC","text":message}), Some(&task.session_id));
    if result.is_err() && action == "worker_send" {
        let mut state = hub().state.lock().unwrap();
        forget_send(&mut state, &task.session_id, created);
    }
    let result = result?;
    if matches!(action, "worker_interrupt" | "worker_send") {
        let mut state = hub().state.lock().unwrap();
        if let Some(task) = state.snapshot.tasks.iter_mut().find(|task| task.id == task_id && active(task)) {
            task.phase = if action == "worker_interrupt" { "interrupted" } else { "running" }.into(); task.summary = None;
        }
        save(&state.snapshot)?; publish(&mut state);
    }
    Ok(result)
}

fn forget_send(state: &mut State, session_id: &str, created: bool) {
    let Some(run) = state.runs.get_mut(session_id) else { return };
    run.next = None;
    if created && run.generation.is_none() { state.runs.remove(session_id); }
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
    task.phase = if outcome == "succeeded" { "completed" } else { "failed" }.into(); task.summary = Some(summary); task.question = None; task.result_delivery = Some("pending".into());
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
    if task.detached { return Err("The coordinator has closed. Continue in this independent session.".into()); }
    if !matches!(action, "ask" | "answer") { return Err("Unknown worker operation".into()); }
    if !state.snapshot.enabled { return Err("Coordination has been disabled".into()); }
    let question_id = if action == "ask" {
        let question = text(args, "question", 8000)?;
        let task = state.snapshot.tasks.iter_mut().find(|task| task.id == id).unwrap();
        if task.question.as_ref().is_some_and(|q| q.answer.is_none()) { return Err("A question is already pending; wait for its answer".into()); }
        let question_id = uuid::Uuid::new_v4().to_string();
        task.question = Some(Question { id: question_id.clone(), text: question, answer: None });
        // An idle coordinator learns of the question the way it learns of results.
        task.result_delivery = Some("pending".into()); save(&state.snapshot)?; publish(&mut state); question_id
    } else { text(args, "questionId", 80)? };
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let task = state.snapshot.tasks.iter().find(|task| task.id == id).ok_or("Task not found")?;
        if !active(task) || task.detached || !state.snapshot.enabled { return Err("Task or coordinator has stopped".into()); }
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
        ("worker_start", "Delegate bounded authorized work in a visible child tab. Supply a stable operationId and reuse it on retry; repeated identical active work in the same turn reuses its existing task. Changed input needs a new ID. Inspect worker_list after uncertain delivery.", json!({"tool":{"type":"string","enum":agents},"title":string,"prompt":string,"operationId":{"type":"string","minLength":1,"maxLength":64,"pattern":"^[A-Za-z0-9._-]+$"},"isolation":{"type":"string","enum":["shared","worktree"],"description":"shared (default): the coordinator's checkout. worktree: the worker's own git worktree and branch from HEAD; merge it yourself after review."}}), vec!["tool","title","prompt"]),
        ("worker_list", "Read only this coordinator's tasks, reports and questions. A completed phase is the worker's report; inspect results before claiming success.", json!({}), vec![]),
        ("worker_wait", "Wait for task or question changes. Use the revision from worker_list or the last wait. No polling loop is needed inside workers.", json!({"revision":{"type":"integer"},"timeoutMs":{"type":"integer","maximum":30000}}), vec![]),
        ("worker_read", "Read the existing worker session. Does not resume or replace closed sessions.", json!({"taskId":string}), vec!["taskId"]),
        ("worker_send", "Send a follow-up to an existing active worker after reading it. A worker that is still running receives it within its current turn, so use it to correct course early. Never use this to approve prompts or automatically retry uncertain delivery. A worker awaiting initial setup has received no task; include the task and reporting instructions when explicitly resuming it.", json!({"taskId":string,"text":string}), vec!["taskId","text"]),
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
const MCP_REQUEST_LIMIT: usize = 100_000;
enum McpLine { End, Unreadable, Text(String) }
/// A request over the limit is answered, never fatal: the server's exit would cost the session every coordination
/// tool. Lines beyond it are still read, because the answer needs their id.
fn read_request(input: &mut impl BufRead) -> std::io::Result<McpLine> {
    const BUFFER_LIMIT: u64 = 8_000_000;
    let mut line = vec![];
    if Read::by_ref(input).take(BUFFER_LIMIT).read_until(b'\n', &mut line)? == 0 { return Ok(McpLine::End); }
    if line.last() != Some(&b'\n') && line.len() as u64 == BUFFER_LIMIT { input.skip_until(b'\n')?; return Ok(McpLine::Unreadable); }
    Ok(McpLine::Text(String::from_utf8_lossy(&line).into_owned()))
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
            let line = match read_request(&mut input).map_err(|e| e.to_string())? {
                McpLine::End => break,
                McpLine::Unreadable => { write(json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Request too large"}})); continue; }
                McpLine::Text(line) => line,
            };
            let Ok(request) = serde_json::from_str::<Value>(&line) else { continue; };
            if request.get("id").is_none() { continue; }
            if line.len() > MCP_REQUEST_LIMIT { write(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32600,"message":"Request too large"}})); continue; }
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
    #[test]
    fn repeated_dispatch_reuses_active_work_and_fixed_ids_reject_changed_input() {
        let mut state = fixture();
        let owner = state.parents["token"].clone();
        state.snapshot.tasks[0].dispatch = Some(Dispatch { ids: vec!["review-1".into()], source_turn: String::new(), fingerprint: fingerprint("codex", "Inspect changes") });
        assert_eq!(duplicate_dispatch(&state.snapshot, &owner, "codex", "Inspect changes", Some("review-1")).unwrap(), Some(0));
        assert_eq!(duplicate_dispatch(&state.snapshot, &owner, "codex", "Inspect changes", Some("retry-2")).unwrap(), Some(0));
        assert!(duplicate_dispatch(&state.snapshot, &owner, "codex", "Different work", Some("review-1")).is_err());
        state.snapshot.tasks[0].phase = "completed".into();
        assert_eq!(duplicate_dispatch(&state.snapshot, &owner, "codex", "Inspect changes", Some("review-1")).unwrap(), Some(0));
        assert_eq!(duplicate_dispatch(&state.snapshot, &owner, "codex", "Inspect changes", None).unwrap(), None);
        state.snapshot.tasks[0].phase = "running".into();
        let mut later = owner; later.turn = "next-turn".into();
        assert_eq!(duplicate_dispatch(&state.snapshot, &later, "codex", "Inspect changes", None).unwrap(), None);
    }
    #[test]
    fn desktop_results_require_the_assigned_input_generation_and_native_turn() {
        let mut state = fixture();
        state.runs.insert("child".into(), WorkerRun::new("Assigned task"));
        record_input(&mut state, "child", "codex", "g1", "Assigned task", "input-1").unwrap();
        assert!(!record_event(&mut state, "child", "codex", "g1", &json!({"method":"turn/completed","params":{"turn":{"id":"old","status":"completed"}}})));
        record_event(&mut state, "child", "codex", "g1", &json!({"method":"turn/started","params":{"turn":{"id":"turn-1"}}}));
        record_event(&mut state, "child", "codex", "g1", &json!({"method":"item/completed","params":{"turnId":"turn-1","item":{"id":"reply","type":"agentMessage","text":"Changed files; tests passed"}}}));
        let done = json!({"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}});
        assert!(!record_event(&mut state, "child", "codex", "old-generation", &done));
        assert!(record_event(&mut state, "child", "codex", "g1", &done));
        assert_eq!(state.snapshot.tasks[0].phase, "completed");
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Changed files; tests passed"));
        assert!(!record_event(&mut state, "child", "codex", "g1", &done));
    }
    #[test]
    fn stopped_or_replaced_work_does_not_auto_report_success() {
        let mut state = fixture(); state.snapshot.tasks[0].tool = "claude".into();
        state.runs.insert("child".into(), WorkerRun::new("Assigned task"));
        record_input(&mut state, "child", "claude", "g1", "Assigned task", "input-1").unwrap();
        stop_input(&mut state, "child", "claude", "g1");
        assert!(!record_event(&mut state, "child", "claude", "g1", &json!({"type":"result","subtype":"success","result":"Late reply"})));
        assert_ne!(state.snapshot.tasks[0].phase, "completed");
    }
    #[test]
    fn result_batches_wait_for_idle_and_cannot_restart_stopped_or_changed_input() {
        let mut state = fixture();
        state.parents.get_mut("token").unwrap().connected = true;
        sync_live(&mut state, vec![live("parent", "claude", "desktop:claude:g1")]);
        state.snapshot.tasks[0].phase = "completed".into();
        state.snapshot.tasks[0].summary = Some("Tests passed".into());
        state.snapshot.tasks[0].result_delivery = Some("pending".into());
        let mut second = state.snapshot.tasks[0].clone(); second.id = "second".into(); second.session_id = "second-child".into();
        state.snapshot.tasks.push(second);
        assert!(take_results(&mut state).is_empty(), "busy or draft-bearing sessions must not receive automatic input");
        state.live.get_mut("parent").unwrap().can_receive = true;
        let deliveries = take_results(&mut state);
        assert_eq!(deliveries.len(), 1);
        assert!(deliveries[0].text.contains("second"));
        assert!(take_results(&mut state).is_empty(), "a claimed batch cannot be resent");
        let delivery = &deliveries[0];
        stop_input(&mut state, "parent", "claude", "g1");
        assert!(record_delivery_input(&mut state, "parent", "claude", "g1", &delivery.text, "auto", Some(&delivery.id), false).is_err());
        record_input(&mut state, "parent", "claude", "g1", "Fresh user task", "new-input").unwrap();
        assert!(record_delivery_input(&mut state, "parent", "claude", "g1", &delivery.text, "auto", Some(&delivery.id), false).is_err(), "new user input invalidates a previously claimed batch");
        assert!(record_delivery_input(&mut state, "parent", "claude", "g2", &delivery.text, "auto", Some(&delivery.id), false).is_err());
    }
    #[test]
    fn one_result_batch_is_admitted_once_without_changing_the_user_task_identity() {
        let mut state = fixture();
        state.parents.get_mut("token").unwrap().connected = true;
        sync_live(&mut state, vec![live("parent", "claude", "desktop:claude:g1")]);
        record_input(&mut state, "parent", "claude", "g1", "Original work", "original").unwrap();
        record_event(&mut state, "parent", "claude", "g1", &json!({"type":"result","subtype":"success"}));
        state.snapshot.tasks[0].phase = "completed".into();
        state.snapshot.tasks[0].result_delivery = Some("pending".into());
        state.live.get_mut("parent").unwrap().can_receive = true;
        let delivery = take_results(&mut state).pop().unwrap();
        record_delivery_input(&mut state, "parent", "claude", "g1", &delivery.text, "automatic", Some(&delivery.id), false).unwrap();
        assert_eq!(state.parents["token"].turn, "original");
        assert!(record_delivery_input(&mut state, "parent", "claude", "g1", &delivery.text, "automatic", Some(&delivery.id), false).is_err());
    }
    #[test]
    fn queued_user_inputs_do_not_change_the_identity_of_the_current_dispatch() {
        let mut state = fixture();
        record_input(&mut state, "parent", "claude", "g1", "First task", "first").unwrap();
        record_input(&mut state, "parent", "claude", "g1", "Second task", "second").unwrap();
        assert_eq!(state.parents["token"].turn, "first");
        record_event(&mut state, "parent", "claude", "g1", &json!({"type":"result","subtype":"success"}));
        assert_eq!(state.parents["token"].turn, "second");
        assert!(state.parents["token"].running);
        record_event(&mut state, "parent", "claude", "g1", &json!({"type":"result","subtype":"success"}));
        assert!(!state.parents["token"].running);
    }
    #[test]
    fn dsh_result_uses_the_last_reply_of_the_assigned_turn() {
        let mut state = fixture(); state.snapshot.tasks[0].tool = "dsh".into();
        state.runs.insert("child".into(), WorkerRun::new("Assigned task"));
        let event = |native: Value| json!({"method":"session.event","params":{"event":native}});
        let done = event(json!({"type":"turn/end","data":{"reason":{"kind":"completed"}}}));
        assert!(!record_event(&mut state, "child", "dsh", "g1", &done));
        record_input(&mut state, "child", "dsh", "g1", "Assigned task", "input").unwrap();
        record_event(&mut state, "child", "dsh", "g1", &event(json!({"type":"assistant/message","data":{"message":{"content":[{"type":"reasoning","text":"Thinking"},{"type":"text","text":"Tests passed"}]}}})));
        assert!(!record_event(&mut state, "child", "dsh", "old-generation", &done));
        assert!(record_event(&mut state, "child", "dsh", "g1", &done));
        assert_eq!((state.snapshot.tasks[0].phase.as_str(), state.snapshot.tasks[0].summary.as_deref()), ("completed", Some("Tests passed")));
    }
    #[test]
    fn opencode_result_uses_the_last_text_of_the_execution() {
        let mut state = fixture(); state.snapshot.tasks[0].tool = "opencode".into();
        state.runs.insert("child".into(), WorkerRun::new("Assigned task"));
        let done = json!({"type":"session.execution.succeeded","data":{"sessionID":"ses_a"}});
        assert!(!record_event(&mut state, "child", "opencode", "g1", &done));
        record_input(&mut state, "child", "opencode", "g1", "Assigned task", "input").unwrap();
        record_event(&mut state, "child", "opencode", "g1", &json!({"type":"session.text.ended","data":{"text":"Reading files"}}));
        record_event(&mut state, "child", "opencode", "g1", &json!({"type":"session.text.ended","data":{"text":"Tests passed"}}));
        assert!(!record_event(&mut state, "child", "opencode", "g1", &json!({"type":"session.execution.interrupted","data":{"reason":"shutdown"}})));
        assert!(!record_event(&mut state, "child", "opencode", "old-generation", &done));
        assert!(record_event(&mut state, "child", "opencode", "g1", &done));
        assert_eq!((state.snapshot.tasks[0].phase.as_str(), state.snapshot.tasks[0].summary.as_deref()), ("completed", Some("Tests passed")));
    }
    #[test]
    fn claude_final_reply_is_collected_but_history_tools_and_manual_input_are_not() {
        let mut state = fixture(); state.snapshot.tasks[0].tool = "claude".into();
        state.runs.insert("child".into(), WorkerRun::new("Assigned task"));
        assert!(!record_event(&mut state, "child", "claude", "g1", &json!({"type":"result","subtype":"success","result":"Old history"})));
        record_input(&mut state, "child", "claude", "g1", "Assigned task", "input").unwrap();
        assert!(!record_event(&mut state, "child", "claude", "g1", &json!({"type":"result","parent_tool_use_id":"nested","subtype":"success","result":"Nested task done"})));
        record_event(&mut state, "child", "claude", "g1", &json!({"type":"assistant","parent_tool_use_id":"nested","message":{"content":[{"type":"text","text":"Nested tool reply"}]}}));
        record_event(&mut state, "child", "claude", "g1", &json!({"type":"assistant","message":{"content":[{"type":"text","text":"Final verified reply"}]}}));
        assert!(record_event(&mut state, "child", "claude", "g1", &json!({"type":"result","subtype":"success"})));
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Final verified reply"));
        state.snapshot.tasks[0].phase = "running".into(); state.snapshot.tasks[0].result_delivery = None;
        state.runs.insert("child".into(), WorkerRun::new("Assigned task"));
        record_input(&mut state, "child", "claude", "g1", "Assigned task", "input").unwrap();
        record_input(&mut state, "child", "claude", "g1", "User's unrelated message", "manual").unwrap();
        assert!(record_event(&mut state, "child", "claude", "g1", &json!({"type":"result","subtype":"success","result":"Unrelated reply"})));
        let task = &state.snapshot.tasks[0];
        assert_eq!((task.phase.as_str(), task.result_delivery.as_deref()), ("interrupted", Some("pending")));
        assert!(!task.summary.as_deref().unwrap().contains("Unrelated reply"));
    }
    fn dsh_event(native: Value) -> Value { json!({"method":"session.event","params":{"sessionId":"s","event":native}}) }
    fn assigned(tool: &str) -> State {
        let mut state = fixture(); state.snapshot.tasks[0].tool = tool.into();
        state.runs.insert("child".into(), WorkerRun::new("Assigned task"));
        record_input(&mut state, "child", tool, "g1", "Assigned task", "input").unwrap();
        state
    }
    fn dsh_turn(state: &mut State, reply: &str) -> bool {
        record_event(state, "child", "dsh", "g1", &dsh_event(json!({"type":"turn/start"})));
        record_event(state, "child", "dsh", "g1", &dsh_event(json!({"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":reply}]}}})));
        record_event(state, "child", "dsh", "g1", &dsh_event(json!({"type":"turn/end","data":{"reason":{"kind":"completed"}}})))
    }
    fn background(state: &mut State, count: usize) {
        record_event(state, "child", "dsh", "g1", &json!({"method":"coffee/background","params":{"count":count}}));
    }
    fn age_held(state: &mut State, by: Duration) {
        let held = state.runs.get_mut("child").unwrap().held.as_mut().unwrap();
        held.at -= by; held.quiet = held.quiet.map(|quiet| quiet - by);
    }
    #[test]
    fn a_turn_that_leaves_background_work_is_not_the_result_of_the_worker() {
        let mut state = assigned("dsh");
        background(&mut state, 1);
        assert!(!dsh_turn(&mut state, "Started a sub-agent"));
        assert_eq!(state.snapshot.tasks[0].phase, "running");
        assert!(!settle_held(&mut state), "still running");
        background(&mut state, 0);
        assert!(dsh_turn(&mut state, "Final result"), "the woken turn is the result");
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Final result"));
    }
    #[test]
    fn held_turns_settle_once_quiet_or_past_the_limit() {
        let mut state = assigned("dsh");
        background(&mut state, 1);
        dsh_turn(&mut state, "Waiting on a job");
        background(&mut state, 0);
        assert!(!settle_held(&mut state), "the wake gets its grace period");
        age_held(&mut state, BACKGROUND_QUIET);
        assert!(settle_held(&mut state));
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Waiting on a job"));
        let mut state = assigned("dsh");
        background(&mut state, 1);
        dsh_turn(&mut state, "Waiting on a server");
        age_held(&mut state, BACKGROUND_LIMIT);
        assert!(settle_held(&mut state));
        assert!(state.snapshot.tasks[0].summary.as_deref().unwrap().contains("still running"));
    }
    #[test]
    fn claude_background_tasks_hold_the_result_and_failures_do_not_wait() {
        let mut state = assigned("claude");
        let frame = |tasks: Value| json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks});
        record_event(&mut state, "child", "claude", "g1", &frame(json!([{"task_id":"a"},{"task_id":"b","ambient":true}])));
        assert_eq!(state.runs["child"].background, 1);
        assert!(!record_event(&mut state, "child", "claude", "g1", &json!({"type":"result","subtype":"success","result":"Started"})));
        record_event(&mut state, "child", "claude", "g1", &json!({"type":"assistant","message":{"content":[{"type":"text","text":"Woken"}]}}));
        assert!(state.runs["child"].held.is_none());
        assert!(record_event(&mut state, "child", "claude", "g1", &json!({"type":"result","subtype":"error_during_execution","errors":["Boom"]})));
        assert_eq!(state.snapshot.tasks[0].phase, "failed");
    }
    #[test]
    fn a_prompt_absorbed_by_the_running_turn_does_not_block_results() {
        let mut state = fixture();
        record_input(&mut state, "parent", "claude", "g1", "First task", "first").unwrap();
        record_input(&mut state, "parent", "claude", "g1", "Mid-turn note", "second").unwrap();
        let idle = json!({"type":"system","subtype":"session_state_changed","state":"idle"});
        record_event(&mut state, "parent", "claude", "g1", &idle);
        assert!(state.parents["token"].running, "idle before the result of a prompt just sent is stale");
        record_event(&mut state, "parent", "claude", "g1", &json!({"type":"result","subtype":"success"}));
        assert!(state.parents["token"].running);
        record_event(&mut state, "parent", "claude", "g1", &idle);
        let owner = &state.parents["token"];
        assert!(!owner.running); assert!(owner.queued.is_empty()); assert_eq!(owner.turn, "second");
    }
    #[test]
    fn a_refused_follow_up_keeps_tracking_the_turn_in_flight() {
        let mut state = assigned("dsh");
        state.runs.get_mut("child").unwrap().next = Some(fingerprint("", "Follow-up"));
        forget_send(&mut state, "child", false);
        assert!(dsh_turn(&mut state, "Original result"));
        let mut state = assigned("dsh");
        state.runs.get_mut("child").unwrap().next = Some(fingerprint("", "Follow-up"));
        record_input(&mut state, "child", "dsh", "g1", "Follow-up", "input-2").unwrap();
        assert_eq!(state.runs["child"].expected, fingerprint("", "Follow-up"));
        assert!(!state.runs["child"].manual);
        let mut state = fixture();
        state.runs.insert("child".into(), WorkerRun::new("New send"));
        forget_send(&mut state, "child", true);
        assert!(state.runs.is_empty());
    }
    fn claimed(state: &mut State) -> ResultDelivery {
        state.parents.get_mut("token").unwrap().connected = true;
        sync_live(state, vec![live("parent", "claude", "desktop:claude:g1")]);
        state.snapshot.tasks[0].phase = "completed".into(); state.snapshot.tasks[0].summary = Some("Done".into());
        state.snapshot.tasks[0].result_delivery = Some("pending".into());
        state.live.get_mut("parent").unwrap().can_receive = true;
        take_results(state).pop().unwrap()
    }
    #[test]
    fn a_batch_that_was_never_admitted_is_offered_again_but_an_admitted_one_is_not() {
        let mut state = fixture(); let delivery = claimed(&mut state);
        assert!(take_results(&mut state).is_empty());
        state.parents.get_mut("token").unwrap().automatic.as_mut().unwrap().at -= CLAIM_LIMIT;
        let again = take_results(&mut state).pop().expect("an unsent batch returns");
        assert_ne!(again.id, delivery.id);
        record_delivery_input(&mut state, "parent", "claude", "g1", &again.text, "automatic", Some(&again.id), false).unwrap();
        assert_eq!(state.snapshot.tasks[0].result_delivery.as_deref(), Some("delivered"));
        let mut state = fixture(); let delivery = claimed(&mut state);
        record_input(&mut state, "parent", "claude", "g1", "New user task", "input").unwrap();
        assert!(record_delivery_input(&mut state, "parent", "claude", "g1", &delivery.text, "automatic", Some(&delivery.id), false).is_err());
        assert_eq!(state.snapshot.tasks[0].result_delivery.as_deref(), Some("pending"), "a refused batch waits for the next idle");
    }
    #[test]
    fn hidden_workers_are_neither_delivered_nor_listed() {
        let mut state = fixture();
        state.parents.get_mut("token").unwrap().connected = true;
        sync_live(&mut state, vec![live("parent", "claude", "desktop:claude:g1")]);
        state.snapshot.tasks[0].phase = "completed".into(); state.snapshot.tasks[0].result_delivery = Some("pending".into());
        state.live.get_mut("parent").unwrap().can_receive = true;
        hide_worker(&mut state.snapshot, "task").unwrap();
        assert!(take_results(&mut state).is_empty());
        assert!(task_for(&state, "parent", "task").is_err());
    }
    #[test]
    fn a_turn_ending_on_a_question_stays_open_and_can_resume() {
        let mut state = assigned("dsh");
        state.snapshot.tasks[0].question = Some(Question { id: "q".into(), text: "Which file?".into(), answer: None });
        assert!(!dsh_turn(&mut state, "Waiting for an answer"));
        assert_eq!(state.snapshot.tasks[0].phase, "running");
        assert!(state.runs["child"].parked);
        answer_question(&mut state.snapshot, "task", &json!({"questionId":"q","answer":"main.rs"})).unwrap();
        state.runs.get_mut("child").unwrap().next = Some(fingerprint("", "Use main.rs"));
        record_input(&mut state, "child", "dsh", "g1", "Use main.rs", "input-2").unwrap();
        assert!(!state.runs["child"].parked);
        assert!(dsh_turn(&mut state, "Updated main.rs"));
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Updated main.rs"));
        assert!(state.snapshot.tasks[0].question.is_none());
    }
    fn dsh_failure(state: &mut State, status: u64) -> bool {
        record_event(state, "child", "dsh", "g1", &dsh_event(json!({"type":"turn/end","data":{"reason":{"kind":"error","error":{"message":"Provider error","code":"HTTP","status":status}}}})))
    }
    fn retry_due(state: &mut State) -> ResultDelivery {
        state.runs.get_mut("child").unwrap().retry.as_mut().unwrap().due = Instant::now();
        let mut due = take_retries(state); assert_eq!(due.len(), 1); due.pop().unwrap()
    }
    #[test]
    fn passing_failures_retry_with_backoff_then_report() {
        let mut state = assigned("dsh");
        for attempt in 1..=RETRY_LIMIT {
            assert!(dsh_failure(&mut state, 503));
            assert_eq!(state.snapshot.tasks[0].phase, "running");
            let retry = state.runs["child"].retry.as_ref().unwrap();
            assert!(retry.due > Instant::now() + RETRY_BACKOFF * 2u32.pow(attempt - 1) - Duration::from_secs(1));
            assert!(take_retries(&mut state).is_empty(), "the backoff has not passed");
            let delivery = retry_due(&mut state);
            assert_eq!((delivery.parent_id.as_str(), delivery.kind), ("child", Some("retry")));
            record_input(&mut state, "child", "dsh", "g1", &delivery.text, "retry").unwrap();
            assert!(state.runs["child"].retry.is_none() && !state.runs["child"].manual);
        }
        assert!(dsh_failure(&mut state, 503));
        assert_eq!((state.snapshot.tasks[0].phase.as_str(), state.snapshot.tasks[0].result_delivery.as_deref()), ("failed", Some("pending")));
    }
    #[test]
    fn a_retry_recovers_the_result_and_lasting_failures_do_not_retry() {
        let mut state = assigned("dsh");
        dsh_failure(&mut state, 429);
        let delivery = retry_due(&mut state);
        record_input(&mut state, "child", "dsh", "g1", &delivery.text, "retry").unwrap();
        assert!(dsh_turn(&mut state, "Done after retry"));
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Done after retry"));
        let mut state = assigned("dsh");
        assert!(dsh_failure(&mut state, 401));
        assert_eq!(state.snapshot.tasks[0].phase, "failed");
    }
    #[test]
    fn a_retry_that_is_never_taken_reports_the_failure() {
        let mut state = assigned("dsh");
        dsh_failure(&mut state, 500);
        retry_due(&mut state);
        assert!(!expire_retries(&mut state));
        state.runs.get_mut("child").unwrap().retry.as_mut().unwrap().sent = Some(Instant::now() - CLAIM_LIMIT);
        assert!(expire_retries(&mut state));
        assert_eq!((state.snapshot.tasks[0].phase.as_str(), state.snapshot.tasks[0].summary.as_deref()), ("failed", Some("Provider error")));
    }
    #[test]
    fn transient_failures_are_recognised_by_status_or_text() {
        assert!(transient("x", Some(429)) && transient("x", Some(502)) && !transient("overloaded", Some(400)));
        assert!(transient("API Error: 529 {\"type\":\"overloaded_error\"}", None));
        assert!(transient("stream disconnected: connection reset by peer", None) && transient("stream disconnected before completion", None));
        assert!(!transient("Invalid API key", None) && !transient("exceeded 4290 tokens", None));
    }
    #[test]
    fn a_coordinator_steer_keeps_the_running_codex_turn() {
        let mut state = assigned("codex");
        record_event(&mut state, "child", "codex", "g1", &json!({"method":"turn/started","params":{"turn":{"id":"turn-1"}}}));
        state.runs.get_mut("child").unwrap().next = Some(fingerprint("", "Also update the docs"));
        record_delivery_input(&mut state, "child", "codex", "g1", "Also update the docs", "steer", None, true).unwrap();
        assert_eq!(state.runs["child"].turn.as_deref(), Some("turn-1"));
        assert!(!state.runs["child"].manual);
        record_event(&mut state, "child", "codex", "g1", &json!({"method":"item/completed","params":{"turnId":"turn-1","item":{"type":"agentMessage","text":"Code and docs updated"}}}));
        assert!(record_event(&mut state, "child", "codex", "g1", &json!({"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}})));
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Code and docs updated"));
        let mut state = assigned("codex");
        record_delivery_input(&mut state, "child", "codex", "g1", "User's own note", "steer", None, true).unwrap();
        assert!(state.runs["child"].manual, "a user's steer is still the user's");
    }
    #[test]
    fn a_worker_that_fails_while_asking_still_settles() {
        let mut state = assigned("dsh");
        state.snapshot.tasks[0].question = Some(Question { id: "q".into(), text: "Which file?".into(), answer: None });
        assert!(settle(&mut state, "child", "dsh", "failed", "The worker process exited unexpectedly".into()));
        let task = &state.snapshot.tasks[0];
        assert_eq!((task.phase.as_str(), task.result_delivery.as_deref()), ("failed", Some("pending")));
        assert!(task.question.is_none()); assert!(state.runs.is_empty());
    }
    #[test]
    fn a_turn_without_a_reply_tells_the_coordinator() {
        let mut state = assigned("dsh");
        assert!(record_event(&mut state, "child", "dsh", "g1", &dsh_event(json!({"type":"turn/end","data":{"reason":{"kind":"completed"}}}))));
        assert_eq!((state.snapshot.tasks[0].phase.as_str(), state.snapshot.tasks[0].result_delivery.as_deref()), ("uncertain", Some("pending")));
    }
    #[test]
    fn a_stop_outlives_the_process_it_replaced() {
        let mut state = fixture();
        stop_input(&mut state, "parent", "claude", "g1");
        assert!(state.stopped.contains("native-parent"));
        state.parents.clear();
        assert!(state.stopped.contains("native-parent"), "the owner can vanish before the new process registers");
        let mut state = fixture();
        stop_input(&mut state, "parent", "claude", "g1");
        record_input(&mut state, "parent", "claude", "g1", "Carry on", "input").unwrap();
        assert!(state.stopped.is_empty());
    }
    #[test]
    fn detached_sessions_are_no_longer_workers() {
        let mut state = fixture();
        assert!(worker_session(&state.snapshot, "child"));
        state.snapshot.tasks[0].detached = true;
        assert!(!worker_session(&state.snapshot, "child"));
    }
    #[test]
    fn oversized_mcp_requests_keep_their_id_and_the_stream_goes_on() {
        let long = format!("{{\"id\":7,\"method\":\"tools/call\",\"text\":\"{}\"}}\nnext\n", "x".repeat(MCP_REQUEST_LIMIT));
        let mut input = std::io::Cursor::new(long.into_bytes());
        let McpLine::Text(first) = read_request(&mut input).unwrap() else { panic!("expected a line") };
        assert!(first.len() > MCP_REQUEST_LIMIT);
        assert_eq!(serde_json::from_str::<Value>(&first).unwrap()["id"], 7);
        assert!(matches!(read_request(&mut input).unwrap(), McpLine::Text(line) if line == "next\n"));
        assert!(matches!(read_request(&mut input).unwrap(), McpLine::End));
    }
    #[test]
    fn desktop_coordinators_are_told_not_to_wait() {
        let agents = default_agents();
        assert!(coordinator_prompt(&agents, true, "auto").contains("end your turn instead of waiting"));
        assert!(!coordinator_prompt(&agents, true, "auto").contains("worker_wait"));
        assert!(coordinator_prompt(&agents, false, "auto").contains("use worker_wait"));
    }
    #[test]
    fn coordinator_roles_change_the_prompt_and_saved_snapshots_default_to_auto() {
        let agents = default_agents();
        let manager = coordinator_prompt(&agents, true, "manager");
        assert!(manager.contains("never implement") && !manager.contains("Handle simple tasks yourself"));
        assert!(coordinator_prompt(&agents, true, "lead").contains("Never delegate the core"));
        assert!(coordinator_prompt(&agents, true, "auto").contains("Handle simple tasks yourself"));
        let old: Snapshot = serde_json::from_value(json!({"enabled":true,"tasks":[],"revision":0})).unwrap();
        assert_eq!(old.mode, "auto");
        assert!(MANAGER_DISALLOWED.starts_with("--disallowedTools=") && !MANAGER_DISALLOWED.contains(' '), "one argument, so the variadic flag cannot swallow later ones");
    }
    fn fixture() -> State {
        let task = Task { id: "task".into(), parent_id: "parent".into(), parent_native_id: Some("native-parent".into()), session_id: "child".into(), parent_tool: "claude".into(), native_id: None, tool: "codex".into(), title: "Review".into(), cwd: "D:\\Project".into(), phase: "running".into(), summary: None, question: None, generation: None, activity: None, dispatch: None, result_delivery: None, detached: false, hidden: false, worktree: None };
        State { snapshot: Snapshot { enabled: true, agents: default_agents(), mode: default_mode(), tasks: vec![task], revision: 0, coordinators: vec![] }, live: HashMap::new(), parents: HashMap::from([("token".into(), Parent { id: "parent".into(), native_id: Some("native-parent".into()), tool: "claude".into(), agents: default_agents(), connected: false, cwd: "D:\\Project".into(), generation: None, seen: false, turn: String::new(), running: false, queued: VecDeque::new(), sent_since_result: false, paused: false, automatic: None })]), workers: HashMap::new(), pending: HashMap::new(), runs: HashMap::new(), app: None, port: None, stopped: HashSet::new() }
    }
    #[test]
    fn worker_history_restore_keeps_native_id_result_and_settled_phase() {
        let mut state=fixture();let task=&mut state.snapshot.tasks[0];task.phase="completed".into();task.native_id=Some("saved-native".into());task.summary=Some("Saved result".into());task.result_delivery=Some("pending".into());
        restore_worker(&mut state.snapshot,"task","new-parent","new-child").unwrap();
        let task=&state.snapshot.tasks[0];assert_eq!(task.session_id,"new-child");assert_eq!(task.parent_id,"new-parent");assert_eq!(task.native_id.as_deref(),Some("saved-native"));assert_eq!(task.phase,"completed");assert_eq!(task.summary.as_deref(),Some("Saved result"));assert_eq!(task.result_delivery.as_deref(),Some("pending"));assert!(state.runs.is_empty());
        state.snapshot.tasks[0].hidden=true;assert!(restore_worker(&mut state.snapshot,"task","p","c").is_err());
        state.snapshot.tasks[0].hidden=false;state.snapshot.tasks[0].phase="running".into();assert!(restore_worker(&mut state.snapshot,"task","p","c").is_err());
        state.snapshot.tasks[0].phase="closed".into();state.snapshot.tasks[0].native_id=None;assert!(restore_worker(&mut state.snapshot,"task","p","c").is_err());
    }
    #[test]
    fn detach_requires_settled_task_and_preserves_original_conversation() {
        let mut state=fixture();assert!(detach_worker(&mut state.snapshot,&state.live,"task").is_err());
        state.snapshot.tasks[0].phase="completed".into();state.snapshot.tasks[0].native_id=Some("original".into());
        let mut session=live("child","codex","g1");session.status=Some("working".into());state.live.insert("child".into(),session);
        assert!(detach_worker(&mut state.snapshot,&state.live,"task").is_err());state.live.clear();
        detach_worker(&mut state.snapshot,&state.live,"task").unwrap();assert!(state.snapshot.tasks[0].detached);assert_eq!(state.snapshot.tasks[0].native_id.as_deref(),Some("original"));
        restore_worker(&mut state.snapshot,"task","another-parent","resumed-child").unwrap();assert_eq!(state.snapshot.tasks[0].parent_id,"parent");
    }
    #[test]
    fn settled_history_follows_existing_native_session_without_rebinding_active_work() {
        let mut state=fixture();state.snapshot.tasks[0].phase="closed".into();state.snapshot.tasks[0].native_id=Some("native-existing".into());
        let mut existing=live("existing","codex","g2");existing.native_id=Some("native-existing".into());
        sync_live(&mut state,vec![existing.clone()]);assert_eq!(state.snapshot.tasks[0].session_id,"existing");
        state.snapshot.tasks[0].session_id="child".into();state.snapshot.tasks[0].phase="running".into();sync_live(&mut state,vec![existing]);assert_eq!(state.snapshot.tasks[0].session_id,"child");
    }
    #[test]
    fn remove_worker_keeps_other_tasks_and_cancels_only_its_pending_launch() {
        let mut state = fixture();
        let mut other = state.snapshot.tasks[0].clone(); other.id = "other".into(); other.session_id = "other-child".into(); state.snapshot.tasks.push(other);
        for child in ["child", "other-child"] {
            let (sender, _receiver) = mpsc::channel();
            state.pending.insert(child.into(), Pending { parent: "parent".into(), token: "token".into(), worker: Some("codex".into()), session_id: Some(child.into()), deadline: Instant::now() + Duration::from_secs(10), sender });
            state.runs.insert(child.into(), WorkerRun::new("Task"));
        }
        let id = hide_worker(&mut state.snapshot, "task").unwrap(); remove_worker_runtime(&mut state, &id);
        assert!(state.snapshot.tasks[0].hidden); assert_eq!(state.snapshot.tasks[0].phase, "closed");
        assert!(!state.snapshot.tasks[1].hidden); assert_eq!(state.snapshot.tasks[1].phase, "running");
        assert!(!state.pending.contains_key("child")); assert!(state.pending.contains_key("other-child"));
        assert!(!state.runs.contains_key("child")); assert!(state.runs.contains_key("other-child")); assert!(state.parents.contains_key("token"));
    }
    #[test]
    fn remove_completed_worker_keeps_result_and_persists_hidden_state() {
        let mut state = fixture(); let task = &mut state.snapshot.tasks[0];
        task.phase = "completed".into(); task.summary = Some("Verified output".into()); task.result_delivery = Some("pending".into());
        hide_worker(&mut state.snapshot, "task").unwrap(); hide_worker(&mut state.snapshot, "task").unwrap();
        assert_eq!(state.snapshot.tasks[0].summary.as_deref(), Some("Verified output")); assert_eq!(state.snapshot.tasks[0].result_delivery.as_deref(), Some("pending"));
        let restored: Snapshot = serde_json::from_str(&serde_json::to_string(&state.snapshot).unwrap()).unwrap();
        assert!(restored.tasks[0].hidden); assert_eq!(restored.tasks[0].phase, "completed");
        assert!(hide_worker(&mut state.snapshot, "missing").is_err());
    }
    #[test]
    fn queued_worker_controls_are_rejected_after_removal_or_detach() {
        let mut state = fixture(); sync_live(&mut state, vec![live("parent", "claude", "g1"), live("child", "codex", "g1")]);
        let (sender, _) = mpsc::channel();
        let pending = Pending { parent: "parent".into(), token: "token".into(), worker: None, session_id: Some("child".into()), deadline: Instant::now() + Duration::from_secs(80), sender };
        assert!(pending_allowed(&state, &pending));
        hide_worker(&mut state.snapshot, "task").unwrap();
        assert!(!pending_allowed(&state, &pending), "a late request cannot reopen a removed worker");
        state.snapshot.tasks[0].hidden = false;
        state.snapshot.tasks[0].phase = "completed".into();
        assert!(pending_allowed(&state, &pending), "completed history remains readable");
        detach_worker(&mut state.snapshot, &state.live, "task").unwrap();
        assert!(!pending_allowed(&state, &pending), "the former coordinator cannot control an independent session");
    }
    #[test]
    fn closing_group_retires_active_work_without_losing_completed_results() {
        let mut state = fixture();
        let mut finished = state.snapshot.tasks[0].clone(); finished.id = "done".into(); finished.session_id = "done-child".into(); finished.phase = "completed".into(); finished.summary = Some("Finished output".into());
        let mut detached = finished.clone(); detached.id = "kept".into(); detached.detached = true;
        state.snapshot.tasks.extend([finished, detached]);
        state.runs.insert("child".into(), WorkerRun::new("Task"));
        settle_group(&mut state.snapshot, "parent", false); revoke_group(&mut state, "parent", false);
        assert_eq!(state.snapshot.tasks[0].phase, "closed");
        assert_eq!(state.snapshot.tasks[1].phase, "completed"); assert_eq!(state.snapshot.tasks[1].summary.as_deref(), Some("Finished output"));
        assert!(state.snapshot.tasks[2].detached); assert!(state.parents.is_empty()); assert!(state.runs.is_empty());
    }
    #[test]
    fn keeping_children_preserves_work_and_prevents_result_replay() {
        let mut state = fixture();
        let (sender, _receiver) = mpsc::channel();
        state.pending.insert("pending".into(), Pending { parent: "parent".into(), token: "token".into(), worker: Some("codex".into()), session_id: Some("child".into()), deadline: Instant::now() + Duration::from_secs(10), sender });
        state.runs.insert("child".into(), WorkerRun::new("Task"));
        settle_group(&mut state.snapshot, "parent", true); revoke_group(&mut state, "parent", true);
        assert!(state.snapshot.tasks[0].detached); assert_eq!(state.snapshot.tasks[0].phase, "running");
        assert!(state.parents.is_empty()); assert!(state.pending.is_empty()); assert!(state.runs.contains_key("child"));
        assert!(task_for(&state, "parent", "task").is_err());
        let json = serde_json::to_string(&state.snapshot).unwrap();
        let restored: Snapshot = serde_json::from_str(&json).unwrap(); assert!(restored.tasks[0].detached);
    }
    fn live(id: &str, tool: &str, generation: &str) -> LiveSession {
        LiveSession { id: id.into(), tool: tool.into(), cwd: "D:\\Project".into(), generation: Some(generation.into()), native_id: Some(format!("native-{id}")), ready: true, status: Some("idle".into()), error: None, can_receive: false }
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
        let prompt = coordinator_prompt(&state.snapshot.agents, true, "auto");
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
        state.pending.insert("request".into(), Pending { parent: "parent".into(), token: "token".into(), worker: Some("codex".into()), session_id: Some("child".into()), deadline: Instant::now() + Duration::from_secs(80), sender });
        sync_live(&mut state, vec![live("child", "codex", "g1")]);
        assert!(state.parents.is_empty()); assert!(state.pending.is_empty()); assert!(receiver.recv().is_err());
        assert_eq!(state.snapshot.tasks[0].phase, "running");
        sync_live(&mut state, vec![]); assert_eq!(state.snapshot.tasks[0].phase, "closed");
    }
    #[test]
    fn disabling_a_worker_cancels_its_start_but_preserves_existing_session_controls() {
        let mut state = fixture(); sync_live(&mut state, vec![live("parent", "claude", "g1")]);
        let (sender, _) = mpsc::channel();
        let mut pending = Pending { parent: "parent".into(), token: "token".into(), worker: Some("codex".into()), session_id: Some("child".into()), deadline: Instant::now() + Duration::from_secs(80), sender };
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
