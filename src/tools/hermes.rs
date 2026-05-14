//! Hermes Agent — `hermes` binary.
//!
//! NB: Always say "Hermes Agent", never bare "Hermes" (luxury-brand
//! conflict). The display name reflects this.
//!
//! ## Where Hermes Agent stores its data
//!
//! Unlike the other agent CLIs (Claude/Codex/Gemini/Qwen/OpenClaw),
//! Hermes's data root is platform-dependent and runtime-overridable:
//!
//!   - macOS / Linux:  `~/.hermes/`
//!   - Windows:        `%LOCALAPPDATA%\hermes\`
//!                     (the official `install.ps1` chose this over
//!                     `%USERPROFILE%\.hermes\` to follow Windows
//!                     conventions, and sets `HERMES_HOME` as a User
//!                     env var pointing there)
//!   - Anywhere:       `$HERMES_HOME` overrides both above when set.
//!
//! All path-touching code (history scan, plugin install, allowlist)
//! goes through `hermes_home()` instead of hardcoding `~/.hermes`,
//! otherwise we silently miss data on Windows.
//!
//! Skills concept landed upstream in 2026-05 (the installer creates
//! `<HERMES_HOME>/skills/` and runs `tools/skills_sync.py`). Our
//! mirror routes through `ToolDescriptor::skill_dir`, which short-
//! circuits to `hermes_home().join("skills")` for this descriptor —
//! `skill_dir_relative: Some("skills")` is therefore only a label,
//! never naively joined under `home`.

use std::path::PathBuf;

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "hermes",
    display_name: "Hermes Agent",
    binary_name: "hermes",
    // <HERMES_HOME>/skills/ — see module doc for the Windows home
    // override. ToolDescriptor::skill_dir special-cases the join.
    skill_dir_relative: Some("skills"),
    // Hermes Agent exposes plugin hooks via `<HERMES_HOME>/plugins/<name>/`
    // Python plugins. Coffee CLI installs `coffee-cli-status` for the
    // tab indicator only.
    has_hook_surface: true,
    // <HERMES_HOME>/sessions/session_*.json — flat directory of full
    // JSON files (not JSONL); custom parser parse_hermes_json.
    history_shape: Some(HistoryShape::HermesFlatJson),
    default_args: &[],
};

/// Resolve Hermes Agent's data root. See module-level doc for the
/// macOS/Linux vs Windows split and the `HERMES_HOME` override.
///
/// Never panics; falls back to a best-effort path if neither
/// `HERMES_HOME` nor any platform home dir is resolvable (rare —
/// only on misconfigured systems with no `$HOME` / `%USERPROFILE%`).
pub fn hermes_home() -> PathBuf {
    if let Ok(v) = std::env::var("HERMES_HOME") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = dirs::data_local_dir() {
            return local.join("hermes");
        }
    }
    dirs::home_dir().unwrap_or_default().join(".hermes")
}
