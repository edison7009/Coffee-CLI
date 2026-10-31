//! Read-only local skill/MCP inventory. Configuration is not proof of runtime availability.
use crate::tool_config::ToolConfigEntry;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, HashSet}, fs, io::Read, path::{Path, PathBuf}};
use tauri::Manager;

const MAX_CONFIG_BYTES: usize = 262_144;
const MAX_SKILLS: usize = 60;

fn text_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() { return Ok(None); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| "Configuration could not be read")?.take(MAX_CONFIG_BYTES as u64 + 1)
        .read_to_end(&mut bytes).map_err(|_| "Configuration could not be read")?;
    if bytes.len() > MAX_CONFIG_BYTES || bytes.contains(&0) { return Err("Configuration exceeds text budget".into()); }
    String::from_utf8(bytes).map(Some).map_err(|_| "Configuration is not UTF-8".into())
}

fn json_file(path: &Path, warnings: &mut Vec<Value>) -> Option<Value> {
    match text_file(path) {
        Ok(Some(text)) => match serde_json::from_str(&text) {
            Ok(value) => Some(value),
            Err(_) => { warnings.push(json!({"source":path.to_string_lossy(),"reason":"Invalid JSON configuration"})); None }
        },
        Ok(None) => None,
        Err(error) => { warnings.push(json!({"source":path.to_string_lossy(),"reason":error})); None }
    }
}

fn toml_file(path: &Path, warnings: &mut Vec<Value>) -> Option<toml::Value> {
    match text_file(path) {
        Ok(Some(text)) => match toml::from_str(&text) {
            Ok(value) => Some(value),
            Err(_) => { warnings.push(json!({"source":path.to_string_lossy(),"reason":"Invalid TOML configuration"})); None }
        },
        Ok(None) => None,
        Err(error) => { warnings.push(json!({"source":path.to_string_lossy(),"reason":error})); None }
    }
}

fn safe_metadata(text: &str, limit: usize) -> String {
    let text = text.chars().take(limit).collect::<String>();
    let pattern = regex::Regex::new(r"(?i)(?:sk-[a-z0-9_-]{12,}|bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)").unwrap();
    pattern.replace_all(&text, "[redacted]").into_owned()
}

fn capability(name: &str, kind: &str, source: &Path, scope: &str, enabled: bool) -> Value {
    json!({"name":safe_metadata(name,100),"kind":kind,"source":source.to_string_lossy(),"scope":scope,"configured":true,"enabled":enabled,"availability":"unknown","description":"","configurationState":"detected","evidence":"Runtime loading and permission have not been verified."})
}

enum SkillSelector { Path(PathBuf), Name(String) }
struct SkillRule { selector: SkillSelector, enabled: bool }

