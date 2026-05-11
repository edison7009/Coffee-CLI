//! Qwen Code (Alibaba) — `qwen` binary.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "qwen",
    display_name: "Qwen Code",
    binary_name: "qwen",
    skill_dir_relative: Some(".qwen/skills"),
    has_hook_surface: false,
    // ~/.qwen/projects/<sanitized-cwd>/chats/<session>.jsonl
    history_shape: Some(HistoryShape::QwenProjects {
        root_under_home: ".qwen/projects",
        depth: 3,
    }),
    default_args: &[],
};
