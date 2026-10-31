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
    control: PathBuf,
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
        let _ = std::fs::remove_file(&self.control);
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
    if event["params"]["sessionId"] == session.native_id.as_str() { crate::orchestration::native_event(id, "dsh", &session.generation, &event); }
    let _ = app.emit("dsh-session-event", json!({"id":id,"generation":session.generation,"event":event}));
}

fn dsh_home() -> PathBuf {
    std::env::var_os("DSH_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".dsh"))
}

/// The user's command override, then `dsh` on PATH, then the runtime bundled with DeepSeek Harness Desktop.
/// Install detection uses this same lookup, so a lit launchpad card always has something to start.
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
    let shim = if cfg!(windows) { r"resources\runtime\cli\bin\dsh.cmd" } else { "Contents/Resources/runtime/cli/bin/dsh" };
    desktop_dirs().into_iter().map(|dir| dir.join(shim)).find(|p| p.is_file()).map(|p| (p.to_string_lossy().into_owned(), args))
}

/// The key DeepSeek Harness Desktop's electron-builder installer registers under (UUID v5 of `com.deepseek.dsh`).
#[cfg(windows)]
const DESKTOP_GUID: &str = "1bf39983-50d0-5fe0-9ef4-cece76f67c5e";

/// Folders DeepSeek Harness Desktop may be installed in. The installer lets users pick any folder and
/// registers it per user (HKCU) or for all users (HKLM); only the registry finds e.g. `D:\tools\dsh`.
fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        let uninstall = format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{DESKTOP_GUID}");
        for machine in [false, true] {
            let read = |key: &str, name: &str| crate::windows_path::registry_string(machine, key, name).map(|v| v.trim().trim_matches('"').to_string()).filter(|v| !v.is_empty());
            dirs.extend(read(&format!(r"Software\{DESKTOP_GUID}"), "InstallLocation").map(PathBuf::from));
            dirs.extend(read(&uninstall, "InstallLocation").map(PathBuf::from));
            for name in ["DisplayIcon", "UninstallString"] { dirs.extend(read(&uninstall, name).as_deref().and_then(registered_exe_dir)); }
        }
        dirs.extend(dirs::data_local_dir().map(|dir| dir.join(r"Programs\DeepSeek Harness")));
        dirs.extend(std::env::var_os("ProgramFiles").map(|dir| PathBuf::from(dir).join("DeepSeek Harness")));
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/Applications/DeepSeek Harness.app"));
        dirs.extend(dirs::home_dir().map(|home| home.join("Applications/DeepSeek Harness.app")));
    }
    dirs
}

/// The folder of the program a registry value names (`D:\tools\dsh\DeepSeek Harness.exe,0`,
/// `"…\Uninstall DeepSeek Harness.exe" /currentuser`).
#[cfg_attr(not(windows), allow(dead_code))]
fn registered_exe_dir(value: &str) -> Option<PathBuf> {
    let value = value.trim();
    let exe = match value.strip_prefix('"') { Some(rest) => rest.split('"').next()?, None => &value[..value.to_ascii_lowercase().rfind(".exe")? + 4] };
    exe.to_ascii_lowercase().ends_with(".exe").then(|| PathBuf::from(exe).parent().map(Path::to_path_buf)).flatten()
}

