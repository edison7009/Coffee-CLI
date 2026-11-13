//! Shell detection + selection.
//!
//! Replaces the old hardcoded `binary_on_path("pwsh.exe") ? "pwsh.exe" :
//! "powershell.exe"` fallback in `server.rs` with an explicit, user-visible
//! shell picker. The picker is fed by `ShellCapabilities` (probed once on
//! app start via `detect_shells`) and the chosen `ShellId` is resolved to a
//! concrete `(program, args)` at spawn time by `resolve_shell`.
//!
//! Why this module exists beyond the old probe:
//!   - **Execution Alias trap**: `pwsh.exe` installed from the Microsoft
//!     Store leaves a 0-byte App Execution Alias reparse point on PATH.
//!     `where pwsh.exe` finds it (so the old `binary_on_path` probe said
//!     "installed"), but `CreateProcessW` on that stub returns
//!     `ERROR_ACCESS_DENIED` — the spawned shell never starts. We now
//!     resolve to a real absolute path and treat 0-byte aliases as
//!     "not installed", so the user either gets a working pwsh or an
//!     honest "not detected" — never a dead tab.
//!   - **Git Bash lives off PATH**: most Git-for-Windows installs that
//!     don't tick "add to PATH" put bash.exe only under Program Files or
//!     %LOCALAPPDATA%\Programs\Git. `where bash.exe` misses those, so we
//!     probe the known install locations directly (mirrors the existing
//!     SHELL-env hint in `terminal.rs`).
//!   - **Decoupled detection** (borrowed from a reference terminal app):
//!     the picker consumes capability flags, never paths. So a future
//!     remote-shell feature can answer the same flags from a different
//!     source without touching the picker UI.
//!
//! WSL detection is probed here too (`wsl_available`) but intentionally
//! NOT exposed in the picker yet — launching a WSL shell needs cwd
//! translation (`\\wsl.localhost\<distro>\` ↔ `/mnt/...`) and a distro
//! list that this first pass doesn't wire up. Left as a capability flag
//! so the second-phase UI can flip on without re-probing.

#![allow(dead_code)] // wsl_available + some arms are second-phase / per-platform

use serde::Serialize;

/// User-facing shell identity. Stored as a string id (the persisted form
/// under `cc-default-shell`), resolved to a concrete program at spawn.
/// `Auto` keeps the historical fallback behavior (pwsh → powershell →
/// cmd on Windows; `$SHELL` → bash on Unix).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellId {
    Auto,
    #[cfg(target_os = "windows")]
    Pwsh,
    #[cfg(target_os = "windows")]
    Powershell,
    #[cfg(target_os = "windows")]
    GitBash,
    #[cfg(target_os = "windows")]
    Cmd,
    #[cfg(not(target_os = "windows"))]
    Zsh,
    #[cfg(not(target_os = "windows"))]
    Bash,
    #[cfg(not(target_os = "windows"))]
    Fish,
    #[cfg(not(target_os = "windows"))]
    Sh,
}

impl ShellId {
    /// Parse the persisted string id. `None` / empty / unrecognized →
    /// `Auto`, so a stale `cc-default-shell` from a removed shell falls
    /// back to the safe default instead of spawning something missing.
    pub fn from_opt(s: &Option<String>) -> Self {
        match s.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            None => Self::Auto,
            #[cfg(target_os = "windows")]
            Some("pwsh") => Self::Pwsh,
            #[cfg(target_os = "windows")]
            Some("powershell") => Self::Powershell,
            #[cfg(target_os = "windows")]
            Some("git-bash") => Self::GitBash,
            #[cfg(target_os = "windows")]
            Some("cmd") => Self::Cmd,
            #[cfg(not(target_os = "windows"))]
            Some("zsh") => Self::Zsh,
            #[cfg(not(target_os = "windows"))]
            Some("bash") => Self::Bash,
            #[cfg(not(target_os = "windows"))]
            Some("fish") => Self::Fish,
            #[cfg(not(target_os = "windows"))]
            Some("sh") => Self::Sh,
            _ => Self::Auto,
        }
    }
}

