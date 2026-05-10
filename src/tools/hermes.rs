//! Hermes Agent — `hermes` binary.
//!
//! NB: Always say "Hermes Agent", never bare "Hermes" (luxury-brand
//! conflict). The display name reflects this. Skills concept not yet
//! supported by Hermes upstream (per 2026-05-09); when it lands the
//! path WILL be `.hermes/skills/` (dotdir family). For now keep
//! `skill_dir_relative` as `None` so we don't pre-create empty
//! `~/.hermes/skills/` folders in homes that don't have Hermes.

use super::{FileEditAttribution, HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "hermes",
    display_name: "Hermes Agent",
    binary_name: "hermes",
    skill_dir_relative: None,
    // Hermes Agent has plugin hooks (pre_llm_call / pre_tool_call /
    // pre_approval_request / on_session_start / on_session_end / etc.)
    // exposed via `~/.hermes/plugins/<name>/` Python plugins.
    // Coffee CLI installs the `coffee-cli-status` plugin to drive the
    // tab dot indicator. File-edit attribution is still None — we only
    // forward status events, not per-file write events. (Hermes' Python
    // hooks DO get tool args including paths, but wiring per-tool path
    // attribution is a follow-up; status indicator is the v2.7.0 scope.)
    file_edit_attribution: FileEditAttribution::Hook,
    // ~/.hermes/sessions/session_*.json — flat directory of full
    // JSON files (not JSONL); custom parser parse_hermes_json.
    history_shape: Some(HistoryShape::HermesFlatJson {
        root_under_home: ".hermes/sessions",
    }),
    default_args: &[],
};
