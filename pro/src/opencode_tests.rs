use super::*;

fn seed_v2_db() -> std::path::PathBuf {
    static NEXT_DB: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!("coffee-opencode-v2-{}-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        NEXT_DB.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(r#"
        CREATE TABLE session_v2 (
            id TEXT PRIMARY KEY, title TEXT, directory TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER, parent_id TEXT
        );
        CREATE TABLE session_message (
            id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
            time_created INTEGER, time_updated INTEGER, data TEXT
        );
        INSERT INTO session_v2 VALUES
            ('ses_main', 'V2 task', '/proj', 2000, 4000, NULL, NULL),
            ('ses_child', 'Child', '/proj', 2000, 5000, NULL, 'ses_main'),
            ('ses_archived', 'Archived', '/proj', 2000, 6000, 6000, NULL);
        INSERT INTO session_message VALUES
            ('msg_answer', 'ses_main', 'assistant', 20, 2000, 3000,
             '{"content":[{"type":"reasoning","text":"private reasoning"},{"type":"text","text":"Hello"},{"type":"tool","name":"bash"},{"type":"text","text":" world"}]}'),
            ('msg_prompt', 'ses_main', 'user', 10, 3000, 3000, '{"text":"你好"}'),
            ('msg_switch', 'ses_main', 'model-switched', 30, 3100, 3100, '{}'),
            ('msg_compact', 'ses_main', 'compaction', 40, 3200, 3200, '{"summary":"summary"}'),
            ('msg_child', 'ses_child', 'user', 10, 3000, 3000, '{"text":"child"}'),
            ('msg_archived', 'ses_archived', 'user', 10, 3000, 3000, '{"text":"old"}');
    "#).unwrap();
    path
}

fn add_legacy_tables(path: &std::path::Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(r#"
        CREATE TABLE session AS SELECT * FROM session_v2;
        UPDATE session SET title = 'Stale V1 title', time_updated = 3000, time_archived = NULL;
        INSERT INTO session VALUES ('ses_legacy', 'V1 task', '/old', 1000, 2000, NULL, NULL);
        CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
            time_created INTEGER, time_updated INTEGER, data TEXT
        );
        INSERT INTO message VALUES
            ('msg_old', 'ses_main', 1000, 1000, '{"role":"user"}'),
            ('msg_legacy', 'ses_legacy', 1000, 1000, '{"role":"user"}');
        INSERT INTO part VALUES
            ('part_old', 'msg_old', 'ses_main', 1000, 1000, '{"type":"text","text":"stale"}'),
            ('part_legacy', 'msg_legacy', 'ses_legacy', 1000, 1000, '{"type":"text","text":"legacy"}');
    "#).unwrap();
}

#[test]
fn opencode_v2_history_merges_legacy_sessions_without_duplicates() {
    let db = seed_v2_db();
    add_legacy_tables(&db);
    let mut sessions = Vec::new();
    find_drizzle_sessions_sqlite(&db, "opencode", "OpenCode Session", &mut sessions);
    assert_eq!(sessions.len(), 2, "only distinct, active root sessions");
    assert_eq!(sessions[0].name, "V2 task");
    assert_eq!(sessions[0].cwd, "/proj");
    assert_eq!(sessions[0].saved_at, "4000");
    assert_eq!(sessions[0].created_at.as_deref(), Some("2000"));
    assert_eq!(sessions[0].turn_count, Some(1));
    assert_eq!(sessions[1].session_token.as_deref(), Some("ses_legacy"));
    assert!(read_opencode_sqlite_session(&db, "ses_legacy").unwrap().contains("legacy"));
    std::fs::remove_file(db).unwrap();
}

#[test]
fn opencode_v2_heatmap_counts_chat_messages_once() {
    let db = seed_v2_db();
    add_legacy_tables(&db);
    let mut entries = Vec::new();
    collect_opencode_heatmap_entries(&db, 3, &mut entries);
    entries.sort_by_key(|entry| entry.ts);
    assert_eq!(entries.iter().map(|entry| (entry.ts, entry.count)).collect::<Vec<_>>(),
        vec![(4, 2), (5, 1)], "exclude old sessions, archived sessions and control events");
    std::fs::remove_file(db).unwrap();
}

#[test]
fn opencode_v2_preview_reads_inline_text_in_sequence_order() {
    let db = seed_v2_db();
    let data = read_opencode_sqlite_session(&db, "ses_main").unwrap();
    let rows: Vec<serde_json::Value> = data.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], "msg_prompt");
    assert_eq!(rows[0]["message"]["role"], "user");
    assert_eq!(rows[0]["message"]["content"][0]["text"], "你好");
    assert_eq!(rows[1]["message"]["role"], "assistant");
    assert_eq!(rows[1]["message"]["content"].as_array().unwrap().len(), 2);
    assert!(!data.contains("private reasoning"));
    let mut sessions = Vec::new();
    find_drizzle_sessions_sqlite(&db, "opencode", "OpenCode Session", &mut sessions);
    assert_eq!(sessions.len(), 1, "a V2-only database is discoverable");
    std::fs::remove_file(db).unwrap();
}

