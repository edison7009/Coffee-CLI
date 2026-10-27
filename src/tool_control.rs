use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::Mutex, time::Duration};

static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const BROWSER_VERSION: &str = "0.39.4";
const BROWSER_LICENSE: &str = include_str!("../licenses/agent-browser.txt");

pub(crate) fn root() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or("control_read")?.join(".coffee-cli/control"))
}

pub(crate) fn plain_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(ancestor) {
            #[cfg(windows)]
            { use std::os::windows::fs::MetadataExt;
              if metadata.file_attributes() & 0x400 != 0 { return Err("control_conflict".into()); } }
            if metadata.file_type().is_symlink() { return Err("control_conflict".into()); }
        }
    }
    Ok(())
}

fn read(path: &Path) -> Result<Option<String>, String> {
    plain_path(path)?;
    match fs::File::open(path) {
        Ok(file) => {
            let mut text = String::new();
            file.take(2_000_001).read_to_string(&mut text).map_err(|_| "control_read")?;
            if text.len() > 2_000_000 { return Err("control_read".into()); }
            Ok(Some(text))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("control_read".into()),
    }
}

fn config_path(tool: &str) -> Result<PathBuf, String> {
    config_path_in(tool, &dirs::home_dir().ok_or("control_read")?, |key| std::env::var_os(key))
}

fn config_path_in(tool: &str, home: &Path, env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Result<PathBuf, String> {
    let relocated = |key: &str, fallback: PathBuf| env(key).filter(|value| !value.is_empty()).map(PathBuf::from).filter(|path| path.is_absolute()).unwrap_or(fallback);
    let config = relocated("XDG_CONFIG_HOME", home.join(".config"));
    let json_config = |directory: PathBuf, name: &str| {
        let commented = directory.join(format!("{name}.jsonc"));
        if commented.exists() { commented } else { directory.join(format!("{name}.json")) }
    };
    match tool {
        "claude" => Ok(env("CLAUDE_CONFIG_DIR").map(PathBuf::from)
            .map(|path| path.join(".claude.json")).unwrap_or_else(|| home.join(".claude.json"))),
        "codex" => Ok(relocated("CODEX_HOME", home.join(".codex")).join("config.toml")),
        "cursor" => Ok(home.join(".cursor/mcp.json")),
        "copilot" => Ok(home.join(".copilot/mcp-config.json")),
        "antigravity" => Ok(home.join(".gemini/config/mcp_config.json")),
        "qwen" => Ok(home.join(".qwen/settings.json")),
        "kiro" => Ok(relocated("KIRO_HOME", home.join(".kiro")).join("settings/mcp.json")),
        "opencode" => Ok(env("OPENCODE_CONFIG").map(PathBuf::from).filter(|path| path.is_absolute()).unwrap_or_else(|| json_config(relocated("OPENCODE_CONFIG_DIR", config.join("opencode")), "opencode"))),
        "kilo" => {
            let directory = config.join("kilo");
            let path = json_config(directory.clone(), "kilo");
            Ok(if !path.exists() && directory.join("config.json").exists() { directory.join("config.json") } else { path })
        }
        _ => Err("control_unsupported".into()),
    }
}

fn key(kind: &str) -> Result<&'static str, String> {
    match kind { "computer" => Ok("coffee-computer-use"), "browser" => Ok("coffee-browser-use"), _ => Err("control_unsupported".into()) }
}

fn spec(exe: &Path, kind: &str, tool: &str) -> Value {
    if matches!(tool, "opencode" | "kilo") {
        json!({"type":"local","command":[exe.to_string_lossy(),"__ui-control",kind,tool]})
    } else {
        let mut value = json!({"command": exe.to_string_lossy(), "args": ["__ui-control", kind, tool]});
        if tool == "copilot" { value["type"] = json!("local"); value["tools"] = json!(["*"]); }
        value
    }
}

fn json_config(text: &str) -> Result<Value, String> {
    if text.trim_start_matches('\u{feff}').trim().is_empty() { return Ok(json!({})); }
    let value: Value = jsonc_parser::parse_to_serde_value(text.trim_start_matches('\u{feff}'), &jsonc_parser::ParseOptions::default()).map_err(|_| "control_read")?;
    if !value.is_object() { return Err("control_read".into()); }
    Ok(value)
}

fn opencode_major() -> Option<u64> {
    static MAJOR: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    if let Some(major) = MAJOR.get() { return Some(*major); }
    let configured = crate::tool_config::get("opencode").command;
    if !configured.trim().is_empty() && crate::tool_config::parse_command(&configured).0.as_deref() != Some("opencode") { return None; }
    #[cfg(windows)]
    let binary = std::env::split_paths(&std::ffi::OsString::from(crate::windows_path::terminal_path()))
        .flat_map(|directory| ["opencode.exe", "opencode.cmd", "opencode.bat"].map(|name| directory.join(name))).find(|path| path.is_file())?;
    #[cfg(not(windows))]
    let binary = PathBuf::from("opencode");
    let mut command = Command::new(binary);
    command.arg("--version").current_dir(dirs::home_dir()?).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] command.env("PATH", crate::windows_path::terminal_path());
    let mut child = hidden(&mut command).spawn().ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || { let mut text = String::new(); let _ = stdout.take(2048).read_to_string(&mut text); let _ = sender.send(text); });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(exit)) if exit.success() => break,
            Ok(None) if started.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(30)),
            _ => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
    let text = receiver.recv_timeout(Duration::from_millis(100)).ok()?;
    let pattern = regex::Regex::new(r"(?m)^\s*(?:opencode[ :v]*)?v?(\d+)\.").ok()?;
    let major = pattern.captures(&text)?.get(1)?.as_str().parse().ok()?;
    let _ = MAJOR.set(major);
    Some(major)
}

