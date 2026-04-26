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
    // Short label like `pane-1` — the canonical id we want the LLM
    // to see and quote. Long full id is for internal cross-tab
    // routing and never surfaces to the model.
    let pane_short = match pane_id.find("::pane-") {
        Some(idx) => &pane_id[idx + "::".len()..],
        None => pane_id,
    };

    format!(
        r#"# Coffee-CLI multi-agent context

You are running inside Coffee-CLI's multi-agent mode. Your pane is
`{pane_short}`. The `coffee-cli` MCP server has this baked in, so
`whoami()` and the `is_self: true` flag in `list_panes()` always
identify you correctly even when 4 panes run the same CLI.

## MCP tools (4) from the `coffee-cli` server

- **whoami()** → returns `{{"pane_id": "{pane_short}"}}`. Authoritative.
- **list_panes()** → array of pane rows. Each has `id` (`pane-N`),
  `cli`, `state`, and `is_self` for your row. Returns only the
  current tab's panes — cross-tab is filtered out. Use to discover
  which peers exist and whether they're idle / busy / empty / terminated.
- **send_to_pane(id, text, wait?)** → dispatch to a peer.
  Pass `id` as `"pane-N"` (e.g. `"pane-1"`). The server auto-prefixes
  `text` with `[From {pane_short}]` so receivers know who you are.
  `wait=true` (default) blocks until the target idles and returns
  their reply; `wait=false` returns immediately and you poll via
  `read_pane()` later. **Don't pass `timeout_sec`** — the 600s default
  covers 99% of cases and including it just lengthens the rendered call.
- **read_pane(id, last_n_lines?)** → read a peer's recent output
  (ANSI stripped). Same `id` convention.

## Sentinel DONE marker (completion receipt)

When you finish a task that a peer dispatched to you, emit on its own
line as your final output:

    [COFFEE-DONE:{pane_short}->paneM]

`paneM` is the dispatcher's pane id — read it off the `[From paneN]`
prefix that Coffee-CLI added to the incoming message. The marker
wakes the dispatcher's turn loop without polling.

## Rules

- Don't self-dispatch — `send_to_pane("{pane_short}", ...)` is rejected.
- Prefer MCP tools for dispatch (structured, give error responses).
  The DONE marker is ONLY a completion signal, not a way to send work.
- All MCP calls and DONE markers are visible to the human user in real
  time. They can interrupt or take over any time.
- Cross-pane prompts: write `text` arguments in English even if the
  user spoke Chinese — LLMs follow tool-use instructions more reliably
  in English. Translate replies back to the user's language.
"#,
        pane_short = pane_short,
    )
}
