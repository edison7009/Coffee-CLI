//! Durable Agent history, bounded working context, and route-scoped memories.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::Path,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const CONTEXT_CHARS: usize = 30_000;
const MEMORY_CHARS: usize = 40_000;
const MAX_MEMORIES: usize = 200;
const MANUAL_MEMORY_CHARS: usize = 8_000;
const AUTO_MEMORY_BYTES: usize = 2_000;
const MAX_MEMORY_CHANGES: usize = 8;
const PAGE_SIZE: usize = 100;
static INITIALIZATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize)]
pub struct Message {
    pub id: i64,
    pub role: String,
    pub text: String,
    /// Tool calls the Agent made before this reply, for the chat's collapsed summary.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolUse>,
}

#[derive(Clone, Serialize)]
pub struct ToolUse {
    pub name: String,
    pub ok: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub route: String,
    pub source: String,
    pub title: String,
    pub updated_at: i64,
    pub message_count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationPage {
    pub id: String,
    pub route: String,
    pub messages: Vec<Message>,
    pub has_older: bool,
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Memory {
    pub id: String,
    pub content: String,
    pub project: String,
    pub updated_at: i64,
    pub source_conversation: Option<String>,
    pub automatic: bool,
    /// A learned procedure; `content` is its cue. Only capture attaches one, from verified tool evidence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experience: Option<Experience>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Experience {
    pub procedure: String,
    pub evidence: Vec<String>,
}

impl Experience {
    pub(crate) fn validate(&self, cue: &str) -> Result<(), String> {
        if cue.is_empty() || cue.len() > 400 || self.procedure.trim().is_empty() || self.procedure.len() > 800
            || self.evidence.is_empty() || self.evidence.len() > 3 || self.evidence.iter().any(|item| item.is_empty() || item.len() > 700) {
            return Err("Task experience exceeds its content limits".into());
        }
        if ![cue, &self.procedure].into_iter().chain(self.evidence.iter().map(String::as_str)).all(memory_text_is_safe) {
            return Err("Task experience must not contain secrets".into());
        }
        Ok(())
    }

    fn chars(&self) -> usize {
        self.procedure.chars().count() + self.evidence.iter().map(|item| item.chars().count()).sum::<usize>()
    }
}

pub(crate) fn memory_chars(memory: &Memory) -> usize {
    memory.content.chars().count() + memory.experience.as_ref().map_or(0, Experience::chars)
}

#[derive(Clone, Serialize)]
pub struct MemorySnapshot {
    pub revision: i64,
    pub manual_epoch: i64,
    pub memories: Vec<Memory>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryChange {
    pub action: String,
    pub id: Option<String>,
    pub scope: Option<String>,
    pub content: Option<String>,
    /// Backend-attached for `learn`; the model can never supply it.
    #[serde(skip)]
    pub experience: Option<Experience>,
}

pub struct Context {
    pub summary: String,
    pub messages: Vec<Message>,
}
pub struct Compaction {
    pub through: i64,
    pub input: String,
}

pub struct Store {
    db: Connection,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn source(route: &str) -> String {
    if route.starts_with("weixin-") {
        "微信"
    } else if route.starts_with("telegram-") {
        "Telegram"
    } else {
        "桌面"
    }
    .into()
}

impl Store {
    pub fn open(root: &Path) -> Result<Self, String> {
        // Changing journal mode and creating the schema must not race on first use.
        let _initialization = INITIALIZATION_LOCK
            .lock()
            .map_err(|_| "Agent storage initialization lock failed")?;
        fs::create_dir_all(root).map_err(|_| "Could not create Agent storage")?;
        let mut db = Connection::open(root.join("history.sqlite")).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY, route TEXT NOT NULL, title TEXT NOT NULL,
                updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
                summary TEXT NOT NULL DEFAULT '', summary_through INTEGER NOT NULL DEFAULT 0);
            CREATE UNIQUE INDEX IF NOT EXISTS active_route ON conversations(route) WHERE active=1;
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id),
                role TEXT NOT NULL, text TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS conversation_messages ON messages(conversation_id,id);
            CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, route TEXT NOT NULL, content TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memory_state (
                route TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, manual_epoch INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS legacy_imports (route TEXT PRIMARY KEY);")
            .map_err(|e| e.to_string())?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        let columns = {
            let mut statement = tx.prepare("PRAGMA table_info(memories)").map_err(|e| e.to_string())?;
            let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|e| e.to_string())?;
            rows.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())?
        };
        for (name, definition) in [
            ("project", "TEXT NOT NULL DEFAULT ''"),
            ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
            ("source_conversation", "TEXT"),
            ("automatic", "INTEGER NOT NULL DEFAULT 0"),
            ("experience", "TEXT"),
        ] {
            if !columns.contains(name) {
                tx.execute(&format!("ALTER TABLE memories ADD COLUMN {name} {definition}"), []).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        let mut store = Self { db };
        store.import_legacy(root)?;
        Ok(store)
    }

    fn import_legacy(&mut self, root: &Path) -> Result<(), String> {
        let directory = root.join("conversations");
        if !directory.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(directory).map_err(|_| "Could not read legacy Agent history")? {
            let path = entry
                .map_err(|_| "Could not read legacy Agent history")?
                .path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let Some(route) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            crate::agent::validate_conversation_id(route)?;
            if self
                .db
                .query_row(
                    "SELECT 1 FROM legacy_imports WHERE route=?1",
                    [route],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                continue;
            }
            let messages: Vec<Value> = serde_json::from_str(
                &fs::read_to_string(&path).map_err(|_| "Could not read legacy Agent history")?,
            )
            .map_err(|_| "Legacy Agent conversation is invalid")?;
            let tx = self
                .db
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            if tx
                .query_row(
                    "SELECT 1 FROM legacy_imports WHERE route=?1",
                    [route],
                    |_| Ok(()),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                continue;
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO conversations(id,route,title,updated_at,active) VALUES(?1,?2,'Coffee Agent',?3,?4)",
                params![id, route, path.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64).unwrap_or_else(now_ms),
                    !tx.query_row("SELECT EXISTS(SELECT 1 FROM conversations WHERE route=?1 AND active=1)", [route], |r| r.get::<_, bool>(0)).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
            for message in messages {
                let role = message["role"]
                    .as_str()
                    .filter(|r| matches!(*r, "user" | "assistant"))
                    .ok_or("Invalid legacy message role")?;
                let text = message["text"]
                    .as_str()
                    .ok_or("Invalid legacy message text")?;
                tx.execute(
                    "INSERT INTO messages(conversation_id,role,text) VALUES(?1,?2,?3)",
                    params![id, role, text],
                )
                .map_err(|e| e.to_string())?;
                if role == "user" {
                    tx.execute(
                        "UPDATE conversations SET title=?2 WHERE id=?1 AND title='Coffee Agent'",
                        params![id, title(text)],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            tx.execute("INSERT INTO legacy_imports(route) VALUES(?1)", [route])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn resolve(&mut self, id_or_route: &str) -> Result<String, String> {
        crate::agent::validate_conversation_id(id_or_route)?;
        if let Some(id) = self
            .db
            .query_row(
                "SELECT id FROM conversations WHERE id=?1",
                [id_or_route],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(id);
        }
        if id_or_route != "desktop"
            && !id_or_route.starts_with("weixin-")
            && !id_or_route.starts_with("telegram-")
        {
            return Err("Agent conversation does not exist".into());
        }
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some(id) = tx
            .query_row(
                "SELECT id FROM conversations WHERE route=?1 AND active=1",
                [id_or_route],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO conversations(id,route,title,updated_at) VALUES(?1,?2,'新对话',?3)",
            params![id, id_or_route, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn route(&self, id: &str) -> Result<String, String> {
        self.db
            .query_row("SELECT route FROM conversations WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "Agent conversation does not exist".into())
    }

    pub fn new_conversation(&mut self, route: &str) -> Result<String, String> {
        crate::agent::validate_conversation_id(route)?;
        let id = uuid::Uuid::new_v4().to_string();
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE conversations SET active=0 WHERE route=?1", [route])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO conversations(id,route,title,updated_at) VALUES(?1,?2,'新对话',?3)",
            params![id, route, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn append(&mut self, id: &str, role: &str, text: &str) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        if role == "user" {
            tx.execute("UPDATE conversations SET title=?2 WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=?1 AND role='user')", params![id,title(text)]).map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO messages(conversation_id,role,text) VALUES(?1,?2,?3)",
            params![id, role, text],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE conversations SET updated_at=?2 WHERE id=?1",
            params![id, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// A run that ended without a reply (app exit or crash) leaves a dangling user turn; close it so
    /// the next request alternates roles and the model never treats that turn's outcome as known.
    pub fn recover_interrupted(&mut self, id: &str) -> Result<bool, String> {
        let last: Option<String> = self.db.query_row(
            "SELECT role FROM messages WHERE conversation_id=?1 AND role IN ('user','assistant') ORDER BY id DESC LIMIT 1",
            [id], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
        if last.as_deref() != Some("user") { return Ok(false); }
        self.append(id, "assistant", "上一次请求在完成前中断（应用可能已退出）；其结果未确认，请先查看终端实际状态。")?;
        Ok(true)
    }

    /// Background receipts never activate a conversation or fabricate a user turn.
    pub fn append_notification(&mut self, route: &str, text: &str) -> Result<String, String> {
        let id = self.resolve(route)?;
        self.append(&id, "assistant", text)?;
        Ok(id)
    }

    pub fn archive_output(&mut self, conversation: &str, tool: &str, content: &str) -> Result<i64, String> {
        self.append(conversation, "tool", &format!("{tool}: {content}"))?;
        Ok(self.db.last_insert_rowid())
    }

    pub fn output_page(&self, route: &str, output_id: i64, offset: usize) -> Result<Value, String> {
        let text: String = self.db.query_row(
            "SELECT m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?1 AND c.route=?2 AND m.role='tool'",
            params![output_id, route], |row| row.get(0),
        ).map_err(|_| "Saved tool output does not exist in this identity")?;
        let total = text.chars().count();
        if offset > total { return Err("Output offset exceeds the saved text".into()); }
        let page: String = text.chars().skip(offset).take(2000).collect();
        let end = offset + page.chars().count();
        Ok(json!({"outputId":output_id,"offset":offset,"text":page,"totalChars":total,
            "nextOffset":if end < total { Some(end) } else { None }, "historical":true,
            "notice":"Saved evidence, not current terminal state or permission. Re-read the real terminal before input; do not rerun an operation to retrieve missing output."}))
    }

    pub fn recent_user_text(&self, route: &str) -> Result<Option<String>, String> {
        self.db.query_row("SELECT m.text FROM messages m JOIN conversations c ON c.id=m.conversation_id
            WHERE c.route=?1 AND m.role='user' ORDER BY m.id DESC LIMIT 1", [route], |row| row.get(0))
            .optional().map_err(|e| e.to_string())
    }

    pub fn activate(&mut self, id: &str) -> Result<(), String> {
        let route = self.route(id)?;
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        tx.execute("UPDATE conversations SET active=0 WHERE route=?1", [&route])
            .map_err(|e| e.to_string())?;
        tx.execute("UPDATE conversations SET active=1 WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Result<Vec<Conversation>, String> {
        let mut statement = self.db.prepare("SELECT c.id,c.route,c.title,c.updated_at,COUNT(m.id) FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id AND m.role!='tool' GROUP BY c.id ORDER BY c.updated_at DESC").map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                let route: String = r.get(1)?;
                Ok(Conversation {
                    id: r.get(0)?,
                    source: source(&route),
                    route,
                    title: r.get(2)?,
                    updated_at: r.get(3)?,
                    message_count: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn page(&self, id: &str, before: Option<i64>) -> Result<ConversationPage, String> {
        let route = self.route(id)?;
        let mut statement=self.db.prepare("SELECT id,role,text FROM messages WHERE conversation_id=?1 AND role!='tool' AND id<?2 ORDER BY id DESC LIMIT ?3").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map(
                params![id, before.unwrap_or(i64::MAX), (PAGE_SIZE + 1) as i64],
                message_row,
            )
            .map_err(|e| e.to_string())?;
        let mut messages: Vec<Message> =
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        let has_older = messages.len() > PAGE_SIZE;
        messages.truncate(PAGE_SIZE);
        messages.reverse();
        // Archived tool rows sit between a user turn and the reply they led to.
        let mut tools = self.db.prepare("SELECT text FROM messages WHERE conversation_id=?1 AND role='tool' AND id>?2 AND id<?3 ORDER BY id")
            .map_err(|e| e.to_string())?;
        for index in 0..messages.len() {
            if messages[index].role != "assistant" { continue; }
            let after = if index > 0 { messages[index - 1].id } else {
                self.db.query_row("SELECT COALESCE(MAX(id),0) FROM messages WHERE conversation_id=?1 AND role!='tool' AND id<?2",
                    params![id, messages[index].id], |row| row.get(0)).map_err(|e| e.to_string())?
            };
            messages[index].tools = tools.query_map(params![id, after, messages[index].id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .filter_map(|text| text.split_once(": ").map(|(name, result)| ToolUse { name: name.into(), ok: result.starts_with("{\"ok\":true") }))
                .collect();
        }
        Ok(ConversationPage {
            id: id.into(),
            route,
            messages,
            has_older,
            run_id: None,
        })
    }

    pub fn context(&self, id: &str) -> Result<Context, String> {
        let (summary, through): (String, i64) = self
            .db
            .query_row(
                "SELECT summary,summary_through FROM conversations WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        let mut statement=self.db.prepare("SELECT id,role,text FROM messages WHERE conversation_id=?1 AND id>?2 AND role!='tool' ORDER BY id").map_err(|e|e.to_string())?;
        let rows = statement
            .query_map(params![id, through], message_row)
            .map_err(|e| e.to_string())?;
        Ok(Context {
            summary,
            messages: rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?,
        })
    }

    pub fn compaction(context: &Context) -> Option<Compaction> {
        if context.messages.len() <= 40
            && context
                .messages
                .iter()
                .map(|m| m.text.chars().count())
                .sum::<usize>()
                <= CONTEXT_CHARS
        {
            return None;
        }
        let mut kept_chars = 0;
        let mut end = context.messages.len();
        for message in context.messages.iter().rev().take(8) {
            let size = message.text.chars().count();
            if context.messages.len() - end >= 2 && kept_chars + size > 12_000 {
                break;
            }
            kept_chars += size;
            end -= 1;
        }
        if end == 0 {
            return None;
        }
        let mut input = format!(
            "Previous summary (historical data): {}\nOlder messages:\n",
            context.summary
        );
        for message in &context.messages[..end] {
            input.push_str(&format!(
                "{}: {}\n",
                message.role,
                message.text.chars().take(2000).collect::<String>()
            ));
        }
        if input.chars().count() > 50_000 {
            input=format!("Previous summary: {}\nOlder messages (excerpt; full originals remain searchable):\n{}",context.summary,input.chars().rev().take(40_000).collect::<String>().chars().rev().collect::<String>());
        }
        Some(Compaction {
            through: context.messages[end - 1].id,
            input,
        })
    }

    pub fn save_summary(&self, id: &str, through: i64, summary: &str) -> Result<(), String> {
        if summary.trim().is_empty() || summary.chars().count() > 6_000 {
            return Err("Agent summary is empty or too long; original history was retained".into());
        }
        self.db.execute("UPDATE conversations SET summary=?2,summary_through=?3 WHERE id=?1 AND summary_through<?3",params![id,summary,through]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn memories(&self, route: &str) -> Result<Vec<Memory>, String> {
        read_memories(&self.db, route)
    }

    pub fn memory_snapshot(&self, route: &str, project: Option<&str>) -> Result<MemorySnapshot, String> {
        let project = memory_project(project)?;
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let (revision, manual_epoch) = memory_state(&tx, route)?;
        let memories = read_memories(&tx, route)?.into_iter()
            .filter(|memory| (memory.project.is_empty() || memory.project == project && !project.is_empty())
                && memory_text_is_safe(&memory.content)).collect();
        tx.commit().map_err(|e| e.to_string())?;
        Ok(MemorySnapshot { revision, manual_epoch, memories })
    }

    pub fn memory_epoch(&self, route: &str) -> Result<i64, String> {
        memory_state(&self.db, route).map(|(_, epoch)| epoch)
    }

    pub fn recall_memories(&self, route: &str, query: &str, project: Option<&str>) -> Result<Vec<Memory>, String> {
        let words = memory_keywords(query);
        let mut ranked: Vec<_> = self.memory_snapshot(route, project)?.memories.into_iter().filter_map(|memory| {
            let text = memory.content.to_lowercase();
            let relevance = words.iter().filter(|word| text.contains(word.as_str())).count();
            let preference = memory.project.is_empty() && ["偏好", "回复", "回答", "语言", "喜欢", "prefer", "language", "reply", "respond"]
                .iter().any(|word| text.contains(word));
            (relevance > 0 || preference).then_some((relevance, memory))
        }).collect();
        ranked.sort_by(|(left_score, left), (right_score, right)| right_score.cmp(left_score)
            .then_with(|| right.updated_at.cmp(&left.updated_at)).then_with(|| left.id.cmp(&right.id)));
        let mut result = Vec::new();
        let mut chars = 0;
        for (_, memory) in ranked {
            let size = memory_chars(&memory);
            if chars + size > 8_000 { continue; }
            chars += size;
            result.push(memory);
            if result.len() == 8 { break; }
        }
        Ok(result)
    }

    pub fn save_memory(
        &mut self,
        route: &str,
        id: Option<&str>,
        content: &str,
    ) -> Result<String, String> {
        let content = content.trim();
        validate_memory_text(content, false)?;
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let memories = read_memories(&tx, route)?;
        if id.is_some_and(|id| !memories.iter().any(|memory| memory.id == id)) {
            return Err("Memory does not exist in this identity".into());
        }
        let existing = id.and_then(|id| memories.iter().find(|memory| memory.id == id)).or_else(|| {
            memories.iter().find(|memory| id.is_none() && memory.project.is_empty() && same_memory(&memory.content, content))
        });
        let count = memories
            .iter()
            .filter(|memory| Some(memory.id.as_str()) != existing.map(|memory| memory.id.as_str()))
            .map(memory_chars)
            .sum::<usize>()
            + content.chars().count();
        if count > MEMORY_CHARS || existing.is_none() && memories.len() >= MAX_MEMORIES {
            return Err("长期记忆已满（200 条或 40000 字符），请先修改或忘记旧记忆".into());
        }
        let id = existing
            .map(|memory| memory.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        tx.execute("INSERT INTO memories(id,route,content,updated_at) VALUES(?1,?2,?3,?4)
            ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,automatic=0,source_conversation=NULL,experience=NULL",
            params![id,route,content,now_ms()]).map_err(|e|e.to_string())?;
        bump_memory_state(&tx, route, true)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn forget_memory(&self, route: &str, id: &str) -> Result<(), String> {
        let tx = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let changed = tx.execute(
                "DELETE FROM memories WHERE route=?1 AND id=?2",
                params![route, id],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Memory does not exist in this identity".into());
        }
        bump_memory_state(&tx, route, true)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn apply_memory_changes(&mut self, route: &str, project: Option<&str>, conversation: &str,
        snapshot: &MemorySnapshot, changes: &[MemoryChange]) -> Result<bool, String> {
        if changes.len() > MAX_MEMORY_CHANGES { return Err("Memory capture exceeds its change limit".into()); }
        let project = memory_project(project)?;
        if self.route(conversation)? != route { return Err("Memory source conversation belongs to another identity".into()); }
        let tx = self.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        if memory_state(&tx, route)? != (snapshot.revision, snapshot.manual_epoch) { return Ok(false); }
        let original = read_memories(&tx, route)?;
        let mut memories = original.clone();
        let mut protected = HashSet::new();
        for change in changes {
            match change.action.as_str() {
                "add" if change.id.is_none() && change.experience.is_none() => {
                    let content = change.content.as_deref().ok_or("Memory addition has no content")?.trim();
                    validate_memory_text(content, true)?;
                    let scope = match change.scope.as_deref() {
                        Some("user") => "",
                        Some("project") if !project.is_empty() => project.as_str(),
                        _ => return Err("Memory scope must be user or the observed project".into()),
                    };
                    if let Some(existing) = memories.iter().find(|memory| memory.project == scope && same_memory(&memory.content, content)) {
                        protected.insert(existing.id.clone());
                    } else {
                        let id = uuid::Uuid::new_v4().to_string();
                        protected.insert(id.clone());
                        memories.push(Memory { id, content:content.into(), project:scope.into(), updated_at:now_ms(), source_conversation:Some(conversation.into()), automatic:true, experience:None });
                    }
                }
                // Experiences are project-scoped only: a procedure observed in one directory never becomes a global rule.
                "learn" if change.id.is_none() && !project.is_empty() => {
                    let experience = change.experience.clone().ok_or("Task experience has no verified evidence")?;
                    let cue = change.content.as_deref().ok_or("Task experience has no cue")?.trim();
                    experience.validate(cue)?;
                    if let Some(existing) = memories.iter_mut().find(|memory| memory.project == project && memory.experience.is_some() && same_memory(&memory.content, cue)) {
                        if !protected.insert(existing.id.clone()) { return Err("Memory capture changes the same note more than once".into()); }
                        existing.experience = Some(experience);
                        existing.updated_at = now_ms();
                        existing.source_conversation = Some(conversation.into());
                    } else {
                        let id = uuid::Uuid::new_v4().to_string();
                        protected.insert(id.clone());
                        memories.push(Memory { id, content:cue.into(), project:project.clone(), updated_at:now_ms(), source_conversation:Some(conversation.into()), automatic:true, experience:Some(experience) });
                    }
                }
                "update" | "forget" if change.scope.is_none() && change.experience.is_none() => {
                    let id = change.id.as_deref().ok_or("Memory change has no exact ID")?;
                    if !protected.insert(id.to_string()) { return Err("Memory capture changes the same note more than once".into()); }
                    let expected = snapshot.memories.iter().find(|memory| memory.id == id).ok_or("Memory change is outside its snapshot")?;
                    let index = memories.iter().position(|memory| memory.id == id && memory == expected
                        && (memory.project.is_empty() || !project.is_empty() && memory.project == project))
                        .ok_or("Memory change is outside this identity or project")?;
                    if change.action == "forget" {
                        if change.content.is_some() { return Err("Memory forget must not supply content".into()); }
                        memories.remove(index);
                    } else {
                        let content = change.content.as_deref().ok_or("Memory update has no content")?.trim();
                        validate_memory_text(content, true)?;
                        if !same_memory(&memories[index].content, content) {
                            memories[index].content = content.into();
                            memories[index].updated_at = now_ms();
                            memories[index].source_conversation = Some(conversation.into());
                        }
                    }
                }
                _ => return Err("Invalid memory change action or fields".into()),
            }
        }
        if memories == original { return Ok(false); }
        for memory in memories.iter().filter(|memory| !original.contains(memory)) {
            if memories.iter().any(|other| other.id != memory.id && other.project == memory.project && same_memory(&other.content, &memory.content)) {
                return Err("Memory capture would duplicate another note; merge or forget it in the same batch".into());
            }
        }
        while memories.len() > MAX_MEMORIES || memories.iter().map(memory_chars).sum::<usize>() > MEMORY_CHARS {
            let candidate = memories.iter().enumerate().filter(|(_, memory)| memory.automatic && !protected.contains(&memory.id))
                .min_by(|(_, left), (_, right)| left.project.is_empty().cmp(&right.project.is_empty())
                    .then_with(|| left.updated_at.cmp(&right.updated_at)).then_with(|| left.id.cmp(&right.id)))
                .map(|(index, _)| index).ok_or("Automatic memory capacity is full; manual memories were preserved")?;
            memories.remove(candidate);
        }
        for memory in &original {
            if !memories.iter().any(|candidate| candidate.id == memory.id) {
                tx.execute("DELETE FROM memories WHERE route=?1 AND id=?2", params![route,memory.id]).map_err(|e| e.to_string())?;
            }
        }
        for memory in memories.iter().filter(|memory| !original.contains(memory)) {
            let experience = memory.experience.as_ref().map(serde_json::to_string).transpose().map_err(|_| "Cannot encode task experience")?;
            tx.execute("INSERT INTO memories(id,route,content,project,updated_at,source_conversation,automatic,experience) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
                ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,source_conversation=excluded.source_conversation,experience=excluded.experience",
                params![memory.id,route,memory.content,memory.project,memory.updated_at,memory.source_conversation,memory.automatic,experience]).map_err(|e| e.to_string())?;
        }
        bump_memory_state(&tx, route, false)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn search(&self, route: &str, query: &str) -> Result<Value, String> {
        if query.trim().is_empty() {
            return Err("Enter a history search keyword".into());
        }
        let mut statement=self.db.prepare("SELECT m.id,m.conversation_id,m.role,m.text,c.title FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.route=?1 AND instr(lower(m.text),lower(?2))>0 ORDER BY m.id DESC LIMIT 8").map_err(|e|e.to_string())?;
        let rows=statement.query_map(params![route,query.trim()],|r| {
            let text:String=r.get(3)?;
            let start=text.to_ascii_lowercase().find(&query.trim().to_ascii_lowercase()).unwrap_or(0);
            let char_start=text[..start.min(text.len())].chars().count().saturating_sub(100);
            let excerpt:String=text.chars().skip(char_start).take(1000).collect();
            Ok(json!({"messageId":r.get::<_,i64>(0)?,"conversationId":r.get::<_,String>(1)?,"role":r.get::<_,String>(2)?,"text":excerpt,"title":r.get::<_,String>(4)?,"historical":true}))
        }).map_err(|e|e.to_string())?;
        Ok(json!({"matches":rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?}))
    }
}

fn read_memories(db: &Connection, route: &str) -> Result<Vec<Memory>, String> {
    let mut statement = db.prepare("SELECT id,content,project,updated_at,source_conversation,automatic,experience FROM memories WHERE route=?1 ORDER BY rowid").map_err(|e| e.to_string())?;
    let rows = statement.query_map([route], |row| Ok(Memory {
        id:row.get(0)?, content:row.get(1)?, project:row.get(2)?, updated_at:row.get(3)?,
        source_conversation:row.get(4)?, automatic:row.get(5)?,
        // An unreadable procedure degrades to its plain cue rather than hiding the note.
        experience:row.get::<_, Option<String>>(6)?.and_then(|text| serde_json::from_str(&text).ok()),
    })).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

fn memory_state(db: &Connection, route: &str) -> Result<(i64, i64), String> {
    db.query_row("SELECT revision,manual_epoch FROM memory_state WHERE route=?1", [route], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional().map(|state| state.unwrap_or_default()).map_err(|e| e.to_string())
}

fn bump_memory_state(db: &Connection, route: &str, manual: bool) -> Result<(), String> {
    db.execute("INSERT INTO memory_state(route,revision,manual_epoch) VALUES(?1,1,?2)
        ON CONFLICT(route) DO UPDATE SET revision=revision+1,manual_epoch=manual_epoch+excluded.manual_epoch", params![route,manual as i64])
        .map(|_| ()).map_err(|e| e.to_string())
}

fn memory_project(project: Option<&str>) -> Result<String, String> {
    let project = project.unwrap_or_default().trim();
    if project.is_empty() { return Ok(String::new()); }
    if project.len() > 32_768 || project.chars().any(char::is_control) || !Path::new(project).is_absolute() {
        return Err("Memory project must be the observed absolute working directory".into());
    }
    #[cfg(windows)]
    let project = project.to_ascii_lowercase().replace('\\', "/");
    Ok(project.to_string())
}

fn same_memory(left: &str, right: &str) -> bool {
    left.split_whitespace().eq(right.split_whitespace())
}

fn validate_memory_text(content: &str, automatic: bool) -> Result<(), String> {
    if content.is_empty() || if automatic { content.len() > AUTO_MEMORY_BYTES } else { content.chars().count() > MANUAL_MEMORY_CHARS } {
        return Err(if automatic { "Automatic memory must contain 1–2000 UTF-8 bytes" } else { "Memory must contain 1–8000 characters" }.into());
    }
    if !memory_text_is_safe(content) { return Err("Memory must not contain passwords, API tokens, private keys or null characters".into()); }
    Ok(())
}

pub(crate) fn memory_text_is_safe(text: &str) -> bool {
    let normalized = text.to_lowercase();
    if text.contains('\0') || normalized.contains("-----begin") && normalized.contains("private key-----") { return false; }
    for token in text.split(|character: char| !character.is_ascii_alphanumeric() && character != '-' && character != '_') {
        if ["sk-", "ghp_", "github_pat_", "AIza"].iter().any(|prefix| token.starts_with(prefix) && token.len() >= prefix.len() + 20) { return false; }
    }
    for marker in ["api_key", "api-key", "apikey", "api key", "access_token", "access token", "password", "passwd", "密码", "密钥", "令牌"] {
        for (offset, _) in normalized.match_indices(marker) {
            let value = normalized[offset + marker.len()..].trim_start_matches(|character: char| character.is_whitespace() || character == '\'' || character == '"');
            if ["=", ":", "：", "是", "为"].iter().any(|separator| value.strip_prefix(separator)
                .is_some_and(|value| !value.trim_matches(|character: char| character.is_whitespace() || character == '\'' || character == '"').is_empty())) { return false; }
        }
    }
    !normalized.match_indices("bearer ").any(|(offset, _)| normalized[offset + 7..].split_whitespace().next().is_some_and(|value| value.len() >= 8))
}

fn memory_keywords(query: &str) -> HashSet<String> {
    let normalized: String = query.to_lowercase().chars().take(2_000).collect();
    let mut words = HashSet::new();
    for word in normalized.split(|character: char| !character.is_alphanumeric()) {
        if word.chars().count() >= 2 { words.insert(word.to_string()); }
        let characters: Vec<_> = word.chars().collect();
        for pair in characters.windows(2) {
            if pair.iter().all(|character| !character.is_ascii()) { words.insert(pair.iter().collect()); }
        }
    }
    words
}

fn title(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(40)
        .collect()
}
fn message_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: r.get(0)?,
        role: r.get(1)?,
        text: r.get(2)?,
        tools: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn each_reply_lists_only_the_tool_calls_of_its_own_turn() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let id = store.resolve("desktop").unwrap();
        store.append(&id, "user", "看看终端").unwrap();
        store.archive_output(&id, "sessions_list", r#"{"ok":true,"result":[]}"#).unwrap();
        store.archive_output(&id, "terminal_send", r#"{"error":"Read the screen first","ok":false}"#).unwrap();
        store.append(&id, "assistant", "完成").unwrap();
        store.append(&id, "user", "谢谢").unwrap();
        store.append(&id, "assistant", "不客气").unwrap();
        let messages = store.page(&id, None).unwrap().messages;
        let tools: Vec<_> = messages[1].tools.iter().map(|tool| (tool.name.as_str(), tool.ok)).collect();
        assert_eq!(tools, [("sessions_list", true), ("terminal_send", false)]);
        assert!(messages[3].tools.is_empty() && messages.iter().all(|message| message.role != "tool"));
        let older = store.page(&id, Some(messages[2].id)).unwrap().messages;
        assert_eq!(older[1].tools.len(), 2, "the first reply of a page still finds its turn");
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_crashed_turn_is_closed_once_before_the_next_request() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let id = store.resolve("desktop").unwrap();
        assert!(!store.recover_interrupted(&id).unwrap());
        store.append(&id, "user", "运行测试").unwrap();
        store.archive_output(&id, "terminal_send", "{}").unwrap();
        assert!(store.recover_interrupted(&id).unwrap());
        assert!(!store.recover_interrupted(&id).unwrap());
        let messages = store.page(&id, None).unwrap().messages;
        assert_eq!(messages.last().unwrap().role, "assistant");
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_manual_edit_turns_a_learned_procedure_into_a_plain_note() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let project = std::env::temp_dir().to_string_lossy().into_owned();
        let snapshot = store.memory_snapshot("desktop", Some(&project)).unwrap();
        let mut learn = change(json!({"action":"learn","scope":"project","content":"构建"}));
        learn.experience = Some(Experience { procedure:"npm run build".into(), evidence:vec!["terminal_read_screen: built".into()] });
        assert!(store.apply_memory_changes("desktop", Some(&project), &conversation, &snapshot, &[learn]).unwrap());
        let saved = store.memories("desktop").unwrap();
        assert!(saved[0].experience.is_some() && saved[0].automatic);
        store.save_memory("desktop", Some(&saved[0].id), "构建前先装依赖").unwrap();
        assert!(store.memories("desktop").unwrap()[0].experience.is_none());
        let model_learn = change(json!({"action":"learn","scope":"project","content":"x"}));
        let snapshot = store.memory_snapshot("desktop", Some(&project)).unwrap();
        assert!(store.apply_memory_changes("desktop", Some(&project), &conversation, &snapshot, &[model_learn]).is_err());
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn archived_output_pages_are_complete_historical_and_identity_scoped() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let raw = json!({"ok":true,"result":{"text":format!("{}\nerror: middle failure\n{}", "项目日志。".repeat(700), "尾部证据。".repeat(700))}}).to_string();
        let output_id = store.archive_output(&conversation, "history_list", &raw).unwrap();
        let summary: Value = serde_json::from_str(&crate::agent_output::for_model("history_list", &raw, output_id)).unwrap();
        assert_eq!(summary["condensed"], true);
        assert_eq!(summary["outputId"].as_i64(), Some(output_id));
        assert!(store.output_page("weixin-other", output_id, 0).is_err());
        store.append(&conversation, "user", "private user message").unwrap();
        let user_id = store.db.last_insert_rowid();
        assert!(store.output_page("desktop", user_id, 0).is_err());
        store.new_conversation("desktop").unwrap();
        drop(store);
        let store = Store::open(&directory).unwrap();
        let mut offset = 0;
        let mut recovered = String::new();
        loop {
            let page = store.output_page("desktop", output_id, offset).unwrap();
            assert_eq!(page["historical"], true);
            let text = page["text"].as_str().unwrap();
            assert!(text.chars().count() <= 2000);
            recovered.push_str(text);
            if let Some(next) = page["nextOffset"].as_u64() { offset = next as usize; }
            else { break; }
        }
        assert_eq!(recovered, format!("history_list: {raw}"));
        assert!(store.output_page("desktop", output_id, recovered.chars().count() + 1).is_err());
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn notification_receipts_are_assistant_only_and_do_not_restore_an_archived_conversation() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let archived = store.resolve("weixin-owner").unwrap();
        store.append(&archived, "user", "请使用中文").unwrap();
        let active = store.new_conversation("weixin-owner").unwrap();
        let desktop = store.resolve("desktop").unwrap();
        store.append(&desktop, "user", "Continue desktop work").unwrap();
        let receipt = store.append_notification("weixin-owner", "Claude Code 本轮结束；结果尚未核验。").unwrap();
        assert_eq!(receipt, active);
        assert_eq!(store.resolve("weixin-owner").unwrap(), active);
        assert_eq!(store.resolve("desktop").unwrap(), desktop);
        assert_eq!(store.page(&active, None).unwrap().messages.len(), 1);
        assert_eq!(store.page(&active, None).unwrap().messages[0].role, "assistant");
        assert_eq!(store.page(&archived, None).unwrap().messages.len(), 1);
        assert_eq!(store.recent_user_text("weixin-owner").unwrap().as_deref(), Some("请使用中文"));
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("coffee-memory-{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn archive_survives_compaction_new_conversation_and_restart() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let id = store.resolve("desktop").unwrap();
        for n in 0..70 {
            store
                .append(
                    &id,
                    if n % 2 == 0 { "user" } else { "assistant" },
                    &format!("第{n}条，工作目录 E:\\项目"),
                )
                .unwrap();
        }
        let plan = Store::compaction(&store.context(&id).unwrap()).unwrap();
        store
            .save_summary(
                &id,
                plan.through,
                "用户正在 E:\\项目 工作；当前终端状态须重新查询。",
            )
            .unwrap();
        assert_eq!(store.context(&id).unwrap().messages.len(), 8);
        assert_eq!(store.page(&id, None).unwrap().messages.len(), 70);
        let memory = store.save_memory("desktop", None, "回复使用中文").unwrap();
        let next = store.new_conversation("desktop").unwrap();
        assert_ne!(next, id);
        assert_eq!(store.memories("desktop").unwrap()[0].id, memory);
        assert!(store.context(&next).unwrap().messages.is_empty());
        drop(store);
        let mut reopened = Store::open(&directory).unwrap();
        assert_eq!(reopened.resolve("desktop").unwrap(), next);
        assert_eq!(reopened.list().unwrap().len(), 2);
        assert_eq!(
            reopened.search("desktop", "第0条").unwrap()["matches"][0]["conversationId"],
            id
        );
        reopened.activate(&id).unwrap();
        assert_eq!(reopened.resolve("desktop").unwrap(), id);
        assert_eq!(reopened.memories("desktop").unwrap()[0].id, memory);
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn migration_is_once_only_and_identity_memory_is_isolated() {
        let directory = root();
        fs::create_dir_all(directory.join("conversations")).unwrap();
        fs::write(
            directory.join("conversations/desktop.json"),
            r#"[{"role":"user","text":"旧对话"},{"role":"assistant","text":"保留历史"}]"#,
        )
        .unwrap();
        let mut store = Store::open(&directory).unwrap();
        let id = store.resolve("desktop").unwrap();
        let memory = store.save_memory("desktop", None, "偏好中文").unwrap();
        assert!(store
            .save_memory("weixin-account", Some(&memory), "覆盖他人记忆")
            .is_err());
        assert!(store.forget_memory("weixin-account", &memory).is_err());
        assert!(store.memories("weixin-account").unwrap().is_empty());
        assert_eq!(
            store.search("weixin-account", "旧对话").unwrap()["matches"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert!(store.save_summary(&id, 1, "").is_err());
        assert_eq!(store.context(&id).unwrap().messages.len(), 2);
        drop(store);
        let store = Store::open(&directory).unwrap();
        assert_eq!(store.page(&id, None).unwrap().messages.len(), 2);
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn paging_and_memory_limits_preserve_existing_data() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let id = store.resolve("desktop").unwrap();
        for n in 0..110 {
            store.append(&id, "user", &format!("消息 {n}")).unwrap();
        }
        let newest = store.page(&id, None).unwrap();
        assert!(newest.has_older);
        assert_eq!(newest.messages.len(), 100);
        let older = store.page(&id, Some(newest.messages[0].id)).unwrap();
        assert_eq!(older.messages.len(), 10);
        assert!(!older.has_older);
        let content = "中".repeat(MANUAL_MEMORY_CHARS);
        let memory = store.save_memory("desktop", None, &content).unwrap();
        for index in 1..5 {
            store.save_memory("desktop", None, &index.to_string().repeat(MANUAL_MEMORY_CHARS)).unwrap();
        }
        assert!(store.save_memory("desktop", None, "额外").is_err());
        assert_eq!(store.memories("desktop").unwrap()[0].content, content);
        store
            .save_memory("desktop", Some(&memory), "新的偏好")
            .unwrap();
        store.forget_memory("desktop", &memory).unwrap();
        for memory in store.memories("desktop").unwrap() { store.forget_memory("desktop", &memory.id).unwrap(); }
        assert!(store.memories("desktop").unwrap().is_empty());
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_readers_import_once_and_share_one_current_thread() {
        let directory = root();
        fs::create_dir_all(directory.join("conversations")).unwrap();
        fs::write(
            directory.join("conversations/desktop.json"),
            r#"[{"role":"user","text":"原始历史"}]"#,
        )
        .unwrap();
        let workers: Vec<_> = (0..4)
            .map(|n| {
                let directory = directory.clone();
                std::thread::spawn(move || {
                    let mut store = Store::open(&directory).unwrap();
                    let id = store.resolve("desktop").unwrap();
                    store.append(&id, "user", &format!("同时请求 {n}")).unwrap();
                    id
                })
            })
            .collect();
        let ids: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        let store = Store::open(&directory).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.page(&ids[0], None).unwrap().messages.len(), 5);
        assert!(directory.join("conversations/desktop.json").exists());
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_memory_writes_enforce_capacity_atomically() {
        let directory = root();
        drop(Store::open(&directory).unwrap());
        let workers: Vec<_> = ['a', 'b', 'c', 'd', 'e', 'f']
            .into_iter()
            .map(|letter| {
                let directory = directory.clone();
                std::thread::spawn(move || {
                    Store::open(&directory).unwrap().save_memory(
                        "desktop",
                        None,
                        &letter.to_string().repeat(MANUAL_MEMORY_CHARS),
                    )
                })
            })
            .collect();
        let successes = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(successes, 5);
        let store = Store::open(&directory).unwrap();
        assert_eq!(store.memories("desktop").unwrap().len(), 5);
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    fn change(value: Value) -> MemoryChange { serde_json::from_value(value).unwrap() }

    #[test]
    fn old_memory_schema_migrates_without_losing_notes_or_ids() {
        let directory = root();
        fs::create_dir_all(&directory).unwrap();
        let db = Connection::open(directory.join("history.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE memories(id TEXT PRIMARY KEY,route TEXT NOT NULL,content TEXT NOT NULL);
            INSERT INTO memories VALUES('old-note','desktop','回复中文');").unwrap();
        drop(db);
        let store = Store::open(&directory).unwrap();
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        assert_eq!(snapshot.revision, 0);
        assert_eq!(snapshot.memories[0].id, "old-note");
        assert_eq!(snapshot.memories[0].content, "回复中文");
        assert!(snapshot.memories[0].project.is_empty());
        assert!(!snapshot.memories[0].automatic);
        assert_eq!(snapshot.memories[0].source_conversation, None);
        drop(store);
        assert_eq!(Store::open(&directory).unwrap().memories("desktop").unwrap(), snapshot.memories);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migrated_credentials_are_retained_for_management_but_never_recalled_or_captured() {
        let directory = root();
        fs::create_dir_all(&directory).unwrap();
        let db = Connection::open(directory.join("history.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE memories(id TEXT PRIMARY KEY,route TEXT NOT NULL,content TEXT NOT NULL);
            INSERT INTO memories VALUES('legacy-secret','desktop','API key: sk-abcdefghijklmnopqrstuvwxyz');
            INSERT INTO memories VALUES('legacy-preference','desktop','偏好中文回复');").unwrap();
        drop(db);
        let store = Store::open(&directory).unwrap();
        let notes = store.memories("desktop").unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, "legacy-secret");
        assert!(notes[0].content.contains("sk-"));
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        assert_eq!(snapshot.memories.len(), 1);
        assert_eq!(snapshot.memories[0].id, "legacy-preference");
        let recall = store.recall_memories("desktop", "API key", None).unwrap();
        assert_eq!(recall.len(), 1);
        assert_eq!(recall[0].id, "legacy-preference");
        store.forget_memory("desktop", "legacy-secret").unwrap();
        assert_eq!(store.memories("desktop").unwrap().len(), 1);
        assert_eq!(store.memory_epoch("desktop").unwrap(), 1);
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn automatic_notes_persist_and_only_recall_their_identity_and_project() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let a = directory.join("project-a").to_string_lossy().into_owned();
        let b = directory.join("project-b").to_string_lossy().into_owned();
        let snapshot = store.memory_snapshot("desktop", Some(&a)).unwrap();
        assert!(store.apply_memory_changes("desktop", Some(&a), &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"user","content":"回复使用中文"})),
            change(json!({"action":"add","scope":"project","content":"容器部署使用 Compose"})),
        ]).unwrap());
        let saved = store.memory_snapshot("desktop", Some(&a)).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(saved.manual_epoch, 0);
        assert_eq!(saved.memories.len(), 2);
        assert!(saved.memories.iter().all(|memory| memory.source_conversation.as_deref() == Some(conversation.as_str())));
        assert_eq!(store.recall_memories("desktop", "帮我检查容器部署", Some(&a)).unwrap().len(), 2);
        assert_eq!(store.recall_memories("desktop", "容器部署", Some(&b)).unwrap().len(), 1);
        assert_eq!(store.memory_snapshot("desktop", None).unwrap().memories.len(), 1);
        assert!(store.recall_memories("weixin-other", "容器部署", Some(&a)).unwrap().is_empty());
        let next = store.new_conversation("desktop").unwrap();
        assert!(store.context(&next).unwrap().messages.is_empty());
        drop(store);
        let reopened = Store::open(&directory).unwrap();
        assert_eq!(reopened.memory_snapshot("desktop", Some(&a)).unwrap().memories, saved.memories);
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn manual_corrections_and_forgetting_discard_old_capture_snapshots() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let id = store.save_memory("desktop", None, "回复中文").unwrap();
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        store.save_memory("desktop", Some(&id), "回复英文").unwrap();
        assert!(!store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"update","id":id,"content":"回复中文"})),
        ]).unwrap());
        assert_eq!(store.memories("desktop").unwrap()[0].content, "回复英文");
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        store.forget_memory("desktop", &id).unwrap();
        assert!(!store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"user","content":"回复英文"})),
        ]).unwrap());
        assert!(store.memories("desktop").unwrap().is_empty());
        assert_eq!(store.memory_epoch("desktop").unwrap(), 3);
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn automatic_batches_are_atomic_deduplicated_and_do_not_advance_manual_epoch() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let first = store.memory_snapshot("desktop", None).unwrap();
        let additions = [change(json!({"action":"add","scope":"user","content":"偏好中文回复"}))];
        assert!(store.apply_memory_changes("desktop", None, &conversation, &first, &additions).unwrap());
        assert!(!store.apply_memory_changes("desktop", None, &conversation, &first, &additions).unwrap());
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        assert!(!store.apply_memory_changes("desktop", None, &conversation, &snapshot, &additions).unwrap());
        assert_eq!(store.memory_snapshot("desktop", None).unwrap().revision, snapshot.revision);
        let id = snapshot.memories[0].id.clone();
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"update","id":id,"content":"偏好英文回复"})),
            change(json!({"action":"forget","id":"missing-id"})),
        ]).is_err());
        assert_eq!(store.memories("desktop").unwrap()[0].content, "偏好中文回复");
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"update","id":id,"content":"偏好英文回复"})),
        ]).unwrap());
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        assert_eq!(snapshot.manual_epoch, 0);
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"forget","id":id})),
        ]).unwrap());
        assert_eq!(store.memory_epoch("desktop").unwrap(), 0);
        assert!(store.memories("desktop").unwrap().is_empty());
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn capture_cannot_change_foreign_notes_or_bind_an_unobserved_project() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let foreign = store.resolve("weixin-owner").unwrap();
        let id = store.save_memory("weixin-owner", None, "偏好中文").unwrap();
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"update","id":id,"content":"偏好英文"})),
        ]).is_err());
        assert!(store.apply_memory_changes("desktop", None, &foreign, &snapshot, &[]).is_err());
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"project","content":"使用 Rust"})),
        ]).is_err());
        assert!(serde_json::from_value::<MemoryChange>(json!({"action":"add","scope":"project","content":"使用 Rust","project":"E:/other"})).is_err());
        assert_eq!(store.memories("weixin-owner").unwrap()[0].content, "偏好中文");
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn retention_prefers_old_automatic_project_notes_and_protects_manual_notes() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let project = directory.join("project").to_string_lossy().into_owned();
        let manual = store.save_memory("desktop", None, "回复中文").unwrap();
        let snapshot = store.memory_snapshot("desktop", Some(&project)).unwrap();
        store.apply_memory_changes("desktop", Some(&project), &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"user","content":"用户喜欢短回答"})),
            change(json!({"action":"add","scope":"project","content":"旧项目事实"})),
        ]).unwrap();
        let old_project = store.memories("desktop").unwrap().into_iter().find(|memory| !memory.project.is_empty()).unwrap().id;
        for index in 0..197 { store.save_memory("desktop", None, &format!("手动事实 {index}")).unwrap(); }
        let snapshot = store.memory_snapshot("desktop", Some(&project)).unwrap();
        assert!(store.apply_memory_changes("desktop", Some(&project), &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"project","content":"新项目事实"})),
        ]).unwrap());
        let notes = store.memories("desktop").unwrap();
        assert_eq!(notes.len(), 200);
        assert!(notes.iter().any(|memory| memory.id == manual));
        assert!(notes.iter().any(|memory| memory.content == "用户喜欢短回答"));
        assert!(!notes.iter().any(|memory| memory.id == old_project));
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn full_manual_capacity_rejects_automatic_capture_without_data_loss() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        for index in 0..5 { store.save_memory("desktop", None, &index.to_string().repeat(MANUAL_MEMORY_CHARS)).unwrap(); }
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"user","content":"新偏好"})),
        ]).is_err());
        assert_eq!(store.memory_snapshot("desktop", None).unwrap().memories, snapshot.memories);
        assert_eq!(store.memory_snapshot("desktop", None).unwrap().revision, snapshot.revision);
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unicode_recall_and_capture_obey_distinct_character_and_byte_budgets() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        store.save_memory("desktop", None, &"偏好中文回复".repeat(1000)).unwrap();
        store.save_memory("desktop", None, &"偏好短回复".repeat(1000)).unwrap();
        let recalled = store.recall_memories("desktop", "请检查容器部署", None).unwrap();
        assert_eq!(recalled.len(), 1);
        assert!(recalled.iter().map(|memory| memory.content.chars().count()).sum::<usize>() <= 8_000);
        let snapshot = store.memory_snapshot("desktop", None).unwrap();
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"user","content":"中".repeat(667)})),
        ]).is_err());
        assert!(store.apply_memory_changes("desktop", None, &conversation, &snapshot, &[
            change(json!({"action":"add","scope":"user","content":"中".repeat(666)})),
        ]).unwrap());
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn secrets_are_rejected_for_manual_and_automatic_memory() {
        for secret in ["api_key = very-secret", "密码是secret", "Bearer very-secret", "-----BEGIN RSA PRIVATE KEY-----", "sk-abcdefghijklmnopqrstuvwxyz", "含\0字符"] {
            assert!(!memory_text_is_safe(secret));
            assert!(validate_memory_text(secret, false).is_err());
            assert!(validate_memory_text(secret, true).is_err());
        }
        assert!(memory_text_is_safe("密钥保存在系统凭据管理器，不记录具体值"));
    }

    #[test]
    fn capture_merges_require_exact_ids_and_cannot_reach_another_project() {
        let directory = root();
        let mut store = Store::open(&directory).unwrap();
        let conversation = store.resolve("desktop").unwrap();
        let a = directory.join("project-a").to_string_lossy().into_owned();
        let b = directory.join("project-b").to_string_lossy().into_owned();
        let initial = store.memory_snapshot("desktop", Some(&a)).unwrap();
        store.apply_memory_changes("desktop", Some(&a), &conversation, &initial, &[
            change(json!({"action":"add","scope":"project","content":"项目部署使用 Compose"})),
            change(json!({"action":"add","scope":"user","content":"偏好中文"})),
            change(json!({"action":"add","scope":"user","content":"偏好短回复"})),
        ]).unwrap();
        let snapshot = store.memory_snapshot("desktop", Some(&a)).unwrap();
        let project_note = snapshot.memories.iter().find(|memory| !memory.project.is_empty()).unwrap();
        assert!(store.apply_memory_changes("desktop", Some(&b), &conversation, &snapshot, &[
            change(json!({"action":"forget","id":project_note.id})),
        ]).is_err());
        let chinese = snapshot.memories.iter().find(|memory| memory.content == "偏好中文").unwrap();
        let concise = snapshot.memories.iter().find(|memory| memory.content == "偏好短回复").unwrap();
        assert!(store.apply_memory_changes("desktop", Some(&a), &conversation, &snapshot, &[
            change(json!({"action":"update","id":chinese.id,"content":"偏好短回复"})),
        ]).is_err());
        assert!(store.apply_memory_changes("desktop", Some(&a), &conversation, &snapshot, &[
            change(json!({"action":"update","id":chinese.id,"content":"偏好短回复"})),
            change(json!({"action":"forget","id":concise.id})),
        ]).unwrap());
        assert_eq!(store.memories("desktop").unwrap().len(), 2);
        let snapshot = store.memory_snapshot("desktop", Some(&a)).unwrap();
        let too_many: Vec<_> = (0..9).map(|n| change(json!({"action":"add","scope":"user","content":format!("偏好 {n}")}))).collect();
        assert!(store.apply_memory_changes("desktop", Some(&a), &conversation, &snapshot, &too_many).is_err());
        assert_eq!(store.memory_snapshot("desktop", Some(&a)).unwrap().revision, snapshot.revision);
        drop(store);
        fs::remove_dir_all(directory).unwrap();
    }
}