/// Probed availability of the optional shells. Inbox shells
/// (`powershell.exe` / `cmd.exe` on Windows) are assumed present and NOT
/// probed, so the picker always offers them. On Unix every candidate is
/// probed via `which` — zsh/bash/sh are near-universal but fish is not
/// installed by default on macOS, so we only show what's actually there.
/// Only the "might genuinely be absent" ones get a real probe.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ShellCapabilities {
    /// PowerShell 7 (`pwsh.exe`) resolved to a real absolute path (0-byte
    /// App Execution Aliases don't count). `false` when only the inbox
    /// 5.1 `powershell.exe` is available.
    #[cfg(target_os = "windows")]
    pub pwsh_available: bool,
    /// Exact version string of PowerShell 7, e.g. "7.4.6" (from
    /// `pwsh --version`). Surfaced in the picker so users see which build
    /// they're picking — most want 7 over 5, and seeing the real version
    /// builds confidence the detection is live, not a guess. `None` when
    /// pwsh isn't installed or the version probe failed.
    #[cfg(target_os = "windows")]
    pub pwsh_version: Option<String>,
    /// Exact version string of inbox PowerShell 5.1, e.g. "5.1.22621.4116"
    /// (from `$PSVersionTable.PSVersion`). `None` if the probe failed —
    /// the card still shows (5.1 is always present on supported Windows)
    /// but without a version suffix.
    #[cfg(target_os = "windows")]
    pub powershell_version: Option<String>,
    /// Absolute path to Git-for-Windows `bash.exe`, when found at any of
    /// the standard install locations. `None` if Git Bash isn't installed
    /// (or is installed somewhere we don't look — accepted gap; `Auto`
    /// still works, and a custom-path override can come in a later phase).
    #[cfg(target_os = "windows")]
    pub git_bash_path: Option<String>,
    /// `wsl.exe` present on PATH. Probed now so the second-phase WSL UI
    /// can flip on without re-plumbing detection; NOT exposed in the
    /// picker this phase.
    pub wsl_available: bool,
    /// Resolved pwsh absolute path (when `pwsh_available`), kept so
    /// `resolve_shell` can spawn the real file instead of the alias.
    /// Not serialized to the frontend — the picker only needs the bool.
    #[cfg(target_os = "windows")]
    #[serde(skip)]
    pub pwsh_path: Option<String>,
    /// Unix candidate shells resolved by `which`. Each is `true` when
    /// present, so the picker only offers shells the user can actually
    /// spawn — fish is absent by default on macOS, so we hide it instead
    /// of offering a dead card. bash is near-universal so `Auto`'s
    /// fallback still works even when zsh isn't on PATH.
    #[cfg(not(target_os = "windows"))]
    pub zsh_available: bool,
    #[cfg(not(target_os = "windows"))]
    pub bash_available: bool,
    #[cfg(not(target_os = "windows"))]
    pub fish_available: bool,
    #[cfg(not(target_os = "windows"))]
    pub sh_available: bool,
}

/// JSON shape shipped to the frontend — a mirror of `ShellCapabilities`
/// minus the private path fields (the picker shows booleans only).
#[derive(Debug, Clone, Serialize)]
pub struct ShellCapabilitiesJson {
    #[cfg(target_os = "windows")]
    pub pwsh_available: bool,
    #[cfg(target_os = "windows")]
    pub pwsh_version: Option<String>,
    #[cfg(target_os = "windows")]
    pub powershell_version: Option<String>,
    #[cfg(target_os = "windows")]
    pub git_bash_available: bool,
    pub wsl_available: bool,
    #[cfg(not(target_os = "windows"))]
    pub zsh_available: bool,
    #[cfg(not(target_os = "windows"))]
    pub bash_available: bool,
    #[cfg(not(target_os = "windows"))]
    pub fish_available: bool,
    #[cfg(not(target_os = "windows"))]
    pub sh_available: bool,
}

