//! Official-source discovery and reviewed, one-shot installs executed by a visible Coffee terminal.
//! A successful independent MCP probe never means the user's existing CLI session has loaded it.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::hash_map::DefaultHasher, fs, hash::{Hash, Hasher}, io::{BufRead, BufReader, Read, Write}, path::{Path, PathBuf}, process::{Command, Stdio}, sync::mpsc, time::{Duration, Instant}};

const MAX_RESPONSE: usize = 2_097_152;
const MAX_FILE: usize = 524_288;
const REGISTRY: &str = "https://registry.modelcontextprotocol.io/v0.1";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(Duration::from_secs(25)).redirect(reqwest::redirect::Policy::none())
        .user_agent("Coffee-CLI-capabilities").build().map_err(|_| "HTTP client unavailable".into())
}

async fn response_bytes(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() { return Err(format!("Source returned HTTP {}", response.status().as_u16())); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Source response could not be read")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE { return Err("Source response exceeds size budget".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn get_json(url: reqwest::Url) -> Result<Value, String> {
    let response = client()?.get(url).send().await.map_err(|_| "Source request failed or timed out")?;
    serde_json::from_slice(&response_bytes(response).await?).map_err(|_| "Source returned invalid JSON".into())
}

fn segment(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && value != "." && value != ".."
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}

pub(crate) fn repository(source: &str) -> Result<String, String> {
    let source = source.trim().trim_end_matches('/').trim_end_matches(".git");
    let source = source.strip_prefix("https://github.com/").unwrap_or(source);
    let parts = source.split('/').collect::<Vec<_>>();
    if parts.len() != 2 || !parts.iter().all(|s| segment(s)) { return Err("Use a GitHub owner/repository or its HTTPS repository URL".into()); }
    Ok(parts.join("/"))
}

fn text(value: &Value, key: &str) -> String { value[key].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(500).collect() }

fn normalize_search(kind: &str, data: &Value) -> Result<Value, String> {
    let entries = if kind == "skill" {
        data["skills"].as_array().ok_or("Skills search response is missing skills")?.iter().take(20).filter_map(|s| {
            let source = repository(s["source"].as_str()?).ok()?;
            let name = s["name"].as_str()?;
            segment(name).then(|| json!({"kind":"skill","source":source,"name":name,"installs":s["installs"],"detailsRequired":true,"trust":"catalogued-not-security-reviewed"}))
        }).collect::<Vec<_>>()
    } else {
        data["servers"].as_array().ok_or("MCP Registry response is missing servers")?.iter().take(20).filter_map(|entry| {
            let s = &entry["server"];
            let name = s["name"].as_str()?;
            (entry["_meta"]["io.modelcontextprotocol.registry/official"]["status"] == "active").then(|| json!({"kind":"mcp","source":name,"name":name,"version":s["version"],"description":text(s,"description"),"repository":s["repository"]["url"],"detailsRequired":true,"trust":"registry-publisher-namespace-not-security-reviewed"}))
        }).collect::<Vec<_>>()
    };
    Ok(json!({"kind":kind,"source":if kind=="skill" {"https://skills.sh"} else {REGISTRY},"results":entries}))
}

pub async fn discover(kind: &str, query: &str) -> Result<Value, String> {
    if !matches!(kind,"skill"|"mcp") { return Err("Capability kind must be skill or mcp".into()); }
    if query.trim().chars().count() < 2 || query.len() > 200 { return Err("Search query must contain 2–200 characters".into()); }
    let mut url = reqwest::Url::parse(if kind=="skill" {"https://skills.sh/api/search"} else {"https://registry.modelcontextprotocol.io/v0.1/servers"}).unwrap();
    url.query_pairs_mut().append_pair(if kind=="skill" {"q"} else {"search"},query).append_pair("limit","20");
    if kind == "mcp" { url.query_pairs_mut().append_pair("version","latest"); }
    normalize_search(kind, &get_json(url).await?)
}

pub(crate) fn skill_metadata(body: &str) -> Result<(String,String),String> {
    let body = body.trim_start_matches('\u{feff}').replace("\r\n","\n");
    let rest = body.strip_prefix("---\n").ok_or("SKILL.md must contain YAML frontmatter")?;
    let (head, instructions) = rest.split_once("\n---\n").ok_or("SKILL.md frontmatter is not closed")?;
    if instructions.trim().is_empty() { return Err("SKILL.md has no instructions".into()); }
    let mut name = String::new(); let mut description = String::new();
    let mut lines = head.lines().peekable();
    while let Some(line) = lines.next() {
        if let Some(value) = line.strip_prefix("name:") { name = value.trim().trim_matches(['\'', '"']).to_string(); }
        if let Some(value) = line.strip_prefix("description:") {
            let value = value.trim();
            if value.starts_with('|') || value.starts_with('>') {
                let mut parts = Vec::new();
                while lines.peek().is_some_and(|line| line.is_empty() || line.starts_with(char::is_whitespace)) { parts.push(lines.next().unwrap().trim()); }
                description = parts.join(" ");
            } else { description = value.trim_matches(['\'', '"']).to_string(); }
        }
    }
    if !segment(&name) || description.trim().is_empty() { return Err("SKILL.md must have a valid name and description".into()); }
    Ok((name,description.chars().take(1000).collect()))
}

async fn skill_details(source: &str, name: &str) -> Result<Value,String> {
    let repo = repository(source)?;
    if !segment(name) { return Err("Skill name is invalid".into()); }
    let base = format!("https://api.github.com/repos/{repo}");
    let info = get_json(reqwest::Url::parse(&base).unwrap()).await?;
    let branch = info["default_branch"].as_str().ok_or("GitHub repository has no default branch")?;
    let mut commit_url=reqwest::Url::parse(&format!("{base}/commits/")).unwrap();
    commit_url.path_segments_mut().map_err(|_|"Invalid GitHub source")?.pop_if_empty().push(branch);
    let commit_info=get_json(commit_url).await?;
    let commit=commit_info["sha"].as_str().ok_or("GitHub repository has no commit")?;
    if commit.len()!=40 || !commit.bytes().all(|c|c.is_ascii_hexdigit()){return Err("GitHub commit is invalid".into());}
    let mut tree_url = reqwest::Url::parse(&format!("{base}/git/trees/")).unwrap();
    tree_url.path_segments_mut().map_err(|_| "Invalid GitHub source")?.pop_if_empty().push(commit);
    tree_url.query_pairs_mut().append_pair("recursive","1");
    let tree = get_json(tree_url).await?;
    if tree["truncated"] == true { return Err("Repository tree is too large; use a smaller skill repository".into()); }
    let mut candidates = tree["tree"].as_array().ok_or("GitHub tree is missing")?.iter().filter(|entry| entry["type"]=="blob" && entry["mode"]!="120000").filter_map(|entry| {
        let path = entry["path"].as_str()?;
        (path=="SKILL.md" || path.ends_with("/SKILL.md")).then_some(path)
    }).collect::<Vec<_>>();
    candidates.sort_by_key(|path|{
        let folder=Path::new(path).parent().and_then(|p|p.file_name()).and_then(|p|p.to_str()).unwrap_or("");
        (if folder==name{0}else if !folder.is_empty() && name.ends_with(&format!("-{folder}")){1}else if *path=="SKILL.md"{2}else{3},*path)
    });
    for path in candidates.into_iter().take(20) {
        let mut url = reqwest::Url::parse(&format!("{base}/contents/")).unwrap();
        { let mut parts=url.path_segments_mut().map_err(|_| "Invalid GitHub path")?; parts.pop_if_empty(); for part in path.split('/') { if part==".." { return Err("Unsafe skill source path".into()); } parts.push(part); } }
        url.query_pairs_mut().append_pair("ref",commit);
        let file = get_json(url).await?;
        if file["encoding"]!="base64" || file["size"].as_u64().unwrap_or(u64::MAX)>MAX_FILE as u64 { continue; }
        let encoded = file["content"].as_str().ok_or("GitHub skill content is missing")?.split_whitespace().collect::<String>();
        let bytes = STANDARD.decode(encoded).map_err(|_| "GitHub skill content is invalid")?;
        let body = String::from_utf8(bytes).map_err(|_| "SKILL.md is not UTF-8")?;
        if let Ok((found,description)) = skill_metadata(&body) {
            if found == name { return Ok(json!({"kind":"skill","source":repo,"name":found,"description":description,"repository":info["html_url"],"commit":commit,"skillPath":path,"installSource":format!("https://github.com/{repo}/tree/{commit}"),"sourceVerified":"github-repository-and-skill-at-commit","securityReviewed":false,"instructionsPreview":body.chars().take(4000).collect::<String>()})); }
        }
    }
    Err("Selected skill was not found with matching SKILL.md metadata in the repository".into())
}

pub async fn details(kind: &str, source: &str, name: &str) -> Result<Value,String> {
    if kind=="skill" { return skill_details(source,name).await; }
    if kind!="mcp" || source.len()>250 || !source.contains('/') || source.chars().any(|c| c.is_control() || "?#\\".contains(c)) { return Err("Use an MCP Registry server name".into()); }
    let mut url=reqwest::Url::parse(&format!("{REGISTRY}/servers/")).unwrap();
    url.path_segments_mut().map_err(|_| "Invalid Registry URL")?.pop_if_empty().push(source).push("versions").push("latest");
    let entry=get_json(url).await?;
    if entry["server"]["name"]!=source || entry["_meta"]["io.modelcontextprotocol.registry/official"]["status"]!="active" { return Err("MCP Registry server is inactive or does not match its requested publisher name".into()); }
    Ok(json!({"kind":"mcp","source":source,"name":source,"version":entry["server"]["version"],"description":text(&entry["server"],"description"),"repository":entry["server"]["repository"]["url"],"sourceVerified":"official-registry-publisher-namespace","securityReviewed":false,"server":entry["server"]}))
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Plan {
    #[serde(rename="planId")] id:String, identity:String, tool:String, cwd:PathBuf, kind:String, source:String, name:String,
    scope:String, state:String, source_evidence:Value, target_paths:Vec<PathBuf>, fingerprints:Vec<String>,
    install_argv:Vec<String>, server:Value, #[serde(default)] receipt:Option<Value>,
}

fn plan_path(root:&Path,id:&str)->Result<PathBuf,String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid capability plan ID")?;
    if !root.is_absolute() || root.components().any(|c|matches!(c,std::path::Component::ParentDir)){return Err("Capability storage root must be an absolute normal path".into());}
    let path=root.join("capability-plans").join(format!("{id}.json"));
    reject_links(&path)?;Ok(path)
}

fn reject_links(path:&Path)->Result<(),String> {
    for parent in path.ancestors(){
        if let Ok(metadata)=fs::symlink_metadata(parent){
            let mut linked=metadata.file_type().is_symlink();
            #[cfg(windows)]{use std::os::windows::fs::MetadataExt;linked|=metadata.file_attributes()&0x400!=0;}
            if linked{return Err("Capability storage and install paths cannot contain symbolic links or junctions".into());}
        }
    }
    Ok(())
}

fn read_plan(root:&Path,id:&str)->Result<Plan,String> {
    let bytes=fs::read(plan_path(root,id)?).map_err(|_| "Capability plan does not exist")?;
    if bytes.len()>MAX_RESPONSE { return Err("Capability plan exceeds budget".into()); }
    let plan:Plan=serde_json::from_slice(&bytes).map_err(|_| "Capability plan is invalid")?;
    if plan.id!=id || !matches!(plan.tool.as_str(),"claude"|"codex") || !matches!(plan.kind.as_str(),"skill"|"mcp") || plan.scope!="project" || !segment(&plan.name) || plan.identity.is_empty(){return Err("Capability plan does not match its saved identity or supported scope".into());}
    if !plan.cwd.is_absolute(){return Err("Capability plan has no absolute project directory".into());}
    Ok(plan)
}

fn load_plan(root:&Path,id:&str)->Result<Plan,String> {
    let plan=read_plan(root,id)?;
    if dunce::canonicalize(&plan.cwd).ok().as_ref()!=Some(&plan.cwd){return Err("Planned project directory changed or is unavailable".into());}
    checked_targets(&plan)?;Ok(plan)
}

fn save_plan(root:&Path,plan:&Plan)->Result<(),String> {
    let path=plan_path(root,&plan.id)?; fs::create_dir_all(path.parent().unwrap()).map_err(|_| "Plan directory could not be created")?;
    atomic_write(&path,&serde_json::to_vec_pretty(plan).map_err(|_| "Plan serialization failed")?)
}

fn atomic_write(path:&Path,bytes:&[u8])->Result<(),String> {
    let temporary=path.with_extension(format!("coffee-{}.tmp",uuid::Uuid::new_v4()));
    let result:Result<(),String>=(||{fs::write(&temporary,bytes).map_err(|_|"Configuration could not be saved")?;fs::rename(&temporary,path).map_err(|_|"Configuration could not be atomically replaced".to_string())})();
    if result.is_err(){let _=fs::remove_file(temporary);}result
}

fn plain_read(path:&Path)->Result<Option<String>,String> {
    if !path.exists(){return Ok(None);}
    if fs::symlink_metadata(path).map_err(|_|"Target unavailable")?.file_type().is_symlink(){return Err("Symbolic link configuration is not supported for installation".into());}
    let bytes=fs::read(path).map_err(|_|"Configuration could not be read")?;
    if bytes.len()>MAX_FILE{return Err("Configuration exceeds budget".into());}
    String::from_utf8(bytes).map(Some).map_err(|_|"Configuration is not UTF-8".into())
}

fn fingerprint(path:&Path)->Result<String,String> {
    if !path.exists(){return Ok("absent".into());}
    let metadata=fs::symlink_metadata(path).map_err(|_|"Target unavailable")?;
    if metadata.file_type().is_symlink(){return Err("An existing target is a symbolic link; choose a normal project directory".into());}
    let mut hasher=DefaultHasher::new();
    if metadata.is_file() { fs::read(path).map_err(|_|"Target unreadable")?.hash(&mut hasher); }
    else { let mut entries=fs::read_dir(path).map_err(|_|"Target unreadable")?.collect::<Result<Vec<_>,_>>().map_err(|_|"Target unreadable")?; entries.sort_by_key(|entry|entry.file_name()); for entry in entries { entry.file_name().hash(&mut hasher); fingerprint(&entry.path())?.hash(&mut hasher); } }
    Ok(format!("{:x}",hasher.finish()))
}

fn targets(tool:&str,cwd:&Path,kind:&str,name:&str)->Vec<PathBuf> {
    if kind=="mcp" { return vec![if tool=="claude" {cwd.join(".mcp.json")} else {cwd.join(".codex").join("config.toml")}]; }
    vec![cwd.join(if tool=="claude" {".claude"} else {".agents"}).join("skills").join(name),cwd.join("skills-lock.json")]
}

fn unresolved(input:&Value)->bool {
    input["isSecret"]==true || input["isRequired"]==true && input["value"].as_str().unwrap_or("").is_empty()
        || input["value"].as_str().is_some_and(|s|s.contains('{') || s.contains('}'))
}

fn mcp_spec(server:&Value)->Result<Value,String> {
    if let Some(remotes)=server["remotes"].as_array() {
        for remote in remotes.iter().filter(|r|r["type"]=="streamable-http") {
            let Some(url)=remote["url"].as_str() else{continue};
            let parsed=reqwest::Url::parse(url).map_err(|_|"Publisher MCP URL is invalid")?;
            if parsed.scheme()!="https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || url.contains('{') {continue;}
            let mut headers=serde_json::Map::new();
            for header in remote["headers"].as_array().into_iter().flatten() {
                if unresolved(header){return Err("needs-credentials: Publisher requires an authentication header; configure credentials explicitly before installation".into());}
                if let (Some(name),Some(value))=(header["name"].as_str(),header["value"].as_str()) { headers.insert(name.to_string(),json!(value)); }
            }
            return Ok(json!({"type":"http","url":url,"headers":headers}));
        }
    }
    if let Some(packages)=server["packages"].as_array() {
        for package in packages.iter().filter(|p|p["registryType"]=="npm" && p["transport"]["type"]=="stdio") {
            if package["registryBaseUrl"].as_str().is_some_and(|url|url!="https://registry.npmjs.org") {continue;}
            if package["runtimeHint"].as_str().is_some_and(|hint|hint!="npx") {continue;}
            let Some(identifier)=package["identifier"].as_str() else{continue}; let Some(version)=package["version"].as_str() else{continue};
            let valid=regex::Regex::new(r"^(?:@[A-Za-z0-9][A-Za-z0-9_.-]*/)?[A-Za-z0-9][A-Za-z0-9_.-]*$").unwrap();
            if !valid.is_match(identifier) || !segment(version) || !version.starts_with(|c:char|c.is_ascii_digit()) {continue;}
            let mut args=vec!["--yes".to_string(),format!("{identifier}@{version}")];
            for arg in package["runtimeArguments"].as_array().into_iter().flatten() {
                // Only the documented npx -y flag is needed; arbitrary runtime flags can change the package being executed.
                if !matches!(arg["value"].as_str(),Some("-y"|"--yes")) {return Err("Publisher specifies unsupported npm runtime arguments".into());}
            }
            for arg in package["packageArguments"].as_array().into_iter().flatten() {
                if unresolved(arg){return Err("needs-configuration: Publisher requires explicit package arguments".into());}
                if arg["type"]=="named" {let name=arg["name"].as_str().ok_or("Publisher argument name missing")?; args.push(name.to_string());}
                if let Some(value)=arg["value"].as_str() {args.push(value.to_string());}
            }
            let mut env=serde_json::Map::new();
            for input in package["environmentVariables"].as_array().into_iter().flatten() {
                if unresolved(input) {return Err("needs-credentials: Publisher requires environment configuration; set it explicitly before installation".into());}
                if let (Some(name),Some(value))=(input["name"].as_str(),input["value"].as_str()) {env.insert(name.to_string(),json!(value));}
            }
            if args.iter().any(|arg|arg.chars().any(|c|c.is_control() || "\"%!^&|<>".contains(c))) {return Err("Publisher arguments cannot be represented safely on Windows".into());}
            return Ok(json!({"type":"stdio","command":"npx","args":args,"env":env}));
        }
    }
    Err("Publisher has no supported credential-free npm stdio or HTTPS streamable-http configuration".into())
}

fn configuration_text(tool:&str, original:Option<&str>,name:&str,server:&Value)->Result<String,String> {
    if tool=="claude" {
        let mut config:Value=original.map(serde_json::from_str).transpose().map_err(|_|"Existing .mcp.json is invalid; it will not be overwritten")?.unwrap_or(json!({"mcpServers":{}}));
        let object=config.as_object_mut().ok_or("Existing .mcp.json must be an object")?;
        let servers=object.entry("mcpServers").or_insert(json!({})).as_object_mut().ok_or("Existing mcpServers must be an object")?;
        if servers.contains_key(name){return Err("An MCP entry with this name already exists; installation will not overwrite it".into());}
        servers.insert(name.to_string(),server.clone());
        return serde_json::to_string_pretty(&config).map_err(|_|"MCP configuration serialization failed".into());
    }
    let before=original.unwrap_or("");
    let config:toml::Value=toml::from_str(before).map_err(|_|"Existing Codex config is invalid; it will not be overwritten")?;
    if config.get("mcp_servers").and_then(|v|v.get(name)).is_some(){return Err("An MCP entry with this name already exists; installation will not overwrite it".into());}
    let spec=if server["type"]=="http" {json!({"url":server["url"],"http_headers":server["headers"]})} else {json!({"command":server["command"],"args":server["args"],"env":server["env"]})};
    let addition=toml::to_string(&json!({"mcp_servers":{name:spec}})).map_err(|_|"Codex MCP configuration serialization failed")?;
    let result=format!("{before}\n{addition}");
    toml::from_str::<toml::Value>(&result).map_err(|_|"New MCP entry conflicts with existing Codex config")?;
    Ok(result)
}

pub async fn prepare_plan(root:&Path,identity:&str,tool:&str,cwd:&str,kind:&str,source:&str,name:&str)->Result<Value,String> {
    if !matches!(tool,"claude"|"codex"){return Err("Capability installation currently supports Claude Code and Codex".into());}
    if !Path::new(cwd).is_absolute(){return Err("Specify an absolute project directory; the Coffee process directory will not be selected implicitly".into());}
    let cwd=dunce::canonicalize(cwd).map_err(|_|"Choose an existing project directory")?;
    if !cwd.is_dir(){return Err("Project path must be a directory".into());}
    let evidence=details(kind,source,name).await?;
    prepare_from_evidence(root,identity,tool,&cwd,kind,evidence)
}

fn prepare_from_evidence(root:&Path,identity:&str,tool:&str,cwd:&Path,kind:&str,evidence:Value)->Result<Value,String> {
    if identity.is_empty(){return Err("Conversation identity is required".into());}
    let (name,server,argv)=if kind=="skill" {
        let name=evidence["name"].as_str().ok_or("Skill details missing name")?;
        if !segment(name){return Err("Skill name is invalid".into());}
        (name.to_string(),Value::Null,vec!["npx".into(),"--yes".into(),"skills@1.7.2".into(),"add".into(),evidence["installSource"].as_str().ok_or("Skill install source missing")?.into(),"--agent".into(),if tool=="claude" {"claude-code".into()} else {"codex".into()},"--skill".into(),name.into(),"--copy".into(),"--yes".into()])
    } else {
        let source=evidence["source"].as_str().ok_or("MCP details missing source")?;
        let leaf=source.rsplit('/').next().unwrap_or("mcp").chars().map(|c|if c.is_ascii_alphanumeric() || c=='-' || c=='_' {c} else {'-'}).take(55).collect::<String>();
        (format!("coffee-{leaf}"),mcp_spec(&evidence["server"])?,Vec::new())
    };
    let paths=targets(tool,cwd,kind,&name);
    if kind=="mcp" {configuration_text(tool,plain_read(&paths[0])?.as_deref(),&name,&server)?;}
    let fingerprints=paths.iter().map(|p|fingerprint(p)).collect::<Result<Vec<_>,_>>()?;
    let plan=Plan{id:uuid::Uuid::new_v4().to_string(),identity:identity.into(),tool:tool.into(),cwd:cwd.into(),kind:kind.into(),source:evidence["source"].as_str().unwrap_or("").into(),name,scope:"project".into(),state:"pending-confirmation".into(),source_evidence:evidence,target_paths:paths,fingerprints,install_argv:argv,server,receipt:None};
    save_plan(root,&plan)?;
    plan_view(&plan)
}

fn plan_view(plan:&Plan)->Result<Value,String> {
    Ok(json!({"planId":plan.id,"identity":plan.identity,"tool":plan.tool,"cwd":plan.cwd,"kind":plan.kind,"source":plan.source,"name":plan.name,"scope":plan.scope,"state":plan.state,"sourceEvidence":plan.source_evidence,"targetPaths":plan.target_paths,"installArgv":plan.install_argv,"configuration":plan.server,"requiresConfirmation":plan.state=="pending-confirmation","changes":"Only the selected project skill directory/skills-lock.json or one new project MCP entry; existing files are backed up before changes.","verification":"Skill metadata and Codex native skills/list loader; MCP native configuration plus independent initialize/tools/list. Existing CLI session loading requires reload/reconnect and trust.","targetCliLoaded":Value::Null,"receipt":plan.receipt}))
}

pub fn approve_plan(root:&Path,identity:&str,id:&str)->Result<Value,String> {
    let mut plan=load_plan(root,id)?;
    if plan.identity!=identity{return Err("Plan belongs to another conversation".into());}
    if plan.state!="pending-confirmation"{return Err("Only a pending, unused plan can be approved".into());}
    plan.state="approved".into();save_plan(root,&plan)?;plan_view(&plan)
}

fn copy_target(source:&Path,destination:&Path)->Result<(),String> {
    let metadata=fs::symlink_metadata(source).map_err(|_|"Backup source unavailable")?;
    if metadata.file_type().is_symlink(){return Err("Installation cannot copy symbolic links".into());}
    if metadata.is_dir(){fs::create_dir_all(destination).map_err(|_|"Backup directory unavailable")?; for entry in fs::read_dir(source).map_err(|_|"Backup source unreadable")?{let entry=entry.map_err(|_|"Backup source unreadable")?;copy_target(&entry.path(),&destination.join(entry.file_name()))?;}}
    else{if let Some(parent)=destination.parent(){fs::create_dir_all(parent).map_err(|_|"Backup parent unavailable")?;}fs::copy(source,destination).map_err(|_|"Backup failed")?;}
    Ok(())
}

fn checked_targets(plan:&Plan)->Result<(),String> {
    if targets(&plan.tool,&plan.cwd,&plan.kind,&plan.name)!=plan.target_paths{return Err("Plan target paths do not match its selected project".into());}
    for path in &plan.target_paths {
        reject_links(path)?;
        let mut ancestor=path.parent();
        while let Some(parent)=ancestor {if parent==plan.cwd{break;} if parent.exists() && fs::symlink_metadata(parent).map_err(|_|"Project target unavailable")?.file_type().is_symlink(){return Err("Project installation path contains a symbolic link".into());} ancestor=parent.parent();}
    }
    Ok(())
}

fn rollback(plan:&Plan,backup:&Path,installed:&[String])->Result<(),String> {
    checked_targets(plan)?;
    for (path,expected) in plan.target_paths.iter().zip(installed){if &fingerprint(path)?!=expected{return Err("Project changed during verification; backup retained for manual recovery".into());}}
    for (index,path) in plan.target_paths.iter().enumerate() {
        if path.exists(){if fs::symlink_metadata(path).map_err(|_|"Rollback target unavailable")?.is_dir(){fs::remove_dir_all(path).map_err(|_|"Rollback failed")?;}else{fs::remove_file(path).map_err(|_|"Rollback failed")?;}}
        let source=backup.join(index.to_string()); if source.exists(){copy_target(&source,path)?;}
    }
    Ok(())
}

fn process(argv:&[String],cwd:&Path)->Result<Command,String> {
    let Some(program)=argv.first()else{return Err("Command is empty".into());};
    #[cfg(windows)]
    let mut command=if let Some((binary,prefix))=windows_program(program){let mut cmd=Command::new(binary);cmd.args(prefix).args(&argv[1..]);cmd} else if program=="npx" || program=="codex" {
        if argv.iter().any(|a|a.chars().any(|c|c.is_control() || "\"%!^&|<>".contains(c))){return Err("Command arguments are not safe for CMD".into());}
        let line=argv.iter().map(|a|format!("\"{a}\"")).collect::<Vec<_>>().join(" ");
        let mut cmd=Command::new("cmd.exe");cmd.args(["/d","/s","/c",&format!("\"{line}\"")]);cmd
    } else {let mut cmd=Command::new(program);cmd.args(&argv[1..]);cmd};
    #[cfg(not(windows))]
    let mut command={let mut cmd=Command::new(program);cmd.args(&argv[1..]);cmd};
    command.current_dir(cwd);Ok(command)
}

#[cfg(windows)]
fn windows_program(program:&str)->Option<(PathBuf,Vec<String>)> {
    if !matches!(program,"npx"|"codex"){return None;}
    let paths=std::env::var_os("PATH")?;let directories=std::env::split_paths(&paths).collect::<Vec<_>>();
    let node=directories.iter().map(|path|path.join("node.exe")).find(|path|path.is_file());
    for directory in directories {
        if program=="codex" {
            let binary=directory.join("codex.exe");if binary.is_file(){return Some((binary,Vec::new()));}
            let architecture=if cfg!(target_arch="aarch64"){"arm64"}else{"x64"};
            let triple=if cfg!(target_arch="aarch64"){"aarch64-pc-windows-msvc"}else{"x86_64-pc-windows-msvc"};
            let package=directory.join("node_modules/@openai/codex");
            let binary=package.join(format!("node_modules/@openai/codex-win32-{architecture}/vendor/{triple}/bin/codex.exe"));
            if binary.is_file(){return Some((binary,Vec::new()));}
            let script=package.join("bin/codex.js");if script.is_file(){if let Some(node)=&node{return Some((node.clone(),vec![script.to_string_lossy().into_owned()]));}}
        } else {
            let script=directory.join("node_modules/npm/bin/npx-cli.js");
            if script.is_file(){if let Some(node)=&node{return Some((node.clone(),vec![script.to_string_lossy().into_owned()]));}}
        }
    }
    None
}

fn close_probe(child:&mut std::process::Child) {
    for _ in 0..20{if child.try_wait().ok().flatten().is_some(){return;}std::thread::sleep(Duration::from_millis(25));}
    #[cfg(windows)]{
        use std::os::windows::process::CommandExt;
        let _=Command::new("taskkill.exe").args(["/PID",&child.id().to_string(),"/T","/F"]).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _=child.kill();let _=child.wait();
}

fn installed_configuration(plan:&Plan)->Result<bool,String> {
    if plan.kind=="skill" {
        let file=plan.target_paths[0].join("SKILL.md");
        let body=plain_read(&file)?.ok_or("Installed skill is missing SKILL.md")?;
        return Ok(skill_metadata(&body)?.0==plan.name);
    }
    let content=plain_read(&plan.target_paths[0])?.ok_or("Installed MCP configuration is missing")?;
    if plan.tool=="claude" {
        let config:Value=serde_json::from_str(&content).map_err(|_|"Installed MCP JSON is invalid")?;
        Ok(config["mcpServers"][&plan.name]==plan.server)
    } else {
        let config:toml::Value=toml::from_str(&content).map_err(|_|"Installed MCP TOML is invalid")?;
        let Some(server)=config.get("mcp_servers").and_then(|v|v.get(&plan.name))else{return Ok(false);};
        let value=serde_json::to_value(server).map_err(|_|"MCP configuration cannot be inspected")?;
        Ok(if plan.server["type"]=="http" {value["url"]==plan.server["url"] && value["http_headers"]==plan.server["headers"]} else {value["command"]==plan.server["command"] && value["args"]==plan.server["args"] && value["env"]==plan.server["env"]})
    }
}

fn rpc_result(value:Value,id:u64)->Result<Value,String> {
    if value["id"]!=id || value["jsonrpc"]!="2.0" || value.get("error").is_some(){return Err("MCP returned an invalid or failed protocol response".into());}
    value.get("result").cloned().ok_or("MCP response has no result".into())
}

fn probe_result(initialize:Value,list:Value)->Result<Value,String> {
    let version=initialize["protocolVersion"].as_str().ok_or("MCP initialize did not negotiate a protocol version")?;
    if !matches!(version,"2024-11-05"|"2025-03-26"|"2025-06-18"|"2025-11-25"){return Err("MCP negotiated an unsupported protocol version".into());}
    if !initialize["capabilities"]["tools"].is_object(){return Err("MCP server did not advertise tool-list capability".into());}
    if initialize["serverInfo"]["name"].as_str().is_none_or(|s|s.trim().is_empty()) || initialize["serverInfo"]["version"].as_str().is_none_or(|s|s.trim().is_empty()){return Err("MCP initialize is missing server identity and version".into());}
    let tools=list["tools"].as_array().ok_or("MCP tools/list did not return a tool list")?;
    if tools.iter().any(|tool|tool["name"].as_str().is_none_or(|name|name.is_empty() || name.len()>128 || name.chars().any(char::is_control)) || tool["inputSchema"]["type"]!="object"){return Err("MCP tools/list returned invalid tool names or input schemas".into());}
    Ok(json!({"protocolVerified":true,"protocolVersion":version,"serverName":text(&initialize["serverInfo"],"name"),"tools":tools.iter().take(100).map(|tool|text(tool,"name")).collect::<Vec<_>>(),"toolsTruncated":tools.len()>100 || list["nextCursor"].as_str().is_some(),"targetCliLoaded":Value::Null}))
}

fn initialize_request()->Value{json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"Coffee CLI verification","version":env!("CARGO_PKG_VERSION")}}})}

