//! Codex CLI (OpenAI) — `codex` binary.

use super::{FileEditAttribution, HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "codex",
    display_name: "Codex CLI",
    binary_name: "codex",
    skill_dir_relative: Some(".codex/skills"),
    has_hook_surface: true,
    // Codex only signals turn-complete (no per-tool-call hook). The
    // `coffee-cli-codex-notify.py` forwarder includes its cwd in the
    // payload; on receipt, the hook server walks that folder and
    // emits one `tool-file-edit` event per file that drifted from
    // the global baseline.
    file_edit_attribution: FileEditAttribution::TurnSnapshot,
    // ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
    history_shape: Some(HistoryShape::CodexRollout {
        root_under_home: ".codex/sessions",
        depth: 4,
    }),
    default_args: &[],
};
