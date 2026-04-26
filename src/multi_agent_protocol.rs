//! Build the per-pane multi-agent protocol text.
//!
//! Same body, three delivery vehicles (decided by `mcp_injector` and
//! `server::tier_terminal_start_blocking`):
//!
//!   - Claude Code → `--append-system-prompt <text>` (survives /clear and /compact)
//!   - Codex       → `-c experimental_instructions_file=<temp>/instructions.md` (text file)
//!   - Gemini      → `<temp>/coffee-cli/panes/<pane>/GEMINI.md` referenced by the
//!                   per-pane Gemini extension manifest's `contextFileName`,
//!                   loaded into the model's `userMemory` for the session
//!
//! The text inlines the running pane's id; the matching per-pane MCP
//! server has the same id baked in (`mcp_server::spawn(.., Some(id))`),
//! so `whoami()` returns deterministic answers and `list_panes()`
//! marks the matching row with `is_self: true` regardless of which
//! CLI is calling.
//!
//! No workspace `.md` file is ever written — this module is purely a
//! string builder. The earlier v1.0–v1.4 logic that wrote
//! `<workspace>/.multi-agent/PROTOCOL.md` + thin-pointer
//! `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` was retired in v1.5 once
//! all three CLIs got per-pane in-memory injection paths.

/// Build the per-pane multi-agent protocol text for `pane_id`. The
/// returned string is safe to drop into a system prompt or a
/// CLI-specific instructions file as-is.
pub fn build_pane_system_prompt(pane_id: &str) -> String {
    format!(
        r#"# Coffee-CLI multi-agent context

You are running inside Coffee-CLI's multi-agent mode. Your pane id
is `{pane_id}`. Coffee-CLI has wired your MCP connection so this id
is baked in server-side — every `whoami()` call returns it
deterministically, and `list_panes()` marks your own row with
`is_self: true`.

## MCP tools (4) from the `coffee-cli` server

- **whoami()** → returns `{{"pane_id": "{pane_id}"}}`. Authoritative
  source for your own identity. Call once if you ever doubt; otherwise
  use the value above.
- **list_panes()** → array of all panes in this Tab. Your row has
  `is_self: true`. Use this to discover which peers are running and
  whether they're idle/busy/empty/terminated.
- **send_to_pane(id, text, wait?, timeout_sec?)** → dispatch work to a
  peer pane. The server auto-prefixes `text` with `[From {pane_id}]`
  so the receiver knows who you are — you don't need to bake your id
  into `text` manually. `wait=true` (default) blocks until the target
  idles and returns their reply; `wait=false` returns immediately and
  you poll via `read_pane()` later. `timeout_sec` default 600.
- **read_pane(id, last_n_lines?)** → read a peer's recent output
  (ANSI stripped). Useful after `wait=false` or to check progress.

## Sentinel DONE marker (completion receipt)

When you finish a task that a peer dispatched to you, emit on its own
line as your final output:

    [COFFEE-DONE:{pane_id}->paneM]

`paneM` is the source pane id — read it off the `[From ...]` prefix
that Coffee-CLI added to the incoming message. The marker wakes the
dispatcher's turn loop without polling.

## Rules

- Don't self-dispatch — `send_to_pane({pane_id}, ...)` is rejected by
  the server.
- Prefer MCP tools for dispatch (structured, give error responses).
  The DONE marker is ONLY a completion signal, not a way to send work.
- All MCP calls and DONE markers are visible to the human user in real
  time. They can interrupt or take over any time.
- Cross-pane prompts: write `text` arguments in English even if the
  user spoke Chinese — LLMs follow tool-use instructions more reliably
  in English. Translate replies back to the user's language.
"#,
        pane_id = pane_id
    )
}
