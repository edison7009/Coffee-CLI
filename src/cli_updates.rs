//! CLI updates target the installation that the launcher actually resolves.
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{LazyLock, Mutex}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct CliUpdateStatus {
    tool: String,
    current: Option<String>,
    latest: Option<String>,
    available: bool,
}

#[derive(Clone, Debug)]
enum Source { Npm(String), Brew(String, bool), Pypi(&'static str), Github(&'static str), Cursor, Antigravity }
#[derive(Clone, Debug)]
struct Plan { program: PathBuf, args: Vec<String>, env: Vec<(String, String)> }
struct Installation { path: PathBuf, current: Option<String>, source: Option<Source>, plan: Option<Plan> }
#[derive(Clone)]
struct Cached { signature: String, at: u64, status: CliUpdateStatus }
static CACHE: LazyLock<Mutex<HashMap<String, Cached>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static LATEST_CACHE: LazyLock<Mutex<HashMap<String, (u64, String)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
// Global package databases must not be written by two installers concurrently.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn packages(tool: &str) -> &'static [&'static str] {
    match tool {
        "claude" => &["@anthropic-ai/claude-code"], "codex" => &["@openai/codex"],
        "copilot" => &["@github/copilot"], "opencode" => &["opencode-ai", "@opencode/cli"],
        "openclaw" => &["openclaw"], "qwen" => &["@qwen-code/qwen-code"],
        "pi" => &["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"],
        "omp" => &["@oh-my-pi/pi-coding-agent"], "cline" => &["cline"],
        "crush" => &["@charmland/crush"], "codebuddy" => &["@tencent-ai/codebuddy-code"],
        "kilo" => &["@kilocode/cli"], "minimax" => &["@minimax-ai/code"],
        "grok" => &["@xai-official/grok"],
        // npm installs only; DeepSeek Harness Desktop updates its bundled runtime itself.
        "dsh" => &["@deepseek-ai/dsh"], _ => &[],
    }
}

fn executable(path: &Path) -> bool {
    if !path.is_file() { return false; }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; return path.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0); }
    #[cfg(not(unix))] { true }
}

fn in_directory(directory: &Path, name: &str) -> Option<PathBuf> {
    #[cfg(windows)] let suffixes = [".exe", ".cmd", ".bat", ""];
    #[cfg(not(windows))] let suffixes = [""];
    suffixes.iter().map(|suffix| directory.join(format!("{name}{suffix}"))).find(|path| executable(path))
}

fn search_path() -> std::ffi::OsString {
    #[cfg(windows)] { crate::windows_path::terminal_path().into() }
    #[cfg(not(windows))] { std::env::var_os("PATH").unwrap_or_default() }
}

fn resolve(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() { return executable(path).then(|| path.to_path_buf()); }
    if path.components().count() != 1 { return None; }
    std::env::split_paths(&search_path()).find_map(|directory| in_directory(&directory, name))
}

fn tool_path(tool: &str) -> Option<PathBuf> {
    let descriptor = crate::tools::find(tool)?;
    let config = crate::tool_config::load();
    let configured = config.get(tool).map(|entry| entry.command.trim()).filter(|value| !value.is_empty());
    if let Some(value) = configured {
        // A wrapper (SSH, WSL, Docker, custom script) owns its own update process.
        let name = if Path::new(value).is_file() { value.to_string() } else { crate::tool_config::parse_command(value).0? };
        let name = crate::tool_config::command_binary(tool, &name);
        let basename = Path::new(name).file_stem()?.to_str()?;
        if basename != descriptor.binary_name { return None; }
        return resolve(name);
    }
    resolve(descriptor.binary_name).or_else(|| {
        if tool != "claude" { return None; }
        in_directory(&dirs::home_dir()?.join(".local/bin"), "claude")
    })
}

fn version(text: &str) -> Option<String> {
    static VERSION: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)").unwrap());
    VERSION.captures(text).and_then(|captures| {
        let value = captures.get(1)?.as_str(); semver::Version::parse(value).ok().map(|_| value.to_string())
    })
}

