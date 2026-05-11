//! OpenClaw — `openclaw` binary.
//!
//! Skills live under the workspace root at
//! `~/.openclaw/workspace/skills/` by default. The workspace path
//! is technically configurable via `agents.defaults.workspace` in
//! `~/.openclaw/openclaw.json`; users overriding that won't get
//! the junction at the right place. See `agent_mcp_config.rs`
//! for the read-openclaw.json pattern when we lift this dynamic.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "openclaw",
    display_name: "OpenClaw",
    binary_name: "openclaw",
    skill_dir_relative: Some(".openclaw/workspace/skills"),
    has_hook_surface: false,
    // ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl —
    // generic JSONL family (parse_agent_jsonl handles it).
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".openclaw/agents",
        depth: 3,
    }),
    // Bare `openclaw` (no subcommand) launches the conversation REPL
    // directly as of OpenClaw 2026.5.7 — verified locally against the
    // installed CLI. The earlier `openclaw tui` invocation still works
    // but adds a redundant subcommand step. Aliases `openclaw chat` /
    // `openclaw terminal` remain available for users who prefer the
    // explicit form.
    default_args: &[],
};
