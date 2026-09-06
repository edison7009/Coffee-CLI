use super::*;

#[test]
fn history_cache_tracks_submillisecond_same_size_edits() {
    use std::fs::{File, FileTimes};
    use std::time::{Duration, UNIX_EPOCH};
    let path = temp_jsonl("precision");
    write_jsonl(&path, &[CODEX_HEADER, CODEX_USER]);
    let set_time = |nanos| {
        let time = UNIX_EPOCH + Duration::new(1_788_710_400, nanos);
        File::options().write(true).open(&path).unwrap()
            .set_times(FileTimes::new().set_modified(time)).unwrap();
    };
    set_time(100_000);
    let mut cache = new_cache();
    let before = scan_once(&mut cache, &path, "codex").unwrap();
    write_jsonl(&path, &[CODEX_HEADER, &CODEX_USER.replace("add retry backoff", "new retry backoff")]);
    set_time(800_000);
    let after = scan_once(&mut cache, &path, "codex").unwrap();
    assert_eq!(before.saved_at, after.saved_at, "display timestamps have millisecond precision");
    assert_eq!(after.name, "new retry backoff", "cache keys retain filesystem precision");
    let _ = std::fs::remove_file(path);
}

#[test]
fn codex_prefilter_accepts_unicode_escaped_json_keys_and_values() {
    let path = temp_jsonl("escaped-keys");
    let header = CODEX_HEADER.replace("session_meta", "session_\\u006deta");
    let user = CODEX_USER.replace("role", "r\\u006fle");
    write_jsonl(&path, &[&header, &user]);
    let session = cold_parse(&path, "codex").unwrap();
    assert_eq!(session.session_token.as_deref(), Some("sess-resume"));
    assert_eq!(session.name, "add retry backoff");
    let _ = std::fs::remove_file(path);
}

#[cfg(unix)]
#[test]
fn history_cache_distinguishes_non_utf8_paths_and_replaced_inodes() {
    use std::os::unix::ffi::OsStringExt;
    let directory = temp_jsonl("unix-paths").with_extension("");
    std::fs::create_dir_all(&directory).unwrap();
    let one = directory.join(std::ffi::OsString::from_vec(b"session-\xff.jsonl".to_vec()));
    let two = directory.join(std::ffi::OsString::from_vec(b"session-\xfe.jsonl".to_vec()));
    assert_eq!(one.to_string_lossy(), two.to_string_lossy());
    write_jsonl(&one, &[CODEX_HEADER, CODEX_USER]);
    write_jsonl(&two, &[CODEX_HEADER, &CODEX_USER.replace("add retry backoff", "new retry backoff")]);
    let mut cache = new_cache();
    scan_once(&mut cache, &one, "codex");
    assert_eq!(scan_once(&mut cache, &two, "codex").unwrap().name, "new retry backoff");
    assert_eq!(cache.entries.len(), 2);
    // Replacement keeps the size/mtime, but is a different inode.
    let time = std::fs::metadata(&one).unwrap().modified().unwrap();
    std::fs::File::options().write(true).open(&two).unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(time)).unwrap();
    std::fs::rename(&two, &one).unwrap();
    assert_eq!(scan_once(&mut cache, &one, "codex").unwrap().name, "new retry backoff");
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn history_walk_follows_directory_links_with_a_depth_limit() {
    let directory = temp_jsonl("linked-store").with_extension("");
    let root = directory.join("scan");
    let target = directory.join("target");
    let link = root.join("linked");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&target).unwrap();
    write_jsonl(&target.join("session.jsonl"), &[CODEX_HEADER, CODEX_USER]);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                "New-Item -ItemType Junction -Path $env:COFFEE_TEST_LINK -Target $env:COFFEE_TEST_TARGET -ErrorAction Stop | Out-Null"])
            .env("COFFEE_TEST_LINK", &link).env("COFFEE_TEST_TARGET", &target)
            .creation_flags(0x0800_0000).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    let mut found = Vec::new();
    collect_jsonl_paths_with_mtime(root.clone(), 2, "codex", &mut found);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].1, link.join("session.jsonl"));
    found.clear();
    collect_jsonl_paths_with_mtime(root, 1, "codex", &mut found);
    assert!(found.is_empty());
    #[cfg(unix)]
    std::fs::remove_file(link).unwrap();
    #[cfg(windows)]
    std::fs::remove_dir(link).unwrap();
    let _ = std::fs::remove_dir_all(directory);
}