impl From<&ShellCapabilities> for ShellCapabilitiesJson {
    fn from(c: &ShellCapabilities) -> Self {
        Self {
            #[cfg(target_os = "windows")]
            pwsh_available: c.pwsh_available,
            #[cfg(target_os = "windows")]
            pwsh_version: c.pwsh_version.clone(),
            #[cfg(target_os = "windows")]
            powershell_version: c.powershell_version.clone(),
            #[cfg(target_os = "windows")]
            git_bash_available: c.git_bash_path.is_some(),
            wsl_available: c.wsl_available,
            #[cfg(not(target_os = "windows"))]
            zsh_available: c.zsh_available,
            #[cfg(not(target_os = "windows"))]
            bash_available: c.bash_available,
            #[cfg(not(target_os = "windows"))]
            fish_available: c.fish_available,
            #[cfg(not(target_os = "windows"))]
            sh_available: c.sh_available,
        }
    }
}

/// Probe the host for optional shells. Cheap (a few `where`/`exists`
/// checks); safe to call once on app start and cache for the process
/// lifetime — re-install-during-run is rare, and `Auto` always works.
/// Does NOT probe exact versions — that's a slower step (powershell.exe
/// takes ~1-2s to report $PSVersionTable) gated to `populate_versions()`,
/// called only when the Settings picker opens, so app startup and every
/// terminal spawn stay fast.
pub fn detect_capabilities() -> ShellCapabilities {
    let mut caps = ShellCapabilities::default();
    #[cfg(target_os = "windows")]
    {
        if let Some(path) = find_pwsh_real_path() {
            caps.pwsh_available = true;
            caps.pwsh_path = Some(path);
        }
        caps.git_bash_path = find_git_bash();
        caps.wsl_available = crate::server::check_tool_windows("wsl.exe");
    }
    #[cfg(not(target_os = "windows"))]
    {
        // WSL is Windows-only. Probe the four Unix candidate shells via
        // `which` so the picker hides absent ones (fish isn't installed by
        // default on macOS). Cheap, runs once on settings open.
        caps.wsl_available = false;
        caps.zsh_available = crate::server::check_tool_unix("zsh");
        caps.bash_available = crate::server::check_tool_unix("bash");
        caps.fish_available = crate::server::check_tool_unix("fish");
        caps.sh_available = crate::server::check_tool_unix("sh");
    }
    caps
}

/// Fill in exact version strings for the Windows PowerShell shells. Called
/// only from `detect_shells` (Settings picker open), NOT from startup —
/// `powershell.exe -Command $PSVersionTable` takes ~1-2s, which would
/// stall app boot and every terminal spawn if it ran in
/// `detect_capabilities`. Each probe is CREATE_NO_WINDOW so opening
/// Settings doesn't flash console windows.
#[cfg(target_os = "windows")]
pub fn populate_versions(caps: &mut ShellCapabilities) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // PowerShell 7: `pwsh --version` prints "PowerShell 7.4.6" and exits
    // fast (~150ms, single-file .NET app). Only probe if we already found a
    // real pwsh path (avoids re-triggering the App Execution Alias trap).
    //
    // This also doubles as the LIVENESS check for the path `find_pwsh_real_path`
    // returned: existence there is checked via `is_file()` (App Execution
    // Aliases report len 0 but is_file true), which can't distinguish a working
    // alias from a stale one. If `--version` fails to spawn, the path is dead
    // and we flip `pwsh_available` false so the picker doesn't offer a shell
    // that won't start. This keeps the startup probe zero-spawn while still
    // never showing a dead card.
    if caps.pwsh_available {
        if let Some(path) = caps.pwsh_path.as_ref() {
            let version = Command::new(path)
                .arg("--version")
                .creation_flags(0x08000000)
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                        // "PowerShell 7.4.6" → take the last whitespace token.
                        s.split_whitespace().last().map(|v| v.to_string())
                    } else {
                        None
                    }
                });
            if version.is_none() {
                // Stale App Execution Alias / unlaunchable candidate: the
                // existence-only startup probe was wrong to accept it. Hide
                // the shell instead of offering a dead tab.
                caps.pwsh_available = false;
            }
            caps.pwsh_version = version;
        }
    }

    // PowerShell 5.1: `$PSVersionTable.PSVersion.ToString()` prints
    // "5.1.22621.4116". powershell.exe cold-starts slowly, so this is the
    // probe that motivated gating versions out of startup. Always probe
    // (5.1 is inbox on every supported Windows) — a failure just leaves
    // the version None and the card shows without a suffix.
    caps.powershell_version = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$PSVersionTable.PSVersion.ToString()",
        ])
        .creation_flags(0x08000000)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if s.is_empty() { None } else { Some(s) }
            } else {
                None
            }
        });
}