fn newer(current: &str, latest: &str, calendar: bool) -> bool {
    let (Ok(current), Ok(latest)) = (semver::Version::parse(current), semver::Version::parse(latest)) else { return false; };
    if calendar && (current.major, current.minor, current.patch) == (latest.major, latest.minor, latest.patch) { return current != latest; }
    latest > current
}

fn plan(program: PathBuf, args: &[&str]) -> Plan { Plan { program, args: args.iter().map(|value| value.to_string()).collect(), env: Vec::new() } }

fn package_installation(path: &Path, real: &Path, tool: &str) -> Option<Installation> {
    let parent = path.parent()?;
    let shim = if matches!(path.extension().and_then(|value| value.to_str()), Some("cmd" | "bat")) {
        std::fs::read(path).ok().filter(|bytes| bytes.len() < 32768).map(|bytes| String::from_utf8_lossy(&bytes).replace('\\', "/"))
    } else { None };
    for package in packages(tool) {
        let mut roots: Vec<PathBuf> = real.ancestors().skip(1).take(10).map(Path::to_path_buf).collect();
        roots.push(parent.join("node_modules").join(package));
        for root in roots {
            let Ok(data) = std::fs::read(root.join("package.json")) else { continue; };
            let Ok(json) = serde_json::from_slice::<serde_json::Value>(&data) else { continue; };
            if json["name"].as_str() != Some(package) { continue; }
            let canonical = root.canonicalize().ok()?;
            if !real.starts_with(&canonical) && !shim.as_ref().is_some_and(|text| text.contains(package)) { continue; }
            let modules = root.ancestors().find(|ancestor| ancestor.file_name().is_some_and(|name| name == "node_modules"))?;
            let prefix = modules.parent()?;
            let location = canonical.to_string_lossy().replace('\\', "/").to_lowercase();
            let update = if location.contains("/.bun/install/global/") {
                let mut update = plan(resolve("bun")?, &["add", "--global", &format!("{package}@latest")]);
                update.env.push(("BUN_INSTALL_GLOBAL_DIR".into(), prefix.to_str()?.into())); update
            } else if location.contains("/pnpm/global/") {
                let manager = in_directory(parent, "pnpm").or_else(|| resolve("pnpm"))?;
                // pnpm inserts layout-version/store directories below its global root.
                // Ask this manager which database it owns instead of deriving one from the package path.
                let output = run(&plan(manager.clone(), &["root", "--global"]), 10).ok()?;
                let modules = output.lines().rev().find_map(|line| Path::new(line.trim()).canonicalize().ok())?;
                if !real.starts_with(modules) { return None; }
                plan(manager, &["add", "--global", &format!("{package}@latest")])
            } else {
                #[cfg(not(windows))]
                if !prefix.file_name().is_some_and(|name| name == "lib") { return None; }
                #[cfg(windows)]
                if parent.canonicalize().ok()? != prefix.canonicalize().ok()? && !real.starts_with(&canonical) { return None; }
                let prefix = if prefix.file_name().is_some_and(|name| name == "lib") { prefix.parent()? } else { prefix };
                let manager = in_directory(parent, "npm").or_else(|| in_directory(&prefix.join("bin"), "npm")).or_else(|| resolve("npm"))?;
                let mut update = plan(manager, &["install", "--global", "--prefix", prefix.to_str()?, &format!("{package}@latest"), "--include=optional"]);
                if tool == "claude" { update.args.extend(["--ignore-scripts=false".into(), "--allow-scripts=@anthropic-ai/claude-code".into()]); }
                update
            };
            return Some(Installation { path: path.into(), current: json["version"].as_str().and_then(version), source: Some(Source::Npm(package.to_string())), plan: Some(update) });
        }
    }
    None
}