fn server_path(tool: &str, value: &Value) -> Result<Vec<&'static str>, String> {
    if tool == "opencode" {
        if value.get("mcp").is_some_and(|value| !value.is_object()) { return Err("control_read".into()); }
        if value["mcp"].get("servers").is_some() { return Ok(vec!["mcp", "servers"]); }
        if value["mcp"].as_object().is_some_and(|servers| servers.values().any(|entry| matches!(entry["type"].as_str(), Some("local" | "remote")))) { return Ok(vec!["mcp"]); }
        return Ok(if opencode_major().ok_or("control_unsupported")? >= 2 { vec!["mcp", "servers"] } else { vec!["mcp"] });
    }
    Ok(vec![if tool == "kilo" { "mcp" } else { "mcpServers" }])
}

fn entry(text: Option<&str>, tool: &str, name: &str) -> Result<Option<Value>, String> {
    let Some(text) = text else { return Ok(None); };
    if tool == "codex" {
        let value: toml::Value = toml::from_str(text).map_err(|_| "control_read")?;
        if value.get("mcp_servers").is_some_and(|value| !value.is_table()) { return Err("control_read".into()); }
        value.get("mcp_servers").and_then(|servers| servers.get(name)).map(serde_json::to_value).transpose().map_err(|_| "control_read".into())
    } else {
        let value = json_config(text)?;
        json_entry(&value, &server_path(tool, &value)?, name)
    }
}

fn json_entry(value: &Value, path: &[&str], name: &str) -> Result<Option<Value>, String> {
    let mut current = value;
    for part in path {
        match current.get(*part) {
            Some(value) if value.is_object() => current = value,
            None => return Ok(None),
            _ => return Err("control_read".into()),
        }
    }
    Ok(current.get(name).cloned())
}

fn cst_value(value: &Value) -> jsonc_parser::cst::CstInputValue {
    use jsonc_parser::cst::CstInputValue as Input;
    match value {
        Value::Null => Input::Null, Value::Bool(value) => Input::Bool(*value), Value::Number(value) => Input::Number(value.to_string()),
        Value::String(value) => Input::String(value.clone()), Value::Array(values) => Input::Array(values.iter().map(cst_value).collect()),
        Value::Object(values) => Input::Object(values.iter().map(|(key, value)| (key.clone(), cst_value(value))).collect()),
    }
}

