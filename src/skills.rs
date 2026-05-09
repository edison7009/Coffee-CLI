//! Coffee CLI Skills — cross-CLI shared skill store.
//!
//! Architecture (matches Codex's `$CODEX_HOME/skills` + Claude Code's
//! `~/.claude/skills` convention; each enabled skill gets a per-skill
//! symlink/junction so the user's own skills directory contents stay
//! untouched):
//!
//! ```text
//!   ~/.coffee-cli/skills/<name>/         ← enabled (linked into each CLI)
//!   ~/.coffee-cli/skills-library/<name>/ ← downloaded but disabled
//!
//!   ~/.claude/skills/<name>  → junction → ~/.coffee-cli/skills/<name>
//!   ~/.codex/skills/<name>   → junction → ~/.coffee-cli/skills/<name>
//! ```
//!
//! Per-skill (not parent-dir) linking is the safe choice: the user's own
//! `~/.claude/skills/foo` stays where it was, only the skills *we manage*
//! get a symlink alongside it.
//!
//! Permission model on Windows: junctions (FSCTL reparse points) need NO
//! special privilege when source and link are on the same volume. We keep
//! both under `%USERPROFILE%`, so junctions work for any user — no admin,
//! no developer mode toggle. (Symbolic links would have required either,
//! which is a non-starter for a desktop app.)
//!
//! Download model (deferred for future custom-skill upload flow): the
//! frontend would do HTTP fetches via `fetch()` and pipe bytes into
//! `skills_write_file`. No HTTP client in Rust deps.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 38 curated skills from `openai/skills` baked into the binary at compile
/// time. ~6 MB of mostly markdown + small scripts; rodata-cheap, network-
/// expensive at runtime so we ship them embedded. Seeded into the user's
/// `~/.coffee-cli/skills-library/` on first launch (idempotent — file
/// already present is left alone, so user toggles aren't disturbed by
/// app upgrades).
static BUNDLED_OPENAI_SKILLS: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/vendor/openai-skills/.curated");

/// Coffee CLI's own skills (vibeid, etc.). Same seeding pipeline as the
/// openai bundle; lives in a separate vendor dir so each set retains
/// its own license/lineage and openai's snapshot can be re-synced from
/// upstream without disturbing our skills (and vice versa).
static BUNDLED_COFFEE_SKILLS: include_dir::Dir<'_> =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/vendor/coffee-skills");

/// CLI directories where Coffee CLI mirrors enabled skills via symlink.
/// All six paths below resolve to the same agentskills.io shape
/// (`<dir>/<name>/SKILL.md`), so one symlink per target dir is all
/// it takes.
///
/// Three layout families to mind:
///   - **Dotdir family** (claude / codex / gemini / qwen): everything
///     under `~/.<tool>/`, so skills live at `~/.<tool>/skills/`.
///   - **XDG family** (opencode): config in `~/.config/<tool>/`, data
///     in `~/.local/share/<tool>/`. Skills are user-installed
///     extensions → live in **config**, not data. So opencode's
///     skills dir is `~/.config/opencode/skills/`, NOT under the
///     `~/.local/share/opencode/` history root the heatmap scanner
///     uses. Don't blindly apply the "history dir's parent" heuristic
///     to XDG-family tools.
///   - **Workspace-nested family** (openclaw): skills live inside
///     OpenClaw's "workspace" dir at `~/.openclaw/workspace/skills/`.
///     **Known limitation**: workspace root is configurable via
///     `agents.defaults.workspace` in `~/.openclaw/openclaw.json`. Our
///     constant uses the default; users who override that key won't
///     get the junction at the right place. Future: read openclaw.json
///     and resolve workspace dynamically — `agent_mcp_config.rs`
///     already has the read-this-file pattern (see memory
///     `reference_openclaw_mcp_gate`).
///
/// Membership criterion: documented or empirically observed that the
/// binary scans the path on launch.
///
/// **Deliberately excluded** (no upstream skills support; adding
/// would just create stray empty dirs in their home):
///   - `.hermes/skills` — Hermes Agent has no skills concept yet
///     (and no Windows support at all). Per upstream confirmation
///     2026-05-09: WHEN Hermes adds skills, the path WILL be
///     `~/.hermes/skills/<name>/SKILL.md` (dotdir family). Add the
///     entry then; don't pre-create now or we leave empty
///     `~/.hermes/skills/` dirs in homes that don't even have Hermes.
/// Per-target tuple: `(binary_name, skill_dir)`.
///
/// `binary_name` is what `where`/`which` looks up. We **only link
/// skills if the binary is on PATH** — otherwise we'd be creating
/// tool dirs (`~/.qwen/`, `~/.codex/`, etc.) for tools the user
/// never installed, which (a) clutters their home and (b) misleads
/// file-explorer tooling into thinking the tool is present.
///
/// This reuses the same detection the launchpad uses for greying
/// out tool cards (`server::check_tool_windows` / `_unix`), so
/// "Coffee CLI thinks tool X is installed" is a single source of
/// truth across launchpad, heatmap, and skills mirror.
///
/// Trade-off vs a cheaper directory-existence check: we shell out
/// to `where`/`which` per target on each toggle (6 spawns). Toggle
/// is a rare user action so the cost is negligible, and being
/// authoritative about "is the tool installed?" beats inferring
/// from filesystem residue (a stale `~/.qwen/` left by an
/// uninstall would otherwise fool a dir-marker check).
const TARGET_CLI_SKILL_DIRS: &[(&str, &str)] = &[
    ("claude",   ".claude/skills"),
    ("codex",    ".codex/skills"),
    ("gemini",   ".gemini/skills"),
    ("qwen",     ".qwen/skills"),
    ("opencode", ".config/opencode/skills"),
    ("openclaw", ".openclaw/workspace/skills"),
];

