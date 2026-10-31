//! DeepSeek Harness (github.com/deepseek-ai/deepseek-harness) — desktop-only in
//! Coffee CLI: tabs drive `dsh --profile sdk` over JSON-RPC (src/dsh_session.rs)
//! and render the native Session events, so there is no terminal launch.
//!
//! `binary_name` covers a `dsh` command on PATH; `check_tools_installed` also
//! accepts the runtime bundled with DeepSeek Harness Desktop.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "dsh",
    display_name: "DeepSeek Harness",
    binary_name: "dsh",
    has_legacy_hook_artifacts: false,
    history_shape: None,
    default_args: &[],
};