fn edit(text: Option<&str>, tool: &str, name: &str, expected: &Value, enabled: bool) -> Result<String, String> {
    let before = entry(text, tool, name)?;
    if before.as_ref().is_some_and(|value| value != expected) { return Err("control_conflict".into()); }
    if tool == "codex" {
        let mut document = text.unwrap_or("").parse::<toml_edit::DocumentMut>().map_err(|_| "control_read")?;
        if enabled {
            let mut table = toml_edit::Table::new();
            table["command"] = toml_edit::value(expected["command"].as_str().ok_or("control_write")?);
            let mut args = toml_edit::Array::new();
            for arg in expected["args"].as_array().ok_or("control_write")? { args.push(arg.as_str().ok_or("control_write")?); }
            table["args"] = toml_edit::value(args);
            if document.get("mcp_servers").is_none() { document["mcp_servers"] = toml_edit::Item::Table(toml_edit::Table::new()); }
            document["mcp_servers"][name] = toml_edit::Item::Table(table);
        } else if let Some(servers) = document.get_mut("mcp_servers").and_then(|item| item.as_table_like_mut()) { servers.remove(name); }
        Ok(document.to_string())
    } else {
        let original = text.filter(|text| !text.trim_start_matches('\u{feff}').trim().is_empty()).unwrap_or("{\n}\n");
        let value = json_config(original)?;
        let path = server_path(tool, &value)?;
        let root = jsonc_parser::cst::CstRootNode::parse(original.trim_start_matches('\u{feff}'), &jsonc_parser::ParseOptions::default()).map_err(|_| "control_read")?;
        let mut object = root.object_value().ok_or("control_read")?;
        for part in &path { object = object.object_value_or_create(part).ok_or("control_read")?; }
        if enabled {
            if let Some(property) = object.get(name) { property.set_value(cst_value(expected)); }
            else { object.append(name, cst_value(expected)); }
        }
        else if let Some(property) = object.get(name) { property.remove(); }
        let result = format!("{}{root}", if original.starts_with('\u{feff}') { "\u{feff}" } else { "" });
        if json_entry(&json_config(&result)?, &path, name)?.as_ref() != if enabled { Some(expected) } else { None } { return Err("control_conflict".into()); }
        Ok(result)
    }
}

fn save(path: &Path, original: Option<&str>, content: &str, storage: &Path) -> Result<(), String> {
    plain_path(path)?; plain_path(storage)?;
    if read(path)?.as_deref() != original { return Err("control_conflict".into()); }
    fs::create_dir_all(path.parent().ok_or("control_write")?).map_err(|_| "control_write")?;
    let backup = storage.join("backups").join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&backup).map_err(|_| "control_write")?;
    if let Some(original) = original {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        options.open(backup.join(path.file_name().ok_or("control_write")?)).map_err(|_| "control_write")?
            .write_all(original.as_bytes()).map_err(|_| "control_write")?;
    }
    let temp = path.with_file_name(format!(".coffee-control-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temp).map_err(|_| "control_write")?;
        file.write_all(content.as_bytes()).map_err(|_| "control_write")?;
        if let Ok(metadata) = fs::metadata(path) { file.set_permissions(metadata.permissions()).map_err(|_| "control_write")?; }
        file.sync_all().map_err(|_| "control_write")?;
        if read(path)?.as_deref() != original { return Err("control_conflict".into()); }
        crate::agent::replace_file(&temp, path).map_err(|_| "control_write".to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}

pub(crate) fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}

fn wait_quiet(command: &mut Command, timeout: Duration) -> Result<(), String> {
    let mut child = hidden(command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()))
        .spawn().map_err(|_| "control_unavailable")?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(exit)) => return if exit.success() { Ok(()) } else { Err("control_unavailable".into()) },
            Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(30)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("control_unavailable".into()); }
        }
    }
}

