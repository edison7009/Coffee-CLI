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
//!   ├── brain/<conv-uuid>/.system_generated/logs/transcript.jsonl
//!   │                                     — *empty in practice* on
//!   │                                       observed sessions; NOT
//!   │                                       the source of truth.
//!   ├── conversations/<conv-uuid>.pb      — protobuf-encoded
//!   │                                       conversation state
//!   │                                       (binary, not JSON-
//!   │                                       parseable).
//!   ├── implicit/<uuid>.pb                — protobuf side-state.
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
//! `binary_name` = `agy`, `skill_dir_relative` = `.gemini/antigravity/
//! skills` (junctioned skills land alongside whatever the IDE / 3rd-
//! party installers put there — same shared dir, just a sibling).
//! Allowed-paths include `~/.gemini/antigravity-cli/` so the security
//! gate on `read_native_session` accepts conversation paths under it.
//! Resume uses `--conversation <uuid>` (wired in `terminal::AGENT_PRESETS`).
//!
//! Deferred:
//!   - `history_shape` stays `None` — the source of truth is the
//!     protobuf `.pb` blob. `history.jsonl` only carries user prompts
//!     (no model responses), and the per-conversation `transcript.jsonl`
//!     is empty on every session observed. A real scanner needs either
//!     the .pb schema (reverse-engineered or upstream-published) or a
//!     future feature that flushes the model side to .jsonl too.
//!   - `agy plugin install <target>` (the persistent plugin registry)
//!     is a separate richer mechanism than our skills dir. Coffee CLI
//!     doesn't wire plugins through it yet — users wanting plugins
//!     install them directly via the CLI.

use super::ToolDescriptor;

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "antigravity",
    display_name: "Antigravity CLI",
    binary_name: "agy",
    skill_dir_relative: Some(".gemini/antigravity/skills"),
    has_hook_surface: false,
    history_shape: None,
    default_args: &[],
};
