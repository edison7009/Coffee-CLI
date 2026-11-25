//! Cursor CLI (Anysphere) — third-class (T3) integration: brand icon + one-click
//! launch only.
//!
//! No session-history scanning and no hook surface (so no Dynamic Island /
//! live status dot — that stays Claude-only). Registered in `TOOLS` purely so
//! the launchpad gets its display name (`list_tools`), its PATH "installed"
//! probe, and the launch binary. `binary_name` is the command users run.
//!
//! Use the distinct `cursor-agent` launcher supplied by the installer.
//! The generic `agent` alias can belong to another installed CLI.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "cursor",
    display_name: "Cursor",
    binary_name: "cursor-agent",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &[],
};
