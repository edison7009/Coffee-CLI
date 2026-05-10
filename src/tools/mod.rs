//! Per-tool integration registry — single source of truth for the
//! per-CLI facts Coffee CLI needs (binary name, skills dir, history
//! shape, hook surface, launch argv). Iterate `TOOLS` instead of
//! hardcoding lists in callers.
//!
//! Adding a new tool: create `src/tools/<id>.rs` with a `ToolDescriptor`
//! constant, register it in `TOOLS` below, and (if it has a hook
//! surface) add an arm to `hook_installer::dispatch_install`.

use std::path::{Path, PathBuf};

/// Where this tool stores its session history on disk and what
/// shape it lives in. Coffee CLI's history scanner (`server.rs`)
/// and message heatmap both consume this. Defaults are relative
/// to `$HOME` (`$USERPROFILE` on Windows); users override per-tool
/// via `~/.coffee-cli/tools.json` (`tool_config.history_path`).
///
/// Each variant maps to a different scanner / parser combination
/// in `server.rs`. New tool families (e.g. another SQLite-backed
/// CLI) get a new variant; CLIs whose layout matches an existing
/// family reuse the variant.
#[derive(Debug, Clone, Copy)]
pub enum HistoryShape {
    /// JSONL files at fixed scan depth, parsed by the generic
    /// `parse_agent_jsonl`. Used by Claude Code (depth 2 from
    /// `projects/`) and OpenClaw (depth 3 from `agents/`).
    GenericJsonl {
        root_under_home: &'static str,
        depth: u8,
    },

    /// Hermes Agent — flat directory of `session_*.json` files
    /// (JSON, not JSONL). Custom parser `parse_hermes_json`.
    HermesFlatJson { root_under_home: &'static str },

    /// Codex dated-rollout layout: `<YYYY>/<MM>/<DD>/rollout-*.jsonl`.
    /// Custom parser `parse_codex_session_jsonl`.
    CodexRollout {
        root_under_home: &'static str,
        depth: u8,
    },

    /// Gemini CLI: `tmp/<project-folder>/chats/session-*.jsonl`.
    /// Custom parser plus a project-hash → cwd map loaded once
    /// per scan. `parse_gemini_session_jsonl`.
    GeminiTmp {
        root_under_home: &'static str,
        depth: u8,
    },

    /// Qwen Code: `projects/<sanitized-cwd>/chats/<session>.jsonl`.
    /// Custom parser `parse_qwen_session_jsonl`.
    QwenProjects {
        root_under_home: &'static str,
        depth: u8,
    },

    /// OpenCode: SQLite DB (`storage/db.sqlite`) plus legacy
    /// JSONL files. Walked by `find_opencode_sessions`, cannot be
    /// processed by the generic mtime-then-parse pipeline.
    OpenCodeMixed { root_under_home: &'static str },
}

impl HistoryShape {
    /// Default disk root for this tool's session history, relative
    /// to `$HOME`. Used by `tool_config::history_path_for` lookup.
    pub fn root_under_home(&self) -> &'static str {
        match self {
            HistoryShape::GenericJsonl { root_under_home, .. }
            | HistoryShape::HermesFlatJson { root_under_home }
            | HistoryShape::CodexRollout { root_under_home, .. }
            | HistoryShape::GeminiTmp { root_under_home, .. }
            | HistoryShape::QwenProjects { root_under_home, .. }
            | HistoryShape::OpenCodeMixed { root_under_home } => root_under_home,
        }
    }

    /// Resolve `root_under_home` against a caller-provided home dir.
    /// Forward slashes in the relative path are converted to the
    /// platform separator. Pass the same `home` you used elsewhere
    /// in the call so per-call path resolution stays consistent.
    pub fn join_under(&self, home: &Path) -> PathBuf {
        join_relative(home, self.root_under_home())
    }

    /// JSONL scan depth, when the shape uses the mtime-then-parse
    /// pipeline. `None` for shapes that bypass it (HermesFlatJson
    /// uses a flat-dir collector; OpenCodeMixed uses SQLite).
    pub fn jsonl_depth(&self) -> Option<u8> {
        match self {
            HistoryShape::GenericJsonl { depth, .. }
            | HistoryShape::CodexRollout { depth, .. }
            | HistoryShape::GeminiTmp { depth, .. }
            | HistoryShape::QwenProjects { depth, .. } => Some(*depth),
            HistoryShape::HermesFlatJson { .. } | HistoryShape::OpenCodeMixed { .. } => None,
        }
    }
}

/// Join a forward-slash-relative path under `home`, converting to the
/// platform separator. Use for any registry-derived path — Windows APIs
/// mostly tolerate mixed separators, but normalising at construction
/// time avoids surprises in display strings, glob comparisons, and
/// downstream string-matching.
pub(crate) fn join_relative(home: &Path, rel: &str) -> PathBuf {
    if std::path::MAIN_SEPARATOR == '/' {
        home.join(rel)
    } else {
        home.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
    }
}

/// How Coffee CLI infers "this tool just edited file X" for the
/// audit log. The choice depends on what kind of hook surface the
/// upstream CLI exposes.
#[derive(Debug, Clone, Copy)]
pub enum FileEditAttribution {
    /// Per-tool-call hook with a file path field. The forwarder
    /// script (Python / JS) extracts `file_path` from the tool
    /// input and POSTs a `file_edit` payload to the hook server.
    /// Examples: Claude Code (`PostToolUse` with Edit/Write/MultiEdit
    /// tool input), OpenCode (`tool.execute.after` plugin hook).
    Hook,