fn write_jsonl(path: &std::path::Path, lines: &[&str]) {
    std::fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
}

const CODEX_HEADER: &str = r#"{"type":"session_meta","payload":{"id":"sess-resume","cwd":"/proj","timestamp":"2026-09-01T10:00:00.000Z","source":"cli"}}"#;
const CODEX_USER: &str = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"add retry backoff"}]}}"#;
const CODEX_ASSISTANT: &str = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#;

/// Every field the UI reads, as one comparable string. SavedSession has no
/// PartialEq, and adding one to a serialized API type purely for tests
/// isn't worth it.
fn session_fields(s: &SavedSession) -> String {
    format!(
        "{}|{}|{}|{}|{:?}|{}|{:?}|{:?}|{:?}",
        s.id, s.name, s.tool, s.cwd, s.session_token, s.saved_at,
        s.created_at, s.file_path, s.turn_count
    )
}

fn temp_jsonl(case: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "coffee-cli-history-{}-{}.jsonl",
        std::process::id(),
        case
    ))
}

fn append_lines(path: &std::path::Path, lines: &[&str]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    for l in lines {
        writeln!(f, "{}", l).unwrap();
    }
}

fn new_cache() -> SessionParseCache {
    SessionParseCache::default()
}

/// One cached-scan cycle — what a single history poll does for a file.
fn scan_once(
    cache: &mut SessionParseCache,
    path: &std::path::Path,
    tool: &str,
) -> Option<SavedSession> {
    let maps = std::collections::HashMap::new();
    parse_session_cached(cache, path, tool, &maps, &maps)
}

/// A cold, uncached parse — the reference a cached scan must match.
fn cold_parse(path: &std::path::Path, tool: &str) -> Option<SavedSession> {
    let maps = std::collections::HashMap::new();
    parse_session_file(path, tool, &maps, &maps)
}

fn assert_matches_cold(cache: &mut SessionParseCache, path: &std::path::Path, tool: &str, stage: &str) {
    let cached = scan_once(cache, path, tool);
    let cold = cold_parse(path, tool);
    assert_eq!(
        cached.as_ref().map(session_fields),
        cold.as_ref().map(session_fields),
        "{stage}: cached scan diverged from a cold parse"
    );
}

/// Rows carrying neither `session_meta` nor a bare `"role"` key are
/// rejected before the JSON parse. Reasoning, function_call,
/// function_call_output and turn_context rows are the bulk of a real
/// rollout and none of them can contribute a title, a cwd or a count.
#[test]
fn codex_parser_counts_only_message_rows_amid_tool_noise() {
    let path = temp_jsonl("noise");
    write_jsonl(&path, &[
        CODEX_HEADER,
        CODEX_USER,
        r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking about the retry budget"}]}}"#,
        r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"cmd\":[\"cargo\",\"test\"]}"}}"#,
        // Tool output that EMBEDS a role. Inside a JSON string the quotes
        // arrive escaped (`\"role\"`), so the bare `"role"` needle doesn't
        // match and the row is rejected — which is what a full parse would
        // have concluded anyway, since `payload.role` is absent.
        r#"{"type":"response_item","payload":{"type":"function_call_output","output":"{\"role\":\"user\",\"text\":\"injected\"}"}}"#,
        // cwd here differs from the header: proves the header wins and a
        // later turn_context row is not mistaken for session metadata.
        r#"{"type":"turn_context","payload":{"model":"gpt-5","cwd":"/elsewhere"}}"#,
        CODEX_ASSISTANT,
    ]);

    let got = parse_codex_session_jsonl(&path).expect("rollout should parse");
    assert_eq!(got.name, "add retry backoff", "title = first real user message");
    assert_eq!(got.cwd, "/proj", "cwd = session_meta, not the later turn_context");
    assert_eq!(got.session_token.as_deref(), Some("sess-resume"));
    // 1 user + 1 assistant = 2 counted rows -> (2+1)/2 = 1. A needle loose
    // enough to admit the escaped-role output, or tight enough to drop a
    // real message row, would both move this.
    assert_eq!(got.turn_count, Some(1));
    let _ = std::fs::remove_file(&path);
}

