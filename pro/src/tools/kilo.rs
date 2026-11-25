//! Kilo Code (kilo.ai) — an OpenCode fork shipped as the `kilo` CLI
//! (github.com/Kilo-Org/kilocode, `packages/opencode/bin/kilo`).
//!
//! Shares OpenCode's Drizzle SQLite schema, so history / heatmap / reading
//! reuse the OpenCode readers with a different db path:
//!   - `~/.local/share/kilo/kilo.db` (XDG data root, `app = "kilo"` in
//!     packages/core/src/global.ts; the fork also honors a `KILO_DB` env
//!     override that Coffee CLI does not read)
//! See server.rs `kilo_db`, `find_drizzle_sessions_sqlite`, and
//! `collect_opencode_heatmap_entries`.
//!
//! Like MiMo Code, the fork ships OpenCode's opaque #000 TUI default, so it
//! joins the maintenance dispatch (`maintain_tool` in hook_installer.rs) purely
//! for the `ensure_opencode_tui_theme_default(home, "kilo")` write that stamps
//! `~/.config/kilo/tui.json` with the transparent `lucent-orng` theme. No
//! OpenCode status plugin was ever installed for Kilo (new tool).

use super::{HistoryShape, ToolDescriptor};

pub static DESCRIPTOR: ToolDescriptor = ToolDescriptor {
    id: "kilo",
    display_name: "Kilo Code",
    binary_name: "kilo",
    // See module doc — needs the tui.json transparency write via dispatch.
    has_legacy_hook_artifacts: true,
    // Same shape as OpenCode so the registry scan skips it (its SQLite
    // second pass in server.rs emits finished SavedSessions instead).
    history_shape: Some(HistoryShape::OpenCodeMixed {
        root_under_home: ".local/share/kilo",
    }),
    default_args: &[],
};
