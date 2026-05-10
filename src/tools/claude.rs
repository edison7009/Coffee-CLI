//! Claude Code (Anthropic) — `claude` binary.

use super::{FileEditAttribution, HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "claude",
    display_name: "Claude Code",
    binary_name: "claude",
    skill_dir_relative: Some(".claude/skills"),
    // Claude Code emits PostToolUse with full tool_input for
    // Edit/Write/MultiEdit — `coffee-cli-hook.py` reads
    // `tool_input.file_path` and forwards a `file_edit` payload.
    file_edit_attribution: FileEditAttribution::Hook,
    // ~/.claude/projects/<hash>/<hash>.jsonl
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".claude/projects",
        depth: 2,
    }),
};