/// Wraps the platform-specific PATH check from `server.rs` so
/// `link_into_cli_dirs` can stay platform-clean.
fn is_tool_installed(bin: &str) -> bool {
    #[cfg(target_os = "windows")]
    { crate::server::check_tool_windows(bin) }
    #[cfg(not(target_os = "windows"))]
    { crate::server::check_tool_unix(bin) }
}

/// Phased rollout allowlist. The combined bundle (openai/skills .curated
/// + Coffee CLI's own skills) always ships every skill, but only the
/// names listed here are surfaced via seeding + UI. Enables "test 5,
/// ship 5, test next batch, ship next batch" without re-cutting a
/// release just to add more skill catalog entries.
///
/// v1 batch (2 skills validating the architecture):
///   - `screenshot` — openai/skills curated; pure SKILL.md, no API keys.
///     Validates the openai-skills bundle → junction → /screenshot path.
///   - `vibeid` — Coffee CLI's own skill; ships scripts/ + matrix.json,
///     references CDN-hosted persona images, requires Claude Code's
///     /insights data. Validates the coffee-skills bundle path AND the
///     more complex script-bundled skill shape.
const VISIBLE_SKILLS: &[&str] = &["screenshot", "vibeid"];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub name: String,
    pub enabled: bool,
    /// Raw SKILL.md content (UTF-8). Frontend parses YAML frontmatter to
    /// pull display name / description / category. Returns None when the
    /// skill folder exists but its SKILL.md is missing or unreadable.
    pub skill_md: Option<String>,
    /// `data:image/...;base64,...` URL for the skill's icon, if any.
    /// Probes `assets/<name>-small.svg` → `assets/<name>.svg` →
    /// `assets/<name>.png` and embeds the first match. None if no
    /// icon exists. Embedding (vs serving via asset:// protocol) keeps
    /// the IPC self-contained — frontend can `<img src={iconDataUrl}>`
    /// without a second round-trip.
    pub icon_data_url: Option<String>,
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "No home directory".to_string())
}

pub fn skills_root() -> Result<PathBuf, String> {
    Ok(home()?.join(".coffee-cli").join("skills"))
}

pub fn library_root() -> Result<PathBuf, String> {
    Ok(home()?.join(".coffee-cli").join("skills-library"))
}

