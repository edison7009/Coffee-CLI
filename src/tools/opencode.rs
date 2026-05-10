//! OpenCode (sst.dev) — `opencode` binary.
//!
//! XDG layout: skills live under `~/.config/opencode/skills/`,
//! NOT in a top-level `~/.opencode/` dotdir.

use super::{FileEditAttribution, HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "opencode",
    display_name: "OpenCode",
    binary_name: "opencode",
    skill_dir_relative: Some(".config/opencode/skills"),
    // OpenCode plugin API exposes `tool.execute.after` as a named
    // hook with the full tool input; `coffee-cli-opencode-plugin.js`
    // reads file paths from write/edit/patch tools and forwards a
    // `file_edit` payload.
    file_edit_attribution: FileEditAttribution::Hook,
    // ~/.local/share/opencode/storage/db.sqlite (+ legacy jsonl
    // fallback) — see `find_opencode_sessions` for layout details.
    history_shape: Some(HistoryShape::OpenCodeMixed {
        root_under_home: ".local/share/opencode",
    }),
};
