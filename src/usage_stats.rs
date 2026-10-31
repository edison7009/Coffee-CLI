//! Local usage ledger. Only timestamps, identifiers and numeric counters are stored.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

static SCAN_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    reasoning: Option<u64>,
}

impl Tokens {
    fn dsh(v: &Value) -> Self {
        Self {
            input: number(v, "inputTokens"),
            output: number(v, "outputTokens"),
            cache_read: number(v, "cacheReadTokens"),
            cache_write: number(v, "cacheWriteTokens"),
            reasoning: None,
        }
    }

    fn claude(v: &Value) -> Self {
        Self {
            input: number(v, "input_tokens"),
            output: number(v, "output_tokens"),
            cache_read: number(v, "cache_read_input_tokens"),
            cache_write: number(v, "cache_creation_input_tokens"),
            reasoning: None,
        }
    }
    fn codex(v: &Value) -> Self {
        Self {
            input: number(v, "input_tokens"),
            output: number(v, "output_tokens"),
            cache_read: number(v, "cached_input_tokens"),
            cache_write: None,
            reasoning: number(v, "reasoning_output_tokens"),
        }
    }
    fn delta(&self, previous: &Self) -> Self {
        fn sub(a: Option<u64>, b: Option<u64>) -> Option<u64> {
            a.map(|n| n.saturating_sub(b.unwrap_or(0)))
        }
        Self {
            input: sub(self.input, previous.input),
            output: sub(self.output, previous.output),
            cache_read: sub(self.cache_read, previous.cache_read),
            cache_write: sub(self.cache_write, previous.cache_write),
            reasoning: sub(self.reasoning, previous.reasoning),
        }
    }
    fn any(&self) -> bool {
        self.input.is_some()
            || self.output.is_some()
            || self.cache_read.is_some()
            || self.cache_write.is_some()
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Parser {
    session: String,
    project: String,
    model: String,
    turn: String,
    previous: Option<Tokens>,
}

fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_owned()
}
fn number(v: &Value, key: &str) -> Option<u64> {
    v[key].as_u64()
}
fn fingerprint(value: impl Hash) -> String {
    let mut h = DefaultHasher::new();
    value.hash(&mut h);
    format!("{:x}", h.finish())
}

fn schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, offset INTEGER NOT NULL, modified TEXT NOT NULL, parser TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(file TEXT NOT NULL, key TEXT NOT NULL, tool TEXT NOT NULL, session TEXT NOT NULL, project TEXT NOT NULL, model TEXT NOT NULL, stamp TEXT NOT NULL, kind TEXT NOT NULL, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER, PRIMARY KEY(file,key));
        CREATE INDEX IF NOT EXISTS events_stamp ON events(stamp);
        CREATE INDEX IF NOT EXISTS events_key ON events(key);")?;
    let version: u32 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != 1 {
        db.execute_batch("DELETE FROM files; DELETE FROM events; PRAGMA user_version=1;")?;
    }
    Ok(())
}

fn codex_prompt(db: &Connection, file: &str, p: &Parser, stamp: &str) -> rusqlite::Result<()> {
    let key = if p.turn.is_empty() {
        fingerprint((&p.session, stamp))
    } else {
        p.turn.clone()
    };
    record(
        db,
        file,
        &format!("codex:prompt:{key}"),
        "codex",
        p,
        stamp,
        "prompt",
        Tokens::default(),
    )
}

fn record(
    db: &Connection,
    file: &str,
    key: &str,
    tool: &str,
    parser: &Parser,
    stamp: &str,
    kind: &str,
    tokens: Tokens,
) -> rusqlite::Result<()> {
    if stamp.is_empty() {
        return Ok(());
    }
    db.execute("INSERT INTO events VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
        ON CONFLICT(file,key) DO UPDATE SET input=COALESCE(MAX(COALESCE(events.input,0),excluded.input),events.input), output=COALESCE(MAX(COALESCE(events.output,0),excluded.output),events.output), cache_read=COALESCE(MAX(COALESCE(events.cache_read,0),excluded.cache_read),events.cache_read), cache_write=COALESCE(MAX(COALESCE(events.cache_write,0),excluded.cache_write),events.cache_write), reasoning=COALESCE(MAX(COALESCE(events.reasoning,0),excluded.reasoning),events.reasoning)",
        params![file,key,tool,parser.session,parser.project,parser.model,stamp,kind,tokens.input,tokens.output,tokens.cache_read,tokens.cache_write,tokens.reasoning])?;
    Ok(())
}

