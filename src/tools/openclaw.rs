//! OpenClaw — `openclaw` binary.
//!
//! Skills live under the workspace root at
//! `~/.openclaw/workspace/skills/` by default. The workspace path
//! is technically configurable via `agents.defaults.workspace` in
//! `~/.openclaw/openclaw.json`; users overriding that won't get
//! the junction at the right place. See `agent_mcp_config.rs`
//! for the read-openclaw.json pattern when we lift this dynamic.

use super::{FileEditAttribution, HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "openclaw",
    display_name: "OpenClaw",
    binary_name: "openclaw",
    skill_dir_relative: Some(".openclaw/workspace/skills"),
    // OpenClaw is workspace-nested but its hook surface (the `commands.mcp`
    // gate, see memory `reference_openclaw_mcp_gate`) is for MCP server
    // injection, not file-edit attribution. No upstream hook event
    // covers "wrote file X"; same policy as Gemini.
    file_edit_attribution: FileEditAttribution::None,
    // ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl —
    // generic JSONL family (parse_agent_jsonl handles it).
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".openclaw/agents",
        depth: 3,
    }),
    // OpenClaw's official primary TUI command per docs.openclaw.ai/cli/tui.
    // `openclaw chat` / `openclaw terminal` are aliases for `openclaw
    // tui --local` (embedded mode, no Gateway daemon needed) and are
    // gentler for first-run users — but we follow OpenClaw's own
    // "Primary command" label here. Users without the Gateway daemon
    // should run `openclaw onboard --install-daemon` once to set it up.
    default_args: &["tui"],
};
