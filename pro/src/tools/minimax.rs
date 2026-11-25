//! MiniMax Code — launch-only integration.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "minimax",
    display_name: "MiniMax Code",
    binary_name: "mcode",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &[],
};
