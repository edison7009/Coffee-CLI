//! Codex CLI (OpenAI) — `codex` binary.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "codex",
    display_name: "Codex CLI",
    binary_name: "codex",
    skill_dir_relative: Some(".codex/skills"),
    has_hook_surface: true,
    // ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
    history_shape: Some(HistoryShape::CodexRollout {
        root_under_home: ".codex/sessions",
        depth: 4,
    }),
    default_args: &[],
};
