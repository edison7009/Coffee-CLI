//! Antigravity CLI (Google) — `agy` binary.
//!
//! Successor to Gemini CLI as of 2026-05-19; Gemini CLI consumer access
//! sunsets 2026-06-18. Coffee CLI swapped the slot wholesale rather than
//! shipping both since the consumer flow is what mass-market users hit.
//! Enterprise users with Code Assist Standard/Enterprise still have
//! Gemini CLI on PATH and can wire it up via `tool_config` as a custom
//! command if they need it.
//!
//! ## On-disk layout
//!
//! Antigravity shares the `.gemini/` namespace with the retiring Gemini
//! CLI. Two distinct subtrees, both under `~/.gemini/`:
//!
//! **`~/.gemini/antigravity/`** — shared by the Antigravity IDE and
//! agy CLI. User-facing extension surfaces live here:
//!
//!   ├── skills/                — global skills dir (markdown SKILL.md
//!   │                            per sub-dir). This is what Coffee
//!   │                            CLI's skill junction targets — same
//!   │                            convention as the Antigravity IDE
//!   │                            and the published `antigravity-
//!   │                            awesome-skills` installer.
//!   ├── global_workflows/      — global workflow files (Antigravity-
//!   │                            specific concept, not currently
//!   │                            consumed by Coffee CLI).
//!   ├── brain/, conversations/, code_tracker/, browser_recordings/,
//!   │   daemon/, …             — Antigravity IDE runtime state.
//!   │                            Coffee CLI doesn't read these.
//!
//! **`~/.gemini/antigravity-cli/`** — agy CLI's own operational data:
//!
//!   ├── bin/                              — embedded helper binaries
//!   ├── brain/<conv-uuid>/.system_generated/logs/transcript_full.jsonl
//!   │                                     — full transcript, one JSON
//!   │                                       row per step
//!   │                                       (`USER_INPUT` / `GENERIC` /
//!   │                                       `PLANNER_RESPONSE` / …).
//!   │                                       Populated on current builds;
//!   │                                       transcript.jsonl is the
//!   │                                       windowed variant.
//!   ├── conversations/<conv-uuid>.db      — SQLite conversation state
//!   │                                       (protobuf `.pb` on early
//!   │                                       builds). Not read by Coffee
//!   │                                       CLI.
//!   ├── implicit/<uuid>.pb                — protobuf side-state.
//!   ├── cache/conversation_metadata.json  — the history index:
//!   │                                       `{"conversations": {uuid:
//!   │                                       {summary: {Title, Preview,
//!   │                                       UpdatedAt, WorkspaceURIs},
//!   │                                       is_internal, ...}}}`.
//!   ├── cache/last_conversations.json     — `{ "<workspace>": "<conv-uuid>" }`
//!   ├── history.jsonl                     — user prompt history rows:
//!   │                                       `{display, timestamp,
//!   │                                         workspace, conversationId}`.
//!   │                                       No model responses.
//!   ├── log/cli-YYYYMMDD_HHMMSS.log
//!   ├── settings.json, keybindings.json, installation_id
//!   └── updater/, knowledge/
//!
//! **Workspace-scoped** (not in home — under each project root):
//!
//!   <ws>/.agent/{skills,rules,workflows}/
//!
//! Other paths to be aware of:
//!   - `~/.gemini/GEMINI.md`                — global rules file. Filename
//!                                            sticky from the Gemini CLI
//!                                            era; Antigravity still
//!                                            reads it. Coffee CLI does
//!                                            not write here.
//!   - `~/.gemini/oauth_creds.json`          — shared Google auth.
//!   - `~/.antigravitycli/` (dotdir at root) — STALE placeholder some
//!                                            installers leave behind;
//!                                            unrelated to live agy
//!                                            sessions. Don't point
//!                                            anything at it.
//!
//! ## What we ship in v1
//!
//! Allowed-paths include `~/.gemini/antigravity-cli/` so the security
//! gate on `read_native_session` accepts conversation paths under it.
//! Resume uses `--conversation <uuid>` (wired in `terminal::AGENT_PRESETS`).
//!
//! History surfaces come from two sources:
//!   - `find_antigravity_cli_sessions` (server.rs) walks
//!     `~/.gemini/antigravity-cli/brain/<uuid>/…/transcript_full.jsonl`
//!     (stat-first, newest 200) and enriches each conversation with the
//!     metadata index (`cache/conversation_metadata.json`) when present;
//!     index-missing sessions derive their title from the first
//!     USER_INPUT row and their cwd from `cache/last_conversations.json`.
//!   - `history_shape` below walks `~/.gemini/tmp/<project>/chats/
//!     session-*.jsonl`, the retired Gemini CLI layout early agy builds
//!     still wrote (verified on populated 2026-05-20 session files).
//!     Both surface as tool="antigravity".
//!
//! Deferred:
//!   - `conversations/<uuid>.db` is unread — the source of truth lives
//!     in the metadata index + transcript JSONL, which cover titles,
//!     workspaces, timestamps and message content.
//!   - `agy plugin install <target>` (the persistent plugin registry)
//!     is a separate richer mechanism than our skills dir. Coffee CLI
//!     doesn't wire plugins through it yet — users wanting plugins
//!     install them directly via the CLI.

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "antigravity",
    display_name: "Antigravity CLI",
    binary_name: "agy",
    has_legacy_hook_artifacts: false,
    // Legacy Gemini CLI (and early agy builds) wrote session JSONL to
    // `~/.gemini/tmp/<project>/chats/session-*.jsonl` — still walked here
    // for users with old sessions. Current agy keeps conversations under
    // `~/.gemini/antigravity-cli/brain/`, which server.rs's
    // `find_antigravity_cli_sessions` second pass scans (metadata-index
    // enriched). Both sources surface as tool="antigravity": Gemini CLI as
    // a separate product is retiring anyway, so a unified label is the
    // cleaner UX.
    history_shape: Some(HistoryShape::AntigravityTmp {
        root_under_home: ".gemini/tmp",
        depth: 3,
    }),
    default_args: &[],
};