/// Make sure the canonical Coffee CLI skill dirs exist AND the bundled
/// skill catalog has been seeded. Safe to call on every app launch /
/// every Skills-page open — both phases are idempotent.
#[tauri::command]
pub fn skills_ensure_dirs() -> Result<(), String> {
    fs::create_dir_all(skills_root()?).map_err(|e| format!("create skills/: {}", e))?;
    fs::create_dir_all(library_root()?).map_err(|e| format!("create skills-library/: {}", e))?;
    seed_library_from_bundle()?;
    Ok(())
}

/// Files that always overwrite on every app launch — the canonical
/// "skill metadata" set. Other files (scripts/, assets/) only seed
/// once on first install so user-side patches survive Coffee CLI
/// upgrades. Updating these on every launch means a Coffee CLI
/// version bump that ships new SKILL.md frontmatter (rename, reword
/// description, add a locale) takes effect WITHOUT users having to
/// manually delete their library/skills dir.
const ALWAYS_REFRESH_FILENAMES: &[&str] = &["SKILL.md", "matrix.json"];

/// Walk both bundles and seed/refresh skill files into
/// `~/.coffee-cli/skills-library/` (and refresh metadata in
/// `~/.coffee-cli/skills/` for already-enabled skills).
///
/// Three-tier write rule:
///   1. New skills (not present in either dir) → full copy to library
///   2. Existing skills, ALWAYS_REFRESH_FILENAMES (SKILL.md / matrix.json)
///      → overwrite in whichever dir the skill lives (library or skills)
///   3. Existing skills, other files → leave alone (preserves user
///      patches to scripts/, assets/, etc.)
fn seed_library_from_bundle() -> Result<(), String> {
    let lib = library_root()?;
    let enabled = skills_root()?;
    seed_bundle(&BUNDLED_OPENAI_SKILLS, &lib, &enabled)?;
    seed_bundle(&BUNDLED_COFFEE_SKILLS, &lib, &enabled)?;
    Ok(())
}

fn seed_bundle(
    bundle: &include_dir::Dir<'_>,
    lib_root: &Path,
    enabled_root: &Path,
) -> Result<(), String> {
    for entry in bundle.entries() {
        let include_dir::DirEntry::Dir(skill_dir) = entry else { continue };

        // Bundle's top-level entries are individual skill dirs (skill_dir
        // path is single-segment, e.g. "vibeid"). Apply allowlist + figure
        // out where the skill currently lives on disk.
        let name = match skill_dir.path().file_name().and_then(|n| n.to_str()) {
            Some(n) if !n.is_empty() && VISIBLE_SKILLS.contains(&n) => n,
            _ => continue,
        };

        let in_enabled = enabled_root.join(name);
        let in_lib = lib_root.join(name);
        let enabled_exists = in_enabled.exists();
        let lib_exists = in_lib.exists();

        if !enabled_exists && !lib_exists {
            // First-time seed → full copy into library/<name>/.
            full_copy_into(skill_dir, lib_root)?;
            continue;
        }

        // Skill exists somewhere — refresh just the metadata files in
        // whichever dir it lives. Both can be true (defensive); refresh
        // both so the two copies stay consistent if the user manually
        // moved files around.
        if enabled_exists {
            refresh_metadata(skill_dir, &in_enabled)?;
        }
        if lib_exists {
            refresh_metadata(skill_dir, &in_lib)?;
        }
    }
    Ok(())
}

/// Recursively copy every file in `bundle` into `dest_root`, creating
/// parent dirs as needed. Used for the first-time seed of a new skill.
fn full_copy_into(bundle: &include_dir::Dir<'_>, dest_root: &Path) -> Result<(), String> {
    for entry in bundle.entries() {
        match entry {
            include_dir::DirEntry::Dir(sub) => {
                full_copy_into(sub, dest_root)?;
            }
            include_dir::DirEntry::File(file) => {
                let dest = dest_root.join(file.path());
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
                }
                fs::write(&dest, file.contents())
                    .map_err(|e| format!("seed write {}: {}", dest.display(), e))?;
            }
        }
    }
    Ok(())
}