/// Built-in DeepSeek routes, shown alongside the user's own: `deepseek-account` uses the account signed in
/// through DeepSeek Harness (shared `$DSH_HOME/.credentials.yaml`), `deepseek-official` an API key.
fn builtin_models() -> Vec<Value> {
    let efforts = json!(["off", "low", "high", "max"]);
    ["deepseek-account", "deepseek-official"].iter().flat_map(|provider| [
        json!({"provider":provider,"model":"deepseek-flash","name":"DeepSeek-V4.1-Flash","efforts":efforts}),
        json!({"provider":provider,"model":"deepseek-v4-pro","name":"DeepSeek-V4-Pro","efforts":efforts}),
    ]).collect()
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

/// Where the balance of a DeepSeek Harness provider can be read.
pub(crate) enum QuotaSource { Account { token: String }, Endpoint { base_url: String, api_key: String } }

/// Resolves a provider's balance source from DeepSeek Harness's own configuration and stored credentials, read only.
pub(crate) fn quota_source(provider: &str) -> Option<QuotaSource> {
    quota_source_in(&dsh_home(), provider, &|key| std::env::var(key).ok())
}

fn quota_source_in(home: &Path, provider: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<QuotaSource> {
    let yaml = |path: PathBuf| std::fs::read_to_string(path).ok()
        .and_then(|text| serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&text).ok())
        .and_then(|value| serde_json::to_value(value).ok()).unwrap_or(Value::Null);
    let credentials = yaml(home.join(".credentials.yaml"));
    if provider == "deepseek-account" {
        let grant = &credentials["records"]["deepseek-account-platform/default"]["payload"];
        // The account token only ever goes back to the DeepSeek Platform that issued it.
        if grant["issuer"].as_str().is_some_and(|issuer| issuer != "https://platform.deepseek.com") { return None; }
        return grant["token"].as_str().filter(|t| !t.is_empty()).map(|token| QuotaSource::Account { token: token.into() });
    }
    // Credential references resolve from the environment first, then DeepSeek Harness's stored refs.
    let key = |name: &str| var(name).filter(|v| !v.is_empty()).or_else(|| credentials["refs"][name].as_str().filter(|v| !v.is_empty()).map(String::from));
    if provider == "deepseek-official" {
        return key("DEEPSEEK_API_KEY").map(|api_key| QuotaSource::Endpoint { base_url: "https://api.deepseek.com".into(), api_key });
    }
    yaml(home.join("profiles/desktop/cordis.patch.yml")).as_array()?.iter()
        .filter(|row| row["id"].as_str().is_some_and(|id| id.starts_with("llm-")))
        .find_map(|row| {
            let entry = &row["config"]["providers"][provider];
            let api_key = entry["apiKey"].as_str().filter(|v| !v.is_empty()).map(String::from).or_else(|| key(entry["apiKeyEnv"].as_str()?))?;
            Some(QuotaSource::Endpoint { base_url: entry["baseURL"].as_str()?.into(), api_key })
        })
}

/// Errors DeepSeek Harness raises when the requested provider or model is absent from its configuration.
fn is_route_error(error: &str) -> bool {
    error.contains("no adapter registered for provider") || error.contains("has no configured model")
}

/// A Host plugin that fills what the SDK protocol leaves out. It applies the preset named in this tab's control
/// file through DeepSeek Harness's own service, as the Session opens and live during a turn, because a resumed
/// Session otherwise keeps its stored preset. It also answers approvals and user questions: these go out as
/// requests on the runtime's stdout, and the replies come back as files beside the control file.
/// Sub-agent Sessions keep their own presets, as with the native command.
const PERMISSION_PLUGIN: &str = r#"import { readFileSync, rmSync } from 'node:fs';
export const inject = ['permissionPresets', 'sessions', 'approval', 'agents', 'userQuestions'];
export function apply(ctx) {
  const { COFFEE_DSH_CONTROL: file, COFFEE_DSH_SESSION: id } = process.env;
  const pending = new Map();
  let applied = '', count = 0;
  const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } };
  const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const update = () => {
    const name = read(file);
    if (!name || name === applied) return;
    const session = ctx.sessions.list().find(s => String(s.id) === id);
    if (!session) return;
    const agent = ctx.agents.list().find(a => a.session === session);
    if (agent) ctx.permissionPresets.apply(session, name, policy => ctx.approval.setPolicy(agent, policy));
    else ctx.permissionPresets.set(session, name);
    applied = name;
  };
  const collect = () => {
    for (const [request, finish] of pending) {
      const path = file + '.' + request + '.reply', reply = read(path);
      if (!reply) continue;
      rmSync(path, { force: true }); pending.delete(request); finish(JSON.parse(reply));
    }
  };
  const ask = (method, params, signal) => new Promise((resolve, reject) => {
    const requestId = 'coffee-' + Date.now() + '-' + ++count;
    const cancel = () => { pending.delete(requestId); send({ method: 'user-question.cancelled', params: { requestId } }); reject(new Error('The request was cancelled')); };
    if (signal?.aborted) return reject(new Error('The request was cancelled'));
    signal?.addEventListener('abort', cancel, { once: true });
    pending.set(requestId, reply => { signal?.removeEventListener('abort', cancel); resolve(reply); });
    send({ id: requestId, method, params: { ...params, requestId } });
  });
  ctx.on('session/created', update);
  ctx.on('approval/request', request => ask('approval/request', { toolName: request.toolName, reason: request.reason }, request.signal).then(reply => reply.outcome, () => 'cancelled'));
  ctx.on('user-questions/request', async request => {
    const reply = await ask('user-question/ask', { questions: request.questions }, request.signal);
    if (reply.cancelled) throw new Error('The user declined to answer');
    return { answers: reply.answers };
  });
  ctx.effect(() => { const timer = setInterval(() => { update(); collect(); }, 250); return () => clearInterval(timer); });
}
"#;
const PRESETS: [&str; 2] = ["workspace-write", "danger-full-access"];

