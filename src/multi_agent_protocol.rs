//! Multi-agent protocol templates and workspace-file injection.
//!
//! Two-tier layout (v1.1):
//!
//!   <workspace>/.multi-agent/
//!     ├── PROTOCOL.md   — full protocol body (the long version)
//!     └── README.md     — human-facing note: "this dir is auto-generated"
//!
//!   <workspace>/
//!     ├── CLAUDE.md   ┐  each contains a *thin pointer* (5 lines) wrapped
//!     ├── AGENTS.md   │  in <!-- COFFEE-CLI:MULTI-AGENT:START/END --> markers
//!     └── GEMINI.md   ┘  that directs the CLI's LLM to `.multi-agent/PROTOCOL.md`
//!
//! Rationale: users asked us not to clutter the workspace root. The three
//! root-level md files are a hard constraint (Claude Code / Codex / Gemini
//! will only pick up configuration from their specific filenames at the
//! project root), so we keep them as minimal 5-line pointers. All the
//! long-form text lives in `.multi-agent/PROTOCOL.md` and doesn't touch
//! the user's daily file listing.
//!
//! Merge behavior: if the user already has content in their CLAUDE.md,
//! we splice in only the marker block; on uninstall we surgically remove
//! it and leave the rest intact.
//!
//! See docs/MULTI-AGENT-ARCHITECTURE.md §5.4 for the original spec and
//! the 2026-04-23 decision log entry for why we switched from "full body
//! in root" to this thin-pointer + `.multi-agent/` layout.

use std::{fs, path::Path};

/// Markers delimit the Coffee-CLI-managed section so we can splice it
/// into an existing file without clobbering user content, and remove it
/// cleanly on disable. Do NOT change these strings once shipped — they
/// are the contract with existing user files on disk.
pub const START_MARKER: &str = "<!-- COFFEE-CLI:MULTI-AGENT:START -->";
pub const END_MARKER: &str = "<!-- COFFEE-CLI:MULTI-AGENT:END -->";

/// Name of the per-workspace subdirectory where we park the long-form
/// protocol and any metadata (endpoint, backups, …).
pub const META_DIR: &str = ".multi-agent";

/// Short note the root CLAUDE.md / AGENTS.md / GEMINI.md each contain.
/// Whatever primary CLI is reading this will see a one-paragraph
/// directive to go read `.multi-agent/PROTOCOL.md` for the full rules.
const THIN_POINTER_BODY: &str = r#"# Coffee-CLI Multi-Agent

You're running inside a Coffee-CLI four-pane quadrant. Three MCP tools
are available via the `coffee-cli` MCP server — `list_panes`,
`send_to_pane`, and `read_pane` — for observing and instructing the
other peer panes.

## Must-follow rules (do NOT skip)

1. **English only across panes.** The user may write to you in any
   language, but every `send_to_pane` text MUST be in English. LLMs
   follow instructions more reliably in English — this is why the
   rule exists, not stylistic preference. Translate the target's
   reply back to the user's language when reporting results.

2. **Pane numbering is 1..4.** UI badges and MCP session ids match:
   the pane labelled "2" has id ending `::pane-2`. Call `list_panes()`
   to get exact ids before dispatching.

3. **Prefer slash commands** when the target CLI supports one for the
   task (e.g. `/review`, `/compact`). If unsure, send `/help` first.
   Don't invent commands — if none fits, use natural English prose.

Full usage protocol (fan-out patterns, cross-CLI command catalog, what
NOT to use these tools for): read `.multi-agent/PROTOCOL.md`.
"#;

/// Long-form protocol written to `.multi-agent/PROTOCOL.md`. The primary
/// CLI's LLM reaches this via the thin pointer at the workspace root.
/// Language stays English: primary CLIs' system prompts are English and
/// mixed-language protocol text confuses some models.
const FULL_PROTOCOL_BODY: &str = r#"# Coffee-CLI Multi-Agent Protocol

You are running inside Coffee-CLI, a desktop container that lets multiple
terminal-based coding agents (Claude Code, Codex, Gemini CLI) work
side-by-side as visible peer panes.

## Pane numbering