fn scan_skills(base: &Path, scope: &str, rules: &[SkillRule], codex_policy: bool, entries: &mut Vec<Value>, warnings: &mut Vec<Value>) {
    if !base.exists() { return; }
    let directory = match fs::read_dir(base) { Ok(value) => value, Err(_) => { warnings.push(json!({"source":base.to_string_lossy(),"reason":"Skill directory could not be read"})); return; } };
    let mut folders = directory.take(MAX_SKILLS + 1).filter_map(Result::ok).map(|entry| entry.path()).collect::<Vec<_>>();
    folders.sort();
    for folder in folders {
        if entries.len() >= MAX_SKILLS { warnings.push(json!({"source":base.to_string_lossy(),"reason":"Skill inventory budget reached"})); break; }
        let path = folder.join("SKILL.md");
        if !path.exists() { continue; }
        // Only the small metadata prefix is needed; never load executable skill bodies.
        let text = match fs::File::open(&path).and_then(|file| {
            let mut bytes = Vec::new(); file.take(8_192).read_to_end(&mut bytes)?; Ok(String::from_utf8_lossy(&bytes).into_owned())
        }) { Ok(value) => value, Err(_) => { warnings.push(json!({"source":path.to_string_lossy(),"reason":"Skill metadata unavailable"})); continue; } };
        let mut name = folder.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let mut description = String::new();
        let mut invocation = true;
        if text.trim_start().starts_with("---") {
            let mut lines = text.trim_start().lines().skip(1).take(80).peekable();
            while let Some(line) = lines.next() {
                if line.trim() == "---" { break; }
                if let Some(value) = line.strip_prefix("name:") { name = value.trim().trim_matches(['\'', '"']).to_string(); }
                if let Some(value) = line.strip_prefix("description:") {
                    let value = value.trim();
                    if value.starts_with('|') || value.starts_with('>') {
                        let mut parts = Vec::new();
                        while lines.peek().is_some_and(|line| line.is_empty() || line.starts_with(char::is_whitespace)) {
                            parts.push(lines.next().unwrap().trim());
                        }
                        description = parts.join(if value.starts_with('>') { " " } else { "\n" });
                    } else { description = value.trim_matches(['\'', '"']).to_string(); }
                }
                if line.split('#').next().unwrap_or("").trim() == "disable-model-invocation: true" { invocation = false; }
            }
        }
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        let enabled = rules.iter().rev().find(|rule| match &rule.selector {
            SkillSelector::Path(path) => path == &canonical,
            SkillSelector::Name(selector) => selector == &name,
        }).map(|rule| rule.enabled).unwrap_or(true);
        let mut value = capability(&name, "skill", &path, scope, enabled);
        value["description"] = json!(safe_metadata(&description, 400));
        value["automaticInvocation"] = json!(invocation);
        if let Some(policy) = codex_policy.then(|| text_file(&folder.join("agents/openai.yaml")).ok().flatten()).flatten() {
            let mut in_policy = false;
            for line in policy.lines().take(120) {
                if !line.starts_with(char::is_whitespace) && !line.trim().is_empty() { in_policy = line.split('#').next().unwrap_or("").trim() == "policy:"; }
                if in_policy && line.trim().split('#').next().unwrap_or("").trim() == "allow_implicit_invocation: false" {
                    value["automaticInvocation"] = json!(false);
                }
            }
        }
        entries.push(value);
    }
}

fn add_json_mcp(value: &Value, source: &Path, scope: &str, disabled: &HashSet<String>, output: &mut BTreeMap<String, Value>) {
    if let Some(servers) = value["mcpServers"].as_object() {
        for (name, server) in servers.iter().take(100) {
            let mut entry = capability(name, "mcp", source, scope, !disabled.contains(name) && server["enabled"] != false);
            let transport = server["type"].as_str().unwrap_or("stdio");
            let valid = match transport {
                "stdio" => server["command"].as_str().is_some_and(|value| !value.trim().is_empty()),
                "http" | "streamable-http" | "sse" | "ws" => server["url"].as_str().is_some_and(|value| !value.trim().is_empty()),
                _ => false,
            };
            entry["transport"] = json!(safe_metadata(transport, 30));
            if !valid { entry["configurationState"] = json!("invalid"); }
            output.insert(name.clone(), entry);
        }
    }
}

fn ancestors(cwd: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for path in cwd.ancestors().take(20) {
        result.push(path.to_path_buf());
        if path.join(".git").exists() { break; }
        if path == cwd && !cwd.ancestors().any(|parent| parent.join(".git").exists()) { break; }
    }
    result.reverse();
    result
}

fn launch_args(tool: &str, launch: Option<&ToolConfigEntry>) -> Result<Vec<String>, String> {
    let Some(launch) = launch else { return Ok(Vec::new()); };
    let (binary, mut args) = crate::tool_config::parse_command(&launch.command);
    if let Some(binary) = binary {
        let basename = binary.rsplit(['/', '\\']).next().unwrap_or("").to_ascii_lowercase();
        let expected = if tool == "claude" { "claude" } else { "codex" };
        if ![expected.to_string(), format!("{expected}.exe"), format!("{expected}.cmd")].contains(&basename) {
            return Err("Custom launcher, container, or remote configuration cannot be verified locally".into());
        }
    }
    args.extend(launch.extra_args.iter().cloned());
    Ok(args)
}