/// Renames into place so the plugin never reads a half-written file.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let next = path.with_extension("next");
    std::fs::write(&next, text).and_then(|_| std::fs::rename(&next, path)).map_err(|e| e.to_string())
}

fn write_preset(control: &Path, preset: &str) -> Result<(), String> {
    if !PRESETS.contains(&preset) { return Err("Unknown permission preset".into()); }
    write_atomic(control, preset)
}

/// MCP rows for what "App settings" enabled for DeepSeek Harness, as JSON flow values YAML reads unchanged.
fn mcp_rows(dir: &Path) -> String {
    let servers = std::fs::read_to_string(dir.join("mcp.json")).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let Some(servers) = servers.as_ref().and_then(|value| value["mcpServers"].as_object()) else { return String::new() };
    servers.iter().map(|(name, server)| format!("    - id: coffee-mcp-{name}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: {}\n",
        json!({"serverName":name,"transport":"stdio","command":server["command"],"args":server["args"]}))).collect()
}

fn permission_patch(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let plugin = dir.join("permission-plugin.mjs");
    std::fs::write(&plugin, PERMISSION_PLUGIN).map_err(|e| e.to_string())?;
    let url = format!("file:///{}", plugin.to_string_lossy().replace('\\', "/").trim_start_matches('/').replace('\'', "''"));
    let patch = dir.join("permission.patch.yml");
    std::fs::write(&patch, format!("- insert:
    - id: coffee-permission
      name: '{url}'
      config: {{}}
    - id: coffee-tool-ask-user
      name: '@deepseek-ai/dsh-tool-ask-user'
      config: {{}}
{}", mcp_rows(dir))).map_err(|e| e.to_string())?;
    Ok(patch)
}

fn start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>, route: Option<Value>, preset: Option<String>) -> Result<Value, String> {
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
    let dir = dirs::home_dir().unwrap_or_default().join(".coffee-cli/dsh");
    let patch = permission_patch(&dir)?;
    let native_id = resume_token.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("session-{}", uuid::Uuid::new_v4()));
    let control = dir.join(format!("{}.preset", uuid::Uuid::new_v4()));
    if let Some(preset) = &preset { write_preset(&control, preset)?; }
    command.arg("--patch").arg(patch).env("COFFEE_DSH_CONTROL", &control).env("COFFEE_DSH_SESSION", &native_id);
    command.args(&config.extra_args).current_dir(&cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| crate::session_directory::validate(&cwd).err().unwrap_or_else(|| format!("Could not start DeepSeek Harness: {e}")))?;
    #[cfg(windows)]
    crate::terminal::windows_job::assign_pid(child.id());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let input = child.stdin.take().unwrap();
    let session = Arc::new(Session { generation, native_id, control, child: Mutex::new(child), input: Mutex::new(Some(input)), protocol: Protocol::default(), stderr: Mutex::new(String::new()) });
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
        _ => routes.default.clone().unwrap_or_else(|| ("deepseek-account".into(), "deepseek-flash".into())),
    };
    let effort = requested["effort"].as_str().filter(|e| !e.is_empty()).map(String::from);
    let result = (|| {
        let initialize = |provider: &str, model: &str| {
            let mut params = json!({"cwd":cwd,"provider":provider,"model":model,"approvalRequests":true,"capabilities":{"userQuestions":true}});
            if let Some(effort) = &effort { params["reasoningEffort"] = json!(effort); }
            // Initialization waits for the plugin tree, including MCP discovery; first launch also prepares the profile.
            session.request("initialize", params, Duration::from_secs(180))
        };
        // Initialization only checks that the route exists in the configuration. A missing model should not
        // block opening the tab: start on the built-in route and report the problem when the user sends.
        let mut route_error = None;
        if let Err(error) = initialize(&provider, &model) {
            let fallback = ("deepseek-account", "deepseek-flash");
            if !is_route_error(&error) || (provider.as_str(), model.as_str()) == fallback { return Err(error); }
            initialize(fallback.0, fallback.1)?;
            route_error = Some(error);
        }
        if resume_token.is_some() { session.request("session/resume", json!({"sessionId":session.native_id}), Duration::from_secs(120))?; }
        // Native slash commands need `session/query` (DeepSeek Harness 0.2.2+). An empty query is rejected
        // before execution by runtimes that have it; older ones answer that the method is unknown.
        let commands = !session.request("session/query", json!({"sessionId":session.native_id,"contentBlocks":[]}), Duration::from_secs(15))
            .err().is_some_and(|error| error.contains("unknown") && error.contains("session/query"));
        Ok(json!({"sessionId":session.native_id,"cwd":cwd,"route":{"provider":provider,"model":model,"effort":effort},"models":routes.models,"commands":commands,"routeError":route_error}))
    })();
    if result.is_err() { session.stop(); }
    result
}