fn installation(path: PathBuf, tool: &str) -> Installation {
    let real = path.canonicalize().unwrap_or_else(|_| path.clone());
    let mut result = Installation { path: path.clone(), current: None, source: None, plan: None };
    // Homebrew owns the whole installation, including npm-shaped formulae.
    for directory in real.ancestors() {
        let Some(marker) = directory.parent().and_then(Path::file_name).and_then(|name| name.to_str()) else { continue; };
        if !matches!(marker, "Cellar" | "Caskroom") { continue; }
        if let (Some(token), Some(prefix)) = (directory.file_name().and_then(|value| value.to_str()), directory.parent().and_then(Path::parent)) {
            if let Some(brew) = in_directory(&prefix.join("bin"), "brew") {
                result.source = Some(Source::Brew(token.into(), marker == "Caskroom"));
                result.plan = Some(plan(brew, &["upgrade", if marker == "Caskroom" { "--cask" } else { "--formula" }, token]));
                return result;
            }
        }
    }
    if let Some(package) = package_installation(&path, &real, tool) { return package; }
    if let Some(package) = match tool { "aider" => Some("aider-chat"), "kimicode" => Some("kimi-cli"), _ => None } {
        for root in real.ancestors().skip(1).take(5) {
            if !root.join("pyvenv.cfg").is_file() { continue; }
            let python = in_directory(&root.join(if cfg!(windows) { "Scripts" } else { "bin" }), "python");
            if let Some(python) = python {
                let location = root.to_string_lossy().replace('\\', "/").to_lowercase();
                let update = if location.contains("/uv/tools/") {
                    resolve("uv").map(|uv| { let mut update = plan(uv, &["tool", "upgrade", package]); update.env.push(("UV_TOOL_DIR".into(), root.parent().unwrap_or(root).to_string_lossy().into_owned())); update })
                } else if location.contains("/pipx/venvs/") {
                    resolve("pipx").map(|pipx| { let mut update = plan(pipx, &["upgrade", package]); update.env.push(("PIPX_HOME".into(), root.parent().and_then(Path::parent).unwrap_or(root).to_string_lossy().into_owned())); update })
                } else { Some(plan(python, &["-m", "pip", "install", "--upgrade", package])) };
                result.source = Some(Source::Pypi(package)); result.plan = update; return result;
            }
        }
    }
    let location = real.to_string_lossy().replace('\\', "/").to_lowercase();
    let native = match tool {
        "claude" if location.contains("/.local/") => Some((Source::Npm(packages(tool)[0].into()), vec!["update"])),
        "codex" if location.contains("/.codex/packages/standalone/") => Some((Source::Npm(packages(tool)[0].into()), vec!["update"])),
        "opencode" => Some((Source::Npm("opencode-ai".into()), vec!["upgrade"])),
        "cursor" => Some((Source::Cursor, vec!["update"])),
        "antigravity" => Some((Source::Antigravity, vec!["update"])),
        "hermes" => Some((Source::Github("NousResearch/hermes-agent"), vec!["update"])),
        "kimicode" => Some((Source::Pypi("kimi-cli"), vec!["upgrade", "--yes"])),
        "omp" if location.contains("/.local/bin/") || location.contains("/appdata/local/omp/") => Some((Source::Npm(packages(tool)[0].into()), vec!["update"])),
        _ => None,
    };
    if let Some((source, args)) = native { result.source = Some(source); result.plan = Some(plan(path, &args)); }
    result
}

fn run(update: &Plan, seconds: u64) -> Result<String, String> {
    // An anonymous spool also handles updaters whose detached children keep stdout open.
    let mut output = tempfile::tempfile().map_err(|_| "cli_update_failed")?;
    let mut command = Command::new(&update.program);
    command.args(&update.args).envs(update.env.iter().map(|(key, value)| (key, value))).stdin(Stdio::null()).stdout(output.try_clone().map_err(|_| "cli_update_failed")?).stderr(output.try_clone().map_err(|_| "cli_update_failed")?).env("CI", "1").env("NO_COLOR", "1");
    let mut paths = vec![update.program.parent().unwrap_or(Path::new(".")).to_path_buf()];
    paths.extend(std::env::split_paths(&search_path()));
    if let Ok(path) = std::env::join_paths(paths) { command.env("PATH", path); }
    if let Some(home) = dirs::home_dir() { command.current_dir(home); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        // Batch expansion must never reinterpret a user's profile path as code.
        if update.program.to_string_lossy().contains(['%', '!', '\r', '\n']) || update.args.iter().any(|arg| arg.contains(['%', '!', '\r', '\n'])) { return Err("cli_update_unsupported".into()); }
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.spawn().map_err(|_| "cli_update_failed")?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < Duration::from_secs(seconds) && output.metadata().is_ok_and(|meta| meta.len() < 8_000_000) => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                #[cfg(windows)] { let mut kill = Command::new("taskkill.exe"); crate::tool_control::hidden(&mut kill).args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status().ok(); }
                #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                let _ = child.kill(); let _ = child.wait(); break None;
            }
        }
    };
    let mut bytes = Vec::new();
    output.seek(SeekFrom::Start(0)).map_err(|_| "cli_update_failed")?;
    output.take(262144).read_to_end(&mut bytes).map_err(|_| "cli_update_failed")?;
    match status {
        Some(status) if status.success() => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        None if started.elapsed() >= Duration::from_secs(seconds) => Err("cli_update_timeout".into()),
        _ => Err("cli_update_failed".into()),
    }
}