The UI shows 4 panes with badges numbered **1, 2, 3, 4** in the top-right
of each pane. The MCP session ids carry the same number — id ends in
`::pane-1`, `::pane-2`, `::pane-3`, or `::pane-4`. When the user says
"pane 2" or "2号窗口", call `send_to_pane` with the id whose suffix is
`::pane-2`. `list_panes()` returns the full ids — never guess; always
list first, then target by exact id.

You have access to 3 MCP tools via the `coffee-cli` MCP server that let
you observe and instruct the OTHER panes. **These tools do NOT replace
your own internal subagent SDK** — prefer your native subagent when the
task is just another instance of yourself (see "When NOT to use" below).

## The 3 tools

- `list_panes()` — discover pane ids, the CLI running in each pane, and
  its current state (empty / idle / busy / terminated).
- `send_to_pane(id, text, timeout_sec?, wait?)` — send a command to
  another pane. If `wait=true` (default), blocks until the pane is idle
  or timeout (default 60s); returns the pane's output. If `wait=false`,
  returns immediately — read progress later with `read_pane`.
- `read_pane(id, last_n_lines?)` — read recent output (ANSI-stripped).

## Sending patterns

**Short task (< 2 min):** use `send_to_pane(wait=true, timeout_sec<=120)`;
you get the completed output directly as the tool result.

**Long task (> 2 min):** use `send_to_pane(wait=false)`. Tell the user
"I dispatched the task to pane X; ask me when to check". Later, call
`read_pane(X)` and reason about `is_idle`.

## Parallel fan-out pattern