fn browser_slot(directory: &Path) -> Result<(fs::File, PathBuf, usize), String> {
    plain_path(directory)?;
    fs::create_dir_all(directory).map_err(|_| "control_write")?;
    // A held OS file lock binds each persistent profile to one live MCP connection.
    for index in 0..64 {
        let lock_path = directory.join(format!("{index}.lock"));
        plain_path(&lock_path)?;
        let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(lock_path).map_err(|_| "control_write")?;
        match file.try_lock() {
            Ok(()) => { let profile = directory.join(index.to_string()); plain_path(&profile)?; return Ok((file, profile, index)); }
            Err(std::fs::TryLockError::WouldBlock) => continue,
            Err(_) => return Err("control_write".into()),
        }
    }
    Err("All browser profiles are in use".into())
}

fn browser_asset() -> Result<(&'static str, &'static str), String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64" | "aarch64") => Ok(("agent-browser-win32-x64.exe", "be19a109a004f84c367d7913c22b8046390b3e0e5241f9f6c7e83c7bacd22aae")),
        ("macos", "aarch64") => Ok(("agent-browser-darwin-arm64", "0317ce35172905c775c25b393914bc259701a464877aab9753ec8896f6e38bf7")),
        ("macos", "x86_64") => Ok(("agent-browser-darwin-x64", "21522a8ec34063fa294b0c928ad03d3485f1821ebe22f9da2b47b89963f731af")),
        ("linux", "x86_64") => Ok(("agent-browser-linux-x64", "aa82c8ee81a38b8ad9ba61af02ced6dcbbb8af36dd8b2b479384177f8aa077a6")),
        ("linux", "aarch64") => Ok(("agent-browser-linux-arm64", "922b60dbd9f5c8b5c0f39b453bfe8cbf61b83abd487344028a508e8c4dca7883")),
        _ => Err("control_unsupported".into()),
    }
}

fn browser_runtime() -> Result<PathBuf, String> { Ok(root()?.join("browser").join(BROWSER_VERSION).join(browser_asset()?.0)) }

fn browser_command(runtime: &Path) -> Result<Command, String> {
    browser_command_in(runtime, &root()?)
}

