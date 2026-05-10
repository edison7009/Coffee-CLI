//! Qwen Code (Alibaba) — `qwen` binary.

use super::{FileEditAttribution, HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "qwen",
    display_name: "Qwen Code",
    binary_name: "qwen",
    skill_dir_relative: Some(".qwen/skills"),
    // Qwen Code is Claude-Code-compatible at the SKILL.md / prompt
    // level but does not expose Claude's hook protocol. No file-edit
    // attribution available; same policy as Gemini.
    file_edit_attribution: FileEditAttribution::None,
    // ~/.qwen/projects/<sanitized-cwd>/chats/<session>.jsonl
    history_shape: Some(HistoryShape::QwenProjects {
        root_under_home: ".qwen/projects",
    }),
};