async fn http_rpc(client:&reqwest::Client,spec:&Value,body:&Value,session:&mut Option<String>,notification:bool,version:Option<&str>)->Result<Value,String> {
    let mut request=client.post(spec["url"].as_str().ok_or("MCP endpoint missing")?).header("Accept","application/json, text/event-stream");
    if let Some(id)=session.as_deref(){request=request.header("Mcp-Session-Id",id);}
    if let Some(version)=version{request=request.header("MCP-Protocol-Version",version);}
    for (name,value) in spec["headers"].as_object().into_iter().flatten(){request=request.header(name,value.as_str().ok_or("MCP header is invalid")?);}
    let mut response=request.json(body).send().await.map_err(|_|"MCP connection failed or timed out")?;
    if matches!(response.status().as_u16(),401|403){return Err("needs-credentials: MCP requires authentication or OAuth login".into());}
    if session.is_none(){*session=response.headers().get("Mcp-Session-Id").and_then(|v|v.to_str().ok()).map(str::to_string);}
    if notification && response.status().is_success(){return Ok(Value::Null);}
    if !response.status().is_success(){return Err(format!("MCP returned HTTP {}",response.status().as_u16()));}
    let mut bytes=Vec::new();let mut total=0;
    while let Some(chunk)=response.chunk().await.map_err(|_|"MCP response failed or timed out")?{
        total+=chunk.len();if total>MAX_RESPONSE{return Err("MCP response exceeds budget".into());}bytes.extend_from_slice(&chunk);
        if let Ok(value)=serde_json::from_slice::<Value>(&bytes){if value["id"]==body["id"]{return Ok(value);}}
        loop{
            let boundary=bytes.windows(2).position(|v|v==b"\n\n").map(|index|(index,2)).or_else(||bytes.windows(4).position(|v|v==b"\r\n\r\n").map(|index|(index,4)));
            let Some((index,length))=boundary else{break};
            let event=String::from_utf8(bytes.drain(..index+length).collect()).map_err(|_|"MCP SSE response is not UTF-8")?;
            let data=event.lines().filter_map(|line|line.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
            if let Ok(value)=serde_json::from_str::<Value>(&data){if value["id"]==body["id"]{return Ok(value);}}
        }
    }
    Err("MCP returned no matching JSON-RPC response".into())
}

async fn probe_http(spec:&Value)->Result<Value,String> {
    let client=client()?;let mut session=None;
    let init=rpc_result(http_rpc(&client,spec,&initialize_request(),&mut session,false,None).await?,1)?;
    let version=init["protocolVersion"].as_str().ok_or("MCP initialize did not negotiate a protocol version")?.to_string();
    http_rpc(&client,spec,&json!({"jsonrpc":"2.0","method":"notifications/initialized"}),&mut session,true,Some(&version)).await?;
    let tools=rpc_result(http_rpc(&client,spec,&json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),&mut session,false,Some(&version)).await?,2)?;
    let result=probe_result(init,tools);
    if let Some(id)=session{let _=client.delete(spec["url"].as_str().unwrap_or("")).header("Mcp-Session-Id",id).header("MCP-Protocol-Version",&version).send().await;}
    result
}