    /// Only turn-level signals available. On turn-complete the
    /// forwarder includes its cwd in the payload; the hook server
    /// walks that folder and diffs against the global baseline,
    /// attributing each changed file to this tool. Imperfect
    /// (concurrent external edits during a turn get attributed
    /// here) but the only path Codex exposes today.
    TurnSnapshot,

    /// No hook integration → files modified by this tool DO NOT
    /// appear in the audit log. Coffee CLI deliberately scopes the
    /// audit list to "what tools running inside Coffee CLI's PTYs
    /// did" — anything outside (no hook, external terminal, IDE
    /// edits) is invisible by design.
    None,
}

/// One static fact-bundle per supported AI CLI. Pure data; behaviours
/// (hook installation, history parsing, …) live in dedicated modules
/// below — each tool gets its own file under `src/tools/<id>.rs`.
///
/// Adding a new tool = create `src/tools/<id>.rs`, write its
/// `ToolDescriptor` constant, add it to `TOOLS` below.
#[derive(Debug, Clone)]
pub struct ToolDescriptor {
    /// Stable internal id used in protocol payloads and frontend
    /// `ToolType` discriminants. Must match the user-visible CLI
    /// name (claude → "claude", openclaw → "openclaw").
    pub id: &'static str,

    /// Display name shown in launchpad cards / tool pickers /
    /// history rows. Frontend pulls these via the `list_tools`
    /// IPC; see `src-ui/src/lib/tool-info.ts`. Always required —
    /// pseudo-tools without a brand name (terminal / remote) are
    /// not registered here and use locale-specific labels in i18n.
    pub display_name: &'static str,

    /// Binary name to look up via `where` (Windows) / `which`
    /// (Unix). Single source of truth for "is this tool on PATH".
    pub binary_name: &'static str,

    /// Where this tool's enabled skills should be junctioned, as a
    /// path relative to the user's home directory (forward-slash).
    /// Three layout families exist (dotdir / XDG / workspace-nested);
    /// each tool encodes its own. `None` = tool doesn't have a
    /// skills concept yet (e.g. Hermes pre-2026-05-09).
    pub skill_dir_relative: Option<&'static str>,

    /// How "this tool just edited X" gets reported for the audit
    /// log. Tools without hook integration (`None`) silently
    /// don't show up in the audit list — Coffee CLI's audit
    /// philosophy is "Coffee CLI's PTY-spawned tools only", so
    /// this is by design, not a TODO.
    pub file_edit_attribution: FileEditAttribution,

    /// Shape of this tool's on-disk session history. `None` =
    /// tool doesn't expose a scannable history (no entries on
    /// the History board, no contributions in the heatmap).
    /// Currently every registered CLI has a history; field is
    /// optional for future tools that may not.
    pub history_shape: Option<HistoryShape>,

    /// Argv prepended to every spawn of this tool *before* any
    /// multi-agent flags or user-configured `extra_args`. Used
    /// for CLIs whose primary REPL is a subcommand of the binary
    /// — e.g. OpenClaw's TUI is `openclaw tui`, not bare
    /// `openclaw`. Most tools have an empty list.
    pub default_args: &'static [&'static str],
}

mod claude;
mod codex;
mod gemini;
mod hermes;
mod openclaw;
mod opencode;
mod qwen;

/// All supported AI CLIs. Order matches launchpad layout (claude
/// first, then codex, …). Iterate this when you need to do
/// something for every tool — don't hardcode lists in callers.
pub static TOOLS: &[&ToolDescriptor] = &[
    &claude::DESCRIPTOR,
    &codex::DESCRIPTOR,
    &opencode::DESCRIPTOR,
    &gemini::DESCRIPTOR,
    &qwen::DESCRIPTOR,
    &openclaw::DESCRIPTOR,
    &hermes::DESCRIPTOR,
];

/// Lookup by id. `None` if the id isn't registered. Used by hook
/// dispatch (where the `tool` field arrives as a string from a
/// Python/JS forwarder) and by the launchpad's per-tool actions.
pub fn find(id: &str) -> Option<&'static ToolDescriptor> {
    TOOLS.iter().find(|t| t.id == id).copied()
}

/// Frontend-facing summary of a registered tool. Returned by the
/// `list_tools` IPC so the UI can pull display names off the registry
/// instead of hardcoding label tables in every component.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: &'static str,
    pub display_name: &'static str,
}

#[tauri::command]
pub fn list_tools() -> Vec<ToolInfo> {
    TOOLS
        .iter()
        .map(|t| ToolInfo {
            id: t.id,
            display_name: t.display_name,
        })
        .collect()
}
