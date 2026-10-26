use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::{Component, Path, PathBuf}, sync::Mutex, time::{Duration, SystemTime, UNIX_EPOCH}};

const MAX_FILE: u64 = 2_000_000;
const MAX_TOTAL: usize = 20_000_000;
const MAX_FILES: usize = 400;
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static DESCRIPTION_READS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn storage() -> Result<PathBuf, String> { Ok(dirs::home_dir().ok_or("skills_read")?.join(".coffee-cli/skills")) }
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn valid_name(s: &str) -> bool { !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)) }
fn normal_path(s: &str) -> bool {
    !s.is_empty() && !s.contains(['\\', ':', '\0', '*', '?', '<', '>', '"', '|']) && !s.starts_with('/')
        && s.split('/').all(|part| !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' '])
            && !matches!(part.split('.').next().unwrap_or("").to_ascii_uppercase().as_str(), "CON"|"PRN"|"AUX"|"NUL"|"COM1"|"COM2"|"COM3"|"COM4"|"COM5"|"COM6"|"COM7"|"COM8"|"COM9"|"LPT1"|"LPT2"|"LPT3"|"LPT4"|"LPT5"|"LPT6"|"LPT7"|"LPT8"|"LPT9"))
        && Path::new(s).components().all(|part| matches!(part, Component::Normal(_)))
}

fn roots_in(tool: &str, home: &Path, env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Vec<PathBuf> {
    let root = |key: &str, fallback: PathBuf| env(key).filter(|s| !s.is_empty()).map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or(fallback);
    let config = root("XDG_CONFIG_HOME", home.join(".config"));
    let primary = match tool {
        "claude" => root("CLAUDE_CONFIG_DIR", home.join(".claude")).join("skills"),
        "codex" => root("CODEX_HOME", home.join(".codex")).join("skills"),
        "cursor" => home.join(".cursor/skills"),
        "copilot" => home.join(".copilot/skills"),
        "opencode" => config.join("opencode/skills"),
        "antigravity" => home.join(".gemini/antigravity/skills"),
        "qwen" => home.join(".qwen/skills"),
        "pi" => root("PI_CODING_AGENT_DIR", home.join(".pi/agent")).join("skills"),
        "hermes" => crate::tools::hermes::hermes_home().join("skills"),
        "kilo" => home.join(".kilo/skills"),
        "goose" => config.join("goose/skills"),
        "grok" => root("GROK_HOME", home.join(".grok")).join("skills"),
        "minimax" => root("MINIMAX_DATA_DIR", home.join(".minimax")).join("skills"),
        "codebuddy" => home.join(".codebuddy/skills"),
        "crush" => config.join("crush/skills"),
        "openclaw" => {
            let config = fs::read_to_string(home.join(".openclaw/openclaw.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
            let workspace = config.as_ref().and_then(|v| v["agents"]["defaults"]["workspace"].as_str());
            let workspace = workspace.map(|s| if let Some(s) = s.strip_prefix("~/") { home.join(s) } else { PathBuf::from(s) }).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".openclaw/workspace"));
            workspace.join("skills")
        }
        _ => return vec![],
    };
    let mut roots = vec![primary];
    if tool == "codex" { roots.push(home.join(".agents/skills")); }
    roots
}
fn roots(tool: &str) -> Result<Vec<PathBuf>, String> { Ok(roots_in(tool, &dirs::home_dir().ok_or("skills_read")?, |key| std::env::var_os(key))) }
fn linked(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| {
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; m.file_type().is_symlink() || m.file_attributes() & 0x400 != 0 }
        #[cfg(not(windows))] { m.file_type().is_symlink() }
    })
}
fn resolved(path: &Path) -> PathBuf { dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()) }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    name: String, description: String, source: Option<String>, path: String,
    managed: bool, update: bool, modified: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct CatalogSkill { source: String, name: String, description: String }
