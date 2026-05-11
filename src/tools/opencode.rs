//! OpenCode (sst.dev) — `opencode` binary.
//!
//! XDG layout: skills live under `~/.config/opencode/skills/`,
//! NOT in a top-level `~/.opencode/` dotdir.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "opencode",
    display_name: "OpenCode",
    binary_name: "opencode",
    skill_dir_relative: Some(".config/opencode/skills"),
    has_hook_surface: true,
    // ~/.local/share/opencode/storage/db.sqlite (+ legacy jsonl
    // fallback) — see `find_opencode_sessions` for layout details.
    history_shape: Some(HistoryShape::OpenCodeMixed {
        root_under_home: ".local/share/opencode",
    }),
    default_args: &[],
};
