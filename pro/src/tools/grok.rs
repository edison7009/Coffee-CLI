//! Grok Build (xAI) - `grok` binary.
//!
//! Hookless integration with native OSC-title dynamic island, history, heatmap,
//! changes, and resume. Existing hook configuration is left untouched.
//!
//! Session storage (verified against on-disk files 2026-07-10): each session
//! lives in its own dir `~/.grok/sessions/<url-encoded-cwd>/<uuid>/` with a
//! `summary.json` index (title / cwd / timestamps / message counts) and a
//! `chat_history.jsonl` conversation log. `GROK_HOME` overrides the base dir.
//! This nested dir + summary-index layout doesn't fit GenericJsonl (flat
//! JSONL files) nor a SQLite shape, so it gets its own HistoryShape variant
//! and a bespoke second pass in server.rs (`find_grok_sessions` /
//! `collect_grok_heatmap_entries`), mirroring the Kimi index second pass.
//!
//! Resume: `grok --resume <uuid>` (UUIDv7). The token is sourced from the
//! history scanner (summary.json `info.id`), not PTY scraping. Coffee CLI
//! launches grok raw - no auth injection, no hook config; grok authenticates
//! itself via `~/.grok/auth.json` (native OAuth, verified working standalone).

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "grok",
    display_name: "Grok Build",
    binary_name: "grok",
    has_legacy_hook_artifacts: true,
    // ~/.grok/sessions/<encoded-cwd>/<uuid>/{summary.json, chat_history.jsonl}
    // Bespoke second pass - bypasses the generic mtime-then-parse pipeline
    // (the session metadata is in summary.json, not the JSONL filename/mtime).
    history_shape: Some(HistoryShape::GrokSessions {
        root_under_home: ".grok/sessions",
    }),
    default_args: &[],
};
