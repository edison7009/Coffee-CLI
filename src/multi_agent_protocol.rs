//! Multi-agent protocol templates and workspace-file injection.
//!
//! When the user enables multi-agent mode, Coffee-CLI writes three near-
//! identical protocol files to the workspace root so every supported
//! primary CLI picks up the same rules of engagement:
//!
//!   CLAUDE.md   — read by Claude Code
//!   AGENTS.md   — read by Codex CLI and OpenCode
//!   GEMINI.md   — read by Gemini CLI
//!
//! All three contain the same content surrounded by markers so we can
//! remove our block on disable without disturbing anything the user or
//! other tools wrote.
//!
//! See docs/MULTI-AGENT-ARCHITECTURE.md §5.4 for the design.

use std::{fs, path::Path};

/// Markers delimit the Coffee-CLI-managed section so we can splice it
/// into an existing file without clobbering user content, and remove it
/// cleanly on disable. Do NOT change these strings once shipped — they
/// are the contract with existing user files on disk.
pub const START_MARKER: &str = "<!-- COFFEE-CLI:MULTI-AGENT:START -->";
pub const END_MARKER: &str = "<!-- COFFEE-CLI:MULTI-AGENT:END -->";

/// Shared protocol body. Language is English because the primary CLIs'
/// system-prompt context is English; mixed-language protocol instructions
/// are known to confuse some LLMs.
const PROTOCOL_BODY: &str = r#"# Coffee-CLI Multi-Agent Protocol

You are running inside Coffee-CLI, a desktop container that lets multiple
terminal-based coding agents (Claude Code, Codex, Gemini CLI, OpenCode)
work side-by-side as visible panes.

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

When the user asks multiple agents to work simultaneously ("let Codex,
Gemini, and OpenCode each design this"), you MUST issue all
`send_to_pane` calls in a SINGLE assistant turn (one reply with multiple
parallel tool_use blocks). Do NOT serialize them — that defeats the
entire point of multiple agents.

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

## When NOT to use these tools

DO NOT reach for `send_to_pane` just to spawn an internal subagent. Each
primary CLI has its own native subagent mechanism — use that for
intra-CLI parallelism:

  - Claude Code  → Agent Teams (/agent spawn, Shift+Down to cycle)
  - Codex CLI    → Codex subagents / rescue
  - Gemini CLI   → Gemini agent framework
  - OpenCode     → @subagent-name or TaskTool

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

/// Build the exact block we splice between the start and end markers.
fn marker_block() -> String {
    format!(
        "{start}\n{body}\n{end}\n",
        start = START_MARKER,
        body = PROTOCOL_BODY.trim_end(),
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
            // Replace only the region between the markers inclusive.
            let end_marker_end = end + END_MARKER.len();
            let mut s = String::with_capacity(existing.len() + new_block.len());
            s.push_str(&existing[..start]);
            s.push_str(new_block.trim_end_matches('\n'));
            s.push_str(&existing[end_marker_end..]);
            s
        }
        _ => {
            // Append.
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
    // Collapse leading/trailing blank noise we may have introduced.
    let cleaned = stripped.trim_start_matches(|c: char| c == '\n' || c == '\r');
    let cleaned = cleaned.trim_end_matches(|c: char| c == '\n' || c == '\r');

    if cleaned.is_empty() {
        // File contained nothing but our block — delete it.
        fs::remove_file(path)?;
        return Ok(true);
    }

    fs::write(path, format!("{}\n", cleaned))?;
    Ok(true)
}

/// Write CLAUDE.md, AGENTS.md, GEMINI.md at the workspace root.
pub fn install(workspace_root: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut touched = Vec::new();
    for name in ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] {
        let p = workspace_root.join(name);
        if upsert_protocol_block(&p)? {
            touched.push(p);
        }
    }
    Ok(touched)
}

/// Strip Coffee-CLI's block from all three files (leave the rest intact).
pub fn uninstall(workspace_root: &Path) -> std::io::Result<Vec<std::path::PathBuf>> {
    let mut touched = Vec::new();
    for name in ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] {
        let p = workspace_root.join(name);
        if remove_protocol_block(&p)? {
            touched.push(p);
        }
    }
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

    #[test]
    fn installs_into_empty_file() {
        let p = tmp_path("empty.md");
        let _ = fs::remove_file(&p);
        assert!(upsert_protocol_block(&p).unwrap());
        let content = fs::read_to_string(&p).unwrap();
        assert!(content.contains(START_MARKER));
        assert!(content.contains(END_MARKER));
        assert!(content.contains("Coffee-CLI Multi-Agent Protocol"));
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
        assert!(content.contains("Coffee-CLI Multi-Agent Protocol"));
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
        // Second call with identical body must be a no-op.
        assert!(!upsert_protocol_block(&p).unwrap());
        let _ = fs::remove_file(&p);
    }
}