fn browser_command_in(runtime: &Path, directory: &Path) -> Result<Command, String> {
    let config = directory.join("browser-config.json");
    plain_path(&config)?;
    fs::create_dir_all(directory).map_err(|_| "control_write")?;
    if fs::read(&config).ok().as_deref() != Some(b"{}") {
        let temp = directory.join(format!(".browser-config-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temp, "{}").map_err(|_| "control_write")?;
        if crate::agent::replace_file(&temp, &config).is_err() { let _ = fs::remove_file(temp); return Err("control_write".into()); }
    }
    let sockets = directory.join("browser-sessions");
    plain_path(&sockets)?;
    fs::create_dir_all(&sockets).map_err(|_| "control_write")?;
    let mut command = Command::new(runtime);
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().to_ascii_uppercase().starts_with("AGENT_BROWSER_") { command.env_remove(name); }
    }
    command.current_dir(directory).env("AGENT_BROWSER_CONFIG", config).env("AGENT_BROWSER_SOCKET_DIR", sockets);
    Ok(command)
}
fn verified_runtime(path: &Path) -> bool {
    if plain_path(path).is_err() { return false; }
    let Ok(mut file) = fs::File::open(path) else { return false; };
    let mut hash = Sha256::new();
    let Ok(size) = std::io::copy(&mut Read::by_ref(&mut file).take(40_000_001), &mut hash) else { return false; };
    size <= 40_000_000 && browser_asset().is_ok_and(|(_, expected)| format!("{:x}", hash.finalize()) == expected)
}

fn browser_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    for (directory, executable) in [("Google/Chrome", "chrome.exe"), ("Microsoft/Edge", "msedge.exe")] {
        for variable in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(variable) {
                candidates.push(PathBuf::from(base).join(directory).join("Application").join(executable));
            }
        }
    }
    #[cfg(target_os = "macos")]
    { candidates.push(PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
      candidates.push(PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")); }
    #[cfg(target_os = "linux")]
    for base in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for name in ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"] { candidates.push(base.join(name)); }
    }
    candidates.into_iter().find(|path| path.is_file())
}

#[derive(Serialize)]
pub struct ControlAgent { tool: String, supported: bool, enabled: bool, conflict: bool, issue: Option<&'static str> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlStatus { supported: bool, installed: bool, ready: bool, browser: Option<String>, agents: Vec<ControlAgent> }

fn agent_status(tool: &str, kind: &str, exe: &Path, contents: Result<Option<String>, String>) -> ControlAgent {
    let current = contents.and_then(|contents| {
        if tool == "opencode" { server_path(tool, &json_config(contents.as_deref().unwrap_or("{}"))?)?; }
        entry(contents.as_deref(), tool, key(kind)?)
    });
    match current {
        Ok(value) => {
            let enabled = value.as_ref() == Some(&spec(exe, kind, tool));
            let conflict = value.is_some() && !enabled;
            ControlAgent { tool: tool.into(), supported: true, enabled, conflict, issue: conflict.then_some("conflict") }
        }
        Err(error) => ControlAgent { tool: tool.into(), supported: error != "control_unsupported", enabled: false, conflict: error != "control_unsupported", issue: Some(if error == "control_unsupported" { "unsupported" } else { "configuration" }) },
    }
}

fn status(kind: &str) -> Result<ControlStatus, String> {
    key(kind)?;
    let exe = std::env::current_exe().map_err(|_| "control_read")?;
    let supported = if kind == "computer" { cfg!(windows) } else { browser_asset().is_ok() };
    let installed = if kind == "computer" { supported } else { browser_runtime().is_ok_and(|path| verified_runtime(&path)) };
    let browser = if kind == "browser" { browser_executable().map(|path| path.to_string_lossy().into_owned()) } else { None };
    let ready = installed && (kind == "computer" || browser.is_some());
    let mut agents = Vec::new();
    for descriptor in crate::tools::TOOLS {
        let tool = descriptor.id;
        agents.push(agent_status(tool, kind, &exe, config_path(tool).and_then(|path| read(&path))));
    }
    Ok(ControlStatus { supported, installed, ready, browser, agents })
}

#[tauri::command]
pub async fn get_tool_control(kind: String) -> Result<ControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&kind)).await.map_err(|_| "control_read")?
}

#[tauri::command]
pub async fn check_tool_control(kind: String) -> Result<ControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = status(&kind)?;
        if !status.ready { return Err("control_unavailable".into()); }
        if kind == "computer" { crate::computer_control::probe()?; }
        else { wait_quiet(browser_command(&browser_runtime()?)?.arg("--version"), Duration::from_secs(10))?; }
        Ok(status)
    }).await.map_err(|_| "control_read")?
}