fn stdio_response(receiver:&mpsc::Receiver<Result<Value,String>>,id:u64,mcp:bool)->Result<Value,String> {
    let deadline=Instant::now()+Duration::from_secs(35);
    loop {let remaining=deadline.checked_duration_since(Instant::now()).ok_or("MCP response timed out")?;
        let value=receiver.recv_timeout(remaining).map_err(|_|"MCP process closed or timed out")??;
        if value["id"]==id{
            if mcp{return rpc_result(value,id);}
            if value.get("error").is_some(){return Err("Native CLI loader rejected the request".into());}
            return value.get("result").cloned().ok_or("Native CLI loader response has no result".into());
        }
    }
}

fn probe_stdio(spec:&Value,cwd:&Path)->Result<Value,String> {
    let mut argv=vec![spec["command"].as_str().ok_or("MCP command missing")?.to_string()];
    for arg in spec["args"].as_array().ok_or("MCP arguments missing")?{argv.push(arg.as_str().ok_or("MCP argument invalid")?.to_string());}
    let mut command=process(&argv,cwd)?;command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    for (name,value) in spec["env"].as_object().into_iter().flatten(){command.env(name,value.as_str().ok_or("MCP environment invalid")?);}
    let mut child=command.spawn().map_err(|_|"MCP process could not be started")?;
    let output=child.stdout.take().ok_or("MCP stdout unavailable")?;let mut input=child.stdin.take().ok_or("MCP stdin unavailable")?;
    let (sender,receiver)=mpsc::sync_channel(32);
    std::thread::spawn(move||{let mut reader=BufReader::new(output);loop{let mut line=Vec::new();let result=Read::by_ref(&mut reader).take(MAX_RESPONSE as u64+1).read_until(b'\n',&mut line);match result {Ok(0)|Err(_)=>break,_=>{}}
        if line.len()>MAX_RESPONSE{let _=sender.try_send(Err("MCP response exceeds budget".into()));break;}
        if let Ok(value)=serde_json::from_slice(&line){if sender.try_send(Ok(value)).is_err(){break;}}
    }});
    let result=(||{
        writeln!(input,"{}",initialize_request()).map_err(|_|"MCP input failed")?;
        let init=stdio_response(&receiver,1,true)?;
        writeln!(input,"{}",json!({"jsonrpc":"2.0","method":"notifications/initialized"})).map_err(|_|"MCP input failed")?;
        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})).map_err(|_|"MCP input failed")?;
        let list=stdio_response(&receiver,2,true)?;probe_result(init,list)
    })();
    drop(input);close_probe(&mut child);result
}