async fn fetch_latest(source: &Source) -> Option<String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(12)).user_agent("Coffee-CLI").build().ok()?;
    let url = match source {
        Source::Npm(package) => format!("https://registry.npmjs.org/{package}/latest"),
        Source::Brew(token, cask) => format!("https://formulae.brew.sh/api/{}/{token}.json", if *cask { "cask" } else { "formula" }),
        Source::Pypi(package) => format!("https://pypi.org/pypi/{package}/json"),
        Source::Github(repo) => format!("https://api.github.com/repos/{repo}/releases/latest"),
        Source::Cursor => "https://cursor.com/install".into(),
        Source::Antigravity => format!("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{}_{}.json", if cfg!(windows) { "windows" } else if cfg!(target_os="macos") { "darwin" } else { "linux" }, if cfg!(target_arch="aarch64") { "arm64" } else { "amd64" }),
    };
    let mut response = client.get(url).send().await.ok()?.error_for_status().ok()?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? { if bytes.len() + chunk.len() > 2_000_000 { return None; } bytes.extend_from_slice(&chunk); }
    if matches!(source, Source::Cursor) {
        let text = String::from_utf8_lossy(&bytes);
        return text.split("https://downloads.cursor.com/lab/").nth(1).and_then(|tail| version(tail.split('/').next()?));
    }
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let value = match source {
        Source::Brew(_, false) => &json["versions"]["stable"], Source::Pypi(_) => &json["info"]["version"],
        Source::Github(_) => &json["tag_name"], _ => &json["version"],
    };
    value.as_str().and_then(version)
}

async fn latest(source: &Source) -> Option<String> {
    let key = format!("{source:?}");
    let cached = LATEST_CACHE.lock().ok()?.get(&key).cloned();
    if let Some((at, value)) = &cached { if now().saturating_sub(*at) < 3600 { return Some(value.clone()); } }
    if let Some(value) = fetch_latest(source).await {
        LATEST_CACHE.lock().ok()?.insert(key, (now(), value.clone())); return Some(value);
    }
    cached.map(|(_, value)| value)
}

fn signature(path: &Path) -> String {
    let real = path.canonicalize().unwrap_or_else(|_| path.into());
    format!("{}:{:?}", real.display(), real.metadata().and_then(|meta| meta.modified()).ok())
}
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }

#[tauri::command]
pub async fn check_cli_update(tool: String) -> Result<CliUpdateStatus, String> {
    if crate::tools::find(&tool).is_none() { return Err("cli_update_unsupported".into()); }
    let id = tool.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = tool_path(&id) else { return Ok::<_, String>(None); };
        let fingerprint = signature(&path);
        if let Some(cached) = CACHE.lock().map_err(|_| "cli_update_failed")?.get(&id).filter(|cached| cached.signature == fingerprint && now().saturating_sub(cached.at) < 60).cloned() {
            return Ok(Some((None, fingerprint, Some(cached.status))));
        }
        let mut installed = installation(path, &id);
        if installed.current.is_none() { installed.current = run(&plan(installed.path.clone(), &["--version"]), 10).ok().and_then(|output| version(&output)); }
        if id == "opencode" && installed.plan.as_ref().is_some_and(|plan| plan.args == ["upgrade"]) && installed.current.as_ref().and_then(|value| semver::Version::parse(value).ok()).is_some_and(|value| value.major >= 2) && matches!(&installed.source, Some(Source::Npm(package)) if package == "opencode-ai") {
            installed.source = Some(Source::Npm("@opencode/cli".into()));
        }
        Ok(Some((Some(installed), fingerprint, None)))
    }).await.map_err(|_| "cli_update_failed")?;
    let Some((installed, fingerprint, cached)) = installed? else { return Ok(CliUpdateStatus { tool, ..Default::default() }); };
    if let Some(cached) = cached { return Ok(cached); }
    let installed = installed.ok_or("cli_update_failed")?;
    let newest = if installed.current.is_some() { match &installed.source { Some(source) => latest(source).await, None => None } } else { None };
    let available = installed.plan.is_some() && installed.current.as_ref().zip(newest.as_ref()).is_some_and(|(current, latest)| newer(current, latest, matches!(installed.source, Some(Source::Cursor))));
    let status = CliUpdateStatus { tool: tool.clone(), current: installed.current, latest: newest, available };
    CACHE.lock().map_err(|_| "cli_update_failed")?.insert(tool, Cached { signature: fingerprint, at: now(), status: status.clone() });
    Ok(status)
}

struct Updating(String);
impl Drop for Updating { fn drop(&mut self) { if let Ok(mut running) = RUNNING.lock() { running.remove(&self.0); } } }

fn perform_update(installed: Installation, expected: &CliUpdateStatus) -> Result<(), String> {
    let update = installed.plan.ok_or("cli_update_unsupported")?;
    run(&update, 600)?;
    let current = run(&plan(installed.path, &["--version"]), 15).ok().and_then(|output| version(&output)).ok_or("cli_update_verify")?;
    if expected.latest.as_ref().is_some_and(|latest| newer(&current, latest, expected.tool == "cursor")) { return Err("cli_update_verify".into()); }
    Ok(())
}