/// Overwrite ALWAYS_REFRESH_FILENAMES in `target_skill_dir` from the
/// matching bundle entries. Skips files that aren't in the bundle (skill
/// might not have a matrix.json, etc.). Other bundle files are NOT
/// touched — user patches to scripts/, assets/, etc. survive upgrade.
///
/// Walks immediate children of `bundle_skill_dir` rather than calling
/// `get_file()` (whose path argument must be relative to the
/// include_dir root, not to the nested Dir handed to us — easy to get
/// wrong, easier to just enumerate).
fn refresh_metadata(
    bundle_skill_dir: &include_dir::Dir<'_>,
    target_skill_dir: &Path,
) -> Result<(), String> {
    for entry in bundle_skill_dir.entries() {
        let include_dir::DirEntry::File(file) = entry else { continue };
        let fname = match file.path().file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !ALWAYS_REFRESH_FILENAMES.contains(&fname) {
            continue;
        }
        let dest = target_skill_dir.join(fname);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        fs::write(&dest, file.contents())
            .map_err(|e| format!("refresh write {}: {}", dest.display(), e))?;
    }
    Ok(())
}

/// Reject anything that's not a single-segment ASCII identifier. Skill
/// names land in filesystem paths and slash-command syntax — keep them
/// boring.
fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 {
        return Err(format!("Invalid skill name length: {}", name));
    }
    for c in name.chars() {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!("Invalid char in skill name: {:?}", name));
        }
    }
    Ok(())
}

/// rel_path must be a forward-slash relative path inside one skill dir —
/// no `..`, no leading slash, no Windows drive letter, no NUL.
fn validate_rel_path(rel_path: &str) -> Result<(), String> {
    if rel_path.is_empty() || rel_path.len() > 255 {
        return Err(format!("Invalid rel_path length: {}", rel_path));
    }
    if rel_path.contains("..")
        || rel_path.starts_with('/')
        || rel_path.starts_with('\\')
        || rel_path.contains(':')
        || rel_path.contains('\0')
    {
        return Err(format!("Invalid rel_path: {}", rel_path));
    }
    Ok(())
}

