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

You're running inside a Coffee-CLI multi-pane workspace. Up to four AI
coding CLIs (Claude Code / Codex / Gemini / OpenCode / OpenClaw /
Qwen / Hermes) run side-by-side in the same window. **Every pane is
an orchestrator** — you can dispatch work to other panes and receive
completion signals from them, all via plain PTY text markers.

## You can command other panes — TELL marker

To make another pane do something, output this line (it MUST start at
the beginning of its own line, in your normal output):

    [COFFEE-TELL:paneN->paneM] <single-line task description>

- `N` = your pane number (1..4)
- `M` = target pane number (must differ from N)
- text after the marker is the task — ONE LINE, no newlines

Coffee-CLI's frontend scans your output, strips the marker, and pastes
`[From pane N] <text>` into pane M's input with auto-Enter. pane M's
agent sees it as if the user typed it there. Always active, no gating.

Your pane number is told to you by the human (or implied in the first
message: "You are pane 3"). If you don't know your number yet, ask.

## You can report completion — DONE marker (optional)

When a task finishes, emit on its own line:

    [COFFEE-DONE:paneN->paneM]

If the user toggled Sentinel mode ON, this:
 - lights a green badge on your pane (visible to the user)
 - auto-notifies pane M with "[From pane N] Task complete." + Enter

If Sentinel is OFF, the DONE marker stays inert — still safe to emit,
just nothing happens. Prefer emitting it anyway so the user can opt in
later without you changing behavior.

## Rules

- **Single-line TELL text**: pack multi-step instructions into one line
  or send multiple separate TELL markers.
- **Don't hallucinate cross-pane tools**. No MCP / ACP functions, no
  programmatic "send to pane" / "list panes" helpers — only the TELL
  and DONE markers above.
- **Don't self-tell**: `paneN->paneN` is a no-op (ignored by the frontend).
- **User can always override**: they see every marker in your scrollback
  and every injection in the target's scrollback. They can interrupt.

Full protocol (TELL text format, orchestration patterns, when NOT to
dispatch): read `.multi-agent/PROTOCOL.md`.
"#;

/// Long-form protocol written to `.multi-agent/PROTOCOL.md`. The primary
/// CLI's LLM reaches this via the thin pointer at the workspace root.
/// Language stays English: primary CLIs' system prompts are English and
/// mixed-language protocol text confuses some models.
const FULL_PROTOCOL_BODY: &str = r#"# Coffee-CLI Multi-Agent Protocol

You are running inside Coffee-CLI, a desktop container showing up to
four terminal-based coding CLIs side-by-side. Every pane is an
independent, orchestrating peer — you can dispatch work to another pane
and receive completion signals back, all through plain text markers
in PTY output that the user can read in real time.

## Core idea

Coffee-CLI's frontend scans every pane's PTY output each frame for
two markers:

    [COFFEE-TELL:paneN->paneM] <text>   — dispatch work
    [COFFEE-DONE:paneN->paneM]          — report completion

When found, the frontend pastes a prefixed notification into the
target pane's input stream with auto-Enter. Nothing leaves the Coffee-
CLI process; there is no MCP server, no HTTP, no injection into your
home-dir CLI config. The user sees every marker in your scrollback and
every injection in the target's scrollback.

This means you are NOT siloed. You can make other panes work for you
as naturally as writing a sentence.

## Knowing your pane number

Coffee-CLI can't inject environment info into your subprocess, so you
don't programmatically know if you are pane 1, 2, 3, or 4. The user
tells you, usually in their first message ("You are pane 2") or
implicitly ("pane 2 please build X"). If your first message doesn't
mention it, ASK before dispatching: "Which pane am I, and which pane
should I target?"

## TELL marker — dispatching work

### Format

On its own line, within your normal output:

    [COFFEE-TELL:paneN->paneM] <one-line task description>

- `N` = your pane number (1..4)
- `M` = target pane number (1..4, M ≠ N)
- `<text>` = single line, ends at newline/carriage-return

The frontend will paste `[From pane N] <text>` into pane M's input
and press Enter for you.

### Activation

ALWAYS ACTIVE. No sentinel toggle, no opt-in. This is the core product
mechanism. As long as the marker is well-formed and the target pane
has a CLI running, the dispatch happens.

### Patterns