#[cfg(not(target_os = "windows"))]
pub fn populate_versions(_caps: &mut ShellCapabilities) {
    // Unix shells don't carry a meaningful single "version" in the picker —
    // zsh/bash/fish versions are rarely actionable for the user. No-op so
    // the Settings command can call this unconditionally across platforms.
}

/// `(program, args)` handed to `terminal::spawn`. The program is an
/// absolute path on Windows (defeating App Execution Aliases) and a
/// resolved bare name / path on Unix. Args match each shell's interactive
/// convention.
pub fn resolve_shell(id: ShellId, caps: &ShellCapabilities) -> (String, Vec<String>) {
    #[cfg(target_os = "windows")]
    {
        match id {
            ShellId::Pwsh => {
                // Caller only offers pwsh when pwsh_available, so the
                // resolved path is present. Fall back to bare name if the
                // capability somehow went stale — never panic on spawn.
                let p = caps.pwsh_path.clone().unwrap_or_else(|| "pwsh.exe".to_string());
                (p, vec!["-NoExit".to_string()])
            }
            ShellId::Powershell => {
                // Inbox 5.1 — resolve to its well-known absolute location so
                // a stripped PATH (issue #30) can't break it.
                let p = system_powershell_path();
                (p, vec!["-NoExit".to_string()])
            }
            ShellId::GitBash => {
                let p = caps.git_bash_path.clone().unwrap_or_else(|| "bash.exe".to_string());
                (p, vec!["--login".to_string(), "-i".to_string()])
            }
            ShellId::Cmd => {
                let p = system_cmd_path();
                (p, vec![])
            }
            ShellId::Auto => auto_windows(caps),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = caps;
        match id {
            ShellId::Zsh => ("zsh".to_string(), vec!["-l".to_string(), "-i".to_string()]),
            ShellId::Bash => ("bash".to_string(), vec!["-l".to_string(), "-i".to_string()]),
            ShellId::Fish => ("fish".to_string(), vec!["-l".to_string(), "-i".to_string()]),
            ShellId::Sh => ("sh".to_string(), vec![]),
            ShellId::Auto => auto_unix(),
        }
    }
}

// ── Windows probes ─────────────────────────────────────────────────────
#[cfg(target_os = "windows")]
fn auto_windows(caps: &ShellCapabilities) -> (String, Vec<String>) {
    // pwsh 7 (resolved real path) → inbox powershell 5.1. Mirrors the
    // pre-feature behavior but with an absolute path that sidesteps the
    // App Execution Alias trap.
    if caps.pwsh_available {
        let p = caps.pwsh_path.clone().unwrap_or_else(|| "pwsh.exe".to_string());
        return (p, vec!["-NoExit".to_string()]);
    }
    (system_powershell_path(), vec!["-NoExit".to_string()])
}

#[cfg(target_os = "windows")]
fn system_powershell_path() -> String {
    // %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe is present
    // on every supported Windows; resolving it explicitly avoids a bare
    // "powershell.exe" PATH lookup failing on a stripped PATH (issue #30).
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let p = format!(r"{}\System32\WindowsPowerShell\v1.0\powershell.exe", sysroot);
    if std::path::Path::new(&p).exists() {
        p
    } else {
        "powershell.exe".to_string()
    }
}

#[cfg(target_os = "windows")]
fn system_cmd_path() -> String {
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
    let p = format!(r"{}\System32\cmd.exe", sysroot);
    if std::path::Path::new(&p).exists() {
        p
    } else {
        "cmd.exe".to_string()
    }
}

/// Find PowerShell 7 (`pwsh.exe`) as a REAL, launchable executable — across
/// every install method Microsoft documents (install-powershell-on-windows):
///   - **MSIX / Microsoft Store** (winget 7.6+ default, and the ONLY form
///     from 7.7 onward): the real `pwsh.exe` lives under an ACL-locked
///     `C:\Program Files\WindowsApps\Microsoft.PowerShell_<ver>_<arch>_<pub>\`
///     and is NOT on PATH. PATH carries only an App Execution Alias — a
///     reparse point whose `metadata().len()` returns **0** in a real Win32
///     process (NOT a normal symlink: `read_link` reports "Unsupported
///     reparse point type"). The old `len() > 0` filter therefore stripped
///     the only candidate and reported "not installed" — the bug this fixes.
///   - **MSI** (global): `%ProgramFiles%\PowerShell\7\pwsh.exe` (+ x86 +
///     `7-preview`). Only on PATH when ADD_PATH was ticked at install.
///   - **MSI per-user**: `%LOCALAPPDATA%\Programs\PowerShell\7\pwsh.exe`.
///   - **.NET global tool**: `%USERPROFILE%\.dotnet\tools\pwsh.exe`.
///   - **PATH** (`where`): a real MSI exe may show up here (alias does too,
///     but a real one is preferred when present).
///
/// We mirror the VS Code PowerShell extension's MSIX strategy (its
/// `src/platform.ts`): glob `%LOCALAPPDATA%\Microsoft\WindowsApps\` for a
/// `Microsoft.PowerShell_*` subdirectory (preview = `Microsoft.PowerShellPreview_*`)
/// and take `dir/pwsh.exe` — WITHOUT a `len() > 0` gate, because App
/// Execution Aliases legitimately report 0 bytes. `pwsh_exists()` below
/// uses `is_file()` (which is `true` for reparse points) instead of `len`.
///
/// Existence-only here (no spawn): `detect_capabilities` runs at app startup
/// and every spawn, so it must stay process-free. Liveness is then proven by
/// `populate_versions`, which runs `<path> --version` when Settings opens;
/// if that fails the path is a stale alias and `pwsh_available` flips false.
#[cfg(target_os = "windows")]
fn find_pwsh_real_path() -> Option<String> {
    // 1. MSIX / Microsoft Store — the case winget 7.6+ installs by default.
    // `%LOCALAPPDATA%\Microsoft\WindowsApps\` is user-readable (unlike the
    // real install under `C:\Program Files\WindowsApps\`, which is ACL-
    // locked). The package's execution-alias folder name is the Package
    // Family Name form (e.g. `Microsoft.PowerShell_8wekyb3d8bbwe`). Stable is
    // the common case, so try it first; fall back to preview only if absent.
    if let Some(la) = std::env::var("LOCALAPPDATA").ok() {
        let apps = std::path::Path::new(&la)
            .join("Microsoft")
            .join("WindowsApps");
        if let Some(p) = find_msix_pwsh(&apps, "Microsoft.PowerShell_") {
            return Some(p);
        }
        if let Some(p) = find_msix_pwsh(&apps, "Microsoft.PowerShellPreview_") {
            return Some(p);
        }
    }

    // 2. MSI global install (official default INSTALLFOLDER).
    let mut msi: Vec<String> = vec![];
    if let Ok(pf) = std::env::var("ProgramFiles") {
        msi.push(format!(r"{}\PowerShell\7\pwsh.exe", pf));
        msi.push(format!(r"{}\PowerShell\7-preview\pwsh.exe", pf));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        msi.push(format!(r"{}\PowerShell\7\pwsh.exe", pf86));
    }
    for c in &msi {
        if pwsh_exists(c) {
            return Some(c.clone());
        }
    }

    // 3. MSI per-user install.
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let c = format!(r"{}\Programs\PowerShell\7\pwsh.exe", la);
        if pwsh_exists(&c) {
            return Some(c);
        }
    }

    // 4. .NET global tool (official: `dotnet tool install --global PowerShell`).
    if let Ok(home) = std::env::var("USERPROFILE") {
        let c = format!(r"{}\.dotnet\tools\pwsh.exe", home);
        if pwsh_exists(&c) {
            return Some(c);
        }
    }

    // 5. PATH fallback (`where`). A real MSI pwsh on PATH surfaces here; a
    // 0-byte alias does too, but `pwsh_exists` accepts it (is_file true) and
    // `populate_versions` later proves liveness via `--version`.
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("where")
        .arg("pwsh.exe")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok();
    if let Some(out) = out {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let p = line.trim();
                if !p.is_empty() && pwsh_exists(p) {
                    return Some(p.to_string());
                }
            }
        }
    }
    None
}

