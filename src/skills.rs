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
/// Both Claude Code and Codex use the same `<HOME>/.<cli>/skills/<name>/SKILL.md`
/// shape (the agentskills.io open standard), so one set of links covers
/// both. Add more here when other CLIs adopt the convention.
const TARGET_CLI_SKILL_DIRS: &[&str] = &[".claude/skills", ".codex/skills"];

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

/// Walk both bundles and copy any missing files into
/// `~/.coffee-cli/skills-library/`. Files that already exist (whether
/// because we copied them earlier or the user manually edited one) are
/// left untouched — this preserves user customisations across app
/// updates and avoids clobbering an enabled skill if its mirror is still
/// present in library/ for some reason.
fn seed_library_from_bundle() -> Result<(), String> {
    let lib = library_root()?;
    let enabled = skills_root()?;
    seed_dir(&BUNDLED_OPENAI_SKILLS, &lib, &enabled)?;
    seed_dir(&BUNDLED_COFFEE_SKILLS, &lib, &enabled)?;
    Ok(())
}

fn seed_dir(
    dir: &include_dir::Dir<'_>,
    lib_root: &Path,
    enabled_root: &Path,
) -> Result<(), String> {
    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(sub) => {
                // Top-level entries under .curated/ are individual skill
                // dirs. Two filters apply:
                //   1. Phased-rollout allowlist (VISIBLE_SKILLS) — skip
                //      anything not in the current ship batch
                //   2. Already-enabled — skill is in skills/ not library/,
                //      re-seeding library/<name>/ would dupe
                if sub.path().parent().map(|p| p.as_os_str().is_empty()).unwrap_or(false) {
                    let name = sub.path().file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.is_empty() || !VISIBLE_SKILLS.contains(&name) {
                        continue;
                    }
                    if enabled_root.join(name).exists() {
                        continue;
                    }
                }
                seed_dir(sub, lib_root, enabled_root)?;
            }
            include_dir::DirEntry::File(file) => {
                let dest = lib_root.join(file.path());
                if dest.exists() {
                    continue;
                }
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
///   `<name>-small.svg`  ← preferred: vector, already sized for thumbnails
///   `<name>.svg`        ← vector, full-size
///   `<name>.png`        ← raster fallback
///   `icon.svg` / `icon.png` ← generic fallback for skills that don't
///                              follow the openai/skills naming convention
///
/// Returns a `data:image/...;base64,...` URL ready for `<img src=>`.
fn read_skill_icon(skill_dir: &Path, name: &str) -> Option<String> {
    let assets = skill_dir.join("assets");
    let candidates = [
        (format!("{}-small.svg", name), "image/svg+xml"),
        (format!("{}.svg", name), "image/svg+xml"),
        (format!("{}.png", name), "image/png"),
        ("icon.svg".to_string(), "image/svg+xml"),
        ("icon.png".to_string(), "image/png"),
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
    for cli_dir in TARGET_CLI_SKILL_DIRS {
        let link = home.join(cli_dir).join(name);
        if !link.exists() {
            continue;
        }
        if !is_dir_link(&link) {
            return Err(format!(
                "Conflict: {} already exists as a real folder (not managed by Coffee CLI). \
                 Remove it manually first if you want Coffee CLI to manage this skill.",
                link.display()
            ));
        }
    }
    Ok(())
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
/// first failure that prevents the skill from reaching its target CLI
/// dir — caller is responsible for rolling back the rename. Pre-creating
/// the parent dir (so future-installed CLIs already see the link) is
/// soft: if THAT fails (e.g. permission denied on a read-only home),
/// we skip that one target but still try the next.
fn link_into_cli_dirs(name: &str, source: &Path) -> Result<(), String> {
    let home = home()?;
    let mut linked_any = false;
    let mut last_err: Option<String> = None;
    for cli_dir in TARGET_CLI_SKILL_DIRS {
        let parent = home.join(cli_dir);
        if !parent.exists() {
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
    } else {
        Err(last_err.unwrap_or_else(|| "No CLI target dir was linkable".to_string()))
    }
}

/// Remove per-CLI symlinks. Only removes links we own (symlink/junction);
/// real folders the user happens to have at the same path are left alone.
fn unlink_from_cli_dirs(name: &str) {
    let Ok(home) = home() else { return };
    for cli_dir in TARGET_CLI_SKILL_DIRS {
        let link = home.join(cli_dir).join(name);
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