When the user asks multiple agents to work simultaneously ("let Codex
and Gemini each design this"), you MUST issue all `send_to_pane` calls
in a SINGLE assistant turn (one reply with multiple parallel tool_use
blocks). Do NOT serialize them — that defeats the entire point of
multiple agents.

Correct (one turn, three parallel tool calls):
  - send_to_pane("pane-1", prompt, wait=true, timeout_sec=180)
  - send_to_pane("pane-2", prompt, wait=true, timeout_sec=180)
  - send_to_pane("pane-3", prompt, wait=true, timeout_sec=180)

Wrong (three sequential turns, each waiting for the previous result):
3x slower and loses the whole advantage.

For > 2 min tasks or 3+ targets, use `wait=false` for fan-out, then
`read_pane` for each in parallel when the user asks for results.

## Prompt completeness

The target pane sees ONLY the text you send — not your conversation
history, not what the user told you, not files you opened. Include every
piece of context the target needs to act independently. Short, concrete,
self-contained prompts work best.

## Cross-pane language: always English

Every `send_to_pane` call's `text` field MUST be in English, regardless
of the language the user speaks to you. Translate the user's intent to
clear English before dispatching.

Why: tool-use accuracy, instruction following, and latency are all
measurably better when LLMs are driven in English. This is consistent
across Claude / Codex / Gemini — their training data and reinforcement
skew English-heavy. Cross-language hand-offs are where multi-agent
systems most often misfire.

Three rules:
1. **User → you**: accept any language (Chinese, Japanese, etc.).
2. **You → another pane** (via `send_to_pane`): always English, even
   when it feels unnatural. If the user asked in Chinese, mentally
   translate their request, then write the pane prompt in English.
3. **Reporting back to the user**: translate the target pane's reply
   back into the user's language before including it in your response.

Exception: when the task's deliverable INTRINSICALLY requires another
language — writing Chinese marketing copy, translating a document,
editing a localized UI string — include the output-language requirement
explicitly inside the English prompt. For example:

  send_to_pane("...::pane-2", "Write a Chinese marketing tagline for
   a coffee shop targeting young professionals. Output must be in
   Simplified Chinese; do not include English.")

The INSTRUCTION is English; only the requested OUTPUT is non-English.

## Slash commands across panes

Each primary CLI has its own set of built-in `/` commands. Well-targeted
slash commands beat natural-language prompts when a matching one exists:
less ambiguity, fewer tokens, and the CLI's own optimized code path.

Known built-in commands in recent versions (surface changes between
releases — treat this as a starting point, not gospel):

**Claude Code (target has tool="claude")**:
  /help /clear /compact /model /agents /doctor /config /init
  /memory /review /mcp /cost /permissions /export /bug /vim
  User commands: ~/.claude/commands/ and .claude/commands/
  Skills:       ~/.claude/skills/ and .claude/skills/

**Codex CLI (target has tool="codex")**:
  /help /model /clear /compact /approvals /status /new
  User commands: ~/.codex/commands/

**Gemini CLI (target has tool="gemini")**:
  /help /clear /memory /theme /auth /stats /tools /compress /mcp /chat
  User commands: .gemini/commands/ (TOML format)

Rules:
1. Check the target's `cli` field in list_panes() BEFORE crafting your
   send_to_pane text — a /agents command makes sense to Claude and
   means nothing to Codex.
2. Use a slash command when one exists for the task at hand. If you
   aren't sure of the exact syntax, send `/help` first with wait=true
   to let the target print its own command list, then dispatch.
3. User-defined custom commands (project-specific workflows, skills)
   can't be discovered cross-process. Either rely on natural-language
   prompts, or ask the target "list your / commands" and parse the
   reply before dispatching.
4. Don't invent commands. If you're unsure a command exists, prefer
   a short natural-language instruction. A made-up /command that the
   target doesn't recognize just wastes a round-trip.

## When NOT to use these tools

DO NOT reach for `send_to_pane` just to spawn an internal subagent. Each
primary CLI has its own native subagent mechanism — use that for
intra-CLI parallelism:

  - Claude Code  → Agent Teams (/agent spawn, Shift+Down to cycle)
  - Codex CLI    → Codex subagents / rescue
  - Gemini CLI   → Gemini agent framework

USE `send_to_pane` ONLY when the user wants a DIFFERENT CLI (running in
another pane) to do the work. The whole point of Coffee-CLI's multi-agent
mode is cross-CLI collaboration, not yet-another-way to spawn subagents.

Rule of thumb: if another version of you could do this, use your native
subagent. If the answer needs a DIFFERENT CLI's strength (Gemini's
vision, Codex's code gen, etc.), reach for `send_to_pane`.

## What NOT to do

- Do NOT send commands to your own pane id (you'd be talking to
  yourself — call `list_panes()` first to find targets).
- Do NOT assume panes share files you created, git state, or conversation
  history. They are separate processes in separate CLIs.
- Do NOT build automatic multi-step pipelines (pane A → auto-trigger
  pane B → auto-trigger pane C). Summarize for the user after each hop
  and let them decide the next step.
- Do NOT call the Coffee-CLI MCP tools for work your own CLI can do
  alone — that is cost without benefit.
"#;

const META_DIR_README: &str = r#"# Coffee-CLI Multi-Agent Workspace Metadata

This directory is auto-generated by Coffee-CLI when you open a
four-pane (multi-agent) Tab against this workspace. You shouldn't need
to edit anything inside it by hand — Coffee-CLI rewrites these files
every time the multi-agent mode is enabled.

Files here:

- `PROTOCOL.md` — the full usage protocol that each pane's CLI reads
  (indirectly, via the thin pointer in the workspace's `CLAUDE.md` /
  `AGENTS.md` / `GEMINI.md`).
- `endpoint.json` — the localhost URL and session key of the running
  `coffee-cli` MCP server. Useful for debugging; regenerated on every
  app launch.

Safe to delete: if you close Coffee-CLI and delete this folder, the
next launch will recreate it. The root `CLAUDE.md` / `AGENTS.md` /
`GEMINI.md` pointers are left untouched by that deletion and can be
removed separately via Coffee-CLI's disable action.

You can add this directory to `.gitignore` if you don't want to commit
it to your project's history.
"#;

// ---------- Low-level helpers (unchanged from v1.0) ----------

/// Build the thin-pointer block we splice between the markers at the
/// workspace root.
fn marker_block() -> String {
    format!(
        "{start}\n{body}\n{end}\n",
        start = START_MARKER,
        body = THIN_POINTER_BODY.trim_end(),
        end = END_MARKER,
    )
}

/// Insert (or refresh) our block in one `.md` file.
///
/// Behavior:
/// - Missing file → create it with just our block.
/// - Existing file, no markers → append a separator + our block.
/// - Existing file with markers → replace only the delimited region.
///
/// Returns `true` if the file was written, `false` if the block was
/// already up to date (no-op).
fn upsert_protocol_block(path: &Path) -> std::io::Result<bool> {
    let new_block = marker_block();
    let existing = fs::read_to_string(path).unwrap_or_default();

    let updated = match (existing.find(START_MARKER), existing.find(END_MARKER)) {
        (Some(start), Some(end)) if end > start => {
            let end_marker_end = end + END_MARKER.len();
            let mut s = String::with_capacity(existing.len() + new_block.len());
            s.push_str(&existing[..start]);
            s.push_str(new_block.trim_end_matches('\n'));
            s.push_str(&existing[end_marker_end..]);
            s
        }
        _ => {
            if existing.is_empty() {
                new_block.clone()
            } else if existing.ends_with('\n') {
                format!("{}\n{}", existing, new_block)
            } else {
                format!("{}\n\n{}", existing, new_block)
            }
        }
    };

    if updated == existing {
        return Ok(false);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, updated)?;
    Ok(true)
}

/// Remove our marker block from a file without touching other content.
/// Missing file or missing markers are silent no-ops.
fn remove_protocol_block(path: &Path) -> std::io::Result<bool> {
    let existing = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };

    let start = match existing.find(START_MARKER) {
        Some(i) => i,
        None => return Ok(false),
    };
    let end = match existing.find(END_MARKER) {
        Some(i) => i + END_MARKER.len(),
        None => return Ok(false),
    };
    if end <= start {
        return Ok(false);
    }

    let mut stripped = String::with_capacity(existing.len());
    stripped.push_str(existing[..start].trim_end_matches(|c: char| c == '\n' || c == '\r'));
    stripped.push_str(&existing[end..]);
    let cleaned = stripped.trim_start_matches(|c: char| c == '\n' || c == '\r');
    let cleaned = cleaned.trim_end_matches(|c: char| c == '\n' || c == '\r');

    if cleaned.is_empty() {
        fs::remove_file(path)?;
        return Ok(true);
    }

    fs::write(path, format!("{}\n", cleaned))?;
    Ok(true)
}

// ---------- `.multi-agent/` directory management (v1.1) ----------

/// Create `<workspace>/.multi-agent/` (idempotent), write `PROTOCOL.md`
/// and `README.md`. Returns the paths touched. An optional
/// `endpoint_json` string is written to `endpoint.json` if provided —
/// callers pass the serialized `McpEndpoint` so the user can see where
/// the current coffee-cli MCP server is listening.
pub fn install_meta_dir(
    workspace_root: &Path,
    endpoint_json: Option<&str>,
) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut touched = Vec::new();
    let meta_dir = workspace_root.join(META_DIR);
    fs::create_dir_all(&meta_dir)?;

    let protocol_path = meta_dir.join("PROTOCOL.md");
    if write_if_changed(&protocol_path, FULL_PROTOCOL_BODY)? {
        touched.push(protocol_path);
    }

    let readme_path = meta_dir.join("README.md");
    if write_if_changed(&readme_path, META_DIR_README)? {
        touched.push(readme_path);
    }

    if let Some(json) = endpoint_json {
        let endpoint_path = meta_dir.join("endpoint.json");
        if write_if_changed(&endpoint_path, json)? {
            touched.push(endpoint_path);
        }
    }

    Ok(touched)
}

