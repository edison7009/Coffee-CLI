//! Kiro CLI — launch-only integration.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "kiro",
    display_name: "Kiro",
    binary_name: "kiro-cli",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &["chat"],
};
