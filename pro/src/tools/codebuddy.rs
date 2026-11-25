//! CodeBuddy Code (Tencent) — second-class (T2) integration: brand icon +
//! one-click launch + session-history scanning + resume.
//!
//! Installed via `npm i -g @tencent-ai/codebuddy-code` (or Homebrew / the
//! native installer); the documented command is `codebuddy` (`cbc` is an
//! alias for the same entry point), so that's the binary we probe and spawn.
//!
//! Sessions live at `~/.codebuddy/projects/<compressed-cwd>/<uuid>.jsonl`
//! (`CODEBUDDY_CONFIG_DIR` replaces `~/.codebuddy`; see `history_root` in
//! server.rs). Same depth-2 layout as Claude Code's `projects/`, so the
//! generic file-walker + heatmap machinery (GenericJsonl) applies unchanged.
//! Sub-agent transcripts sit one level deeper
//! (`<session-uuid>/subagents/<agent-id>.jsonl`) and are excluded by the
//! depth limit, so one conversation yields exactly one history row.
//!
//! Only the per-line schema differs from Claude: CodeBuddy wraps each history
//! item in an envelope (`{type, uuid, timestamp, payload:{…}}`) and stores the
//! conversation as `payload.type == "message"` rows with `role` + content
//! blocks. Handled by `parse_codebuddy_session_jsonl` in server.rs.
//!
//! No hook surface (so the tab stays in its native terminal UI — no Dynamic
//! Island). Registered in `TOOLS` for display name + PATH probe + launch
//! binary + history; the launchpad tile lives in CenterPanel's AGENT_CATALOG
//! and the resume preset in terminal.rs AGENT_PRESETS.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "codebuddy",
    display_name: "CodeBuddy",
    binary_name: "codebuddy",
    has_legacy_hook_artifacts: false,
    // ~/.codebuddy/projects/<compressed-cwd>/<uuid>.jsonl — depth 2, same
    // walker as Claude Code. cwd + session id live INSIDE the transcript
    // (each item carries `cwd`), so no bucket-name decoding is needed.
    history_shape: Some(HistoryShape::GenericJsonl {
        root_under_home: ".codebuddy/projects",
        depth: 2,
    }),
    default_args: &[],
};
