//! Kimi Code — brand icon + one-click launch, session-history scanning, and
//! auto-resume.
//!
//! Moonshot AI's `kimi` binary (npm `@moonshot-ai/kimi-code`). Sessions
//! live under a flat `~/.kimi-code/` root (same path on every OS; override
//! `KIMI_CODE_HOME`) in an INDEX-based layout — NOT a dir of JSONL files
//! and NOT SQLite:
//!   - `~/.kimi-code/session_index.jsonl` — one line per main session:
//!     `{sessionId, sessionDir, workDir}`. Sub-agents (`agents/agent-0/`)
//!     are nested under each main session's dir, never separate index
//!     entries, so the index gives main sessions only — no dedup needed.
//!   - `<sessionDir>/state.json` — `{createdAt, updatedAt, title, lastPrompt}`.
//!   - `<sessionDir>/agents/main/wire.jsonl` — full main-agent conversation;
//!     resume source (Kimi replays from it) + heatmap message count.
//!
//! Because the entry point is an index file (not a dir walk), this bypasses
//! the generic mtime-then-parse pipeline — `KimiIndex` is skipped in
//! `collect_registry_history_candidates` and emitted by a bespoke second
//! pass (`find_kimi_sessions` + `collect_kimi_heatmap_entries` in server.rs).
//!
//! Resume: `kimi --session <sessionId>` (canonical `-S, --session` flag,
//! verified against `kimi --help`). Token shape `session_<uuid>`.
//!
//! Older Coffee releases wrote `[[hooks]]` entries to config.toml. Startup
//! removes only those Coffee-owned blocks; current builds never install them.
//! Registered in `TOOLS` for display name + PATH probe + launch binary +
//! history. Launchpad tile is the frontend's hardcoded AGENT_CATALOG.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "kimicode",
    display_name: "Kimi Code",
    binary_name: "kimi",
    has_legacy_hook_artifacts: true,
    // ~/.kimi-code/ — flat on all OS (override KIMI_CODE_HOME). Bypasses
    // the file-walk pipeline; server.rs `kimi_root` + `find_kimi_sessions`
    // read session_index.jsonl + state.json.
    history_shape: Some(HistoryShape::KimiIndex {
        root_under_home: ".kimi-code",
    }),
    default_args: &[],
};