/// Write one file into `~/.coffee-cli/skills-library/<name>/<rel_path>`.
///
/// Used by the frontend during the download flow: fetch SKILL.md / scripts /
/// assets via `fetch()` then call this for each. Always lands in the
/// disabled "library" tier — user must explicitly toggle to expose to CLIs.
#[tauri::command]
pub fn skills_write_file(name: String, rel_path: String, bytes: Vec<u8>) -> Result<(), String> {
    validate_skill_name(&name)?;
    validate_rel_path(&rel_path)?;
    let target = library_root()?.join(&name).join(&rel_path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    fs::write(&target, &bytes).map_err(|e| format!("write {}: {}", target.display(), e))
}

/// List every skill Coffee CLI knows about, with enable status and raw
/// SKILL.md content. Frontend parses frontmatter for display.
///
/// If the same name exists in both `skills/` and `skills-library/` (a
/// pathological state that shouldn't happen in normal flow), the enabled
/// copy wins.
#[tauri::command]
pub fn skills_list() -> Result<Vec<SkillEntry>, String> {
    let mut out: Vec<SkillEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (root, enabled) in [(skills_root()?, true), (library_root()?, false)] {
        if !root.is_dir() {
            continue;
        }
        let entries =
            fs::read_dir(&root).map_err(|e| format!("read {}: {}", root.display(), e))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if seen.contains(&name) {
                continue;
            }
            seen.insert(name.clone());

            let skill_md = fs::read_to_string(path.join("SKILL.md")).ok();
            let icon_data_url = read_skill_icon(&path, &name);
            out.push(SkillEntry { name, enabled, skill_md, icon_data_url });
        }
    }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Probe the skill's `assets/` folder for a usable icon, in priority order:
///   `<name>.png`         ← preferred: matches Codex's pick. The unsuffixed
///                            PNG is the skill's canonical hero icon —
///                            colourful, detailed, designed to be the
///                            "main" art. The `-small.svg` variant is
///                            literally named for thumbnail use, so it's
///                            visually thinner than what skill cards want.
///   `<name>.svg`         ← vector full-size, fallback when no PNG
///   `<name>-small.svg`   ← thumbnail SVG, last resort within the
///                            `<name>.<ext>` namespace
///   `icon.svg`/`icon.png` ← generic fallback for skills that don't
///                            follow openai/skills' naming convention
///
/// Returns a `data:image/...;base64,...` URL ready for `<img src=>`.
fn read_skill_icon(skill_dir: &Path, name: &str) -> Option<String> {
    let assets = skill_dir.join("assets");
    let candidates = [
        (format!("{}.png", name), "image/png"),
        (format!("{}.svg", name), "image/svg+xml"),
        (format!("{}-small.svg", name), "image/svg+xml"),
        ("icon.png".to_string(), "image/png"),
        ("icon.svg".to_string(), "image/svg+xml"),
    ];
    for (filename, mime) in candidates {
        let path = assets.join(&filename);
        if let Ok(bytes) = fs::read(&path) {
            // Cap embedded icons at 256 KiB. Above that, the IPC payload
            // bloat outweighs the convenience — frontend should fall back
            // to a generic glyph rather than carry a 2 MB image inline.
            if bytes.len() > 256 * 1024 {
                continue;
            }
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            return Some(format!("data:{};base64,{}", mime, b64));
        }
    }
    None
}

/// Toggle a skill between disabled (library) and enabled (skills/ + symlinks).
///
/// `enable=true`: skill must currently exist in `skills-library/<name>`.
/// We `mv` it into `skills/<name>` and create per-CLI symlinks.
///
/// `enable=false`: reverse — `mv` back into library and remove symlinks.
///
/// Per the Skills feature contract: this never touches the user's running
/// CLI sessions. The frontend is responsible for showing the
/// "需重启工具才能生效" toast.
#[tauri::command]
pub fn skills_toggle(name: String, enable: bool) -> Result<(), String> {
    validate_skill_name(&name)?;
    let (from_root, to_root) = if enable {
        (library_root()?, skills_root()?)
    } else {
        (skills_root()?, library_root()?)
    };
    let src = from_root.join(&name);
    let dst = to_root.join(&name);

    if !src.exists() {
        return Err(format!("Skill not in {}: {}", from_root.display(), name));
    }
    if dst.exists() {
        return Err(format!("Destination already exists: {}", dst.display()));
    }

    // Make sure the destination's parent dir exists (defensive — they're
    // created by skills_ensure_dirs at boot, but a rogue rm could have
    // wiped them).
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }

    // Precheck before the (irreversible) rename: if a target CLI dir
    // already has a real folder (not our own link) with this name, the
    // junction step will silently no-op and the user will see "enabled"
    // without the skill actually being wired. Refuse early with a clear
    // error so the UI can surface a toast and the user decides how to
    // resolve (rm their manual install, or accept that ours stays
    // disabled).
    if enable {
        precheck_link_conflicts(&name)?;
    }

    fs::rename(&src, &dst).map_err(|e| format!("rename: {}", e))?;

    if enable {
        // Per feedback_refuse_silent_override: if link creation fails,
        // surface a real error rather than logging-and-pretending. The
        // user has just been told "✓ enabled" by an optimistic UI; the
        // CLIs they care about can't actually see the skill yet.
        if let Err(e) = link_into_cli_dirs(&name, &dst) {
            // Roll the rename back so the on-disk state matches what
            // the UI is about to show (skill back in library/ as
            // disabled). Best-effort; if rollback also fails, the
            // user has a real-but-unliked skill in skills/, which the
            // next toggle will work around (precheck won't trip since
            // we just rolled back).
            let _ = fs::rename(&dst, &from_root.join(&name));
            return Err(e);
        }
    } else {
        unlink_from_cli_dirs(&name);
    }
    Ok(())
}

/// Verify no target CLI dir has a non-link entry under `<name>`. Returns
/// a human-readable error pointing at the first conflicting path.
/// Existing entries that ARE links (left over from a prior session our
/// app created) are fine — they'll be transparently replaced by the
/// link step that follows.
fn precheck_link_conflicts(name: &str) -> Result<(), String> {
    let home = home()?;
    for (binary, skill_dir) in TARGET_CLI_SKILL_DIRS {
        // Skip tools the user doesn't have — no link would be
        // created, so nothing to conflict with.
        if !is_tool_installed(binary) {
            continue;
        }
        let link = home.join(skill_dir).join(name);
        if !link.exists() {
            continue;
        }
        if !is_dir_link(&link) {
            return Err(format!(
                "Conflict: {} already exists as a real folder (not managed by Coffee CLI). \
                 Remove it manually first if you want Coffee CLI to manage this skill.",
                display_path(&link)
            ));
        }
    }
    Ok(())
}