fn codex_skill_loader(cwd:&Path,name:&str,expected:&Path)->Result<Value,String> {
    let mut child=process(&["codex".into(),"app-server".into(),"--stdio".into()],cwd)?
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_|"Codex native Skills loader could not be started")?;
    let output=child.stdout.take().ok_or("Codex loader stdout unavailable")?;let mut input=child.stdin.take().ok_or("Codex loader stdin unavailable")?;
    let (sender,receiver)=mpsc::sync_channel(32);
    std::thread::spawn(move||{let mut reader=BufReader::new(output);loop{let mut line=Vec::new();let result=Read::by_ref(&mut reader).take(MAX_RESPONSE as u64+1).read_until(b'\n',&mut line);match result{Ok(0)|Err(_)=>break,_=>{}}
        if line.len()>MAX_RESPONSE{let _=sender.try_send(Err("Native Skills loader response exceeds budget".into()));break;}
        if let Ok(value)=serde_json::from_slice(&line){if sender.try_send(Ok(value)).is_err(){break;}}
    }});
    let result=(||{
        writeln!(input,"{}",json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"coffee_capability_verification","version":env!("CARGO_PKG_VERSION")}}})).map_err(|_|"Codex loader input failed")?;
        stdio_response(&receiver,1,false)?;
        writeln!(input,"{}",json!({"method":"initialized","params":{}})).map_err(|_|"Codex loader input failed")?;
        writeln!(input,"{}",json!({"id":2,"method":"skills/list","params":{"cwds":[cwd],"forceReload":true}})).map_err(|_|"Codex loader input failed")?;
        let result=stdio_response(&receiver,2,false)?;
        let expected=dunce::canonicalize(expected).map_err(|_|"Installed skill path unavailable")?;
        let loaded=result["data"].as_array().into_iter().flatten().flat_map(|entry|entry["skills"].as_array().into_iter().flatten()).find(|skill|skill["name"]==name && skill["enabled"]==true && skill["path"].as_str().is_some_and(|p|dunce::canonicalize(p).ok().as_ref()==Some(&expected))).is_some();
        if !loaded{return Err("Codex native Skills loader did not discover the enabled installed skill".into());}
        Ok(json!({"nativeLoaderVerified":true,"nativeLoader":"codex app-server skills/list forceReload","protocolVerified":false,"targetCliLoaded":Value::Null,"evidence":"A new native CLI loader detected the selected enabled skill; existing terminal sessions may still need reload."}))
    })();
    drop(input);close_probe(&mut child);result
}

