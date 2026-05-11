//! Gemini CLI (Google) — `gemini` binary.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "gemini",
    display_name: "Gemini CLI",
    binary_name: "gemini",
    skill_dir_relative: Some(".gemini/skills"),
    has_hook_surface: false,
    // ~/.gemini/tmp/<project-folder>/chats/session-<ts>-<hash>.jsonl
    history_shape: Some(HistoryShape::GeminiTmp {
        root_under_home: ".gemini/tmp",
        depth: 3,
    }),
    default_args: &[],
};
