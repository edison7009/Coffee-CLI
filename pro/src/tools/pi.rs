//! Pi — second-class (T2) integration: brand icon + one-click launch +
//! session-history scanning + auto-resume.
//!
//! Pi (earendil-works `pi` binary) stores sessions as JSONL trees at
//! `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl` — the
//! same depth-2 layout as Claude Code's `projects/<encoded-cwd>/*.jsonl`,
//! so the generic file-walker + heatmap machinery (GenericJsonl) applies
//! unchanged. Only the per-line parser differs (Pi's header is
//! `{type:"session", id, cwd, timestamp}` and message rows nest under
//! `message.role`), handled by `parse_pi_session_jsonl` in server.rs.
//!
//! No hook surface (so no live Dynamic Island — stays the static "fake
//! island" green, like Antigravity / Qwen / OpenClaw). Registered in
//! `TOOLS` for display name + PATH probe + launch binary + history. The
//! launchpad tile + resume preset live in the frontend's AGENT_CATALOG
//! (CenterPanel) and terminal.rs AGENT_PRESETS.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "pi",
    display_name: "Pi",
    binary_name: "pi",
    has_legacy_hook_artifacts: false,
    // ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl — depth 2, same
    // walker as Claude Code. cwd + session id live INSIDE the file header
    // (no bucket-name decoding needed, unlike Claude's ~/.claude.json map).
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".pi/agent/sessions",
        depth: 2,
    }),
    default_args: &[],
};