/// An unchanged file is served from the cache without being re-read. Proved
/// by overwriting the cached entry's name with a sentinel: the file on disk
/// still holds the real title, so only a cache hit can return it.
#[test]
fn history_parse_cache_serves_unchanged_file_without_rereading() {
    let path = temp_jsonl("hit");
    write_jsonl(&path, &[CODEX_HEADER, CODEX_USER]);
    let mut cache = new_cache();

    let first = scan_once(&mut cache, &path, "codex").expect("probe should parse");
    assert_eq!(first.name, "add retry backoff");
    assert_eq!(cache.entries.len(), 1, "first parse populates the cache");

    let key = path.to_path_buf();
    cache.entries.get_mut(&key).unwrap().session.name =
        "SENTINEL-FROM-CACHE".to_string();

    let second = scan_once(&mut cache, &path, "codex").expect("cached entry");
    assert_eq!(second.name, "SENTINEL-FROM-CACHE", "an unchanged file must not be re-read");
    assert_eq!(cache.entries.len(), 1, "a hit must not add a second entry");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn history_cache_does_not_persist_missing_or_rejected_sessions() {
    let path = temp_jsonl("cache-reject");
    let rejected = CODEX_HEADER.replace("\"cli\"", "{\"subagent\":{}}");
    write_jsonl(&path, &[&rejected, CODEX_USER]);
    let mut cache = new_cache();
    assert!(scan_once(&mut cache, &path, "codex").is_none());
    assert!(cache.entries.is_empty());
    write_jsonl(&path, &[CODEX_HEADER, CODEX_USER]);
    assert!(scan_once(&mut cache, &path, "codex").is_some());
    std::fs::remove_file(&path).unwrap();
    assert!(scan_once(&mut cache, &path, "codex").is_none());
    assert!(cache.entries.is_empty());
}

/// The cwd fallback comes from ~/.claude.json / ~/.gemini/projects.json.
/// When either moves, a cached entry could be holding a cwd resolved from
/// the older map, so the whole cache is dropped.
#[test]
fn history_parse_cache_drops_entries_when_aux_maps_move() {
    let path = temp_jsonl("aux");
    write_jsonl(&path, &[CODEX_HEADER, CODEX_USER]);
    let mut cache = new_cache();
    let empty = std::collections::HashMap::new();
    scan_once(&mut cache, &path, "codex").unwrap();
    assert!(!sync_aux_generation(&mut cache, &empty, &empty));
    assert_eq!(cache.entries.len(), 1);
    let claude = std::collections::HashMap::from([("project".to_string(), "/new/path".to_string())]);
    assert!(sync_aux_generation(&mut cache, &claude, &empty));
    assert!(cache.entries.is_empty());
    assert!(!sync_aux_generation(&mut cache, &claude, &empty));
    scan_once(&mut cache, &path, "codex").unwrap();
    assert!(sync_aux_generation(&mut cache, &claude, &claude));
    assert!(cache.entries.is_empty());
    let _ = std::fs::remove_file(&path);
}

// Cached and cold results must agree after every append.
#[test]
fn history_cache_matches_cold_after_append_codex() {
    let path = temp_jsonl("codex-equiv");
    write_jsonl(&path, &[CODEX_HEADER]);
    let mut cache = new_cache();

    let stages: Vec<( &str, Vec<&str>)> = vec![
        ("first user turn", vec![CODEX_USER]),
        // Non-message rows: dropped by the prefilter on the cold path and
        // by the same filter on each scan, so they must not move the
        // tally either way.
        ("tool noise", vec![
            r#"{"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"thinking"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call_output","output":"{\"role\":\"user\"}"}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-5","cwd":"/elsewhere"}}"#,
        ]),
        ("first assistant turn", vec![CODEX_ASSISTANT]),
        ("second exchange", vec![
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"and again"}]}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}"#,
        ]),
    ];

    for (stage, lines) in &stages {
        append_lines(&path, lines);
        assert_matches_cold(&mut cache, &path, "codex", stage);
    }

    let got = scan_once(&mut cache, &path, "codex").expect("session");
    assert_eq!(got.name, "add retry backoff", "title stays the first user message");
    assert_eq!(got.cwd, "/proj", "cwd stays the header value");
    assert_eq!(got.session_token.as_deref(), Some("sess-resume"));
    // 2 user + 2 assistant = 4 counted rows -> (4+1)/2 = 2
    assert_eq!(got.turn_count, Some(2));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn history_cache_matches_cold_after_append_claude() {
    let path = temp_jsonl("claude-equiv");
    write_jsonl(&path, &[
        r#"{"sessionId":"s-claude","cwd":"/proj","timestamp":"2026-09-01T10:00:00.000Z","message":{"role":"user","content":"refactor the parser"}}"#,
    ]);
    let mut cache = new_cache();

    let stages: Vec<(&str, Vec<&str>)> = vec![
        ("assistant reply", vec![
            r#"{"cwd":"/proj","message":{"role":"assistant","content":"ok"}}"#,
        ]),
        // An injected user row: counts as a message but NOT as a real user
        // turn, on both paths.
        ("ide injection", vec![
            r#"{"cwd":"/proj","message":{"role":"user","content":"<environment_context>cwd=/proj</environment_context>"}}"#,
        ]),
        ("second exchange", vec![
            r#"{"cwd":"/proj","message":{"role":"user","content":"now the tests"}}"#,
            r#"{"cwd":"/proj","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}"#,
        ]),
    ];

    assert_matches_cold(&mut cache, &path, "claude", "header only");
    for (stage, lines) in &stages {
        append_lines(&path, lines);
        assert_matches_cold(&mut cache, &path, "claude", stage);
    }

    let got = scan_once(&mut cache, &path, "claude").expect("session");
    assert_eq!(got.name, "refactor the parser", "title = first real user message");
    assert_eq!(got.cwd, "/proj");
    // 1 + 1 + 1 + 2 = 5 counted rows -> (5+1)/2 = 3
    assert_eq!(got.turn_count, Some(3));
    let _ = std::fs::remove_file(&path);
}