#[tauri::command]
pub async fn install_browser_control() -> Result<ControlStatus, String> {
    let _guard = INSTALL_LOCK.lock().await;
    let path = browser_runtime()?;
    if !verified_runtime(&path) {
        plain_path(&path)?;
        let (name, expected) = browser_asset()?;
        let client = reqwest::Client::builder().timeout(Duration::from_secs(120)).user_agent("Coffee-CLI").build().map_err(|_| "control_network")?;
        let mut response = client.get(format!("https://github.com/vercel-labs/agent-browser/releases/download/v{BROWSER_VERSION}/{name}")).send().await.map_err(|_| "control_network")?.error_for_status().map_err(|_| "control_network")?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "control_network")? {
            if bytes.len() + chunk.len() > 40_000_000 { return Err("control_network".into()); }
            bytes.extend_from_slice(&chunk);
        }
        if format!("{:x}", Sha256::digest(&bytes)) != expected { return Err("control_integrity".into()); }
        fs::create_dir_all(path.parent().ok_or("control_write")?).map_err(|_| "control_write")?;
        let license = path.with_file_name("LICENSE.txt");
        plain_path(&license)?;
        fs::write(license, BROWSER_LICENSE).map_err(|_| "control_write")?;
        let temp = path.with_file_name(format!(".browser-{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temp, bytes).map_err(|_| "control_write")?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&temp, fs::Permissions::from_mode(0o755)).map_err(|_| "control_write")?; }
        if let Err(error) = crate::agent::replace_file(&temp, &path) { let _ = fs::remove_file(temp); return Err(error); }
    }
    status("browser")
}

#[tauri::command]
pub async fn set_tool_control(kind: String, tool: String, enabled: bool) -> Result<ControlStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = CONFIG_LOCK.lock().map_err(|_| "control_write")?;
        let name = key(&kind)?;
        let path = config_path(&tool)?;
        if enabled && !crate::tools::find(&tool).is_some_and(|descriptor| crate::server::binary_on_path(descriptor.binary_name)) { return Err("control_tool_missing".into()); }
        let current = status(&kind)?;
        if !current.agents.iter().any(|agent| agent.tool == tool && agent.supported) { return Err("control_unsupported".into()); }
        if enabled && !current.ready { return Err("control_unavailable".into()); }
        if enabled && kind == "computer" { crate::computer_control::probe()?; }
        let before = read(&path)?;
        let expected = spec(&std::env::current_exe().map_err(|_| "control_write")?, &kind, &tool);
        if entry(before.as_deref(), &tool, name)?.as_ref() != if enabled { Some(&expected) } else { None } {
            let content = edit(before.as_deref(), &tool, name, &expected, enabled)?;
            save(&path, before.as_deref(), &content, &root()?)?;
        }
        status(&kind)
    }).await.map_err(|_| "control_write")?
}

