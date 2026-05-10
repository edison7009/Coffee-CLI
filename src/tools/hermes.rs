//! Hermes Agent — `hermes` binary.
//!
//! NB: Always say "Hermes Agent", never bare "Hermes" (luxury-brand
//! conflict). The display name reflects this. Skills concept not yet
//! supported by Hermes upstream (per 2026-05-09); when it lands the
//! path WILL be `.hermes/skills/` (dotdir family). For now keep
//! `skill_dir_relative` as `None` so we don't pre-create empty
//! `~/.hermes/skills/` folders in homes that don't have Hermes.

use super::{FileEditAttribution, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "hermes",
    display_name: "Hermes Agent",
    binary_name: "hermes",
    skill_dir_relative: None,
    // Hermes Agent — no hook surface today. Same policy as Gemini.
    file_edit_attribution: FileEditAttribution::None,
};
