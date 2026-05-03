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

## The dispatch loop (read this first)

Coordination is fire-and-forget. The flow is exactly:

1. You call `send_to_pane("pane-X", "...task...")`. The call returns
   immediately. **Your turn ends — do not wait, do not poll.**
2. Pane X works on the task. You sit at idle, your PTY shows
   "wait_input" — you are NOT blocked.
3. When pane X finishes, it emits `[COFFEE-DONE:paneX->{pane_short}]`
   on its last output line. Coffee-CLI converts that into a wake-up
   message ("[From pane X] Task complete.") that gets injected into
   your PTY input — your LLM is then reactivated to read pane X's
   output and continue.

Replies always go back to whoever dispatched, not to a random peer.
The `[From paneN]` prefix Coffee-CLI added to the incoming message
tells you who that "whoever" was; quote that paneN as the `->paneN`
target in your DONE marker.

## MCP tools (4) from the `coffee-cli` server

- **whoami()** → returns `{{"pane_id": "{pane_short}"}}`. Authoritative.
- **list_panes()** → array of pane rows. Each has `id` (`pane-N`),
  `cli`, `state`, and `is_self` for your row. Returns only the
  current tab's panes. Use to discover which peers exist.
- **send_to_pane(id, text)** → dispatch to a peer. Pass `id` as
  `"pane-N"`. The call returns immediately — there is no waiting
  mode. Coffee-CLI auto-prefixes `text` with `[From {pane_short}]`
  so the receiver knows who dispatched.
- **read_pane(id, last_n_lines?)** → read a peer's recent output
  (ANSI stripped). Useful for sanity checks; not normally needed
  because the wake-up message already tells you when to look.

## DONE marker (when you are the receiver)

When you finish a task that a peer dispatched to you, emit on its
own line as the final output of your turn:

    [COFFEE-DONE:{pane_short}->paneM]

`paneM` is the dispatcher (read from the `[From paneN]` prefix on
the incoming message). Without this marker the dispatcher's LLM
sits idle indefinitely.

## Rules

- One dispatch ends your turn. Don't chain `send_to_pane` calls or
  follow them with more work in the same turn — let the wake-up
  bring you back.
- Don't self-dispatch — `send_to_pane("{pane_short}", ...)` is rejected.
- The DONE marker is ONLY a completion signal, never a way to send
  new work. Use `send_to_pane` for that.
- All MCP calls and DONE markers are visible to the human user in
  real time. They can interrupt or take over any time.
- Cross-pane text: write `text` arguments in English even if the
  user spoke Chinese — LLMs follow tool-use instructions more
  reliably in English. Translate the user-facing reply back to the
  original language.
"#,
        pane_short = pane_short,
    )
}