pub(crate) fn expert_inspect(tool: &str, cwd: &str, launch_config: Option<&ToolConfigEntry>) -> Result<Value, String> {
    let canonical = crate::agent::canonical_directory(cwd)?;
    let home = dirs::home_dir().ok_or("User home directory unavailable")?;
    let codex_home = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    if std::env::var_os("CLAUDE_CONFIG_DIR").is_some() && tool == "claude" {
        return Ok(json!({"tool":tool,"cwd":dunce::simplified(&canonical).to_string_lossy(),"state":"unknown","capabilities":[],"reason":"Custom CLAUDE_CONFIG_DIR requires a dedicated configuration-location adapter"}));
    }
    let mut result = inspect_local(tool, &canonical, launch_config, &home, &codex_home)?;
    result["configurationSource"] = json!("current-configuration-only");
    Ok(result)
}

pub(crate) fn expert_inspect_session(app: &tauri::AppHandle, session_id: &str, tool: &str, cwd: &str) -> Result<Value, String> {
    let desktop = match tool {
        "claude" => crate::claude_session::launch_context(app, session_id),
        "codex" => crate::codex_session::launch_context(app, session_id),
        "opencode" => crate::opencode_session::launch_context(app, session_id),
        _ => None,
    };
    let source = if desktop.is_some() { "desktop-launch-snapshot" } else { "terminal-launch-snapshot" };
    let (launch_config, launch_cwd) = if let Some((config, path)) = desktop { (config, Some(path)) } else {
        let state = app.try_state::<crate::server::AppState>().ok_or("Terminal state unavailable")?;
        let sessions = state.terminal_session.lock().map_err(|_| "Terminal state unavailable")?;
        let session = sessions.get(session_id).ok_or("Terminal is no longer running")?;
        if session.tool_name.as_deref() != Some(tool) { return Err("Terminal tool changed; read the current screen again".into()); }
        (session.launch_config.clone(), session.launch_cwd.clone())
    };
    let canonical = crate::agent::canonical_directory(cwd)?;
    if launch_cwd.as_deref().and_then(|path| Path::new(path).canonicalize().ok()).as_ref() != Some(&canonical) {
        return Ok(json!({"tool":tool,"cwd":dunce::simplified(&canonical).to_string_lossy(),"state":"unknown","capabilities":[],"reason":"The workspace changed after launch; configuration loading needs runtime verification"}));
    }
    let mut result = expert_inspect(tool, cwd, Some(&launch_config))?;
    result["configurationSource"] = json!(source);
    Ok(result)
}

