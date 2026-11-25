//! OpenCode (sst.dev) — `opencode` binary.
//!
//! XDG layout: skills live under `~/.config/opencode/skills/`,
//! NOT in a top-level `~/.opencode/` dotdir.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "opencode",
    display_name: "OpenCode",
    binary_name: "opencode",
    has_legacy_hook_artifacts: true,
    // ~/.local/share/opencode/opencode.db (V1/V2 tables + legacy JSON
    // fallback) — see `find_opencode_sessions` for layout details.
    history_shape: Some(HistoryShape::OpenCodeMixed {
        root_under_home: ".local/share/opencode",
    }),
    default_args: &[],
};