#[tauri::command]
pub async fn dsh_session_start(app: tauri::AppHandle, id: String, generation: String, cwd: Option<String>, resume_token: Option<String>, route: Option<Value>, preset: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || start(app, id, generation, cwd, resume_token, route, preset)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn dsh_session_set_preset(sessions: State<'_, DshSessions>, id: String, generation: String, preset: String) -> Result<(), String> {
    write_preset(&get(&sessions, &id, &generation)?.control, &preset)
}
#[tauri::command]
pub async fn dsh_session_request(sessions: State<'_, DshSessions>, id: String, generation: String, method: String, params: Value) -> Result<Value, String> {
    if !matches!(method.as_str(), "session/prompt" | "session/query" | "session/working-directory/get") { return Err("Unsupported DeepSeek Harness request".into()); }
    let s = get(&sessions, &id, &generation)?;
    // Requests always address this tab's own Session.
    let mut params = params; params["sessionId"] = json!(s.native_id);
    if method == "session/prompt" {
        let prompt = params["contentBlocks"].as_array().into_iter().flatten().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
        crate::orchestration::native_input(&id, "dsh", &s.generation, &prompt, &uuid::Uuid::new_v4().to_string(), None)?;
    }
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
        // Requests from Coffee's plugin wait for a reply file; the runtime's own wait on stdin.
        match request_id.as_str().filter(|id| id.starts_with("coffee-")) {
            Some(plugin_id) => write_atomic(&s.control.with_extension(format!("preset.{plugin_id}.reply")), &result.to_string())?,
            None => s.write(&json!({"jsonrpc":"2.0","id":request_id,"result":result}))?,
        }
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
        crate::orchestration::native_stop(&id, "dsh", &generation);
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
pub(crate) fn read_log(path: &Path) -> Result<Vec<Value>, String> {
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

pub(crate) struct HistoryEntry { pub session_id: String, pub title: Option<String>, pub cwd: String, pub created_ms: Option<u64>, pub last_ms: u64, pub turns: Option<u32>, pub log: PathBuf }

/// Persisted root Sessions, newest first. Metadata comes from DeepSeek Harness's own projection cache
/// (the same rows its Session list reads), so no log is decompressed; blank Sessions are skipped.
/// Every Session log, sub-agents included, for the usage ledger.
pub(crate) fn usage_logs() -> (PathBuf, Vec<PathBuf>) {
    let root = dsh_home().join("sessions");
    let mut logs = Vec::new();
    for project in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        for session in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let id = session.file_name().to_string_lossy().into_owned();
            logs.extend(session_log(&dsh_home(), &id));
        }
    }
    logs.sort(); logs.dedup();
    (root, logs)
}

pub(crate) fn history_entries(limit: usize) -> Vec<HistoryEntry> { history_in(&dsh_home(), limit) }

fn history_in(home: &Path, limit: usize) -> Vec<HistoryEntry> {
    let mut logs: Vec<(std::time::SystemTime, String, PathBuf)> = std::fs::read_dir(home.join("sessions")).into_iter().flatten().flatten()
        .flat_map(|workspace| std::fs::read_dir(workspace.path()).into_iter().flatten().flatten())
        .filter_map(|dir| {
            let id = dir.file_name().to_string_lossy().into_owned();
            let log = session_log(home, &id)?;
            Some((std::fs::metadata(&log).and_then(|m| m.modified()).ok()?, id, log))
        }).collect();
    logs.sort_by(|a, b| b.0.cmp(&a.0));
    let mut entries = Vec::new();
    for (modified, session_id, log) in logs {
        if entries.len() >= limit { break; }
        let cache: Value = std::fs::read_to_string(home.join("storages/session_projcache/sessions").join(format!("{session_id}.json"))).ok()
            .and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Value::Null);
        let rows = &cache["record"]["rows"];
        if rows["sessionListMetadata"]["val"]["blank"] == true { continue; }
        let modified_ms = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let cwd = cache["record"]["identity"]["cwd"].as_str().map(String::from)
            .or_else(|| read_log_header(&log).and_then(|header| header["cwd"].as_str().map(String::from))).unwrap_or_default();
        entries.push(HistoryEntry {
            title: rows["title"]["val"].as_str().filter(|t| !t.trim().is_empty()).map(String::from),
            cwd,
            created_ms: cache["record"]["identity"]["createdAt"].as_u64(),
            last_ms: rows["sessionListMetadata"]["val"]["lastPromptAt"].as_u64().unwrap_or(modified_ms),
            turns: rows["sessionStats"]["val"]["turns"].as_u64().map(|n| n as u32),
            session_id, log,
        });
    }
    entries
}

