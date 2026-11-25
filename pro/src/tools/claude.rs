//! Claude Code (Anthropic) — `claude` binary.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "claude",
    display_name: "Claude Code",
    binary_name: "claude",
    has_legacy_hook_artifacts: true,
    // ~/.claude/projects/<hash>/<hash>.jsonl
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".claude/projects",
        depth: 2,
    }),
    default_args: &[],
};
