//! Codex CLI (OpenAI) — `codex` binary.

use super::{FileEditAttribution, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "codex",
    display_name: "Codex CLI",
    binary_name: "codex",
    skill_dir_relative: Some(".codex/skills"),
    // Codex only signals turn-complete (no per-tool-call hook). The
    // `coffee-cli-codex-notify.py` forwarder includes its cwd in the
    // payload; on receipt, the hook server walks that folder and
    // emits one `tool-file-edit` event per file that drifted from
    // the global baseline.
    file_edit_attribution: FileEditAttribution::TurnSnapshot,
};