/// Glob a WindowsApps dir for an MSIX PowerShell execution-alias subfolder
/// matching `prefix` (stable `"Microsoft.PowerShell_"` or preview
/// `"Microsoft.PowerShellPreview_"`) and return `dir/pwsh.exe`. The folder
/// is an App Execution Alias reparse point whose `metadata().len()` is 0,
/// so we use `is_file()` (true for reparse points) instead of `len() > 0`.
/// Caller guarantees `prefix` does not match the other variant (stable ≠
/// preview prefixes are disjoint).
///
/// The alias folder name is the **Package Family Name** form —
/// `Microsoft.PowerShell_<publisher-hash>` (e.g. `Microsoft.PowerShell_8wekyb3d8bbwe`),
/// which is version-less: the versioned name (`Microsoft.PowerShell_7.6.3.0_x64__…`)
/// only exists under the ACL-locked `C:\Program Files\WindowsApps\`, not in this
/// user-readable alias dir. There is at most one folder per prefix (a single
/// PowerShell package family), so we return the first match without sorting.
#[cfg(target_os = "windows")]
fn find_msix_pwsh(apps: &std::path::Path, prefix: &str) -> Option<String> {
    let entries = std::fs::read_dir(apps).ok()?;
    for e in entries.flatten() {
        let name = e.file_name();
        if !name.to_string_lossy().starts_with(prefix) {
            continue;
        }
        let p = apps.join(&name).join("pwsh.exe");
        if pwsh_exists(p.to_string_lossy().as_ref()) {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

/// Reparse-point-friendly existence check for a `pwsh.exe` candidate. A real
/// MSI exe has `len() > 0`; an App Execution Alias (MSIX) is a reparse point
/// whose `len()` is **0** but `is_file()` is still `true`. We therefore gate
/// on `is_file()`, not `len()`, so MSIX installs are not mistaken for "absent".
/// Liveness is confirmed separately by `populate_versions` (`pwsh --version`).
#[cfg(target_os = "windows")]
fn pwsh_exists(path: &str) -> bool {
    // symlink_metadata does not follow the link/reparse point, so even a
    // dangling alias reports its own attributes; is_file() is true for both
    // real files and App Execution Aliases, false for directories/missing.
    std::fs::symlink_metadata(path)
        .map(|m| m.is_file())
        .unwrap_or(false)
}

/// Locate Git-for-Windows `bash.exe`. Avoids `where bash.exe` because many
/// Git installs don't add Git to PATH. Probes the three standard install
/// roots (Program Files x64/x86 + %LOCALAPPDATA%\Programs\Git) plus a
/// PATH scan for any `Git`/`PortableGit` directory's `bin\bash.exe`.
/// Mirrors the SHELL-hint candidates in `terminal.rs` and generalizes.
#[cfg(target_os = "windows")]
fn find_git_bash() -> Option<String> {
    // Fixed well-known locations (same set terminal.rs uses for the
    // SHELL env hint — keep them in sync if one changes).
    let mut candidates: Vec<String> = vec![
        r"C:\Program Files\Git\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
    ];
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!(r"{}\Programs\Git\bin\bash.exe", la));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(format!(r"{}\Git\bin\bash.exe", pf));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        candidates.push(format!(r"{}\Git\bin\bash.exe", pf86));
    }
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return Some(c.clone());
        }
    }
    // Last resort: walk PATH segments looking for a dir whose name contains
    // "Git" or "PortableGit" and has bin\bash.exe — covers scoop / custom
    // install roots without hardcoding them.
    if let Some(path) = std::env::var_os("PATH") {
        for seg in std::env::split_paths(&path) {
            let Some(name) = seg.file_name().and_then(|n| n.to_str()) else { continue };
            let lower = name.to_ascii_lowercase();
            if !lower.contains("git") && !lower.contains("portablegit") {
                continue;
            }
            let bash = seg.join("bin").join("bash.exe");
            if bash.exists() {
                return Some(bash.to_string_lossy().to_string());
            }
        }
    }
    None
}