#[derive(Serialize)]
pub struct Inventory { supported: bool, skills: Vec<SkillItem> }
#[derive(Clone, Serialize, Deserialize)]
struct Installed {
    tool: String, path: String, source: String, name: String, remote_path: String,
    remote_hash: String, hash: String, update: bool, modified: bool,
}
#[derive(Default, Serialize, Deserialize)]
struct State { installed: Vec<Installed>, checked: BTreeMap<String, u64> }
fn read_state(root: &Path) -> Result<State, String> {
    match fs::read(root.join("state.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "skills_read".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(_) => Err("skills_read".into()),
    }
}
fn write_json(path: &Path, data: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("skills_write")?).map_err(|_| "skills_write")?;
    let temp = path.with_file_name(format!(".skills-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(&temp, serde_json::to_vec(data).map_err(|_| "skills_write")?).map_err(|_| "skills_write")?;
        crate::agent::replace_file(&temp, path).map_err(|_| "skills_write".to_string())
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}
fn metadata(path: &Path) -> Option<(String, String)> {
    let file = fs::File::open(path.join("SKILL.md")).ok()?;
    let mut text = String::new(); file.take(MAX_FILE + 1).read_to_string(&mut text).ok()?;
    if text.len() as u64 > MAX_FILE { return None; }
    crate::agent_capabilities::skill_metadata(&text).ok()
}
fn inventory(tool: &str, root: &Path, directories: &[PathBuf]) -> Result<Inventory, String> {
    let state = read_state(root)?;
    let mut found = BTreeMap::new();
    for directory in directories {
        if !directory.exists() { continue; }
        for entry in fs::read_dir(directory).map_err(|_| "skills_read")?.take(1000) {
            let entry = entry.map_err(|_| "skills_read")?;
            if entry.file_name().to_string_lossy().starts_with('.') { continue; }
            let path = entry.path();
            if let Some((name, description)) = metadata(&path) {
                let path = resolved(&path).to_string_lossy().into_owned();
                let own = state.installed.iter().find(|s| s.tool == tool && s.path == path);
                found.entry(path.clone()).or_insert(SkillItem { name, description, path, source: own.map(|s| s.source.clone()), managed: own.is_some(), update: own.is_some_and(|s| s.update), modified: own.is_some_and(|s| s.modified) });
            }
        }
    }
    let mut skills = found.into_values().collect::<Vec<_>>(); skills.sort_by_key(|s| s.name.to_lowercase());
    Ok(Inventory { supported: !directories.is_empty(), skills })
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(25)).user_agent("Coffee-CLI").redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "skills_network".into())
}
async fn get(url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client()?.get(url).send().await.map_err(|_| "skills_network")?;
    if !response.status().is_success() { return Err("skills_network".into()); }
    let mut out = Vec::new();
    while let Some(bytes) = response.chunk().await.map_err(|_| "skills_network")? {
        if out.len() + bytes.len() > limit { return Err("skills_size".into()); } out.extend(bytes);
    }
    Ok(out)
}
async fn json_get(url: &str) -> Result<Value, String> { serde_json::from_slice(&get(url, 8_000_000).await?).map_err(|_| "skills_network".into()) }
fn raw_url(source: &str, commit: &str, path: &str) -> Result<String, String> {
    if source.split('/').count() != 2 || !source.split('/').all(valid_name) || !valid_name(commit) || !normal_path(path) { return Err("skills_source".into()); }
    let mut url = reqwest::Url::parse("https://raw.githubusercontent.com/").unwrap();
    { let mut parts = url.path_segments_mut().unwrap(); parts.pop_if_empty(); for part in source.split('/').chain(std::iter::once(commit)).chain(path.split('/')) { parts.push(part); } }
    Ok(url.into())
}
async fn tree(source: &str, commit: &str) -> Result<Value, String> {
    if source.split('/').count() != 2 || !source.split('/').all(valid_name) || !valid_name(commit) { return Err("skills_source".into()); }
    let tree = json_get(&format!("https://api.github.com/repos/{source}/git/trees/{commit}?recursive=1")).await?;
    if tree["truncated"] == true || !tree["tree"].is_array() { return Err("skills_size".into()); } Ok(tree)
}
fn folder_hash(tree: &Value, path: &str) -> Result<String, String> {
    if path.is_empty() { return tree["sha"].as_str().map(str::to_string).ok_or("skills_source".into()); }
    tree["tree"].as_array().and_then(|entries| entries.iter().find(|e| e["path"] == path && e["type"] == "tree")).and_then(|e| e["sha"].as_str()).map(str::to_string).ok_or("skills_source".into())
}
fn license_path<'a>(tree: &'a Value, directory: &str) -> Option<&'a str> {
    let prefix = if directory.is_empty() { String::new() } else { format!("{directory}/") };
    tree["tree"].as_array()?.iter().filter(|e| e["type"] == "blob" && e["mode"] != "120000").filter_map(|e| e["path"].as_str()).find(|path| {
        let name = path.strip_prefix(&prefix).unwrap_or("");
        matches!(name.to_ascii_uppercase().as_str(), "LICENSE"|"LICENSE.MD"|"LICENSE.TXT"|"COPYING")
    })
}
fn open_license(bytes: &[u8]) -> bool {
    let start = String::from_utf8_lossy(bytes).lines().take(25).collect::<Vec<_>>().join(" ").to_lowercase();
    start.contains("permission is hereby granted, free of charge") || start.contains("apache license") && start.contains("version 2.0")
}
async fn featured(source: &str) -> Result<Vec<CatalogSkill>, String> {
    let head = json_get(&format!("https://api.github.com/repos/{source}/commits/HEAD")).await?;
    let commit = head["sha"].as_str().ok_or("skills_source")?;
    let tree = tree(source, commit).await?;
    let root_license = match license_path(&tree, "") {
        Some(path) => open_license(&get(&raw_url(source, commit, path)?, MAX_FILE as usize).await?),
        None => false,
    };
    let mut jobs = tokio::task::JoinSet::new();
    let permits = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    for entry in tree["tree"].as_array().unwrap().iter().filter(|e| e["type"] == "blob" && e["mode"] != "120000" && e["path"].as_str().is_some_and(|p| p.ends_with("/SKILL.md") || p == "SKILL.md")).take(30) {
        let path = entry["path"].as_str().unwrap();
        let directory = path.strip_suffix("SKILL.md").unwrap().trim_end_matches('/');
        let own_license = license_path(&tree, directory).map(|p| raw_url(source, commit, p)).transpose()?;
        let url = raw_url(source, commit, path)?; let source = source.to_string(); let permits = permits.clone();
        jobs.spawn(async move {
            let _permit = permits.acquire().await.map_err(|_| "skills_network")?;
            let permitted = match own_license { Some(url) => open_license(&get(&url, MAX_FILE as usize).await?), None => root_license };
            if !permitted { return Ok::<_, String>(None); }
            let body = String::from_utf8(get(&url, MAX_FILE as usize).await?).map_err(|_| "skills_source")?;
            Ok(crate::agent_capabilities::skill_metadata(&body).ok().map(|(name, description)| CatalogSkill { source, name, description }))
        });
    }
    let mut items = Vec::new();
    while let Some(result) = jobs.join_next().await { if let Ok(Ok(Some(item))) = result { items.push(item); } }
    items.sort_by(|a,b| a.name.cmp(&b.name));
    if items.is_empty() { return Err("skills_network".into()); } Ok(items)
}
#[derive(Serialize, Deserialize)]
struct CatalogCache { at: u64, items: Vec<CatalogSkill> }
#[derive(Serialize, Deserialize)]
struct DescriptionCache { at: u64, description: String }
fn description_from_html(html: &str) -> Result<String, String> {
    for script in html.split("<script").skip(1) {
        let Some((attributes, body)) = script.split_once('>') else { continue; };
        if !attributes.contains("type=\"application/ld+json\"") { continue; }
        let Some((body, _)) = body.split_once("</script>") else { continue; };
        let Ok(value) = serde_json::from_str::<Value>(body) else { continue; };
        if value["@type"] != "SoftwareApplication" { continue; }
        if let Some(description) = value["description"].as_str().filter(|s| !s.trim().is_empty()) { return Ok(description.chars().take(1000).collect()); }
    }
    Err("skills_source".into())
}
async fn description(source: &str, name: &str, root: &Path) -> Result<String, String> {
    let source = crate::agent_capabilities::repository(source).map_err(|_| "skills_source")?;
    if !valid_name(name) { return Err("skills_source".into()); }
    let path = root.join("descriptions").join(format!("{}.json", hash(format!("{source}/{name}").as_bytes())));
    let cached = fs::read(&path).ok().and_then(|b| serde_json::from_slice::<DescriptionCache>(&b).ok());
    if cached.as_ref().is_some_and(|c| now().saturating_sub(c.at) < 7 * 24 * 3600) { return Ok(cached.unwrap().description); }
    let result = async {
        let _permit = DESCRIPTION_READS.acquire().await.map_err(|_| "skills_network")?;
        let html = get(&format!("https://www.skills.sh/{source}/{name}"), 8_000_000).await?;
        description_from_html(&String::from_utf8(html).map_err(|_| "skills_source")?)
    }.await;
    match result {
        Ok(description) => { let _ = write_json(&path, &DescriptionCache { at:now(), description:description.clone() }); Ok(description) }
        Err(error) => cached.map(|c| c.description).ok_or(error),
    }
}
fn popular_items(html: &str) -> Result<Vec<CatalogSkill>, String> {
    let mut items = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for link in html.split("href=\"/").skip(1).filter_map(|s| s.split_once('"').map(|(path, _)| path)) {
        let parts = link.split('/').collect::<Vec<_>>();
        if parts.len() != 3 || !parts.iter().all(|s| valid_name(s)) { continue; }
        let source = format!("{}/{}", parts[0], parts[1]);
        let name = parts[2].to_string();
        if seen.insert((source.clone(), name.clone())) { items.push(CatalogSkill { source, name, description:String::new() }); }
        if items.len() == 60 { break; }
    }
    if items.is_empty() { return Err("skills_source".into()); } Ok(items)
}
async fn popular_catalog() -> Result<Vec<CatalogSkill>, String> {
    let html = get("https://www.skills.sh/", 8_000_000).await?;
    popular_items(&String::from_utf8(html).map_err(|_| "skills_source")?)
}
async fn search_catalog(query: &str) -> Result<Vec<CatalogSkill>, String> {
    let result = crate::agent_capabilities::discover("skill", query).await.map_err(|_| "skills_network")?;
    Ok(result["results"].as_array().ok_or("skills_network")?.iter().filter_map(|v| Some(CatalogSkill { source:v["source"].as_str()?.into(), name:v["name"].as_str()?.into(), description:String::new() })).collect())
}
async fn catalog(query: &str, root: &Path) -> Result<Vec<CatalogSkill>, String> {
    let query = query.trim(); if query.len() > 200 { return Err("skills_source".into()); }
    let key = if query.is_empty() { "popular-v1" } else { query };
    let path = root.join("catalog").join(format!("{}.json", hash(key.as_bytes())));
    let cached = fs::read(&path).ok().and_then(|b| serde_json::from_slice::<CatalogCache>(&b).ok());
    if cached.as_ref().is_some_and(|c| now().saturating_sub(c.at) < 6 * 3600) { return Ok(cached.unwrap().items); }
    let result = async {
        if !query.is_empty() {
            if let Ok(source) = crate::agent_capabilities::repository(query) { return featured(&source).await; }
            return search_catalog(query).await;
        }
        if let Ok(items) = popular_catalog().await { return Ok(items); }
        let (first, second) = tokio::join!(featured("anthropics/skills"), featured("vercel-labs/skills"));
        match (first, second) {
            (Ok(mut a), Ok(b)) => { a.extend(b); Ok(a) },
            (Ok(a), Err(_)) | (Err(_), Ok(a)) => Ok(a),
            (Err(_), Err(_)) => search_catalog("skills").await,
        }
    }.await;
    match result {
        Ok(items) => { let _ = write_json(&path, &CatalogCache { at:now(), items:items.clone() }); Ok(items) }
        Err(error) => cached.map(|c| c.items).ok_or(error),
    }
}

