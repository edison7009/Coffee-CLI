//! Muse Code (Meta) — `muse` starts the interactive terminal.
//!
//! Launch-only integration. Its event-sourced session logs require a dedicated
//! adapter, so history and heatmap scanning are not enabled here.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "muse",
    display_name: "Muse Code",
    binary_name: "muse",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &[],
};