/// Display-safe path string: native separators converted to forward
/// slashes. Windows backslash paths sometimes get mangled when copy-
/// pasted from a toast (`\U`, `\e`, etc. land near letters and
/// downstream rendering pipelines silently drop them). Forward slashes
/// round-trip cleanly through every UI layer and Windows still resolves
/// them as paths, so error messages destined for end-users always go
/// through this helper.
fn display_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Permanently remove a skill from both tiers + clean up any symlinks.
#[tauri::command]
pub fn skills_delete(name: String) -> Result<(), String> {
    validate_skill_name(&name)?;
    unlink_from_cli_dirs(&name);
    for root in [skills_root()?, library_root()?] {
        let p = root.join(&name);
        if p.exists() {
            fs::remove_dir_all(&p).map_err(|e| format!("rm {}: {}", p.display(), e))?;
        }
    }
    Ok(())
}

/// Create per-CLI symlinks for an enabled skill. Returns Err on the
/// first failure that prevents the skill from reaching ANY target CLI
/// dir — but a skill enabled when zero supported CLIs are installed
/// is still a success (no-op linking, the skill stays in our library
/// for the user to later install a CLI and have it picked up).
///
/// Per-target gating: only mirror to a CLI's skills dir if its
/// binary is on PATH (same source of truth as the launchpad's
/// tool-availability check). We **never** create a CLI's home dir
/// from scratch when the binary isn't installed.
fn link_into_cli_dirs(name: &str, source: &Path) -> Result<(), String> {
    let home = home()?;
    let mut installed_any = false;
    let mut linked_any = false;
    let mut last_err: Option<String> = None;
    for (binary, skill_dir) in TARGET_CLI_SKILL_DIRS {
        // Binary gate: tool not on PATH → skip silently. Don't
        // mkdir its home; that would mislead the user / file
        // explorer into thinking the tool is there.
        if !is_tool_installed(binary) {
            continue;
        }
        installed_any = true;
        let parent = home.join(skill_dir);
        if !parent.exists() {
            // Tool IS installed but doesn't yet have a `skills/` subdir
            // (or hasn't been launched at all yet). Safe to create the
            // standard subdir on its behalf — the binary IS on PATH,
            // so the user clearly intends to use it.
            if let Err(e) = fs::create_dir_all(&parent) {
                log::warn!("[skills] mkdir {}: {} — skipping target", parent.display(), e);
                continue;
            }
        }
        let link = parent.join(name);
        if link.exists() {
            // Existing link from a previous session (precheck would have
            // caught a real folder). Treat as already-wired so we don't
            // try and fail "destination exists".
            if is_dir_link(&link) {
                linked_any = true;
                continue;
            }
            // Race: a real folder appeared between precheck and now.
            last_err = Some(format!(
                "Conflict at {}: real folder appeared after precheck",
                link.display()
            ));
            continue;
        }
        match create_dir_link(source, &link) {
            Ok(_) => linked_any = true,
            Err(e) => {
                let msg = format!(
                    "link {} → {} failed: {}",
                    link.display(),
                    source.display(),
                    e
                );
                log::warn!("[skills] {}", msg);
                last_err = Some(msg);
            }
        }
    }
    if linked_any {
        Ok(())
    } else if !installed_any {
        // No supported CLI installed at all → user enabled a skill
        // before installing any of the agent CLIs. That's fine: the
        // skill is in our library, future install + re-toggle will
        // wire it. Don't surface an error toast for the expected
        // first-run state.
        log::info!(
            "[skills] enabled '{}' but no supported CLI present yet; skill is staged in library",
            name
        );
        Ok(())
    } else {
        Err(last_err.unwrap_or_else(|| "No CLI target dir was linkable".to_string()))
    }
}