#[test]
fn opencode_v2_revision_tracks_streamed_text_and_legacy_sessions() {
    let db = seed_v2_db();
    add_legacy_tables(&db);
    let before = drizzle_session_revision(&db, "ses_main").unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("UPDATE session_message SET data = ?1, time_updated = 4500 WHERE id = 'msg_answer'",
        [r#"{"content":[{"type":"text","text":"Updated"}]}"#]).unwrap();
    drop(conn);
    assert_ne!(before, drizzle_session_revision(&db, "ses_main").unwrap());
    assert!(read_opencode_sqlite_session(&db, "ses_main").unwrap().contains("Updated"));
    assert!(drizzle_session_revision(&db, "ses_legacy").unwrap().starts_with("drizzle:"));
    std::fs::remove_file(db).unwrap();
}

#[test]
fn opencode_v2_preview_paginates_without_gaps_or_control_events() {
    let db = seed_v2_db();
    let mut conn = rusqlite::Connection::open(&db).unwrap();
    let transaction = conn.transaction().unwrap();
    for index in 0..205 {
        transaction.execute(
            "INSERT INTO session_message VALUES (?1, 'ses_main', 'assistant', ?2, 5000, 5000, ?3)",
            rusqlite::params![format!("msg_page_{index}"), 100 + index,
                serde_json::json!({"content": [{"type": "text", "text": format!("message {index}")}]}).to_string()],
        ).unwrap();
    }
    transaction.commit().unwrap();
    drop(conn);
    let tail = read_opencode_sqlite_session_page(&db, "ses_main", None).unwrap();
    let older = read_opencode_sqlite_session_page(&db, "ses_main", Some(tail.history_cursor)).unwrap();
    assert!(tail.has_older);
    assert_eq!(tail.data.lines().count(), CHAT_WINDOW_ROWS);
    assert!(!older.has_older);
    assert_eq!(older.data.lines().count() + tail.data.lines().count(), 207);
    assert!(older.data.contains("你好"));
    assert!(!older.data.contains("message 204"));
    std::fs::remove_file(db).unwrap();
}

#[test]
fn opencode_v2_transitional_schema_keeps_v1_only_sessions_readable() {
    let db = seed_v2_db();
    add_legacy_tables(&db);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("DROP TABLE session_v2").unwrap();
    drop(conn);
    assert!(read_opencode_sqlite_session(&db, "ses_main").unwrap().contains("你好"));
    assert!(read_opencode_sqlite_session(&db, "ses_legacy").unwrap().contains("legacy"));
    std::fs::remove_file(db).unwrap();
}

#[test]
fn opencode_v2_empty_migrated_session_does_not_restore_stale_v1_text() {
    let db = seed_v2_db();
    add_legacy_tables(&db);
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute("DELETE FROM session_message WHERE session_id = 'ses_main'", []).unwrap();
    drop(conn);
    let page = read_opencode_sqlite_session_page(&db, "ses_main", None).unwrap();
    assert!(page.data.is_empty());
    assert!(!page.has_older);
    assert!(drizzle_session_revision(&db, "ses_main").unwrap().starts_with("opencode-v2:0:"));
    let mut entries = Vec::new();
    collect_opencode_heatmap_entries(&db, 3, &mut entries);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].ts, 5, "only the child still has V2 messages");
    std::fs::remove_file(db).unwrap();
}

#[test]
fn opencode_sqlite_history_preserves_the_session_working_directory() {
    for table in ["session_v2", "session"] {
        let db = seed_v2_db();
        let conn = rusqlite::Connection::open(&db).unwrap();
        if table == "session" {
            conn.execute_batch("ALTER TABLE session_v2 RENAME TO session;
                DROP TABLE session_message;
                CREATE TABLE message (session_id TEXT);
                INSERT INTO message VALUES ('ses_main'), ('ses_main')").unwrap();
        }
        for tool in ["opencode", "mimocode", "kilo"] {
            let mut sessions = Vec::new();
            find_drizzle_sessions_sqlite(&db, tool, "Session", &mut sessions);
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].cwd, "/proj", "{table}/{tool}, no path column");
        }
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN path TEXT")).unwrap();
        for (directory, path) in [
            ("C:/Users/cxj/Desktop", Some("Users/cxj/Desktop")),
            ("F:/VibeCoding_workspace/GitShow/packages/app", Some("packages/app")),
            ("F:/VibeCoding_workspace/GitShow", Some("")),
            ("/home/user/work", Some("home/user/work")),
            ("/proj/packages/app", Some("packages/app")),
            ("/proj", Some(".")),
            ("/proj", None),
        ] {
            conn.execute(&format!("UPDATE {table} SET directory = ?1, path = ?2 WHERE id = 'ses_main'"),
                rusqlite::params![directory, path]).unwrap();
            for tool in ["opencode", "mimocode", "kilo"] {
                let mut sessions = Vec::new();
                find_drizzle_sessions_sqlite(&db, tool, "Session", &mut sessions);
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].cwd, directory, "{table}/{tool}, path={path:?}");
                assert_eq!(sessions[0].tool, tool);
            }
        }
        drop(conn);
        std::fs::remove_file(db).unwrap();
    }
}