/// A scan can land while the agent is mid-write. An unterminated trailing
/// line must be left alone: consuming it would lose its tail forever and
/// start the next scan in the middle of a row.
#[test]
fn history_cache_retries_partial_trailing_line() {
    let path = temp_jsonl("partial");
    write_jsonl(&path, &[CODEX_HEADER]);
    let mut cache = new_cache();
    scan_once(&mut cache, &path, "codex");

    // One complete user row, then HALF an assistant row with no newline.
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(f, "{}", CODEX_USER).unwrap();
        write!(f, r#"{{"type":"response_item","payload":{{"type":"message","role":"assi"#).unwrap();
    }
    let partial = scan_once(&mut cache, &path, "codex").expect("session");
    assert_eq!(partial.turn_count, Some(1), "the half-written row must not be counted");

    // Completing the row makes it count, and still agrees with a cold parse.
    append_lines(&path, &[r#"stant","content":[{"type":"output_text","text":"yo"}]}}"#]);
    assert_matches_cold(&mut cache, &path, "codex", "completed row");
    assert_eq!(scan_once(&mut cache, &path, "codex").unwrap().turn_count, Some(1));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn history_cache_reparses_shrunk_file() {
    let path = temp_jsonl("shrink");
    write_jsonl(&path, &[CODEX_HEADER, CODEX_USER, CODEX_ASSISTANT, CODEX_ASSISTANT]);
    let mut cache = new_cache();
    let first = scan_once(&mut cache, &path, "codex").expect("session");
    assert_eq!(first.name, "add retry backoff");
    assert_eq!(first.turn_count, Some(2), "1 user + 3 assistant -> (4+1)/2");

    // Rewrite shorter, with a different first user turn.
    write_jsonl(&path, &[
        CODEX_HEADER,
        r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second life"}]}}"#,
    ]);
    let got = scan_once(&mut cache, &path, "codex").expect("session");
    assert_eq!(got.name, "second life", "a shrunk file must be reparsed, not reused");
    assert_eq!(got.turn_count, Some(1));
    assert_eq!(session_fields(&got), session_fields(&cold_parse(&path, "codex").unwrap()));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn claude_rejection_flips_to_session_when_a_real_user_turn_is_appended() {
    let path = temp_jsonl("claude-flip");
    write_jsonl(&path, &[
        "{\"sessionId\":\"s-flip\",\"cwd\":\"/proj\",\"message\":{\"role\":\"user\",\"content\":\"Below is a conversation log from a Claude Code coding session.\\nCreate a summary.\"}}",
        "{\"cwd\":\"/proj\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"# Session Summary\"}]}}",
    ]);
    let mut cache = new_cache();
    assert!(scan_once(&mut cache, &path, "claude").is_none(), "compaction sub-task is not listed");

    append_lines(&path, &[
        r#"{"cwd":"/proj","message":{"role":"user","content":"continue the refactor"}}"#,
    ]);
    let got = scan_once(&mut cache, &path, "claude").expect("now a real session");
    assert_eq!(got.name, "continue the refactor");
    assert_eq!(session_fields(&got), session_fields(&cold_parse(&path, "claude").unwrap()));
    let _ = std::fs::remove_file(&path);
}

#[test]
fn history_review_reparses_a_larger_replacement() {
    let path = temp_jsonl("review-grow-rewrite");
    write_jsonl(&path, &[CODEX_HEADER, CODEX_USER]);
    let mut cache = new_cache();
    scan_once(&mut cache, &path, "codex");
    let renamed = CODEX_USER.replace("add retry backoff", "a completely different conversation");
    write_jsonl(&path, &[CODEX_HEADER, &renamed, CODEX_ASSISTANT]);
    assert_matches_cold(&mut cache, &path, "codex", "larger replacement");
    let _ = std::fs::remove_file(path);
}

#[test]
fn history_review_rechecks_replaced_subagent() {
    let path = temp_jsonl("review-rejected-rewrite");
    let rejected = CODEX_HEADER.replace("\"cli\"", "{\"subagent\":{\"thread_spawn\":{}}}");
    write_jsonl(&path, &[&rejected, CODEX_USER]);
    let mut cache = new_cache();
    assert!(scan_once(&mut cache, &path, "codex").is_none());
    write_jsonl(&path, &[CODEX_HEADER, CODEX_USER]);
    assert_matches_cold(&mut cache, &path, "codex", "rejected file replaced");
    let _ = std::fs::remove_file(path);
}

#[test]
fn history_review_does_not_recount_unterminated_valid_json() {
    let path = temp_jsonl("review-unterminated");
    std::fs::write(&path, format!("{CODEX_HEADER}\r\n{CODEX_USER}\r\n{CODEX_ASSISTANT}")).unwrap();
    let mut cache = new_cache();
    assert_matches_cold(&mut cache, &path, "codex", "valid JSON without newline");
    append_lines(&path, &[""]);
    assert_matches_cold(&mut cache, &path, "codex", "newline completed");
    let _ = std::fs::remove_file(path);
}

#[test]
fn history_review_observes_appended_claude_metadata() {
    let path = temp_jsonl("review-claude-metadata");
    write_jsonl(&path, &[r#"{"sessionId":"before","cwd":"/proj","message":{"role":"user","content":"hello"}}"#]);
    let mut cache = new_cache();
    scan_once(&mut cache, &path, "claude");
    append_lines(&path, &[r#"{"sessionId":"after","timestamp":"2026-09-07T00:00:00Z","message":{"role":"assistant","content":"ok"}}"#]);
    assert_matches_cold(&mut cache, &path, "claude", "later session id and timestamp");
    let _ = std::fs::remove_file(path);
}