/// Remove per-CLI symlinks. Only removes links we own (symlink/junction);
/// real folders the user happens to have at the same path are left alone.
/// No binary gating here — a link might exist from a previous session
/// when the tool WAS installed and has since been uninstalled; we still
/// want to clean it up.
fn unlink_from_cli_dirs(name: &str) {
    let Ok(home) = home() else { return };
    for (_binary, skill_dir) in TARGET_CLI_SKILL_DIRS {
        let link = home.join(skill_dir).join(name);
        if !link.exists() {
            continue;
        }
        if !is_dir_link(&link) {
            log::warn!("[skills] {} is not a link, leaving alone", link.display());
            continue;
        }
        if let Err(e) = remove_dir_link(&link) {
            log::warn!("[skills] unlink {}: {}", link.display(), e);
        }
    }
}

#[cfg(unix)]
fn create_dir_link(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}

#[cfg(windows)]
fn create_dir_link(source: &Path, link: &Path) -> std::io::Result<()> {
    // Junction (FSCTL_SET_REPARSE_POINT) — no admin/dev-mode required, in
    // contrast to symbolic links which need SeCreateSymbolicLinkPrivilege.
    // Shell out to cmd's `mklink /J` rather than implementing the IOCTL
    // ourselves: simpler, no new windows-crate features, behaves identically.
    //
    // Two production gotchas baked in here:
    //   1. **Force backslash separators.** Rust's `PathBuf::join()` on
    //      Windows happily preserves any `/` inside the joined string
    //      ("/skills" remains as-is when joined with a backslashed
    //      home dir). When that mixed-slash path reaches cmd.exe,
    //      mklink's tokeniser sees `/skills` and treats it as a flag —
    //      exits 1 with no useful message. Always normalise both
    //      paths to backslash before handing off.
    //   2. **Capture stderr.** mklink prints the actual reason
    //      ("Cannot create a file when that file already exists",
    //      "The system cannot find the path specified", etc.) to
    //      stderr; the exit code alone says nothing useful. Surface
    //      the message into our Err so users + future-us see the
    //      real cause instead of "Some(1)".
    let normalize = |p: &Path| -> std::ffi::OsString {
        p.to_string_lossy().replace('/', "\\").into()
    };
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(normalize(link))
        .arg(normalize(source))
        .creation_flags(0x08000000)
        .output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("exit {:?}", output.status.code())
        };
        return Err(std::io::Error::other(format!("mklink /J: {}", detail)));
    }
    Ok(())
}

/// Both Unix symlinks and Windows junctions/symlinks return true for
/// `is_symlink()` via `symlink_metadata()`. Plain directories return false.
fn is_dir_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(unix)]
fn remove_dir_link(link: &Path) -> std::io::Result<()> {
    fs::remove_file(link)
}

#[cfg(windows)]
fn remove_dir_link(link: &Path) -> std::io::Result<()> {
    // Junctions are reparse-pointed directories — `remove_dir` is the
    // correct call; `remove_file` would fail with "permission denied".
    fs::remove_dir(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_name_validation() {
        assert!(validate_skill_name("documents").is_ok());
        assert!(validate_skill_name("cli-creator").is_ok());
        assert!(validate_skill_name("foo_bar_42").is_ok());
        assert!(validate_skill_name("").is_err());
        assert!(validate_skill_name("../etc").is_err());
        assert!(validate_skill_name("foo bar").is_err());
        assert!(validate_skill_name("foo/bar").is_err());
        assert!(validate_skill_name("foo:bar").is_err());
    }

    #[test]
    fn rel_path_validation() {
        assert!(validate_rel_path("SKILL.md").is_ok());
        assert!(validate_rel_path("scripts/run.sh").is_ok());
        assert!(validate_rel_path("assets/sub/icon.png").is_ok());
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("../escape").is_err());
        assert!(validate_rel_path("/abs/path").is_err());
        assert!(validate_rel_path("\\windows\\abs").is_err());
        assert!(validate_rel_path("C:/drive").is_err());
        assert!(validate_rel_path("null\0byte").is_err());
    }
}