pub fn serve(kind: &str, tool: &str) -> Result<(), String> {
    let path = config_path(tool)?;
    if entry(read(&path)?.as_deref(), tool, key(kind)?)?.as_ref() != Some(&spec(&std::env::current_exe().map_err(|_| "control_read")?, kind, tool)) {
        return Err("This capability is not enabled for this agent".into());
    }
    if kind == "computer" { return crate::computer_control::serve(); }
    let runtime = browser_runtime()?;
    if !verified_runtime(&runtime) { return Err("control_integrity".into()); }
    let browser = browser_executable().ok_or("control_browser_missing")?;
    let (_lease, profile, index) = browser_slot(&root()?.join("browser-profiles").join(tool))?;
    fs::create_dir_all(&profile).map_err(|_| "control_write")?;
    let session = format!("coffee-{tool}-{index}");
    // A previous interrupted connection may have left its own daemon running.
    let close = || wait_quiet(browser_command(&runtime)?.args(["--session", &session, "close"]), Duration::from_secs(10));
    let _ = close();
    let exit = hidden(browser_command(&runtime)?.args(["mcp", "--tools", "core"])
        .env("AGENT_BROWSER_HEADED", "1").env("AGENT_BROWSER_PROFILE", profile)
        .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", "3600000")
        .env("AGENT_BROWSER_EXECUTABLE_PATH", browser).env("AGENT_BROWSER_SESSION", &session)
        .stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()))
        .status();
    let _ = close();
    let exit = exit.map_err(|error| error.to_string())?;
    if exit.success() { Ok(()) } else { Err(format!("Browser control exited with {exit}")) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_configuration_locations_respect_homes_and_existing_jsonc() {
        let home = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("coffee-control-paths-{}", uuid::Uuid::new_v4()));
        let expected = [("cursor",".cursor/mcp.json"),("copilot",".copilot/mcp-config.json"),("antigravity",".gemini/config/mcp_config.json"),
            ("qwen",".qwen/settings.json"),("kiro",".kiro/settings/mcp.json"),("opencode",".config/opencode/opencode.json"),("kilo",".config/kilo/kilo.json")];
        for (tool, suffix) in expected { assert_eq!(config_path_in(tool, &home, |_| None).unwrap(), home.join(suffix)); }
        let relocated = home.join("custom");
        assert_eq!(config_path_in("kiro", &home, |key| (key == "KIRO_HOME").then(|| relocated.clone().into_os_string())).unwrap(), relocated.join("settings/mcp.json"));
        assert_eq!(config_path_in("kilo", &home, |key| (key == "XDG_CONFIG_HOME").then(|| relocated.clone().into_os_string())).unwrap(), relocated.join("kilo/kilo.json"));
        fs::create_dir_all(home.join(".config/kilo")).unwrap(); fs::write(home.join(".config/kilo/kilo.jsonc"), "{}").unwrap();
        assert_eq!(config_path_in("kilo", &home, |_| None).unwrap(), home.join(".config/kilo/kilo.jsonc"));
        assert!(config_path_in("pi", &home, |_| None).is_err());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn json_clients_round_trip_only_the_owned_entry_and_keep_comments() {
        let exe = Path::new("C:/Program Files/Coffee/coffee-cli.exe");
        for tool in ["claude","cursor","copilot","antigravity","qwen","kiro","kilo","opencode"] {
            for nested in [false,true] {
                if nested && tool != "opencode" { continue; }
                let original = if nested { "{\n// keep model\n\"model\":\"my-model\",\"mcp\":{\"servers\":{\"mine\":{\"type\":\"local\",\"command\":[\"custom\"]}},\"timeout\":{\"startup\":30000}},\"hooks\":[],\n}\n" }
                    else if matches!(tool,"kilo"|"opencode") { "{\n// keep model\n\"model\":\"my-model\",\"mcp\":{\"mine\":{\"type\":\"local\",\"command\":[\"custom\"]}},\"hooks\":[],\n}\n" }
                    else { "{\n// keep model\n\"model\":\"my-model\",\"mcpServers\":{\"mine\":{\"command\":\"custom\"}},\"hooks\":[],\n}\n" };
                let expected = spec(exe, "browser", tool);
                let added = edit(Some(original), tool, "coffee-browser-use", &expected, true).unwrap();
                assert!(added.contains("// keep model"));
                assert_eq!(entry(Some(&added), tool, "coffee-browser-use").unwrap(), Some(expected.clone()));
                let removed = edit(Some(&added), tool, "coffee-browser-use", &expected, false).unwrap();
                assert!(removed.contains("// keep model"));
                assert_eq!(json_config(&removed).unwrap(), json_config(original).unwrap());
                assert!(edit(Some(&added), tool, "coffee-browser-use", &json!({"command":"user-changed"}), false).is_err());
                if matches!(tool,"kilo"|"opencode") { assert!(expected["command"].is_array()); assert!(expected.get("enabled").is_none()); }
                if tool == "copilot" { assert_eq!(expected["type"], "local"); assert_eq!(expected["tools"], json!(["*"])); }
            }
        }
    }
    #[test]
    fn empty_configuration_is_unconfigured_until_explicitly_enabled() {
        let exe = Path::new("/opt/coffee");
        for original in ["", "  \r\n", "\u{feff}\n"] {
            let agent = agent_status("antigravity", "computer", exe, Ok(Some(original.into())));
            assert!(agent.supported && !agent.enabled && !agent.conflict && agent.issue.is_none());
            let expected = spec(exe, "computer", "antigravity");
            let added = edit(Some(original), "antigravity", "coffee-computer-use", &expected, true).unwrap();
            assert_eq!(entry(Some(&added), "antigravity", "coffee-computer-use").unwrap(), Some(expected));
        }
    }
    #[test]
    fn malformed_or_unsupported_agents_do_not_hide_other_controls() {
        let exe = Path::new("/opt/coffee");
        let broken = agent_status("cursor", "computer", exe, Ok(Some("{ broken".into())));
        assert!(broken.supported && broken.conflict && !broken.enabled);
        assert_eq!(broken.issue, Some("configuration"));
        let unsupported = agent_status("pi", "computer", exe, Err("control_unsupported".into()));
        assert!(!unsupported.supported && !unsupported.enabled && !unsupported.conflict);
        assert_eq!(unsupported.issue, Some("unsupported"));
        let healthy = agent_status("copilot", "computer", exe, Ok(None));
        assert!(healthy.supported && !healthy.conflict);
    }
    #[test]
    fn edits_preserve_other_servers_permissions_and_hooks() {
        let expected = spec(Path::new("C:/Coffee/coffee-cli.exe"), "computer", "claude");
        let original = r#"{"mcpServers":{"mine":{"command":"custom"}},"hooks":{"Stop":[{"hooks":[]}]},"permissions":{"deny":["x"]}}"#;
        let added = edit(Some(original), "claude", "coffee-computer-use", &expected, true).unwrap();
        let removed = edit(Some(&added), "claude", "coffee-computer-use", &expected, false).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&removed).unwrap(), serde_json::from_str::<Value>(original).unwrap());
        assert!(edit(Some(&added), "claude", "coffee-computer-use", &json!({"command":"different"}), false).is_err());
    }
    #[test]
    fn toml_comments_and_unrelated_values_survive_enable_and_disable() {
        let original = "# keep me\nmodel = \"my-model\" # selected\n[mcp_servers.mine]\ncommand = \"other\"\n";
        let expected = spec(Path::new("/opt/coffee"), "browser", "codex");
        let added = edit(Some(original), "codex", "coffee-browser-use", &expected, true).unwrap();
        assert!(added.contains("# keep me") && added.contains("# selected"));
        assert_eq!(entry(Some(&added), "codex", "coffee-browser-use").unwrap(), Some(expected.clone()));
        let removed = edit(Some(&added), "codex", "coffee-browser-use", &expected, false).unwrap();
        assert_eq!(removed, original);
        assert!(edit(Some("model=["), "codex", "x", &expected, true).is_err());
    }
    #[test]
    fn save_rejects_a_concurrent_edit() {
        let directory = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("coffee-control-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json"); fs::write(&path, "user edit").unwrap();
        assert!(save(&path, Some("old"), "new", &directory).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "user edit");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn saved_configuration_backups_are_private() {
        let base = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("coffee-backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("config.json");
        let storage = base.join("storage");
        fs::write(&path, "previous private configuration").unwrap();
        save(&path, Some("previous private configuration"), "new configuration", &storage).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new configuration");
        let backup = fs::read_dir(storage.join("backups")).unwrap().next().unwrap().unwrap().path().join("config.json");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "previous private configuration");
        #[cfg(unix)]
        { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(backup).unwrap().permissions().mode() & 0o777, 0o600); }
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn preparing_browser_connections_preserves_the_shared_configuration() {
        let directory = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("coffee-browser-config-{}", uuid::Uuid::new_v4()));
        browser_command_in(Path::new("browser-runtime"), &directory).unwrap();
        let config = directory.join("browser-config.json");
        let original = fs::metadata(&config).unwrap();
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let directory = &directory;
                scope.spawn(move || { for _ in 0..32 { browser_command_in(Path::new("browser-runtime"), directory).unwrap(); } });
            }
            for _ in 0..128 { assert_eq!(fs::read(&config).unwrap(), b"{}"); }
        });
        assert_eq!(fs::metadata(&config).unwrap().modified().unwrap(), original.modified().unwrap());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn parallel_connections_use_different_persistent_profiles() {
        let directory = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("coffee-browser-slots-{}", uuid::Uuid::new_v4()));
        let (first, first_profile, first_index) = browser_slot(&directory).unwrap();
        let (second, second_profile, _) = browser_slot(&directory).unwrap();
        assert_ne!(first_profile, second_profile);
        drop(first);
        let (reused, reused_profile, reused_index) = browser_slot(&directory).unwrap();
        assert_eq!(first_index, reused_index); assert_eq!(first_profile, reused_profile);
        drop(second); drop(reused); fs::remove_dir_all(directory).unwrap();
    }
}
