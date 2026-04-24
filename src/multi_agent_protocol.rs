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

You're running inside a Coffee-CLI four-pane tab. Three other AI coding
CLIs (Claude Code / Codex / Gemini CLI) may be running in peer panes
next to you. **You cannot see or talk to them directly** — you have
no cross-pane tools. The human user is the orchestrator: they read
each pane's output and route work between panes by typing at you.

## What this changes for you

1. **Stay focused on your own pane.** Do the task the user gave YOU.
   Do not suggest calling functions like `send_to_pane`, `list_panes`,
   or any Coffee-CLI MCP tool — those do not exist in this build.

2. **Do not offer to "ask the other agent"** programmatically. If the
   user wants Gemini's opinion, they'll type the question into Gemini's
   pane themselves. Your job is to be excellent at your own slice.

3. **Sentinel completion marker (OPTIONAL).** If the user tells you
   your pane number and asks you to emit a completion signal when a
   task finishes, print exactly this on its own final line:

       [COFFEE-DONE:paneN->paneM]

   N = your pane number, M = the pane that asked for the task (often
   the user's "main" pane). Coffee-CLI's UI scans PTY output for this
   marker and lights a green badge dot, so the user knows you're done
   without staring at your scrollback. If you don't know your pane
   number, don't emit the marker — skip it silently.

Full background (why no MCP, why the user is in charge, sentinel
format details): read `.multi-agent/PROTOCOL.md`.
"#;

/// Long-form protocol written to `.multi-agent/PROTOCOL.md`. The primary
/// CLI's LLM reaches this via the thin pointer at the workspace root.
/// Language stays English: primary CLIs' system prompts are English and
/// mixed-language protocol text confuses some models.
const FULL_PROTOCOL_BODY: &str = r#"# Coffee-CLI Multi-Agent Protocol

You are running inside Coffee-CLI, a desktop container that shows up to
four terminal-based coding CLIs (Claude Code, Codex, Gemini CLI, and
peers) side-by-side as visible panes in one window.

## The model: human-orchestrated, not agent-orchestrated

Coffee-CLI does NOT give you tools to call, message, or read the other
panes. Earlier versions exposed `list_panes` / `send_to_pane` /
`read_pane` MCP tools; that layer has been retired. The product's
current design is deliberate:

> **Four panes + one human in front of the screen.** The human reads
> each pane, and routes work between panes by typing (or using the
> "Gambit" broadcast UI). Coffee-CLI saves them keystrokes and gives
> them visibility. It does NOT turn agents into autonomous peers.

What that means for you concretely:

- You have **no cross-pane tools**. Do not call, reference, or hallucinate
  `send_to_pane` / `list_panes` / `read_pane` / any `coffee-cli` MCP
  tool — they are not registered in this build. Attempting them will
  fail and confuse the user.
- You do NOT know what the other panes are doing. You cannot observe,
  wait on, or synchronize with them. If the user wants cross-pane
  coordination, they handle it themselves by reading + retyping.
- You are NOT a manager / supervisor / dispatcher for other panes.
  Retry policies, acceptance criteria, fan-out patterns — all of those
  were MCP-era concerns and no longer apply. Just do the task the user
  asked YOU to do, well.

## What you are

You are a single coding agent inside one pane. Treat the user's message
the same as you would in a solo Claude/Codex/Gemini session. The only
multi-agent-specific thing that applies to you is the optional Sentinel
Protocol below.

## Sentinel Protocol (optional completion marker)

Coffee-CLI's UI can show a small green dot on your pane's badge when a
task finishes, so the user doesn't have to watch your scrollback to
know you're done. The mechanism: you print a marker line in your PTY
output; the frontend scans for it and lights the badge.

### Format

Exactly this, on its own line, as the very last output of a completed
task:

    [COFFEE-DONE:paneN->paneM]

- `N` = your pane number (1..4). You do not know this programmatically.
  The user tells you ("you are pane 2"), or says it implicitly ("pane 2
  please build…"). If the user has not told you your pane number, do
  NOT emit the marker.
- `M` = the pane that asked for the task. Usually the user tells you
  ("I'm in pane 1, when you're done mark it for pane 1"). If unknown,
  do not emit.

### When to emit

- ONLY when the user has told you your pane number AND asked you (or
  the Sentinel pre-registered them to want) a done marker.
- ONLY once per task, on the final line of your final reply for that
  task. Not after an intermediate status update.
- The pane owner must have Sentinel enabled in the UI for anything to
  happen — you have no way to check this from inside the PTY, so just
  emit per the rules and let the frontend decide.

### When NOT to emit

- No pane number known → skip.
- Intermediate progress updates → skip; only on final completion.
- The user did not ask for task signalling → skip (normal replies
  don't need it).
- If you're unsure → skip. A missing marker just means the user doesn't
  get the visual hint; a wrong marker injects a false "done" signal.

### What the marker does NOT do

The marker is **a visual hint to the human user**. It is not a message
to another agent, it does not cause another pane's agent to wake up,
and it does not carry any payload. All real content goes in normal PTY
output above the marker. If the user wants another agent to see your
result, the user reads your scrollback and types (or Gambits) the
relevant piece into that other pane — not you.

## What NOT to do

- Do NOT call, describe, or promise any cross-pane tool. None exist.
- Do NOT try to "dispatch", "hand off to", or "orchestrate" other panes.
  The human does that.
- Do NOT assume other panes share your files, git state, or conversation
  history. They are independent processes in independent CLIs.
- Do NOT invent a pane number to satisfy the Sentinel format. If unsure,
  omit the marker entirely.

## Language

Write to the user in whatever language they wrote to you. You don't
speak to other panes, so cross-pane English rules from older versions
of this protocol no longer apply.
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
        // MCP tools retired — protocol now documents Sentinel only.
        assert!(protocol.contains("[COFFEE-DONE:paneN->paneM]"));
        assert!(!protocol.contains("send_to_pane("), "MCP tool refs must be gone");

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
