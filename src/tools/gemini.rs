//! Gemini CLI (Google) — `gemini` binary.

use super::{FileEditAttribution, HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "gemini",
    display_name: "Gemini CLI",
    binary_name: "gemini",
    skill_dir_relative: Some(".gemini/skills"),
    // Gemini CLI exposes no hook protocol Coffee CLI can use today.
    // Files it modifies don't appear in the audit log — by design,
    // not a TODO. If Google adds a hook protocol later we'll
    // upgrade to `Hook` or `TurnSnapshot`.
    file_edit_attribution: FileEditAttribution::None,
    // ~/.gemini/tmp/<project-folder>/chats/session-<ts>-<hash>.jsonl
    history_shape: Some(HistoryShape::GeminiTmp {
        root_under_home: ".gemini/tmp",
        depth: 3,
    }),
    default_args: &[],
};