// ── Unix auto ───────────────────────────────────────────────────────────
#[cfg(not(target_os = "windows"))]
fn auto_unix() -> (String, Vec<String>) {
    // Same logic the old server.rs fallback used, kept verbatim so
    // existing Unix users see no behavior change unless they pick a
    // specific shell in settings.
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .filter(|s| std::path::Path::new(s).exists())
        .unwrap_or_else(|| "bash".to_string());
    let basename = std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let mut args = vec!["-l".to_string(), "-i".to_string()];
    // OSC 7 cwd reporting hook for fish — bash gets it via PROMPT_COMMAND
    // (injected in terminal.rs); zsh has no clean flag hook. Preserved
    // from the old server.rs branch so fish users keep cd-follow.
    if basename == "fish" {
        args.push("-C".to_string());
        args.push(
            r#"function __coffee_osc7 --on-variable PWD; printf '\033]7;file://%s%s\033\\' (hostname) "$PWD"; end; __coffee_osc7"#
                .to_string(),
        );
    }
    (shell, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_is_default_for_unknown_string() {
        assert_eq!(ShellId::from_opt(&None), ShellId::Auto);
        assert_eq!(ShellId::from_opt(&Some(String::new())), ShellId::Auto);
        assert_eq!(ShellId::from_opt(&Some("nonsense".into())), ShellId::Auto);
        assert_eq!(ShellId::from_opt(&Some("  ".into())), ShellId::Auto);
    }

    /// Live MSIX smoke test — only meaningful on a machine where PowerShell 7
    /// was installed as an MSIX/Store package (winget 7.6+ default). `#[ignore]`
    /// so CI / machines without PS7 skip it; run locally with
    /// `cargo test shell_probe -- --ignored` after `winget install
    /// Microsoft.PowerShell`. Asserts the new probe finds the alias folder
    /// under `%LOCALAPPDATA%\Microsoft\WindowsApps\` that the old `len() > 0`
    /// filter wrongly rejected.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn finds_msix_pwsh_alias() {
        let path = find_pwsh_real_path()
            .expect("find_pwsh_real_path returned None — MSIX PS7 not detected");
        // The MSIX alias path always lives under the user's WindowsApps dir;
        // an MSI install would instead resolve to Program Files. This test
        // is specifically run on a machine with the MSIX install, so assert
        // the MSIX form.
        let la = std::env::var("LOCALAPPDATA").unwrap_or_default();
        assert!(
            path.starts_with(&format!("{}\\Microsoft\\WindowsApps", la)),
            "expected MSIX alias path under WindowsApps, got: {path}"
        );
        assert!(
            pwsh_exists(&path),
            "returned path failed pwsh_exists (is_file): {path}"
        );
    }

    /// End-to-end: the same path the Settings picker runs (detect_capabilities
    /// + populate_versions) must report pwsh as available AND fill a version
    /// string when PS7 (MSIX or MSI) is installed. `--ignored` because it
    /// needs a real PS7 install; on a bare CI box it correctly stays absent.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn end_to_end_detects_installed_pwsh_with_version() {
        let mut caps = detect_capabilities();
        assert!(caps.pwsh_available, "pwsh_available false — PS7 not detected");
        populate_versions(&mut caps);
        assert!(
            caps.pwsh_version.is_some(),
            "pwsh --version failed — path is a stale alias, not a live shell"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn parses_windows_ids() {
        assert_eq!(ShellId::from_opt(&Some("pwsh".into())), ShellId::Pwsh);
        assert_eq!(ShellId::from_opt(&Some("powershell".into())), ShellId::Powershell);
        assert_eq!(ShellId::from_opt(&Some("git-bash".into())), ShellId::GitBash);
        assert_eq!(ShellId::from_opt(&Some("cmd".into())), ShellId::Cmd);
        // A Unix id on Windows is unrecognized → Auto (cross-OS prefs don't apply).
        assert_eq!(ShellId::from_opt(&Some("zsh".into())), ShellId::Auto);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn parses_unix_ids() {
        assert_eq!(ShellId::from_opt(&Some("zsh".into())), ShellId::Zsh);
        assert_eq!(ShellId::from_opt(&Some("bash".into())), ShellId::Bash);
        assert_eq!(ShellId::from_opt(&Some("fish".into())), ShellId::Fish);
        assert_eq!(ShellId::from_opt(&Some("sh".into())), ShellId::Sh);
        assert_eq!(ShellId::from_opt(&Some("pwsh".into())), ShellId::Auto);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn json_mirror_hides_paths() {
        let caps = ShellCapabilities {
            pwsh_available: true,
            git_bash_path: Some(r"C:\Git\bin\bash.exe".into()),
            wsl_available: false,
            pwsh_path: Some(r"C:\pwsh\pwsh.exe".into()),
            ..ShellCapabilities::default()
        };
        let json = ShellCapabilitiesJson::from(&caps);
        assert!(json.pwsh_available);
        assert!(json.git_bash_available);
        assert!(!json.wsl_available);
        // Serialize to confirm no path leaks into the payload.
        let s = serde_json::to_string(&json).unwrap();
        assert!(!s.contains("bash.exe"));
        assert!(!s.contains("pwsh.exe"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_cmd_uses_system_path() {
        let caps = ShellCapabilities::default();
        let (prog, args) = resolve_shell(ShellId::Cmd, &caps);
        assert!(prog.ends_with("cmd.exe"));
        assert!(args.is_empty());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_powershell_is_absolute() {
        let caps = ShellCapabilities::default();
        let (prog, _args) = resolve_shell(ShellId::Powershell, &caps);
        // Absolute path (drive letter or resolved system path), never a
        // bare "powershell.exe" that re-introduces the PATH-lookup risk.
        assert!(prog.contains('\\'), "powershell path should be absolute: {prog}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn resolve_gitbash_falls_back_when_absent() {
        // No git_bash_path → resolve still returns something spawnable
        // (bare bash.exe) rather than panicking; the picker simply won't
        // offer the option when the capability is None.
        let caps = ShellCapabilities::default();
        let (prog, _args) = resolve_shell(ShellId::GitBash, &caps);
        assert_eq!(prog, "bash.exe");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn resolve_unix_explicit_shells() {
        let caps = ShellCapabilities::default();
        let (p, _) = resolve_shell(ShellId::Zsh, &caps);
        assert_eq!(p, "zsh");
        let (p, _) = resolve_shell(ShellId::Bash, &caps);
        assert_eq!(p, "bash");
        let (p, _) = resolve_shell(ShellId::Fish, &caps);
        assert_eq!(p, "fish");
        let (p, a) = resolve_shell(ShellId::Sh, &caps);
        assert_eq!(p, "sh");
        assert!(a.is_empty());
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn json_unix_carries_four_bools_no_paths() {
        let caps = ShellCapabilities {
            wsl_available: false,
            zsh_available: true,
            bash_available: true,
            fish_available: false,
            sh_available: true,
        };
        let json = ShellCapabilitiesJson::from(&caps);
        assert!(json.zsh_available);
        assert!(json.bash_available);
        assert!(!json.fish_available);
        assert!(json.sh_available);
        let s = serde_json::to_string(&json).unwrap();
        assert!(s.contains("zsh_available"));
        assert!(s.contains("sh_available"));
        // No filesystem paths leak into the frontend payload.
        assert!(!s.contains("/bin/"));
        assert!(!s.contains("/usr/"));
    }
}