/// The first row only: the Session header carries the workspace when no projection cache exists yet.
fn read_log_header(path: &Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    if path.extension().is_some_and(|e| e == "zstd") { BufReader::new(zstd::stream::read::Decoder::new(file).ok()?).read_line(&mut line).ok()?; }
    else { BufReader::new(file).read_line(&mut line).ok()?; }
    serde_json::from_str(line.trim()).ok()
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
    fn quota_sources_read_account_grants_and_provider_keys() {
        let home = std::env::temp_dir().join(format!("coffee-dsh-quota-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join("profiles/desktop")).unwrap();
        std::fs::write(home.join(".credentials.yaml"), "version: 1\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      token: tok\n      issuer: https://platform.deepseek.com\nrefs:\n  RELAY_KEY: stored\n").unwrap();
        std::fs::write(home.join("profiles/desktop/cordis.patch.yml"), "- id: llm-pi-ai\n  config:\n    providers:\n      relay:\n        apiKeyEnv: RELAY_KEY\n        baseURL: https://relay.example/v1\n").unwrap();
        let none = |_: &str| None;
        assert!(matches!(quota_source_in(&home, "deepseek-account", &none), Some(QuotaSource::Account { token }) if token == "tok"));
        assert!(matches!(quota_source_in(&home, "relay", &none), Some(QuotaSource::Endpoint { base_url, api_key }) if base_url == "https://relay.example/v1" && api_key == "stored"));
        assert!(matches!(quota_source_in(&home, "relay", &|_| Some("env".into())), Some(QuotaSource::Endpoint { api_key, .. }) if api_key == "env"));
        assert!(quota_source_in(&home, "deepseek-official", &none).is_none());
        assert!(quota_source_in(&home, "missing", &none).is_none());
        std::fs::write(home.join(".credentials.yaml"), "records:\n  deepseek-account-platform/default:\n    payload:\n      token: tok\n      issuer: https://evil.example\n").unwrap();
        assert!(quota_source_in(&home, "deepseek-account", &none).is_none());
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn route_errors_are_only_missing_configuration() {
        // Messages verified against DeepSeek Harness 0.2.1-rc.5.
        assert!(is_route_error("pi-ai provider \"relay\" has no configured model \"zzz\""));
        assert!(is_route_error("no adapter registered for provider \"echobird\""));
        assert!(!is_route_error("DeepSeek Harness process exited"));
    }
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
    fn history_lists_cached_sessions_newest_first_and_skips_blanks() {
        let root = std::env::temp_dir().join(format!("coffee-dsh-hist-{}", uuid::Uuid::new_v4()));
        let write_log = |id: &str, cwd: &str| {
            let dir = root.join("sessions/--D-repo--").join(id); std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("session.v4.jsonl.zstd"), zstd::encode_all(format!("{{\"type\":\"session\",\"id\":\"{id}\",\"cwd\":{cwd:?}}}\n").as_bytes(), 3).unwrap()).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        };
        let cache = root.join("storages/session_projcache/sessions"); std::fs::create_dir_all(&cache).unwrap();
        write_log("session-old", "D:\\old");
        write_log("session-blank", "D:\\blank");
        write_log("session-new", "D:\\repo");
        std::fs::write(cache.join("session-new.json"), r#"{"version":7,"record":{"identity":{"cwd":"D:\\repo","createdAt":5},"rows":{"title":{"val":"Fix the build"},"sessionListMetadata":{"val":{"blank":false,"lastPromptAt":42}},"sessionStats":{"val":{"turns":3}}}}}"#).unwrap();
        std::fs::write(cache.join("session-blank.json"), r#"{"record":{"rows":{"sessionListMetadata":{"val":{"blank":true}}}}}"#).unwrap();
        let entries = history_in(&root, 10);
        assert_eq!(entries.iter().map(|e| e.session_id.as_str()).collect::<Vec<_>>(), ["session-new", "session-old"]);
        assert_eq!((entries[0].title.as_deref(), entries[0].last_ms, entries[0].turns, entries[0].created_ms), (Some("Fix the build"), 42, Some(3), Some(5)));
        assert_eq!((entries[1].title.as_deref(), entries[1].cwd.as_str()), (None, "D:\\old"), "an uncached Session falls back to its log header");
        assert_eq!(history_in(&root, 1).len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)] // Registry values hold backslash paths, which only Windows splits into folders.
    #[test]
    fn registered_values_name_the_install_folder() {
        assert_eq!(registered_exe_dir(r"D:\tools\dsh\DeepSeek Harness.exe,0"), Some(PathBuf::from(r"D:\tools\dsh")));
        assert_eq!(registered_exe_dir(r#""C:\Program Files\DeepSeek Harness\Uninstall DeepSeek Harness.exe" /allusers"#), Some(PathBuf::from(r"C:\Program Files\DeepSeek Harness")));
        assert_eq!(registered_exe_dir("not a program"), None);
    }
    #[test]
    fn enabled_controls_become_mcp_plugin_rows() {
        let dir = std::env::temp_dir().join(format!("coffee-dsh-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(mcp_rows(&dir), "");
        std::fs::write(dir.join("mcp.json"), r#"{"mcpServers":{"coffee-browser-use":{"command":"C:\\Coffee CLI\\coffee.exe","args":["__ui-control","browser","dsh"]}}}"#).unwrap();
        let rows: serde_yaml_ng::Value = serde_yaml_ng::from_str(&mcp_rows(&dir).replace("\n    - ", "\n- ").replacen("    - ", "- ", 1).replace("\n      ", "\n  ")).unwrap();
        let row = serde_json::to_value(&rows[0]).unwrap();
        assert_eq!((row["id"].as_str(), row["config"]["serverName"].as_str(), row["config"]["command"].as_str()), (Some("coffee-mcp-coffee-browser-use"), Some("coffee-browser-use"), Some(r"C:\Coffee CLI\coffee.exe")));
        std::fs::remove_dir_all(dir).unwrap();
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
