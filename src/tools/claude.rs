//! Claude Code (Anthropic) — `claude` binary.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "claude",
    display_name: "Claude Code",
    binary_name: "claude",
    skill_dir_relative: Some(".claude/skills"),
    has_hook_surface: true,
    // ~/.claude/projects/<hash>/<hash>.jsonl
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".claude/projects",
        depth: 2,
    }),
    default_args: &[],
};
