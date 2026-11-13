//! Official-source skill and MCP discovery for the skills panel: search the
//! catalogs, read a skill's metadata and details. Nothing here installs.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

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

#[cfg(test)]
mod tests {
    use super::*;
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


    #[tokio::test]
    #[ignore="Read-only official endpoint smoke; opt in when network is available"]
    async fn official_sources_read_only_smoke(){
        let skills=discover("skill","find-skills").await.unwrap();assert!(!skills["results"].as_array().unwrap().is_empty());
        let skill=details("skill","vercel-labs/skills","find-skills").await.unwrap();assert_eq!(skill["name"],"find-skills");assert_eq!(skill["commit"].as_str().unwrap().len(),40);
        let mcp=discover("mcp","github").await.unwrap();let source=mcp["results"][0]["source"].as_str().unwrap();assert_eq!(details("mcp",source,source).await.unwrap()["source"],source);
    }
}