fn inspect_local(tool: &str, cwd: &Path, launch: Option<&ToolConfigEntry>, home: &Path, codex_home: &Path) -> Result<Value, String> {
    let mut result = json!({"tool":tool,"cwd":dunce::simplified(cwd).to_string_lossy(),"state":"partial","capabilities":[],"warnings":[],"installationAuthorized":false,"limitations":["Configuration does not verify runtime loading, workspace trust, or permission.","Managed policies, bundled skills, plugins, and dynamically added directories are not enumerated."]});
    if !matches!(tool, "claude" | "codex") { result["state"] = json!("unsupported"); return Ok(result); }
    let args = match launch_args(tool, launch) { Ok(value) => value, Err(reason) => { result["state"] = json!("unknown"); result["reason"] = json!(reason); return Ok(result); } };
    if args.iter().any(|value| value == "--safe-mode" || value == "--bare" || value == "--setting-sources" || value.starts_with("--setting-sources=") || value == "--settings" || value.starts_with("--settings=") || value == "--add-dir" || value == "--plugin-dir" || (tool == "codex" && (value == "-c" || value == "--config" || value.starts_with("--config=") || value == "--profile" || value == "-p"))) {
        result["state"] = json!("unknown"); result["reason"] = json!("Launch-time configuration restrictions or overrides require runtime verification"); return Ok(result);
    }
    let mut warnings = Vec::new();
    let mut skills = Vec::new();
    let mut servers = BTreeMap::new();
    let mut skill_rules = Vec::new();
    let roots = ancestors(cwd);
    if tool == "claude" {
        let global_path = home.join(".claude.json");
        let global = json_file(&global_path, &mut warnings).unwrap_or_else(|| json!({}));
        let local = global["projects"].as_object().and_then(|projects| projects.iter().find(|(path, _)| {
            Path::new(path).canonicalize().is_ok_and(|path| path == cwd)
        }).map(|(_, config)| config.clone())).unwrap_or_else(|| json!({}));
        let mut disabled = HashSet::new();
        let mut skill_overrides = BTreeMap::new();
        for key in ["disabledMcpServers", "disabledMcpjsonServers"] {
            if let Some(names) = local[key].as_array() { disabled.extend(names.iter().filter_map(Value::as_str).map(str::to_string)); }
        }
        let mut settings = vec![home.join(".claude/settings.json")];
        settings.extend(roots.iter().map(|path| path.join(".claude/settings.json")));
        settings.push(cwd.join(".claude/settings.local.json"));
        for path in settings {
            if let Some(config) = json_file(&path, &mut warnings) {
                for key in ["disabledMcpServers", "disabledMcpjsonServers"] {
                    if let Some(names) = config[key].as_array() { disabled.extend(names.iter().filter_map(Value::as_str).map(str::to_string)); }
                }
                if let Some(overrides) = config["skillOverrides"].as_object() {
                    for (name, value) in overrides { if let Some(value) = value.as_str() { skill_overrides.insert(name.clone(), value.to_string()); } }
                }
            }
        }
        if !args.iter().any(|value| value == "--strict-mcp-config") {
            add_json_mcp(&global, &global_path, "user", &disabled, &mut servers);
            for path in &roots {
                if let Some(project) = json_file(&path.join(".mcp.json"), &mut warnings) { add_json_mcp(&project, &path.join(".mcp.json"), "project", &disabled, &mut servers); }
            }
            add_json_mcp(&local, &global_path, "local-project", &disabled, &mut servers);
        }
        for (index, arg) in args.iter().enumerate() {
            let config = arg.strip_prefix("--mcp-config=").map(str::to_string).or_else(|| (arg == "--mcp-config").then(|| args.get(index + 1).cloned()).flatten());
            if let Some(config) = config {
                let path = if Path::new(&config).is_absolute() { PathBuf::from(&config) } else { cwd.join(&config) };
                if config.trim_start().starts_with('{') { warnings.push(json!({"reason":"Inline MCP launch configuration is not enumerated"})); result["state"] = json!("unknown"); }
                else if let Some(config) = json_file(&path, &mut warnings) { add_json_mcp(&config, &path, "launch", &disabled, &mut servers); }
            }
        }
        for path in &roots { scan_skills(&path.join(".claude/skills"), "project", &skill_rules, false, &mut skills, &mut warnings); }
        scan_skills(&home.join(".claude/skills"), "user", &skill_rules, false, &mut skills, &mut warnings);
        for skill in &mut skills {
            match skill_overrides.get(skill["name"].as_str().unwrap_or("")).map(String::as_str) {
                Some("off") => { skill["enabled"] = json!(false); skill["automaticInvocation"] = json!(false); },
                Some("user-invocable-only") => skill["automaticInvocation"] = json!(false),
                _ => {},
            }
        }
        let user_names: HashSet<_> = skills.iter().filter(|entry| entry["scope"] == "user").filter_map(|entry| entry["name"].as_str().map(str::to_string)).collect();
        for skill in &mut skills { if skill["scope"] == "project" && user_names.contains(skill["name"].as_str().unwrap_or("")) { skill["configurationState"] = json!("shadowed-by-user"); } }
    } else {
        let mut configs = vec![(codex_home.join("config.toml"), "user")];
        configs.extend(roots.iter().map(|path| (path.join(".codex/config.toml"), "project")));
        for (path, scope) in configs {
            if let Some(config) = toml_file(&path, &mut warnings) {
                // Codex applies skill enablement rules from user/session layers, not project layers.
                if scope == "user" {
                    if let Some(rules) = config.get("skills").and_then(|value| value.get("config")).and_then(toml::Value::as_array) {
                        for entry in rules {
                            let Some(enabled) = entry.get("enabled").and_then(toml::Value::as_bool) else { continue; };
                            let selector = match (entry.get("path").and_then(toml::Value::as_str), entry.get("name").and_then(toml::Value::as_str)) {
                                (Some(skill_path), None) => {
                                    let skill_path = crate::tool_config::expand_path(skill_path);
                                    let skill_path = if skill_path.is_absolute() { skill_path } else { path.parent().unwrap_or(cwd).join(skill_path) };
                                    Some(SkillSelector::Path(skill_path.canonicalize().unwrap_or(skill_path)))
                                },
                                (None, Some(name)) if !name.trim().is_empty() => Some(SkillSelector::Name(name.trim().to_string())),
                                _ => None,
                            };
                            if let Some(selector) = selector { skill_rules.push(SkillRule { selector, enabled }); }
                        }
                    }
                }
                if let Some(mcp) = config.get("mcp_servers").and_then(toml::Value::as_table) {
                    for (name, server) in mcp.iter().take(100) {
                        let previous = servers.get(name);
                        let enabled = server.get("enabled").and_then(toml::Value::as_bool)
                            .unwrap_or_else(|| previous.and_then(|value| value["enabled"].as_bool()).unwrap_or(true));
                        let mut entry = capability(name, "mcp", &path, scope, enabled);
                        entry["transport"] = if server.get("url").is_some() { json!("http") }
                            else if server.get("command").is_some() { json!("stdio") }
                            else { previous.map(|value| value["transport"].clone()).unwrap_or_else(|| json!("unknown")) };
                        let has_transport = ["url", "command"].iter().any(|key| server.get(key).is_some());
                        let valid = if has_transport { ["url", "command"].iter().any(|key| server.get(key).and_then(toml::Value::as_str).is_some_and(|value| !value.trim().is_empty())) }
                            else { previous.is_some_and(|value| value["configurationState"] != "invalid") };
                        if !valid { entry["configurationState"] = json!("invalid"); }
                        if scope == "project" { entry["evidence"] = json!("Project configuration is loaded only for trusted projects; runtime loading has not been verified."); }
                        servers.insert(name.clone(), entry);
                    }
                }
            }
        }
        for path in &roots { scan_skills(&path.join(".agents/skills"), "project", &skill_rules, true, &mut skills, &mut warnings); }
        scan_skills(&home.join(".agents/skills"), "user", &skill_rules, true, &mut skills, &mut warnings);
        // Older Codex versions still use CODEX_HOME/skills; keep the source explicit.
        scan_skills(&codex_home.join("skills"), "legacy-user", &skill_rules, true, &mut skills, &mut warnings);
    }
    let mut capabilities = servers.into_values().chain(skills).collect::<Vec<_>>();
    result["capabilityCount"] = json!(capabilities.len());
    result["truncated"] = json!(capabilities.len() > MAX_SKILLS);
    if capabilities.len() > MAX_SKILLS {
        capabilities.truncate(MAX_SKILLS);
        warnings.push(json!({"reason":"Capability inventory budget reached; not all entries are included"}));
    }
    result["capabilities"] = json!(capabilities);
    result["warnings"] = json!(warnings);
    while serde_json::to_vec(&result).map_err(|_| "Invalid capability inventory")?.len() > 16_000 {
        if result["capabilities"].as_array_mut().is_some_and(|entries| entries.pop().is_some()) {
            result["truncated"] = json!(true);
        } else if result["warnings"].as_array_mut().is_some_and(|warnings| warnings.pop().is_some()) {
            result["truncated"] = json!(true);
        } else { return Err("Capability metadata exceeded its output budget".into()); }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf { std::env::temp_dir().join(format!("coffee-experts-{}", uuid::Uuid::new_v4())) }
    #[test]
    fn mcp_secrets_and_other_tool_configs_never_enter_inventory() {
        let root = root(); let home = root.join("home"); let cwd = root.join("project"); fs::create_dir_all(home.join(".codex")).unwrap(); fs::create_dir_all(&cwd).unwrap();
        fs::write(home.join(".claude.json"), r#"{"mcpServers":{"claude-only":{"type":"http","url":"https://user:password@host/?token=URL_SECRET","headers":{"Authorization":"Bearer HEADER_SECRET"},"env":{"KEY":"ENV_SECRET"}}}}"#).unwrap();
        fs::write(home.join(".codex/config.toml"), "[mcp_servers.codex_only]\ncommand='node'\nenabled=false\n[mcp_servers.codex_only.env]\nAPI_KEY='CODEX_SECRET'\n").unwrap();
        let claude = inspect_local("claude", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        let codex = inspect_local("codex", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        let all = format!("{claude}{codex}"); for secret in ["URL_SECRET", "HEADER_SECRET", "ENV_SECRET", "CODEX_SECRET", "password@"] { assert!(!all.contains(secret)); }
        assert!(claude.to_string().contains("claude-only")); assert!(!claude.to_string().contains("codex_only"));
        assert!(codex.to_string().contains("codex_only")); assert!(!codex.to_string().contains("claude-only")); assert_eq!(codex["capabilities"][0]["enabled"], false);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn local_project_mcp_has_precedence_and_custom_launchers_are_unknown() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home"); fs::create_dir_all(&cwd).unwrap(); fs::create_dir_all(&home).unwrap();
        let canonical = cwd.canonicalize().unwrap();
        fs::write(home.join(".claude.json"), json!({"mcpServers":{"same":{"command":"global-secret-command"}},"projects":{canonical.to_string_lossy().into_owned():{"mcpServers":{"same":{"command":"local-secret-command"}},"disabledMcpServers":["same"]}}}).to_string()).unwrap();
        fs::write(cwd.join(".mcp.json"), r#"{"mcpServers":{"same":{"command":"project-secret-command"}}}"#).unwrap();
        let result = inspect_local("claude", &canonical, None, &home, &home.join(".codex")).unwrap();
        assert_eq!(result["capabilities"].as_array().unwrap().len(), 1); assert_eq!(result["capabilities"][0]["scope"], "local-project"); assert_eq!(result["capabilities"][0]["enabled"], false); assert!(!result.to_string().contains("secret-command"));
        let launch = ToolConfigEntry { command:"docker exec machine codex".into(), ..Default::default() };
        assert_eq!(inspect_local("codex", &canonical, Some(&launch), &home, &home.join(".codex")).unwrap()["state"], "unknown");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn skills_are_metadata_only_and_codex_disable_rules_are_respected() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home"); let skill = cwd.join(".agents/skills/test/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap(); fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(&skill, "---\nname: test\ndescription: Useful tests\n---\nBODY_SECRET\n").unwrap();
        fs::write(home.join(".codex/config.toml"), format!("[[skills.config]]\npath={}\nenabled=false\n", serde_json::to_string(&skill.canonicalize().unwrap().to_string_lossy()).unwrap())).unwrap();
        let result = inspect_local("codex", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        assert_eq!(result["capabilities"][0]["enabled"], false); assert_eq!(result["capabilities"][0]["description"], "Useful tests"); assert!(!result.to_string().contains("BODY_SECRET"));
        assert_eq!(inspect_local("opencode", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap()["state"], "unsupported");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn launch_mcp_is_strict_and_large_inventories_stay_bounded() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home"); fs::create_dir_all(&cwd).unwrap(); fs::create_dir_all(&home).unwrap();
        fs::write(home.join(".claude.json"), r#"{"mcpServers":{"default_server":{"command":"node"}}}"#).unwrap();
        fs::write(cwd.join("launch.json"), r#"{"mcpServers":{"launch_server":{"command":"node","env":{"SECRET":"LAUNCH_SECRET"}}}}"#).unwrap();
        for index in 0..65 {
            let skill = cwd.join(format!(".claude/skills/skill-{index:02}/SKILL.md")); fs::create_dir_all(skill.parent().unwrap()).unwrap();
            fs::write(skill, format!("---\nname: skill-{index}\ndescription: {}\n---\n", "Long metadata ".repeat(50))).unwrap();
        }
        let launch = ToolConfigEntry { extra_args:vec!["--strict-mcp-config".into(), "--mcp-config".into(), "launch.json".into()], ..Default::default() };
        let result = inspect_local("claude", &cwd.canonicalize().unwrap(), Some(&launch), &home, &home.join(".codex")).unwrap();
        assert!(result.to_string().contains("launch_server")); assert!(!result.to_string().contains("default_server")); assert!(!result.to_string().contains("LAUNCH_SECRET"));
        assert!(serde_json::to_vec(&result).unwrap().len() <= 16_000); assert_eq!(result["truncated"], true);
        assert!(result["capabilities"].as_array().unwrap().iter().all(|entry| entry["availability"] == "unknown"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn codex_project_enable_override_preserves_the_user_transport() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home"); fs::create_dir_all(cwd.join(".codex")).unwrap(); fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(home.join(".codex/config.toml"), "[mcp_servers.same]\ncommand='node'\nenabled=true\n").unwrap();
        fs::write(cwd.join(".codex/config.toml"), "[mcp_servers.same]\nenabled=false\n").unwrap();
        let result = inspect_local("codex", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        assert_eq!(result["capabilities"][0]["enabled"], false); assert_eq!(result["capabilities"][0]["transport"], "stdio"); assert_eq!(result["capabilities"][0]["configurationState"], "detected");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn codex_skill_paths_are_relative_to_the_config_and_later_rules_can_reenable() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home");
        let skill = cwd.join(".agents/skills/test/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap(); fs::create_dir_all(cwd.join(".codex")).unwrap(); fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(&skill, "---\nname: test\ndescription: Project test skill\n---\n").unwrap();
        let config = home.join(".codex/config.toml");
        let relative_rule = "[[skills.config]]\npath='../../project/.agents/skills/test/SKILL.md'\nenabled=false\n";
        fs::write(&config, relative_rule).unwrap();
        let inspect = || inspect_local("codex", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        assert_eq!(inspect()["capabilities"][0]["enabled"], false);
        fs::write(&config, format!("{relative_rule}[[skills.config]]\npath={}\nenabled=true\n", serde_json::to_string(&skill.canonicalize().unwrap().to_string_lossy()).unwrap())).unwrap();
        assert_eq!(inspect()["capabilities"][0]["enabled"], true);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn codex_name_and_path_skill_rules_follow_order_and_ignore_project_rules() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home");
        let skill = cwd.join(".agents/skills/folder-name/SKILL.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap(); fs::create_dir_all(cwd.join(".codex")).unwrap(); fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(&skill, "---\nname: test\ndescription: Ordered selectors\n---\n").unwrap();
        let config = home.join(".codex/config.toml");
        let path = serde_json::to_string(&skill.canonicalize().unwrap().to_string_lossy()).unwrap();
        let name_off = "[[skills.config]]\nname=' test '\nenabled=false\n";
        let path_on = format!("[[skills.config]]\npath={path}\nenabled=true\n");
        let inspect = || inspect_local("codex", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        fs::write(&config, name_off).unwrap(); assert_eq!(inspect()["capabilities"][0]["enabled"], false);
        fs::write(&config, format!("{name_off}{path_on}")).unwrap(); assert_eq!(inspect()["capabilities"][0]["enabled"], true);
        fs::write(&config, format!("{path_on}{name_off}")).unwrap(); assert_eq!(inspect()["capabilities"][0]["enabled"], false);
        fs::write(cwd.join(".codex/config.toml"), "[[skills.config]]\nname='test'\nenabled=true\n").unwrap();
        assert_eq!(inspect()["capabilities"][0]["enabled"], false, "Project config cannot override user skill enablement");
        fs::write(&config, format!("{name_off}[[skills.config]]\npath={path}\nname='test'\nenabled=true\n")).unwrap();
        assert_eq!(inspect()["capabilities"][0]["enabled"], false, "Rules with both selectors are ignored by Codex");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn skill_descriptions_and_invocation_preferences_are_read_without_bodies_or_secrets() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home");
        for (tool_dir, suffix) in [(".claude", "|"), (".agents", ">-")] {
            let folder = cwd.join(tool_dir).join("skills/test"); fs::create_dir_all(folder.join("agents")).unwrap();
            fs::write(folder.join("SKILL.md"), format!("---\nname: test\ndescription: {suffix}\n  Inspect the project.\n  Run useful checks.\n---\nBODY_SECRET\n")).unwrap();
            fs::write(folder.join("agents/openai.yaml"), "policy:\n  allow_implicit_invocation: false\ndependencies:\n  secret: POLICY_SECRET\n").unwrap();
        }
        fs::create_dir_all(cwd.join(".claude")).unwrap();
        let settings = cwd.join(".claude/settings.local.json");
        fs::write(&settings, r#"{"skillOverrides":{"test":"off"}}"#).unwrap();
        let inspect = |tool| inspect_local(tool, &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        let claude = inspect("claude"); let codex = inspect("codex");
        assert_eq!(claude["capabilities"][0]["description"], "Inspect the project.\nRun useful checks.");
        assert_eq!(codex["capabilities"][0]["description"], "Inspect the project. Run useful checks.");
        assert_eq!(claude["capabilities"][0]["enabled"], false); assert_eq!(claude["capabilities"][0]["automaticInvocation"], false);
        assert_eq!(codex["capabilities"][0]["enabled"], true); assert_eq!(codex["capabilities"][0]["automaticInvocation"], false);
        fs::write(&settings, r#"{"skillOverrides":{"test":"user-invocable-only"}}"#).unwrap();
        let claude = inspect("claude"); assert_eq!(claude["capabilities"][0]["enabled"], true); assert_eq!(claude["capabilities"][0]["automaticInvocation"], false);
        fs::write(&settings, "{}").unwrap();
        assert_eq!(inspect("claude")["capabilities"][0]["automaticInvocation"], true, "Codex YAML policy must not disable Claude invocation");
        for result in [claude, codex] { assert!(!result.to_string().contains("BODY_SECRET")); assert!(!result.to_string().contains("POLICY_SECRET")); }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn claude_invocation_restrictions_allow_yaml_comments() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home");
        let folder = cwd.join(".claude/skills/test"); fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), "---\nname: test\ndescription: Explicit invocation only.\ndisable-model-invocation: true # Only invoke on request\n---\nDo the work.\n").unwrap();
        let result = inspect_local("claude", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        assert_eq!(result["capabilities"][0]["enabled"], true);
        assert_eq!(result["capabilities"][0]["automaticInvocation"], false);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn codex_policy_sections_allow_yaml_comments() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home");
        let folder = cwd.join(".agents/skills/test"); fs::create_dir_all(folder.join("agents")).unwrap();
        fs::write(folder.join("SKILL.md"), "---\nname: test\ndescription: Explicit invocation only.\n---\nDo the work.\n").unwrap();
        fs::write(folder.join("agents/openai.yaml"), "policy: # Invocation rules\n  allow_implicit_invocation: false # Only invoke on request\n").unwrap();
        let result = inspect_local("codex", &cwd.canonicalize().unwrap(), None, &home, &home.join(".codex")).unwrap();
        assert_eq!(result["capabilities"][0]["enabled"], true);
        assert_eq!(result["capabilities"][0]["automaticInvocation"], false);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn running_terminal_launch_snapshot_is_not_replaced_by_later_overrides() {
        let root = root(); let cwd = root.join("project"); let home = root.join("home"); fs::create_dir_all(&cwd).unwrap();
        fs::write(cwd.join("a.json"), r#"{"mcpServers":{"original_a":{"command":"node"}}}"#).unwrap();
        fs::write(cwd.join("b.json"), r#"{"mcpServers":{"later_b":{"command":"node"}}}"#).unwrap();
        let mut current = ToolConfigEntry { extra_args:vec!["--strict-mcp-config".into(), "--mcp-config".into(), "a.json".into()], ..Default::default() };
        let launch_snapshot = current.clone();
        current.extra_args[2] = "b.json".into();
        let running = inspect_local("claude", &cwd.canonicalize().unwrap(), Some(&launch_snapshot), &home, &home.join(".codex")).unwrap();
        let later = inspect_local("claude", &cwd.canonicalize().unwrap(), Some(&current), &home, &home.join(".codex")).unwrap();
        assert!(running.to_string().contains("original_a")); assert!(!running.to_string().contains("later_b"));
        assert!(later.to_string().contains("later_b"));
        fs::remove_dir_all(root).unwrap();
    }
}
