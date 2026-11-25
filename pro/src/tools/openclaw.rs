//! OpenClaw — `openclaw` binary.
//!
//! Skills live under the workspace root at
//! `~/.openclaw/workspace/skills/` by default. The workspace path
//! is technically configurable via `agents.defaults.workspace` in
//! `~/.openclaw/openclaw.json`; users overriding that won't get
//! the junction at the right place. See `agent_mcp_config.rs`
//! for the read-openclaw.json pattern when we lift this dynamic.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "openclaw",
    display_name: "OpenClaw",
    binary_name: "openclaw",
    has_legacy_hook_artifacts: false,
    // OpenClaw is NOT collected into the History board. Verified against
    // upstream `openclaw --help` (2026.7.1-2): there is no
    // `openclaw resume <id>`, no `--resume`/`--session` flag — OpenClaw
    // resumes its own last session internally on launch, not via argv.
    // HistoryBoard's only card action is click-to-resume (the old read-only
    // history preview was removed), and the Rust resume path
    // (terminal.rs AGENT_PRESETS) has `resume_program: None` for openclaw,
    // so server.rs returns "Tool 'openclaw' does not support resume" and
    // the card is a dead-end error. OpenClaw DOES persist multi-session
    // state on disk (`~/.openclaw/agents/<agentId>/sessions/<uuid>.jsonl`
    // + `sessions.json` index + `state/openclaw.sqlite`), but since Coffee
    // CLI can't resume any of them, collecting them only manufactures
    // broken rows. Drop the shape → scanner skips openclaw entirely.
    // If OpenClaw ever ships a CLI resume entry point, restore the
    // GenericJsonl shape (root ".openclaw/agents", depth 3) and add a
    // resume_program arm in terminal.rs.
    history_shape: None,
    // Bare `openclaw` (no subcommand) launches the conversation REPL
    // directly as of OpenClaw 2026.5.7 — verified locally against the
    // installed CLI. The earlier `openclaw tui` invocation still works
    // but adds a redundant subcommand step. Aliases `openclaw chat` /
    // `openclaw terminal` remain available for users who prefer the
    // explicit form.
    default_args: &[],
};
