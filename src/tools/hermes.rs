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
    // Hermes Agent exposes plugin hooks (pre_llm_call / pre_tool_call /
    // pre_approval_request / on_session_start / on_session_end / etc.)
    // via `~/.hermes/plugins/<name>/` Python plugins. Coffee CLI today
    // installs `coffee-cli-status` for the tab indicator; we have NOT
    // written a file-edit forwarder yet, so Hermes edits don't appear
    // in the 修改记录 panel. Two independent flags reflect this:
    has_hook_surface: true,
    file_edit_attribution: FileEditAttribution::None,
    // ~/.hermes/sessions/session_*.json — flat directory of full
    // JSON files (not JSONL); custom parser parse_hermes_json.
    history_shape: Some(HistoryShape::HermesFlatJson {
        root_under_home: ".hermes/sessions",
    }),
    default_args: &[],
};