#[tauri::command]
pub async fn update_cli(tool: String) -> Result<CliUpdateStatus, String> {
    if crate::tools::find(&tool).is_none() { return Err("cli_update_unsupported".into()); }
    if !RUNNING.lock().map_err(|_| "cli_update_failed")?.insert(tool.clone()) { return Err("cli_update_busy".into()); }
    let updating = Updating(tool.clone());
    let expected = check_cli_update(tool.clone()).await?;
    if !expected.available { return Err("cli_update_unsupported".into()); }
    let id = tool.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _updating = updating;
        let _serial = INSTALL_LOCK.lock().map_err(|_| "cli_update_failed")?;
        let path = tool_path(&id).ok_or("cli_update_missing")?;
        perform_update(installation(path, &id), &expected)?;
        CACHE.lock().map_err(|_| "cli_update_failed")?.remove(&id);
        Ok::<(), String>(())
    }).await.map_err(|_| "cli_update_failed")??;
    check_cli_update(tool).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn script(directory: &Path, name: &str, windows: &str, unix: &str) -> PathBuf {
        fs::create_dir_all(directory).unwrap();
        let path = directory.join(if cfg!(windows) { format!("{name}.cmd") } else { name.into() });
        fs::write(&path, if cfg!(windows) { windows } else { unix }).unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap(); }
        path
    }

    #[test]
    fn versions_use_semantic_order_without_downgrading_preview_builds() {
        assert_eq!(version("codex-cli 0.153.2\n"), Some("0.153.2".into()));
        assert_eq!(version("v2.1.4"), Some("2.1.4".into()));
        assert_eq!(version("not installed"), None);
        assert!(newer("1.9.0", "1.10.0", false));
        assert!(!newer("2.0.0-beta.1", "1.9.9", false));
        assert!(newer("1.0.0-beta.1", "1.0.0", false));
        assert!(!newer("1.0.0", "1.0.0", false));
        assert!(newer("2026.10.22-z123", "2026.10.22-a123", true));
        assert!(!newer("2026.10.23-a123", "2026.10.22-z123", true));
    }

    #[test]
    fn cursor_detection_and_updates_do_not_select_another_agent() {
        let temp = tempfile::tempdir().unwrap();
        script(temp.path(), "agent", "@echo off\r\necho 1.0.70", "#!/bin/sh\necho 1.0.70");
        let binary = crate::tools::find("cursor").unwrap().binary_name;
        assert!(in_directory(temp.path(), binary).is_none(), "an unrelated agent is not a Cursor installation");
        let cursor = script(temp.path(), "cursor-agent", "@echo off\r\necho 2026.10.21-abc", "#!/bin/sh\necho 2026.10.21-abc");
        let resolved = in_directory(temp.path(), binary).unwrap();
        assert_eq!(resolved, cursor);
        let installed = installation(resolved, "cursor");
        assert!(matches!(installed.source, Some(Source::Cursor)));
        let update = installed.plan.unwrap();
        assert_eq!(update.program, cursor);
        assert_eq!(update.args, ["update"]);
        assert_eq!(version(&run(&plan(cursor, &["--version"]), 5).unwrap()).as_deref(), Some("2026.10.21-abc"));
    }

    #[test]
    fn npm_updates_are_bound_to_the_original_prefix_and_package() {
        let temp = tempfile::Builder::new().prefix("coffee update 测试 ").tempdir().unwrap();
        let prefix = temp.path();
        let bin = if cfg!(windows) { prefix.into() } else { prefix.join("bin") };
        let package = prefix.join(if cfg!(windows) { "node_modules" } else { "lib/node_modules" }).join("@openai/codex");
        fs::create_dir_all(package.join("bin")).unwrap();
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex","version":"1.0.0"}"#).unwrap();
        script(&bin, "npm", "@echo off\r\nexit /b 0", "#!/bin/sh\nexit 0");
        #[cfg(windows)] let path = script(&bin, "codex", "@echo off\r\nnode \"%~dp0node_modules/@openai/codex/bin/codex.js\" %*", "");
        #[cfg(unix)] let path = {
            let real = script(&package.join("bin"), "codex", "", "#!/bin/sh\necho 1.0.0");
            let path = bin.join("codex"); std::os::unix::fs::symlink(real, &path).unwrap(); path
        };
        let found = installation(path, "codex");
        assert_eq!(found.current.as_deref(), Some("1.0.0"));
        let update = found.plan.unwrap();
        assert_eq!(&update.args[0..3], &["install", "--global", "--prefix"]);
        assert_eq!(Path::new(&update.args[3]).canonicalize().unwrap(), prefix.canonicalize().unwrap());
        assert_eq!(update.args[4], "@openai/codex@latest");
        // A package elsewhere in the same directory does not own an unrelated binary.
        let unrelated = bin.join("codex-private.exe"); fs::write(&unrelated, b"fixture").unwrap();
        assert!(package_installation(&unrelated, &unrelated.canonicalize().unwrap(), "codex").is_none());
    }

    #[test]
    fn brew_ownership_takes_precedence_over_node_layout() {
        let temp = tempfile::tempdir().unwrap();
        script(&temp.path().join("bin"), "brew", "@echo off\r\nexit /b 0", "#!/bin/sh\nexit 0");
        let root = temp.path().join("Cellar/codex/1.0.0/lib/node_modules/@openai/codex/bin");
        let path = script(&root, "codex", "@echo off\r\necho 1.0.0", "#!/bin/sh\necho 1.0.0");
        let found = installation(path, "codex");
        assert!(matches!(found.source, Some(Source::Brew(ref token, false)) if token == "codex"));
        assert_eq!(found.plan.unwrap().args, ["upgrade", "--formula", "codex"]);
    }

    #[test]
    fn pnpm_nested_store_uses_the_verified_global_database() {
        let temp = tempfile::Builder::new().prefix("coffee-pnpm-").tempdir().unwrap();
        let modules = temp.path().join("pnpm/global/5/node_modules");
        let package = modules.join(".pnpm/@openai+codex@1.0.0/node_modules/@openai/codex");
        let bin = package.join("bin"); fs::create_dir_all(&bin).unwrap();
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex","version":"1.0.0"}"#).unwrap();
        let path = script(&bin, "codex", "@echo off\r\necho 1.0.0", "#!/bin/sh\necho 1.0.0");
        script(&bin, "pnpm", &format!("@echo off\r\necho {}", modules.display()), &format!("#!/bin/sh\nprintf '%s\\n' '{}'", modules.display()));
        let update = installation(path.clone(), "codex").plan.unwrap();
        assert_eq!(update.args, ["add", "--global", "@openai/codex@latest"]);
        assert!(update.env.is_empty(), "do not override PNPM_HOME or append a second layout version");
        let other = temp.path().join("other/node_modules"); fs::create_dir_all(&other).unwrap();
        script(&bin, "pnpm", &format!("@echo off\r\necho {}", other.display()), &format!("#!/bin/sh\nprintf '%s\\n' '{}'", other.display()));
        assert!(installation(path, "codex").plan.is_none(), "a different global database must not receive the update");
    }

    #[test]
    fn private_and_unmanaged_binaries_are_not_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let private = script(&temp.path().join("editor/resources"), "codex", "@echo off\r\necho 1.0.0", "#!/bin/sh\necho 1.0.0");
        assert!(installation(private, "codex").plan.is_none());
        let native = script(&temp.path().join(".local/bin"), "claude", "@echo off\r\necho 1.0.0", "#!/bin/sh\necho 1.0.0");
        assert_eq!(installation(native, "claude").plan.unwrap().args, ["update"]);
    }

    #[test]
    fn successful_exit_is_not_success_until_the_running_version_changes() {
        let temp = tempfile::Builder::new().prefix("coffee installer 测试 ").tempdir().unwrap();
        fs::write(temp.path().join("version.txt"), "1.0.0").unwrap();
        let path = script(temp.path(), "fake-cli",
            "@echo off\r\nif \"%~1\"==\"--version\" (type \"%~dp0version.txt\" & exit /b 0)\r\nif \"%~1\"==\"update\" (>\"%~dp0version.txt\" echo 1.1.0 & exit /b 0)\r\nexit /b 0",
            "#!/bin/sh\nif [ \"$1\" = '--version' ]; then cat \"$(dirname \"$0\")/version.txt\"; elif [ \"$1\" = 'update' ]; then echo 1.1.0 > \"$(dirname \"$0\")/version.txt\"; fi");
        let expected = CliUpdateStatus { tool: "codex".into(), current: Some("1.0.0".into()), latest: Some("1.1.0".into()), available: true };
        let installed = |args: &[&str]| Installation { path: path.clone(), current: None, source: None, plan: Some(plan(path.clone(), args)) };
        assert_eq!(perform_update(installed(&["noop"]), &expected).unwrap_err(), "cli_update_verify");
        perform_update(installed(&["update"]), &expected).unwrap();
        assert_eq!(version(&run(&plan(path, &["--version"]), 5).unwrap()).as_deref(), Some("1.1.0"));
    }

    #[test]
    fn failed_and_timed_out_installers_do_not_report_success() {
        let temp = tempfile::tempdir().unwrap();
        let fail = script(temp.path(), "failed", "@echo off\r\nexit /b 7", "#!/bin/sh\nexit 7");
        assert_eq!(run(&plan(fail, &[]), 5).unwrap_err(), "cli_update_failed");
        let slow = script(temp.path(), "slow", "@echo off\r\nping -n 20 127.0.0.1 >nul", "#!/bin/sh\nsleep 20");
        let started = Instant::now();
        assert_eq!(run(&plan(slow, &[]), 1).unwrap_err(), "cli_update_timeout");
        assert!(started.elapsed() < Duration::from_secs(6));
    }

    #[test]
    fn update_guards_are_released_on_failure() {
        RUNNING.lock().unwrap().insert("fixture".into());
        { let _guard = Updating("fixture".into()); }
        assert!(!RUNNING.lock().unwrap().contains("fixture"));
    }

    #[test]
    #[ignore = "Read-only probe of installed CLIs and their public release feeds"]
    fn local_cli_probe() {
        for tool in ["claude", "codex", "cursor", "copilot", "antigravity", "opencode"] {
            let status = tauri::async_runtime::block_on(check_cli_update(tool.into())).unwrap();
            println!("{tool}: {}", serde_json::to_string(&status).unwrap());
        }
    }
}
