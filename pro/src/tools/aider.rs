//! Aider — third-class (T3) integration: brand icon + one-click launch only.
//!
//! No session-history scanning and no hook surface (so no Dynamic Island /
//! live status dot — that stays Claude-only). Registered in `TOOLS` purely so
//! the launchpad gets its display name (`list_tools`), its PATH "installed"
//! probe, and the launch binary. `binary_name` is the command users run.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "aider",
    display_name: "Aider",
    binary_name: "aider",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &[],
};