**Simple dispatch** — you need Gemini's reasoning on a doc:
    I'll ask pane 2 (Gemini) to summarize this RFC.
    [COFFEE-TELL:pane1->pane2] Read the RFC at docs/rfc-042.md and reply with the 3 most important decisions in bullet points.

**Fan-out** — get three opinions in parallel:
    [COFFEE-TELL:pane1->pane2] Review auth.rs for security issues; reply with a numbered list.
    [COFFEE-TELL:pane1->pane3] Review auth.rs for style / idiom issues; reply with a numbered list.
    [COFFEE-TELL:pane1->pane4] Review auth.rs for test coverage gaps; reply with a numbered list.

**Pipeline** — pane 2 produces, pane 3 consumes. You can dispatch the
second step when you see pane 2's DONE arrive in your own input:
    [COFFEE-TELL:pane1->pane2] Draft a commit message for the current git diff in one sentence.
    (later, after pane 2 emits DONE and the notification lands in your input)
    [COFFEE-TELL:pane1->pane3] Here is the drafted commit message: "<paste>". Apply it via git commit.

### Rules

- **Single-line text only.** Newlines in `<text>` break parsing. Summarize.
- **Do NOT self-tell.** pane N → pane N is ignored.
- **Target must have a CLI running.** Empty panes ignore the marker.
- **Dispatched agents are peers, not slaves.** They can TELL you back,
  or TELL a third pane. Respect their orchestration too.

## DONE marker — reporting completion

### Format

On its own line at the end of a completed task:

    [COFFEE-DONE:paneN->paneM]

- `N` = your pane (the one reporting done)
- `M` = the pane that dispatched the task (usually the one whose TELL
  you received — extract it from the `[From pane M]` prefix)

### Activation (sentinel-gated)

The DONE marker only does something if SENTINEL mode is toggled ON for
your pane. With sentinel on:
 - your pane's badge lights green for 30 minutes
 - if target pane M also has sentinel on, it receives
   "[From pane M] Task complete." + auto-Enter

With sentinel off, DONE is inert — it still sits in your scrollback but
triggers no frontend behavior.

**Emit DONE anyway** on task completion. You can't tell from inside
your subprocess whether sentinel is on; emitting is cheap, and the
user can flip sentinel on later to activate the receipts.

### When to emit

- After finishing work that a TELL asked for.
- After finishing a task the user assigned you, if they mentioned a
  "main" pane to notify.
- NOT on intermediate status — only on final completion.

## Multi-language

Address your messages in the language the user / dispatcher uses. When
sending TELL to another agent, match the downstream agent's expected
language (usually English for technical prompts, but follow the
convention already visible in the user's messages).

## What NOT to do

- Don't hallucinate tools. There are no MCP / ACP functions here, no
  "send to pane" / "list panes" / "read pane" helpers — only TELL and
  DONE markers described above.
- Don't dispatch without reason: a TELL costs another agent's context
  budget. Use it for genuine cross-CLI value (different CLI's strength,
  parallel work), not for things you can do yourself.
- Don't dispatch into empty panes: the marker silently drops.
- Don't assume other panes share your files / git state. They may be
  in different working directories; include file paths explicitly.
- Don't auto-chain long pipelines without user awareness. Summarize
  results from dispatched panes and let the user decide whether to
  continue chaining.
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
- `endpoint.json` — legacy leftover from the retired MCP era. Not
  currently written by Coffee-CLI; cleaned up if found from old runs.

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
        // Thin pointer now teaches both TELL (dispatch) and DONE (receipt)
        // markers — richer than the 2026-04-24 Sentinel-only version but
        // still bounded so the bulk lives in PROTOCOL.md. Raise the ceiling
        // only if adding a third marker; otherwise trim before growing.
        assert!(THIN_POINTER_BODY.lines().count() < 70);
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
        // Bidirectional PTY-marker protocol (v1.1.9): TELL forward dispatch,
        // DONE backward receipt. MCP tools stay retired — make sure the
        // agent-facing doc neither presents them as available nor uses the
        // legacy function-call syntax.
        assert!(protocol.contains("[COFFEE-TELL:paneN->paneM]"));
        assert!(protocol.contains("[COFFEE-DONE:paneN->paneM]"));
        assert!(!protocol.contains("send_to_pane("), "legacy MCP function-call syntax must not appear");

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