pub async fn apply_plan(root:&Path,id:&str)->Result<Value,String> {
    let result=apply_approved_plan(root,id).await;
    if let Err(error)=&result {
        // A rejected replay must not replace the receipt or state of a run already underway.
        if !error.contains("already run") {
            if let Ok(mut plan)=read_plan(root,id) {
                if matches!(plan.state.as_str(),"approved"|"running") && plan.receipt.is_none() {
                    plan.state=if plan.state=="approved" {"failed-before-install"} else {"failed-run-record"}.into();
                    plan.receipt=Some(json!({"planId":plan.id,"state":plan.state,"tool":plan.tool,"cwd":plan.cwd,"source":plan.source,"scope":plan.scope,"exitCode":Value::Null,"configurationVerified":false,"protocolVerified":false,"targetCliLoaded":Value::Null,"error":error,"observedAtUnixMs":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()}));
                    save_plan(root,&plan)?;
                }
            }
        }
    }
    result
}

async fn apply_approved_plan(root:&Path,id:&str)->Result<Value,String> {
    let mut plan=load_plan(root,id)?;
    if plan.state!="approved"{return Err("Capability plan has not been approved or has already run".into());}
    checked_targets(&plan)?;
    for (path,before) in plan.target_paths.iter().zip(&plan.fingerprints){if &fingerprint(path)?!=before{return Err("Project configuration changed after the plan; prepare and review a new plan".into());}}
    let runs=root.join("capability-runs");fs::create_dir_all(&runs).map_err(|_|"Run directory unavailable")?;
    reject_links(&runs)?;
    let _once=fs::OpenOptions::new().write(true).create_new(true).open(runs.join(&plan.id)).map_err(|_|"Capability plan has already run")?;
    let backup=root.join("capability-backups").join(&plan.id);
    reject_links(&backup)?;
    fs::create_dir_all(&backup).map_err(|_|"Backup directory unavailable")?;
    for (index,path) in plan.target_paths.iter().enumerate(){if path.exists(){copy_target(path,&backup.join(index.to_string()))?;}}
    plan.state="running".into();save_plan(root,&plan)?;
    println!("Coffee CLI: installing {} for {} in {} (project scope)",plan.name,plan.tool,plan.cwd.display());
    let mut actual_exit=None;
    let mut installed=plan.fingerprints.clone();
    let operation=async {
        if plan.kind=="skill" {
            let mut child=process(&plan.install_argv,&plan.cwd)?.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn().map_err(|_|"Skills CLI could not be started")?;
            let status=child.wait().map_err(|_|"Skills CLI exit status unavailable")?;actual_exit=status.code();
            installed=plan.target_paths.iter().map(|path|fingerprint(path)).collect::<Result<Vec<_>,_>>()?;
            if !status.success(){return Err("Skills CLI installation failed".to_string());}
        } else {
            let path=&plan.target_paths[0];let content=configuration_text(&plan.tool,plain_read(path)?.as_deref(),&plan.name,&plan.server)?;
            fs::create_dir_all(path.parent().unwrap()).map_err(|_|"Project configuration directory unavailable")?;
            atomic_write(path,content.as_bytes())?;
            installed=plan.target_paths.iter().map(|path|fingerprint(path)).collect::<Result<Vec<_>,_>>()?;
            actual_exit=Some(0);
        }
        if !installed_configuration(&plan)?{return Err("Installed capability does not match the selected plan".to_string());}
        if plan.kind=="mcp" {
            println!("Coffee CLI: verifying MCP initialize and tools/list; no tool is being called.");
            if plan.server["type"]=="http" {probe_http(&plan.server).await} else {probe_stdio(&plan.server,&plan.cwd)}
        } else if plan.tool=="codex" {
            println!("Coffee CLI: verifying the native Codex Skills loader without making a model request.");
            codex_skill_loader(&plan.cwd,&plan.name,&plan.target_paths[0].join("SKILL.md"))
        } else {Ok(json!({"nativeLoaderVerified":false,"protocolVerified":false,"targetCliLoaded":Value::Null,"evidence":"Selected SKILL.md exists with valid matching metadata; Claude /reload-skills may be required. Runtime loading is unknown."}))}
    }.await;
    let mut receipt=match operation {
        Ok(probe)=>{plan.state="verified".into();json!({"state":"verified","exitCode":actual_exit,"configurationVerified":true,"protocolVerified":probe["protocolVerified"],"nativeLoaderVerified":probe["nativeLoaderVerified"],"probe":probe,"targetCliLoaded":Value::Null,"reloadRequired":true})}
        Err(error)=>{
            let authentication=error.starts_with("needs-credentials:");
            let restored=if authentication{true}else{rollback(&plan,&backup,&installed).is_ok()};
            plan.state=if authentication {"needs-credentials"} else if restored {"failed-rolled-back"} else {"failed-rollback-required"}.into();
            json!({"state":plan.state,"exitCode":actual_exit,"configurationVerified":authentication,"protocolVerified":false,"targetCliLoaded":Value::Null,"error":error,"rolledBack":!authentication && restored})
        }
    };
    receipt["planId"]=json!(plan.id);receipt["source"]=json!(plan.source);receipt["tool"]=json!(plan.tool);receipt["cwd"]=json!(plan.cwd);receipt["scope"]=json!(plan.scope);receipt["backupPath"]=json!(backup);
    receipt["observedAtUnixMs"]=json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis());
    receipt["verificationScope"]=json!("last-visible-terminal-run; existing user CLI sessions and current connectivity are not verified");
    plan.receipt=Some(receipt.clone());save_plan(root,&plan)?;
    println!("Coffee CLI: {}. Existing CLI tabs may need reload/reconnect and project trust.",plan.state);
    Ok(receipt)
}