/// Remove the `.multi-agent/` directory if present. Best-effort: a
/// missing directory or a dir with unexpected extra files returns Ok
/// with no path touched rather than erroring.
pub fn uninstall_meta_dir(workspace_root: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let meta_dir = workspace_root.join(META_DIR);
    if !meta_dir.exists() {
        return Ok(Vec::new());
    }
    // Only remove files we know we wrote, so a user who dropped their
    // own notes inside doesn't lose data.
    let mut touched = Vec::new();
    for name in ["PROTOCOL.md", "README.md", "endpoint.json"] {
        let p = meta_dir.join(name);
        if p.exists() {
            fs::remove_file(&p)?;
            touched.push(p);
        }
    }
    // If the directory is now empty, remove it too.
    if let Ok(mut entries) = fs::read_dir(&meta_dir) {
        if entries.next().is_none() {
            let _ = fs::remove_dir(&meta_dir);
        }
    }
    Ok(touched)
}

fn write_if_changed(path: &Path, body: &str) -> std::io::Result<bool> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if existing == body {
        return Ok(false);
    }
    fs::write(path, body)?;
    Ok(true)
}

// ---------- Public entry points ----------

/// Write CLAUDE.md, AGENTS.md, GEMINI.md thin pointers at the workspace
/// root AND install `<workspace>/.multi-agent/` with the full protocol.
/// `endpoint_json` (optional) becomes `.multi-agent/endpoint.json`.
pub fn install(
    workspace_root: &Path,
    endpoint_json: Option<&str>,
) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut touched = Vec::new();

    // 1. Meta directory first, because the thin pointer refers to
    //    `.multi-agent/PROTOCOL.md` — having it live before the CLI
    //    reads the root .md avoids a "file not found" confusion.
    touched.extend(install_meta_dir(workspace_root, endpoint_json)?);

    // 2. Root-level thin pointers.
    for name in ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] {
        let p = workspace_root.join(name);
        if upsert_protocol_block(&p)? {
            touched.push(p);
        }
    }
    Ok(touched)
}