fn parse_line(
    db: &Connection,
    file: &str,
    tool: &str,
    p: &mut Parser,
    v: &Value,
    offset: u64,
) -> rusqlite::Result<()> {
    let stamp = text(v, "timestamp");
    if tool == "claude" {
        if let Some(id) = v["sessionId"].as_str() {
            p.session = id.into();
        }
        if let Some(cwd) = v["cwd"].as_str() {
            p.project = cwd.replace('\\', "/");
        }
        let message = &v["message"];
        if v["type"] == "user" && v["isMeta"] != true && v["isCompactSummary"] != true {
            let content = &message["content"];
            let notification = content.as_str().or_else(|| content[0]["text"].as_str()).is_some_and(|text| text.trim_start().starts_with("<task-notification>"));
            let prompt = !notification && (content.is_string()
                || content.as_array().is_some_and(|a| {
                    a.iter()
                        .any(|c| c["type"] == "text" || c["type"] == "image")
                }));
            if prompt {
                let id = v["uuid"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| fingerprint((&p.session, &stamp, offset)));
                record(
                    db,
                    file,
                    &format!("claude:prompt:{id}"),
                    tool,
                    p,
                    &stamp,
                    "prompt",
                    Tokens::default(),
                )?;
            }
        } else if v["type"] == "assistant" {
            p.model = text(message, "model");
            if p.model == "<synthetic>" {
                return Ok(());
            }
            let usage = Tokens::claude(&message["usage"]);
            if usage.any() {
                let id = message["id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| fingerprint((&p.session, &stamp, offset)));
                record(
                    db,
                    file,
                    &format!("claude:usage:{id}"),
                    tool,
                    p,
                    &stamp,
                    "usage",
                    usage,
                )?;
            }
        }
    } else {
        let data = &v["payload"];
        if v["type"] == "session_meta" {
            if let Some(id) = data["id"].as_str() {
                p.session = id.into();
            }
            p.project = text(data, "cwd").replace('\\', "/");
        } else if v["type"] == "turn_context" {
            if let Some(model) = data["model"].as_str() {
                p.model = model.into();
            }
            if let Some(id) = data["turn_id"].as_str() {
                p.turn = id.into();
            }
        } else if v["type"] == "response_item"
            && data["type"] == "message"
            && data["role"] == "user"
        {
            codex_prompt(db, file, p, &stamp)?;
        } else if v["type"] == "event_msg" {
            match data["type"].as_str().unwrap_or("") {
                "task_started" => p.turn = text(data, "turn_id"),
                "user_message" => {
                    codex_prompt(db, file, p, &stamp)?;
                }
                "token_count" => {
                    let info = &data["info"];
                    if info.is_null() {
                        return Ok(());
                    }
                    let total = Tokens::codex(&info["total_token_usage"]);
                    let last = Tokens::codex(&info["last_token_usage"]);
                    if !total.any() && !last.any() {
                        return Ok(());
                    }
                    if total.any() && p.previous.as_ref() == Some(&total) {
                        return Ok(());
                    }
                    let mut usage = match &p.previous {
                        Some(prev)
                            if total.input.unwrap_or(0) >= prev.input.unwrap_or(0)
                                && total.output.unwrap_or(0) >= prev.output.unwrap_or(0) =>
                        {
                            total.delta(prev)
                        }
                        _ if last.any() => last,
                        _ => total.clone(),
                    };
                    // Cached input is part of the native input counter; reasoning is part of output.
                    usage.input = usage
                        .input
                        .map(|n| n.saturating_sub(usage.cache_read.unwrap_or(0)));
                    let key = fingerprint((
                        if p.turn.is_empty() {
                            &p.session
                        } else {
                            &p.turn
                        },
                        &stamp,
                        serde_json::to_string(&total).unwrap_or_default(),
                    ));
                    record(
                        db,
                        file,
                        &format!("codex:usage:{key}"),
                        tool,
                        p,
                        &stamp,
                        "usage",
                        usage,
                    )?;
                    if total.any() {
                        p.previous = Some(total);
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn import_file(db: &mut Connection, path: &Path, tool: &str) -> Result<(), String> {
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    let file = path.to_string_lossy().to_string();
    let modified = format!("{:?}", metadata.modified().map_err(|e| e.to_string())?);
    let cached: Option<(u64, String, String)> = db
        .query_row(
            "SELECT offset,modified,parser FROM files WHERE path=?",
            [&file],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (mut offset, old_modified, saved) = cached.unwrap_or_default();
    if metadata.len() == offset && modified == old_modified {
        return Ok(());
    }
    let reset = metadata.len() <= offset;
    if reset {
        offset = 0;
    }
    let mut parser: Parser = if offset == 0 {
        Parser::default()
    } else {
        serde_json::from_str(&saved).unwrap_or_default()
    };
    if parser.session.is_empty() {
        parser.session = file.clone();
    }
    let mut source = std::fs::File::open(path).map_err(|e| e.to_string())?;
    source
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(source);
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if reset {
        tx.execute("DELETE FROM events WHERE file=?", [&file])
            .map_err(|e| e.to_string())?;
    }
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if read == 0 || !line.ends_with('\n') {
            break;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            parse_line(&tx, &file, tool, &mut parser, &v, offset).map_err(|e| e.to_string())?;
        }
        offset += read as u64;
    }
    tx.execute(
        "INSERT OR REPLACE INTO files VALUES (?1,?2,?3,?4)",
        params![
            file,
            offset,
            modified,
            serde_json::to_string(&parser).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// DeepSeek Harness logs are compressed, so a changed log is read whole; event keys keep that idempotent.
fn import_dsh(db: &mut Connection, path: &Path) -> Result<(), String> {
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    let file = path.to_string_lossy().to_string();
    let modified = format!("{:?}", metadata.modified().map_err(|e| e.to_string())?);
    let cached: Option<(u64, String)> = db
        .query_row("SELECT offset,modified FROM files WHERE path=?", [&file], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    if cached == Some((metadata.len(), modified.clone())) {
        return Ok(());
    }
    let rows = crate::dsh_session::read_log(path)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let mut parser = Parser { session: file.clone(), ..Parser::default() };
    for row in &rows {
        parse_dsh(&tx, &file, &mut parser, row).map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO files VALUES (?1,?2,?3,?4)",
        params![file, metadata.len(), modified, serde_json::to_string(&parser).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn parse_dsh(db: &Connection, file: &str, p: &mut Parser, v: &Value) -> rusqlite::Result<()> {
    let data = &v["data"];
    let stamp = v["time"]
        .as_i64()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let seq = v["seq"].as_u64().unwrap_or(0);
    match v["type"].as_str() {
        Some("session") => {
            p.session = text(v, "id");
            p.project = text(v, "cwd").replace('\\', "/");
        }
        Some("model/selection") => p.model = text(data, "model"),
        Some("user/message") if data["source"]["kind"] == "user" => {
            // Message ids survive into forked Sessions' logs, so copied history counts once.
            let id = data["id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("{}:{seq}", p.session));
            record(db, file, &format!("dsh:prompt:{id}"), "dsh", p, &stamp, "prompt", Tokens::default())?;
        }
        Some("assistant/message") => {
            let usage = Tokens::dsh(&data["usage"]);
            if usage.any() {
                let message = &data["message"];
                if let Some(model) = message["source"]["model"].as_str() { p.model = model.into(); }
                let id = message["id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("{}:{seq}", p.session));
                record(db, file, &format!("dsh:usage:{id}"), "dsh", p, &stamp, "usage", usage)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn collect(root: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() && depth > 0 {
            collect(&path, depth - 1, out);
        } else if kind.is_file() && path.extension().is_some_and(|v| v == "jsonl") {
            out.push(path);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    tool: String,
    files: usize,
    available: bool,
    errors: usize,
}

fn sync(db: &mut Connection, home: &Path) -> Vec<Source> {
    let (dsh_root, dsh_logs) = crate::dsh_session::usage_logs();
    let dsh_errors = dsh_logs.iter().filter(|path| import_dsh(db, path).is_err()).count();
    let dsh = Source { tool: "dsh".into(), files: dsh_logs.len(), available: dsh_root.is_dir(), errors: dsh_errors };
    ["claude", "codex"]
        .into_iter()
        .map(|tool| {
            let base = std::env::var_os(if tool == "claude" {
                "CLAUDE_CONFIG_DIR"
            } else {
                "CODEX_HOME"
            })
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(format!(".{tool}")));
            let root = crate::tool_config::history_path_for(
                tool,
                base.join(if tool == "claude" {
                    "projects"
                } else {
                    "sessions"
                }),
            );
            let mut files = Vec::new();
            collect(&root, 4, &mut files);
            if tool == "codex" && root == base.join("sessions") {
                collect(&base.join("archived_sessions"), 4, &mut files);
            }
            let errors = files
                .iter()
                .filter(|path| import_file(db, path, tool).is_err())
                .count();
            Source {
                tool: tool.into(),
                files: files.len(),
                available: root.is_dir(),
                errors,
            }
        })
        .chain(std::iter::once(dsh))
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    from: i64,
    to: i64,
    tool: Option<String>,
    project: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    sessions: u64,
    prompts: u64,
    calls: u64,
    days: u64,
    input: Option<u64>,
    output: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    reasoning: Option<u64>,
    tokens: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    key: String,
    summary: Summary,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    summary: Summary,
    daily: Vec<Group>,
    models: Vec<Group>,
    projects: Vec<String>,
    sources: Vec<Source>,
}

const DEDUP: &str = "WITH unique_events AS (SELECT key,tool,session,project,model,stamp,kind,MAX(input) input,MAX(output) output,MAX(cache_read) cache_read,MAX(cache_write) cache_write,MAX(reasoning) reasoning FROM events GROUP BY key), selected AS (SELECT e.* FROM unique_events e WHERE unixepoch(stamp)>=?1 AND unixepoch(stamp)<?2 AND (?3='' OR tool=?3) AND (?4='' OR project=?4)) ";
const AGG: &str = "COUNT(DISTINCT tool||':'||session),SUM(kind='prompt'),SUM(kind='usage'),COUNT(DISTINCT date(stamp,'localtime')),SUM(input),SUM(output),SUM(cache_read),SUM(cache_write),SUM(reasoning),SUM(CASE WHEN input IS NOT NULL OR output IS NOT NULL OR cache_read IS NOT NULL OR cache_write IS NOT NULL THEN COALESCE(input,0)+COALESCE(output,0)+COALESCE(cache_read,0)+COALESCE(cache_write,0) END)";

fn summary(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<Summary> {
    Ok(Summary {
        sessions: row.get(offset)?,
        prompts: row.get::<_, Option<u64>>(offset + 1)?.unwrap_or(0),
        calls: row.get::<_, Option<u64>>(offset + 2)?.unwrap_or(0),
        days: row.get(offset + 3)?,
        input: row.get(offset + 4)?,
        output: row.get(offset + 5)?,
        cache_read: row.get(offset + 6)?,
        cache_write: row.get(offset + 7)?,
        reasoning: row.get(offset + 8)?,
        tokens: row.get(offset + 9)?,
    })
}

fn report(db: &Connection, q: Query, sources: Vec<Source>) -> Result<Report, String> {
    let tool = q.tool.unwrap_or_default();
    let project = q.project.unwrap_or_default();
    let args = params![q.from, q.to, tool, project];
    let total = db
        .query_row(&format!("{DEDUP}SELECT {AGG} FROM selected"), args, |r| {
            summary(r, 0)
        })
        .map_err(|e| e.to_string())?;
    let groups = |expression: &str| -> rusqlite::Result<Vec<Group>> {
        db.prepare(&format!("{DEDUP}SELECT {expression},{AGG} FROM selected GROUP BY {expression} ORDER BY {expression}"))?
            .query_map(args,|r| Ok(Group { key:r.get(0)?,summary:summary(r,1)? }))?.collect()
    };
    let daily = groups("date(stamp,'localtime')").map_err(|e| e.to_string())?;
    let models = groups("model")
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|g| g.summary.calls > 0)
        .collect();
    let projects = db
        .prepare("SELECT DISTINCT project FROM events WHERE project<>'' ORDER BY project")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|e| e.to_string())?;
    Ok(Report {
        summary: total,
        daily,
        models,
        projects,
        sources,
    })
}

fn database() -> Result<(Connection, PathBuf), String> {
    let home = dirs::home_dir().ok_or("Home directory is unavailable")?;
    let directory = home.join(".coffee-cli/cache");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let db = Connection::open(directory.join("usage-v1.sqlite")).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    schema(&db).map_err(|e| e.to_string())?;
    Ok((db, home))
}

#[tauri::command]
pub async fn get_usage_statistics(query: Query) -> Result<Report, String> {
    if query.from < 0
        || query.to <= query.from
        || !matches!(
            query.tool.as_deref(),
            None | Some("") | Some("claude") | Some("codex") | Some("dsh")
        )
    {
        return Err("Invalid usage range or tool".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SCAN_LOCK.lock().map_err(|e| e.to_string())?;
        let (mut db, home) = database()?;
        let sources = sync(&mut db, &home);
        report(&db, query, sources)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        schema(&c).unwrap();
        c
    }
    fn totals(c: &Connection) -> Report {
        report(
            c,
            Query {
                from: 0,
                to: 4102444800,
                tool: None,
                project: None,
            },
            vec![],
        )
        .unwrap()
    }
    #[test]
    fn dsh_logs_count_user_prompts_and_assistant_usage_only() {
        let c = db();
        let mut p = Parser::default();
        for row in [
            json!({"type":"session","id":"session-1","cwd":"D:\\repo"}),
            json!({"type":"model/selection","seq":1,"time":1793432653000i64,"data":{"model":"deepseek-flash"}}),
            json!({"type":"user/message","seq":2,"time":1793432653000i64,"data":{"source":{"kind":"user"}}}),
            json!({"type":"user/message","seq":3,"time":1793432653000i64,"data":{"source":{"kind":"runtime"}}}),
            json!({"type":"assistant/message","seq":4,"time":1793432654000i64,"data":{"message":{"id":"reply","source":{"kind":"model","model":"deepseek-v4-pro"}},"usage":{"inputTokens":490,"outputTokens":167,"cacheReadTokens":5760,"cacheWriteTokens":0,"totalTokens":6417}}}),
            json!({"type":"assistant/message","seq":5,"time":1793432654000i64,"data":{}}),
        ] {
            parse_dsh(&c, "fixture", &mut p, &row).unwrap();
        }
        let report = totals(&c);
        assert_eq!((report.summary.prompts, report.summary.calls, report.summary.input, report.summary.cache_read), (1, 1, Some(490), Some(5760)));
        assert_eq!((p.project.as_str(), p.model.as_str()), ("D:/repo", "deepseek-v4-pro"));
    }

    fn line(c: &Connection, p: &mut Parser, tool: &str, v: Value) {
        parse_line(c, "fixture", tool, p, &v, 1).unwrap();
    }

    #[test]
    fn claude_blocks_and_tool_results_do_not_inflate_counts() {
        let c = db();
        let mut p = Parser::default();
        line(
            &c,
            &mut p,
            "claude",
            json!({"type":"user","uuid":"u","sessionId":"s","cwd":"D:\\Test","timestamp":"2026-10-24T08:00:00Z","message":{"content":[{"type":"text","text":"private prompt"}]}}),
        );
        line(
            &c,
            &mut p,
            "claude",
            json!({"type":"user","uuid":"t","timestamp":"2026-10-24T08:01:00Z","message":{"content":[{"type":"tool_result","content":"private result"}]}}),
        );
        for content in [json!("<task-notification>\nWorker result\n</task-notification>"), json!([{"type":"text","text":"<task-notification>\nWorker result\n</task-notification>"}])] {
            line(&c, &mut p, "claude", json!({"type":"user","uuid":"automatic-result","timestamp":"2026-10-24T08:01:30Z","message":{"content":content}}));
        }
        for output in [4, 12, 8] {
            line(
                &c,
                &mut p,
                "claude",
                json!({"type":"assistant","timestamp":"2026-10-24T08:02:00Z","message":{"id":"m","model":"fixture-model","usage":{"input_tokens":10,"output_tokens":output,"cache_read_input_tokens":30,"cache_creation_input_tokens":5}}}),
            );
        }
        let r = totals(&c);
        assert_eq!(
            (r.summary.sessions, r.summary.prompts, r.summary.calls),
            (1, 1, 1)
        );
        assert_eq!(r.summary.tokens, Some(57));
        assert_eq!(r.summary.reasoning, None);
        assert_eq!(r.projects, vec!["D:/Test"]);
        let contents: String = c
            .query_row("SELECT group_concat(key) FROM events", [], |r| r.get(0))
            .unwrap();
        assert!(!contents.contains("private"));
    }

    #[test]
    fn codex_cumulative_cache_and_reasoning_are_not_double_counted() {
        let c = db();
        let mut p = Parser::default();
        line(
            &c,
            &mut p,
            "codex",
            json!({"type":"session_meta","payload":{"id":"s","cwd":"D:/Test"}}),
        );
        line(
            &c,
            &mut p,
            "codex",
            json!({"type":"turn_context","payload":{"model":"fixture-model","turn_id":"turn"}}),
        );
        for (stamp, input, output, cache, reasoning) in [
            ("08:00:00", 100, 20, 40, 10),
            ("08:00:00", 100, 20, 40, 10),
            ("08:01:00", 200, 60, 90, 30),
        ] {
            line(
                &c,
                &mut p,
                "codex",
                json!({"type":"event_msg","timestamp":format!("2026-10-24T{stamp}Z"),"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":cache,"reasoning_output_tokens":reasoning}}}}),
            );
        }
        let r = totals(&c);
        assert_eq!(r.summary.calls, 2);
        assert_eq!(r.summary.input, Some(110));
        assert_eq!(r.summary.cache_read, Some(90));
        assert_eq!(r.summary.reasoning, Some(30));
        assert_eq!(r.summary.tokens, Some(260));
    }

    #[test]
    fn codex_user_message_shapes_share_one_prompt_per_turn() {
        let c = db();
        let mut p = Parser {
            session: "s".into(),
            ..Default::default()
        };
        line(
            &c,
            &mut p,
            "codex",
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}),
        );
        for role in ["user", "user", "assistant"] {
            line(
                &c,
                &mut p,
                "codex",
                json!({"type":"response_item","timestamp":"2026-10-24T00:00:00Z","payload":{"type":"message","role":role,"id":"message","content":[]}}),
            );
        }
        line(
            &c,
            &mut p,
            "codex",
            json!({"type":"event_msg","timestamp":"2026-10-24T00:00:01Z","payload":{"type":"user_message","message":"private"}}),
        );
        assert_eq!(totals(&c).summary.prompts, 1);
        line(
            &c,
            &mut p,
            "codex",
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"two"}}),
        );
        line(
            &c,
            &mut p,
            "codex",
            json!({"type":"response_item","timestamp":"2026-10-24T00:01:00Z","payload":{"type":"message","role":"user","content":[]}}),
        );
        assert_eq!(totals(&c).summary.prompts, 2);
    }

    #[test]
    fn copied_logs_deduplicate_and_tool_filters_stay_independent() {
        let c = db();
        let p = Parser {
            session: "s".into(),
            model: "model-a".into(),
            ..Default::default()
        };
        for file in ["a", "b"] {
            record(
                &c,
                file,
                "same",
                "claude",
                &p,
                "2026-10-24T00:00:00Z",
                "usage",
                Tokens {
                    input: Some(100),
                    output: Some(20),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let other = Parser {
            model: "model-b".into(),
            ..p
        };
        record(
            &c,
            "c",
            "other",
            "codex",
            &other,
            "2026-10-24T00:01:00Z",
            "usage",
            Tokens {
                input: Some(20),
                ..Default::default()
            },
        )
        .unwrap();
        let r = totals(&c);
        assert_eq!(r.summary.calls, 2);
        let filtered = report(
            &c,
            Query {
                from: 0,
                to: 4102444800,
                tool: Some("codex".into()),
                project: None,
            },
            vec![],
        )
        .unwrap();
        assert_eq!(filtered.summary.calls, 1);
    }

    #[test]
    fn incremental_import_waits_for_complete_lines_and_can_resume() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("coffee-usage-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let prompt=json!({"type":"user","uuid":"u","sessionId":"s","timestamp":"2026-10-24T00:00:00Z","message":{"content":"text"}}).to_string();
        std::fs::write(&path, &prompt).unwrap();
        let mut c = db();
        import_file(&mut c, &path, "claude").unwrap();
        assert_eq!(totals(&c).summary.prompts, 0);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        import_file(&mut c, &path, "claude").unwrap();
        import_file(&mut c, &path, "claude").unwrap();
        assert_eq!(totals(&c).summary.prompts, 1);
        std::fs::write(&path, format!("{prompt}\n{prompt}\n")).unwrap();
        import_file(&mut c, &path, "claude").unwrap();
        assert_eq!(totals(&c).summary.prompts, 1);
        std::fs::write(&path, "{}\n").unwrap();
        import_file(&mut c, &path, "claude").unwrap();
        assert_eq!(totals(&c).summary.prompts, 0);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