pub fn verify_plan(root:&Path,identity:&str,id:&str)->Result<Value,String> {
    let plan=read_plan(root,id)?;
    if plan.identity!=identity{return Err("Plan belongs to another conversation".into());}
    let mut view=plan_view(&plan)?;
    if let Some(receipt)=plan.receipt.clone(){
        view["receipt"]=receipt.clone();
        if let Some(object)=receipt.as_object(){for (key,value) in object{view[key]=value.clone();}}
        let matches=checked_targets(&plan).is_ok() && installed_configuration(&plan).unwrap_or(false);
        view["currentConfigurationMatches"]=json!(matches);
        if plan.state=="verified" && !matches {
            view["state"]=json!("configuration-changed");view["configurationVerified"]=json!(false);
            view["protocolVerified"]=Value::Null;view["nativeLoaderVerified"]=Value::Null;
            view["evidence"]=json!("Current project configuration no longer matches the installation. The unchanged receipt describes the historical terminal run.");
        }
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->PathBuf{let path=std::env::temp_dir().join(format!("coffee-capabilities-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&path).unwrap();dunce::canonicalize(path).unwrap()}
    fn mcp_evidence()->Value{json!({"kind":"mcp","source":"io.github.coffee/fixture","server":{"remotes":[{"type":"streamable-http","url":"https://fixture.example/mcp"}]}})}
    fn skill_evidence()->Value{json!({"kind":"skill","source":"vercel-labs/skills","name":"fixture","commit":"0123456789012345678901234567890123456789","installSource":"https://github.com/vercel-labs/skills/tree/0123456789012345678901234567890123456789"})}
    fn init()->Value{json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1.0"}})}
    fn tools()->Value{json!({"tools":[{"name":"fixture_read","inputSchema":{"type":"object","properties":{}}}]})}

    #[test]
    fn official_catalog_results_are_not_trust_or_install_proof(){
        let skills=normalize_search("skill",&json!({"skills":[{"name":"good","source":"owner/repo"},{"name":"--bad","source":"https://attacker.example/repo"}]})).unwrap();
        assert_eq!(skills["results"].as_array().unwrap().len(),1);assert_eq!(skills["results"][0]["detailsRequired"],true);
        let mcp=normalize_search("mcp",&json!({"servers":[{"server":{"name":"io.test/active"},"_meta":{"io.modelcontextprotocol.registry/official":{"status":"active"}}},{"server":{"name":"io.test/deleted"},"_meta":{"io.modelcontextprotocol.registry/official":{"status":"deleted"}}}]})).unwrap();
        assert_eq!(mcp["results"].as_array().unwrap().len(),1);assert!(repository("../repo").is_err());
    }

    #[test]
    fn skill_frontmatter_is_validated_before_install(){
        assert_eq!(skill_metadata("---\nname: fixture\ndescription: >\n  Useful first line.\n  More detail.\n---\nDo the work.").unwrap(),("fixture".into(),"Useful first line. More detail.".into()));
        assert!(skill_metadata("---\nname: ../escape\ndescription: test\n---\nbody").is_err());
        assert!(skill_metadata("---\nname: fixture\ndescription: test\n---evil\nbody").is_err());
        assert!(skill_metadata("---\nname: fixture\ndescription: test\n---\n").is_err());
    }

    #[test]
    fn credentials_unknown_runtime_and_shell_metacharacters_are_not_invented(){
        assert!(mcp_spec(&json!({"remotes":[{"type":"streamable-http","url":"https://publisher.example/mcp","headers":[{"name":"Authorization","isRequired":true,"isSecret":true,"value":"Bearer {api_key}"}]}]})).unwrap_err().starts_with("needs-credentials:"));
        assert!(mcp_spec(&json!({"packages":[{"registryType":"npm","identifier":"--unsafe","version":"1.0.0","transport":{"type":"stdio"}}]})).is_err());
        assert!(mcp_spec(&json!({"packages":[{"registryType":"npm","identifier":"safe-package","version":"1.0.0","transport":{"type":"stdio"},"packageArguments":[{"type":"positional","value":"x & execute-other"}]}]})).is_err());
        let spec=mcp_spec(&json!({"packages":[{"registryType":"npm","identifier":"@publisher/server","version":"1.0.0","transport":{"type":"stdio"}}]})).unwrap();
        assert_eq!(spec["args"],json!(["--yes","@publisher/server@1.0.0"]));
    }

    #[test]
    fn project_configuration_preserves_unrelated_settings_and_refuses_overwrite(){
        let original="# Keep this comment\nmodel = 'existing-model'\n[mcp_servers.existing]\ncommand = 'existing-server'\n";
        let server=json!({"type":"http","url":"https://publisher.example/mcp","headers":{}});
        let changed=configuration_text("codex",Some(original),"coffee-new",&server).unwrap();
        assert!(changed.starts_with(original));let parsed:toml::Value=toml::from_str(&changed).unwrap();
        assert_eq!(parsed["mcp_servers"]["existing"]["command"].as_str(),Some("existing-server"));
        assert_eq!(parsed["mcp_servers"]["coffee-new"]["url"].as_str(),Some("https://publisher.example/mcp"));
        assert!(configuration_text("codex",Some(&changed),"coffee-new",&server).is_err());
        let json=configuration_text("claude",Some(r#"{"unrelated":42,"mcpServers":{"existing":{"command":"old"}}}"#),"coffee-new",&server).unwrap();
        let parsed:Value=serde_json::from_str(&json).unwrap();assert_eq!(parsed["unrelated"],42);assert_eq!(parsed["mcpServers"]["existing"]["command"],"old");
        assert!(configuration_text("claude",Some("not-json"),"coffee-new",&server).is_err());
    }

    #[tokio::test]
    async fn relative_project_directory_is_rejected_before_network_or_mutation(){
        let root=fixture();let error=prepare_plan(&root,"owner","claude","relative-project","skill","vercel-labs/skills","find-skills").await.unwrap_err();
        assert!(error.contains("absolute project directory"));assert!(!root.join("capability-plans").exists());fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn pending_identity_stale_config_and_replay_are_enforced(){
        let root=fixture();let project=root.join("project");fs::create_dir_all(&project).unwrap();
        let view=prepare_from_evidence(&root,"owner","claude",&project,"mcp",mcp_evidence()).unwrap();let id=view["planId"].as_str().unwrap();
        assert!(!project.join(".mcp.json").exists());assert!(apply_plan(&root,id).await.is_err());
        assert!(approve_plan(&root,"other",id).is_err());assert!(verify_plan(&root,"other",id).is_err());
        assert_eq!(verify_plan(&root,"owner",id).unwrap()["state"],"pending-confirmation");
        approve_plan(&root,"owner",id).unwrap();assert!(approve_plan(&root,"owner",id).is_err());
        fs::write(project.join(".mcp.json"),"{\"mcpServers\":{}}").unwrap();
        assert!(apply_plan(&root,id).await.unwrap_err().contains("changed after"));
        let failed=verify_plan(&root,"owner",id).unwrap();assert_eq!(failed["state"],"failed-before-install");assert!(failed["receipt"]["error"].as_str().unwrap().contains("changed after"));
        let before=failed["receipt"].clone();assert!(apply_plan(&root,id).await.is_err());assert_eq!(verify_plan(&root,"owner",id).unwrap()["receipt"],before);
        let mut plan=load_plan(&root,id).unwrap();plan.id=uuid::Uuid::new_v4().to_string();fs::write(plan_path(&root,id).unwrap(),serde_json::to_vec(&plan).unwrap()).unwrap();
        assert!(load_plan(&root,id).unwrap_err().contains("saved identity"));fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_plan_targets_only_selected_project_agent(){
        let root=fixture();let project=root.join("project");fs::create_dir_all(&project).unwrap();
        let claude=prepare_from_evidence(&root,"owner","claude",&project,"skill",skill_evidence()).unwrap();
        let codex=prepare_from_evidence(&root,"owner","codex",&project,"skill",skill_evidence()).unwrap();
        assert_eq!(PathBuf::from(claude["targetPaths"][0].as_str().unwrap()),project.join(".claude").join("skills").join("fixture"));
        assert_eq!(PathBuf::from(codex["targetPaths"][0].as_str().unwrap()),project.join(".agents").join("skills").join("fixture"));
        assert!(!claude["installArgv"].as_array().unwrap().iter().any(|arg|arg=="--global" || arg=="*"));
        assert_eq!(claude["installArgv"][2],"skills@1.7.2");fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn protocol_success_requires_server_identity_supported_version_and_valid_tools(){
        assert_eq!(probe_result(init(),tools()).unwrap()["protocolVerified"],true);
        let mut invalid=init();invalid["protocolVersion"]=json!("unrecognized-version");assert!(probe_result(invalid,tools()).is_err());
        let mut invalid=init();invalid["serverInfo"]["version"]=Value::Null;assert!(probe_result(invalid,tools()).is_err());
        assert!(probe_result(init(),json!({"tools":[{"name":"","inputSchema":{"type":"object"}}]})).is_err());
        assert!(probe_result(init(),json!({"tools":[{"name":"broken"}]})).is_err());
    }

    fn mock_http(responses:Vec<(u16,String,bool)>) -> (String,std::thread::JoinHandle<Vec<String>>) {
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let url=format!("http://{}/mcp",listener.local_addr().unwrap());
        let thread=std::thread::spawn(move||{let mut requests=Vec::new();let mut workers=Vec::new();for (status,body,sse) in responses{let (mut stream,_)=listener.accept().unwrap();stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();let mut reader=BufReader::new(stream.try_clone().unwrap());let mut headers=String::new();let mut length=0;loop{let mut line=String::new();reader.read_line(&mut line).unwrap();if line.to_ascii_lowercase().starts_with("content-length:"){length=line.split_once(':').unwrap().1.trim().parse().unwrap();}headers.push_str(&line);if line=="\r\n"{break;}}let mut payload=vec![0;length];reader.read_exact(&mut payload).unwrap();requests.push(format!("{headers}{}",String::from_utf8(payload).unwrap()));
            if sse{write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nMcp-Session-Id: fixture-session\r\nConnection: close\r\n\r\n").unwrap();for part in body.as_bytes().chunks(7){write!(stream,"{:X}\r\n",part.len()).unwrap();stream.write_all(part).unwrap();write!(stream,"\r\n").unwrap();stream.flush().unwrap();}workers.push(std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(2));let _=write!(stream,"0\r\n\r\n");}));}
            else{write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nMcp-Session-Id: fixture-session\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();}
        }for worker in workers{worker.join().unwrap();}requests});(url,thread)
    }

    #[tokio::test]
    async fn http_protocol_uses_negotiated_version_and_returns_before_sse_closes(){
        let initialize=json!({"jsonrpc":"2.0","id":1,"result":init()}).to_string();let list=json!({"jsonrpc":"2.0","id":2,"result":tools()}).to_string();
        let (url,thread)=mock_http(vec![(200,format!("event: message\ndata: {initialize}\n\n"),true),(202,String::new(),false),(200,format!("event: message\ndata: {list}\n\n"),true),(204,String::new(),false)]);
        let start=Instant::now();let result=probe_http(&json!({"url":url,"headers":{}})).await.unwrap();assert!(start.elapsed()<Duration::from_secs(1),"Must return before a live SSE stream closes");assert_eq!(result["tools"],json!(["fixture_read"]));assert!(result["targetCliLoaded"].is_null());
        let requests=thread.join().unwrap();assert!(requests[1].to_ascii_lowercase().contains("mcp-protocol-version: 2025-06-18"));assert!(requests[2].to_ascii_lowercase().contains("mcp-session-id: fixture-session"));
    }

    #[tokio::test]
    async fn failed_protocol_restores_original_configuration_and_run_is_one_shot(){
        let root=fixture();let project=root.join("project");fs::create_dir_all(&project).unwrap();let original="{\"mcpServers\":{\"existing\":{\"command\":\"old\"}},\"keep\":true}";fs::write(project.join(".mcp.json"),original).unwrap();
        let view=prepare_from_evidence(&root,"owner","claude",&project,"mcp",mcp_evidence()).unwrap();let id=view["planId"].as_str().unwrap();
        let (url,thread)=mock_http(vec![(200,json!({"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"fixture failure"}}).to_string(),false)]);
        let mut plan=load_plan(&root,id).unwrap();plan.server["url"]=json!(url);save_plan(&root,&plan).unwrap();approve_plan(&root,"owner",id).unwrap();
        let receipt=apply_plan(&root,id).await.unwrap();assert_eq!(receipt["state"],"failed-rolled-back");assert_eq!(receipt["exitCode"],0);assert_eq!(fs::read_to_string(project.join(".mcp.json")).unwrap(),original);
        assert!(apply_plan(&root,id).await.is_err());thread.join().unwrap();fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn removed_configuration_invalidates_current_state_but_keeps_historical_receipt(){
        let root=fixture();let project=root.join("project");fs::create_dir_all(&project).unwrap();
        let view=prepare_from_evidence(&root,"owner","claude",&project,"mcp",mcp_evidence()).unwrap();let id=view["planId"].as_str().unwrap();
        let (url,thread)=mock_http(vec![(200,json!({"jsonrpc":"2.0","id":1,"result":init()}).to_string(),false),(202,String::new(),false),(200,json!({"jsonrpc":"2.0","id":2,"result":tools()}).to_string(),false),(204,String::new(),false)]);
        let mut plan=load_plan(&root,id).unwrap();plan.server["url"]=json!(url);save_plan(&root,&plan).unwrap();approve_plan(&root,"owner",id).unwrap();
        let receipt=apply_plan(&root,id).await.unwrap();assert_eq!(receipt["state"],"verified");assert_eq!(receipt["protocolVerified"],true);assert_eq!(verify_plan(&root,"owner",id).unwrap()["currentConfigurationMatches"],true);
        fs::remove_file(project.join(".mcp.json")).unwrap();let changed=verify_plan(&root,"owner",id).unwrap();assert_eq!(changed["state"],"configuration-changed");assert_eq!(changed["configurationVerified"],false);assert!(changed["protocolVerified"].is_null());assert_eq!(changed["receipt"],receipt);
        assert!(apply_plan(&root,id).await.is_err());assert_eq!(verify_plan(&root,"owner",id).unwrap()["receipt"],receipt);thread.join().unwrap();fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rollback_preserves_concurrent_user_edits(){
        let root=fixture();let project=root.join("project");fs::create_dir_all(&project).unwrap();let view=prepare_from_evidence(&root,"owner","claude",&project,"mcp",mcp_evidence()).unwrap();let plan=load_plan(&root,view["planId"].as_str().unwrap()).unwrap();
        let path=&plan.target_paths[0];fs::write(path,"installed content").unwrap();let installed=vec![fingerprint(path).unwrap()];fs::write(path,"user's concurrent edit").unwrap();
        assert!(rollback(&plan,&root.join("backup"),&installed).is_err());assert_eq!(fs::read_to_string(path).unwrap(),"user's concurrent edit");fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    #[ignore="Read-only official endpoint smoke; opt in when network is available"]
    async fn official_sources_read_only_smoke(){
        let skills=discover("skill","find-skills").await.unwrap();assert!(!skills["results"].as_array().unwrap().is_empty());
        let skill=details("skill","vercel-labs/skills","find-skills").await.unwrap();assert_eq!(skill["name"],"find-skills");assert_eq!(skill["commit"].as_str().unwrap().len(),40);
        let mcp=discover("mcp","github").await.unwrap();let source=mcp["results"][0]["source"].as_str().unwrap();assert_eq!(details("mcp",source,source).await.unwrap()["source"],source);
    }
}