/// Strip Coffee-CLI's marker block from all three root .md files AND
/// remove the `.multi-agent/` subdirectory (files we own only).
pub fn uninstall(workspace_root: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut touched = Vec::new();
    for name in ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] {
        let p = workspace_root.join(name);
        if remove_protocol_block(&p)? {
            touched.push(p);
        }
    }
    touched.extend(uninstall_meta_dir(workspace_root)?);
    Ok(touched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "coffee-cli-map-test-{}-{}",
            std::process::id(),
            name
        ));
        p
    }

    fn tmp_workspace(name: &str) -> PathBuf {
        let p = tmp_path(name);
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn thin_pointer_mentions_meta_dir() {
        assert!(THIN_POINTER_BODY.contains(".multi-agent/PROTOCOL.md"));
        // Grew from a 5-line pointer to ~30 lines once we inlined the
        // three must-follow rules (English, 1..4 numbering, slash
        // commands). Still bounded to stay a pointer and not a full
        // manual — keep the bulk in PROTOCOL.md.
        assert!(THIN_POINTER_BODY.lines().count() < 40);
    }

    #[test]
    fn installs_into_empty_file() {
        let p = tmp_path("empty.md");
        let _ = fs::remove_file(&p);
        assert!(upsert_protocol_block(&p).unwrap());
        let content = fs::read_to_string(&p).unwrap();
        assert!(content.contains(START_MARKER));
        assert!(content.contains(END_MARKER));
        assert!(content.contains("Coffee-CLI Multi-Agent"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn appends_without_overwriting_user_content() {
        let p = tmp_path("user.md");
        fs::write(&p, "# My rules\n\nDo not touch this.\n").unwrap();
        assert!(upsert_protocol_block(&p).unwrap());
        let content = fs::read_to_string(&p).unwrap();
        assert!(content.contains("Do not touch this."));
        assert!(content.contains(START_MARKER));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn refreshes_existing_block_in_place() {
        let p = tmp_path("refresh.md");
        fs::write(
            &p,
            format!(
                "# Top\n\n{start}\nOLD BLOCK\n{end}\n\n# Bottom\n",
                start = START_MARKER,
                end = END_MARKER,
            ),
        )
        .unwrap();
        assert!(upsert_protocol_block(&p).unwrap());
        let content = fs::read_to_string(&p).unwrap();
        assert!(content.contains("# Top"));
        assert!(content.contains("# Bottom"));
        assert!(!content.contains("OLD BLOCK"));
        assert!(content.contains("Coffee-CLI Multi-Agent"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn uninstall_leaves_user_content_intact() {
        let p = tmp_path("uninstall.md");
        fs::write(
            &p,
            format!(
                "# Top\n\n{start}\nwhatever\n{end}\n\n# Bottom\n",
                start = START_MARKER,
                end = END_MARKER,
            ),
        )
        .unwrap();
        assert!(remove_protocol_block(&p).unwrap());
        let content = fs::read_to_string(&p).unwrap();
        assert!(content.contains("# Top"));
        assert!(content.contains("# Bottom"));
        assert!(!content.contains(START_MARKER));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn uninstall_deletes_file_if_only_our_block() {
        let p = tmp_path("solo.md");
        upsert_protocol_block(&p).unwrap();
        assert!(remove_protocol_block(&p).unwrap());
        assert!(!p.exists(), "solo-content .md should be deleted on uninstall");
    }

    #[test]
    fn upsert_is_idempotent_when_already_current() {
        let p = tmp_path("idem.md");
        let _ = fs::remove_file(&p);
        assert!(upsert_protocol_block(&p).unwrap());
        assert!(!upsert_protocol_block(&p).unwrap());
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn install_meta_dir_writes_protocol_and_readme() {
        let ws = tmp_workspace("meta-install");
        let touched = install_meta_dir(&ws, None).unwrap();
        assert!(ws.join(META_DIR).is_dir());
        assert!(ws.join(META_DIR).join("PROTOCOL.md").exists());
        assert!(ws.join(META_DIR).join("README.md").exists());
        assert!(!ws.join(META_DIR).join("endpoint.json").exists());
        assert_eq!(touched.len(), 2);

        let protocol = fs::read_to_string(ws.join(META_DIR).join("PROTOCOL.md")).unwrap();
        assert!(protocol.contains("Coffee-CLI Multi-Agent Protocol"));
        assert!(protocol.contains("list_panes"));

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn install_meta_dir_writes_endpoint_when_provided() {
        let ws = tmp_workspace("meta-endpoint");
        let json = r#"{"url":"http://127.0.0.1:55555/mcp","port":55555}"#;
        install_meta_dir(&ws, Some(json)).unwrap();
        let ep = fs::read_to_string(ws.join(META_DIR).join("endpoint.json")).unwrap();
        assert_eq!(ep, json);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn install_meta_dir_is_idempotent() {
        let ws = tmp_workspace("meta-idem");
        install_meta_dir(&ws, None).unwrap();
        // Second call with identical bodies should change nothing.
        let touched = install_meta_dir(&ws, None).unwrap();
        assert_eq!(touched.len(), 0);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn uninstall_meta_dir_removes_known_files_only() {
        let ws = tmp_workspace("meta-uninstall");
        install_meta_dir(&ws, Some("{}")).unwrap();
        // User dropped their own note inside — must not be deleted.
        fs::write(ws.join(META_DIR).join("user-notes.txt"), "mine").unwrap();

        let touched = uninstall_meta_dir(&ws).unwrap();
        assert_eq!(touched.len(), 3, "PROTOCOL + README + endpoint all removed");
        assert!(!ws.join(META_DIR).join("PROTOCOL.md").exists());
        assert!(!ws.join(META_DIR).join("README.md").exists());
        assert!(!ws.join(META_DIR).join("endpoint.json").exists());
        // The user's file and the now-non-empty dir both survive.
        assert!(ws.join(META_DIR).join("user-notes.txt").exists());
        assert!(ws.join(META_DIR).exists());

        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn uninstall_meta_dir_removes_empty_dir() {
        let ws = tmp_workspace("meta-empty");
        install_meta_dir(&ws, None).unwrap();
        uninstall_meta_dir(&ws).unwrap();
        assert!(!ws.join(META_DIR).exists(), "empty meta dir should be cleaned up");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn public_install_creates_root_pointers_and_meta_dir() {
        let ws = tmp_workspace("public-install");
        let touched = install(&ws, Some(r#"{"port":1}"#)).unwrap();
        assert!(ws.join("CLAUDE.md").exists());
        assert!(ws.join("AGENTS.md").exists());
        assert!(ws.join("GEMINI.md").exists());
        assert!(ws.join(META_DIR).join("PROTOCOL.md").exists());
        assert!(ws.join(META_DIR).join("endpoint.json").exists());

        // Root pointer should be the THIN version, referring to the
        // meta-dir file — not dragging in 100 lines of protocol.
        let root_claude = fs::read_to_string(ws.join("CLAUDE.md")).unwrap();
        assert!(root_claude.contains(".multi-agent/PROTOCOL.md"));
        assert!(!root_claude.contains("Parallel fan-out pattern"),
            "root pointer must stay short — long sections belong in PROTOCOL.md");

        assert!(touched.len() >= 5);
        let _ = fs::remove_dir_all(&ws);
    }
}
