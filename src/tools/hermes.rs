//! Hermes Agent — `hermes` binary.
//!
//! NB: Always say "Hermes Agent", never bare "Hermes" (luxury-brand
//! conflict). The display name reflects this. Skills concept not yet
//! supported by Hermes upstream (per 2026-05-09); when it lands the
//! path WILL be `.hermes/skills/` (dotdir family). For now keep
//! `skill_dir_relative` as `None` so we don't pre-create empty
//! `~/.hermes/skills/` folders in homes that don't have Hermes.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "hermes",
    display_name: "Hermes Agent",
    binary_name: "hermes",
    skill_dir_relative: None,
    // Hermes Agent exposes plugin hooks via `~/.hermes/plugins/<name>/`
    // Python plugins. Coffee CLI installs `coffee-cli-status` for the
    // tab indicator only.
    has_hook_surface: true,
    // ~/.hermes/sessions/session_*.json — flat directory of full
    // JSON files (not JSONL); custom parser parse_hermes_json.
    history_shape: Some(HistoryShape::HermesFlatJson {
        root_under_home: ".hermes/sessions",
    }),
    default_args: &[],
};