struct FileData { path: String, bytes: Vec<u8>, #[cfg_attr(not(unix), allow(dead_code))] executable: bool }
fn digest(files: &[FileData]) -> String {
    let mut sha = Sha256::new();
    for file in files { sha.update(file.path.as_bytes()); sha.update([0]); sha.update((file.bytes.len() as u64).to_le_bytes()); sha.update(&file.bytes); }
    format!("{:x}", sha.finalize())
}
fn read_files(path: &Path) -> Result<Vec<FileData>, String> {
    fn walk(base: &Path, path: &Path, files: &mut Vec<FileData>, total: &mut usize) -> Result<(), String> {
        if linked(path) { return Err("skills_modified".into()); }
        for entry in fs::read_dir(path).map_err(|_| "skills_read")? {
            let entry = entry.map_err(|_| "skills_read")?; let p = entry.path();
            if linked(&p) { return Err("skills_modified".into()); }
            let meta = entry.metadata().map_err(|_| "skills_read")?;
            if meta.is_dir() { if p.strip_prefix(base).map_err(|_| "skills_read")?.components().count() > 12 { return Err("skills_size".into()); } walk(base, &p, files, total)?; }
            else if meta.is_file() {
                if meta.len() > MAX_FILE || files.len() >= MAX_FILES { return Err("skills_size".into()); }
                let mut bytes = Vec::new(); fs::File::open(&p).map_err(|_| "skills_read")?.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|_| "skills_read")?;
                *total += bytes.len(); if bytes.len() as u64 > MAX_FILE || *total > MAX_TOTAL { return Err("skills_size".into()); }
                #[cfg(unix)] let executable = { use std::os::unix::fs::PermissionsExt; meta.permissions().mode() & 0o111 != 0 };
                #[cfg(not(unix))] let executable = false;
                files.push(FileData { path:p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), bytes, executable });
            }
        }
        Ok(())
    }
    let mut files = Vec::new(); walk(path, path, &mut files, &mut 0)?; files.sort_by(|a,b| a.path.cmp(&b.path)); Ok(files)
}
fn write_files(path: &Path, files: &[FileData]) -> Result<(), String> {
    let mut seen = std::collections::BTreeSet::new();
    for file in files {
        if !normal_path(&file.path) { return Err("skills_source".into()); }
        #[cfg(windows)] let key = file.path.to_lowercase();
        #[cfg(not(windows))] let key = file.path.clone();
        if !seen.insert(key) { return Err("skills_source".into()); }
        let target = path.join(&file.path); fs::create_dir_all(target.parent().unwrap()).map_err(|_| "skills_write")?;
        fs::write(&target, &file.bytes).map_err(|_| "skills_write")?;
        #[cfg(unix)] if file.executable { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).map_err(|_| "skills_write")?; }
    }
    Ok(())
}
async fn download(source: &str, name: &str) -> Result<(Installed, Vec<FileData>), String> {
    let details = crate::agent_capabilities::details("skill", source, name).await.map_err(|_| "skills_source")?;
    let source = details["source"].as_str().ok_or("skills_source")?;
    let commit = details["commit"].as_str().ok_or("skills_source")?;
    let skill_path = details["skillPath"].as_str().ok_or("skills_source")?;
    let directory = skill_path.strip_suffix("SKILL.md").ok_or("skills_source")?.trim_end_matches('/');
    let listing = tree(source, commit).await?;
    let prefix = if directory.is_empty() { String::new() } else { format!("{directory}/") };
    let mut files = Vec::new(); let mut total = 0;
    for entry in listing["tree"].as_array().unwrap() {
        let Some(path) = entry["path"].as_str().and_then(|p| p.strip_prefix(&prefix)) else { continue };
        if entry["type"] == "tree" { continue; }
        if entry["type"] != "blob" || entry["mode"] == "120000" || !normal_path(path) { return Err("skills_source".into()); }
        if files.len() >= MAX_FILES || entry["size"].as_u64().unwrap_or(MAX_FILE + 1) > MAX_FILE { return Err("skills_size".into()); }
        let bytes = get(&raw_url(source, commit, entry["path"].as_str().unwrap())?, MAX_FILE as usize).await?;
        total += bytes.len(); if total > MAX_TOTAL { return Err("skills_size".into()); }
        files.push(FileData { path:path.into(), bytes, executable:entry["mode"] == "100755" });
    }
    if !files.iter().any(|f| f.path == "SKILL.md") { return Err("skills_source".into()); }
    if !directory.is_empty() && !files.iter().any(|f| f.path.to_ascii_uppercase().starts_with("LICENSE")) {
        if let Some(path) = license_path(&listing, "") {
            let bytes = get(&raw_url(source, commit, path)?, MAX_FILE as usize).await?;
            if total + bytes.len() > MAX_TOTAL || files.len() >= MAX_FILES { return Err("skills_size".into()); }
            files.push(FileData { path:path.into(), bytes, executable:false });
        }
    }
    files.sort_by(|a,b| a.path.cmp(&b.path));
    Ok((Installed { tool:String::new(), path:String::new(), source:source.into(), name:name.into(), remote_path:directory.into(), remote_hash:folder_hash(&listing, directory)?, hash:digest(&files), update:false, modified:false }, files))
}
fn apply(tool: &str, root: &Path, directories: &[PathBuf], mut next: Installed, files: &[FileData]) -> Result<Inventory, String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "skills_write")?;
    let directory = directories.first().ok_or("skills_unsupported")?;
    if !valid_name(&next.name) || !normal_path(&next.name) || next.name.starts_with('.') { return Err("skills_source".into()); }
    let mut state = read_state(root)?;
    fs::create_dir_all(directory).map_err(|_| "skills_write")?;
    let target = resolved(directory).join(&next.name);
    let path = target.to_string_lossy().into_owned();
    let previous = state.installed.iter().find(|s| s.path == path && s.tool == tool).cloned();
    if fs::symlink_metadata(&target).is_ok() {
        let previous = previous.as_ref().ok_or("skills_exists")?;
        if previous.source != next.source { return Err("skills_exists".into()); }
        if digest(&read_files(&target)?) != previous.hash { return Err("skills_modified".into()); }
        write_files(&root.join("backups").join(uuid::Uuid::new_v4().to_string()).join(&next.name), &read_files(&target)?)?;
    }
    let stage = target.with_file_name(format!(".coffee-skills-{}", uuid::Uuid::new_v4()));
    let old = target.with_file_name(format!(".coffee-skills-old-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        write_files(&stage, files)?;
        if target.exists() && previous.as_ref().is_none_or(|s| read_files(&target).map(|files| digest(&files) != s.hash).unwrap_or(true)) { return Err("skills_modified".to_string()); }
        if target.exists() { fs::rename(&target, &old).map_err(|_| "skills_write")?; }
        if fs::rename(&stage, &target).is_err() { if old.exists() { let _ = fs::rename(&old, &target); } return Err("skills_write".to_string()); }
        next.tool = tool.into(); next.path = path.clone();
        state.installed.retain(|s| !(s.tool == tool && s.path == path)); state.installed.push(next);
        if let Err(error) = write_json(&root.join("state.json"), &state) {
            let _ = fs::remove_dir_all(&target); if old.exists() { let _ = fs::rename(&old, &target); } return Err(error);
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&stage); if result.is_ok() { let _ = fs::remove_dir_all(&old); } result?;
    inventory(tool, root, directories)
}

#[tauri::command]
pub async fn get_tool_skills(tool: String) -> Result<Inventory, String> {
    tauri::async_runtime::spawn_blocking(move || inventory(&tool, &storage()?, &roots(&tool)?)).await.map_err(|_| "skills_read")?
}
#[tauri::command]
pub async fn search_tool_skills(query: String) -> Result<Vec<CatalogSkill>, String> { catalog(&query, &storage()?).await }
#[tauri::command]
pub async fn get_tool_skill_description(source: String, name: String) -> Result<String, String> { description(&source, &name, &storage()?).await }
#[tauri::command]
pub async fn install_tool_skill(tool: String, source: String, name: String) -> Result<Inventory, String> {
    let directories = roots(&tool)?; if directories.is_empty() { return Err("skills_unsupported".into()); }
    let (next, files) = download(&source, &name).await?;
    tauri::async_runtime::spawn_blocking(move || apply(&tool, &storage()?, &directories, next, &files)).await.map_err(|_| "skills_write")?
}
#[tauri::command]
pub async fn remove_tool_skill(tool: String, path: String) -> Result<Inventory, String> {
    tauri::async_runtime::spawn_blocking(move || remove(&tool, &storage()?, &roots(&tool)?, &path)).await.map_err(|_| "skills_write")?
}
fn remove(tool: &str, root: &Path, directories: &[PathBuf], path: &str) -> Result<Inventory, String> {
        let _guard = WRITE_LOCK.lock().map_err(|_| "skills_write")?;
        let mut state = read_state(root)?;
        let target = PathBuf::from(path);
        if linked(&target) { return Err("skills_modified".into()); }
        let target = resolved(&target);
        let path = target.to_string_lossy().into_owned();
        let own = state.installed.iter().find(|s| s.tool == tool && s.path == path).ok_or("skills_exists")?;
        if !valid_name(&own.name) || !normal_path(&own.name) || !directories.iter().any(|p| resolved(p).join(&own.name) == target) || digest(&read_files(&target)?) != own.hash { return Err("skills_modified".into()); }
        let backup = root.join("backups").join(uuid::Uuid::new_v4().to_string()).join(&own.name);
        write_files(&backup, &read_files(&target)?)?;
        let old = target.with_file_name(format!(".coffee-skills-old-{}", uuid::Uuid::new_v4()));
        if digest(&read_files(&target)?) != own.hash { return Err("skills_modified".into()); }
        fs::rename(&target, &old).map_err(|_| "skills_write")?;
        state.installed.retain(|s| !(s.tool == tool && s.path == path));
        if let Err(error) = write_json(&root.join("state.json"), &state) { let _ = fs::rename(&old, &target); return Err(error); }
        let _ = fs::remove_dir_all(&old);
        inventory(tool, root, directories)
}
#[tauri::command]
pub async fn check_tool_skill_updates(tool: String) -> Result<Inventory, String> {
    let root = storage()?; let state = read_state(&root)?;
    if !state.installed.iter().any(|s| s.tool == tool) { return inventory(&tool, &root, &roots(&tool)?); }
    if now().saturating_sub(*state.checked.get(&tool).unwrap_or(&0)) < 12 * 3600 { return inventory(&tool, &root, &roots(&tool)?); }
    let mut trees = BTreeMap::new(); let mut results = Vec::new();
    for entry in state.installed.iter().filter(|s| s.tool == tool) {
        if !trees.contains_key(&entry.source) { trees.insert(entry.source.clone(), tree(&entry.source, "HEAD").await?); }
        let update = folder_hash(&trees[&entry.source], &entry.remote_path)? != entry.remote_hash;
        let modified = read_files(Path::new(&entry.path)).map(|files| digest(&files) != entry.hash).unwrap_or(true);
        results.push((entry.clone(), update, modified));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITE_LOCK.lock().map_err(|_| "skills_write")?; let mut state = read_state(&root)?;
        for (previous, update, modified) in results {
            if let Some(entry) = state.installed.iter_mut().find(|s| s.tool == tool && s.path == previous.path && s.hash == previous.hash && s.remote_hash == previous.remote_hash) { entry.update = update; entry.modified = modified; }
        }
        state.checked.insert(tool.clone(), now()); write_json(&root.join("state.json"), &state)?;
        inventory(&tool, &root, &roots(&tool)?)
    }).await.map_err(|_| "skills_read")?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { root: PathBuf, directories: Vec<PathBuf>, base: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let base = dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("coffee-skills-test-{}", uuid::Uuid::new_v4()));
            Self { root:base.join("app"), directories:vec![base.join("native/skills")], base }
        }
        fn files(text: &str) -> Vec<FileData> { vec![FileData { path:"SKILL.md".into(), bytes:format!("---\nname: demo\ndescription: Example skill\n---\n{text}\n").into_bytes(), executable:false }] }
        fn install(&self, text: &str) -> Result<Inventory, String> {
            let files = Self::files(text);
            apply("claude", &self.root, &self.directories, Installed { tool:String::new(), path:String::new(), source:"owner/repo".into(), name:"demo".into(), remote_path:"skills/demo".into(), remote_hash:hash(text.as_bytes()), hash:digest(&files), update:false, modified:false }, &files)
        }
        fn path(&self) -> PathBuf { self.directories[0].join("demo") }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.base); } }

    #[test]
    fn reads_are_non_mutating_and_paths_use_native_overrides() {
        let f = Fixture::new();
        assert!(inventory("claude", &f.root, &f.directories).unwrap().skills.is_empty());
        assert!(!f.base.exists());
        let custom = f.base.join("custom");
        assert_eq!(roots_in("claude", &f.base, |key| (key == "CLAUDE_CONFIG_DIR").then(|| custom.clone().into_os_string())), vec![custom.join("skills")]);
        assert_eq!(roots_in("codex", &f.base, |_| None), vec![f.base.join(".codex/skills"), f.base.join(".agents/skills")]);
        assert!(roots_in("terminal", &f.base, |_| None).is_empty());
        for path in ["../outside", "/absolute", "a/../../b", "a\\b", "C:/bad", "CON", "a/COM1.txt", "a.", "a/../b", "a//b"] { assert!(!normal_path(path), "{path}"); }
        assert!(normal_path("scripts/check.py"));
    }

    #[test]
    fn installs_updates_and_removes_only_owned_unchanged_files() {
        let f = Fixture::new();
        let first = f.install("first").unwrap(); assert_eq!(first.skills.len(), 1); assert!(first.skills[0].managed);
        let path = f.path(); let original = fs::read(path.join("SKILL.md")).unwrap();
        fs::write(path.join("SKILL.md"), Fixture::files("local edit")[0].bytes.clone()).unwrap();
        assert_eq!(f.install("upstream change").err().unwrap(), "skills_modified");
        assert_eq!(remove("claude", &f.root, &f.directories, &path.to_string_lossy()).err().unwrap(), "skills_modified");
        assert!(fs::read_to_string(path.join("SKILL.md")).unwrap().contains("local edit"));
        fs::write(path.join("SKILL.md"), original).unwrap();
        f.install("second").unwrap(); assert!(fs::read_to_string(path.join("SKILL.md")).unwrap().contains("second"));
        assert!(f.root.join("backups").is_dir());
        assert!(remove("codex", &f.root, &f.directories, &path.to_string_lossy()).is_err());
        let final_list = remove("claude", &f.root, &f.directories, &path.to_string_lossy()).unwrap();
        assert!(final_list.skills.is_empty()); assert!(!path.exists());
    }

    #[test]
    fn unmanaged_files_and_same_name_other_sources_are_kept() {
        let f = Fixture::new(); write_files(&f.path(), &Fixture::files("user" )).unwrap();
        assert!(!inventory("claude", &f.root, &f.directories).unwrap().skills[0].managed);
        assert_eq!(f.install("replace").err().unwrap(), "skills_exists");
        assert!(fs::read_to_string(f.path().join("SKILL.md")).unwrap().contains("user"));
        let f = Fixture::new(); f.install("first").unwrap();
        let mut state = read_state(&f.root).unwrap(); state.installed[0].source = "another/repo".into(); write_json(&f.root.join("state.json"), &state).unwrap();
        assert_eq!(f.install("replace").err().unwrap(), "skills_exists");
    }

    #[test]
    fn staging_failure_keeps_the_previous_skill_and_state() {
        let f = Fixture::new(); f.install("first").unwrap();
        let state = fs::read(f.root.join("state.json")).unwrap();
        let mut files = Fixture::files("second"); files.push(FileData { path:"../outside".into(), bytes:vec![1], executable:false });
        let next = read_state(&f.root).unwrap().installed.remove(0);
        assert_eq!(apply("claude", &f.root, &f.directories, next, &files).err().unwrap(), "skills_source");
        assert_eq!(fs::read(f.root.join("state.json")).unwrap(), state);
        assert!(fs::read_to_string(f.path().join("SKILL.md")).unwrap().contains("first"));
        assert_eq!(fs::read_dir(&f.directories[0]).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn case_colliding_source_files_do_not_replace_an_installation() {
        let f = Fixture::new(); f.install("first").unwrap();
        let original = fs::read(f.path().join("SKILL.md")).unwrap();
        let state = fs::read(f.root.join("state.json")).unwrap();
        let mut files = Fixture::files("second");
        files.push(FileData { path:"README.md".into(), bytes:vec![1], executable:false });
        files.push(FileData { path:"readme.md".into(), bytes:vec![2], executable:false });
        let next = read_state(&f.root).unwrap().installed.remove(0);
        assert_eq!(apply("claude", &f.root, &f.directories, next, &files).err().unwrap(), "skills_source");
        assert_eq!(fs::read(f.root.join("state.json")).unwrap(), state);
        assert_eq!(fs::read(f.path().join("SKILL.md")).unwrap(), original);
        assert_eq!(fs::read_dir(&f.directories[0]).unwrap().count(), 1);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn linked_or_replaced_installations_are_never_removed() {
        let f = Fixture::new(); f.install("first").unwrap();
        let elsewhere = f.base.join("elsewhere"); fs::rename(f.path(), &elsewhere).unwrap();
        #[cfg(unix)] std::os::unix::fs::symlink(&elsewhere, f.path()).unwrap();
        #[cfg(windows)] {
            let link = f.path().to_string_lossy().replace('/', "\\");
            let target = elsewhere.to_string_lossy().replace('/', "\\");
            let output = std::process::Command::new("cmd.exe").args(["/d", "/c", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
        assert!(remove("claude", &f.root, &f.directories, &f.path().to_string_lossy()).is_err());
        assert!(elsewhere.join("SKILL.md").is_file());
    }

    #[test]
    fn popular_catalog_keeps_order_and_rejects_invalid_links() {
        let html = r#"<a href="/docs">docs</a><a href="https://other.test/a/b/c">external</a>
            <a href="/owner/repo/first">first</a><a href="/owner/repo/first">duplicate</a>
            <a href="/../repo/bad">traversal</a><a href="/owner/repo/second">second</a>"#;
        let items = popular_items(html).unwrap();
        assert_eq!(items.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
        assert_eq!(items[0].source, "owner/repo");
        assert!(popular_items("<html>No catalogue</html>").is_err());
        let large = (0..80).map(|i| format!("<a href=\"/owner/repo/skill-{i}\">skill</a>")).collect::<String>();
        assert_eq!(popular_items(&large).unwrap().len(), 60);
    }

    #[test]
    fn description_reads_only_the_skill_document_metadata() {
        let html = r#"<script type="application/ld+json">{"@type":"WebSite","description":"Not a skill"}</script>
            <script type="application/ld+json">{"@type":"SoftwareApplication","description":"Build and review \"pages\"."}</script>"#;
        assert_eq!(description_from_html(html).unwrap(), "Build and review \"pages\".");
        assert!(description_from_html("<script>execute()</script>").is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "Reads public catalogues and writes only a temporary cache"]
    async fn public_catalog_smoke() {
        let f = Fixture::new();
        let popular = popular_catalog().await.unwrap();
        assert!(popular.len() >= 30);
        let items = catalog("", &f.root).await.unwrap();
        assert!(!items.is_empty());
        assert!(items.iter().any(|item| item.name == "find-skills"));
        assert_eq!(catalog("", &f.root).await.unwrap().len(), items.len());
        let text = description("vercel-labs/skills", "find-skills", &f.root).await.unwrap();
        assert!(text.len() > 20);
        assert_eq!(description("vercel-labs/skills", "find-skills", &f.root).await.unwrap(), text);
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "Reads a public source; all installation writes remain in a temporary fixture"]
    async fn public_source_install_smoke() {
        let f = Fixture::new();
        let searched = catalog("find skills", &f.root).await.unwrap(); assert!(!searched.is_empty());
        let items = catalog("", &f.root).await.unwrap(); assert!(!items.is_empty());
        let item = items.iter().find(|s| s.name == "find-skills").unwrap();
        let (next, files) = download(&item.source, &item.name).await.unwrap();
        assert!(files.iter().any(|f| f.path.to_ascii_uppercase().starts_with("LICENSE")));
        let list = apply("claude", &f.root, &f.directories, next, &files).unwrap();
        assert_eq!(list.skills[0].name, item.name); assert!(list.skills[0].managed);
        assert!(remove("claude", &f.root, &f.directories, &list.skills[0].path).unwrap().skills.is_empty());
    }
}
