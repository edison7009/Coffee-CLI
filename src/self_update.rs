//! In-app self-update, in two steps the user controls.
//!
//! `download_update` saves the latest installer into the user's Downloads
//! folder. Sources (see update_sources.rs): the CNB and GitCode mirrors when
//! their manifest has the newest version, then `coffeecli.com/download/<os>`
//! (a CF Worker proxying the GitHub Release asset). The sources race briefly
//! ("speed_test"), the fastest is downloaded, and a mirror's installer is
//! checked against its manifest's size and SHA-256 — a failed check falls
//! through to the next source. Progress streams to the frontend's ring via
//! `self-update-progress`.
//!
//! Windows and macOS then stop: the installer waits in Downloads, remembered
//! by a receipt (version, path, size, SHA-256), and the update button turns
//! into "Install". Only `install_downloaded_update` — the user's second click
//! — re-checks the file against the receipt, installs it and closes Coffee
//! CLI. The receipt outlives a restart, so a download finished earlier can
//! still be installed later.
//!
//! Windows runs the NSIS installer silently. macOS mounts the DMG, checks the
//! new app (intact signature, same bundle id, same Developer ID team once we
//! are signed), copies it beside the running bundle and hands the swap to a
//! small detached shell that waits for us to exit, renames the new bundle into
//! place and relaunches it — the way Sparkle-style updaters do it. An app the
//! user cannot replace (running from the DMG, App Translocation, a folder
//! without write access) falls back to opening the DMG, as Linux falls back
//! to opening the Downloads folder.
//!
//! ureq is blocking + rustls, so the work runs on spawn_blocking threads;
//! `app.emit` works from any thread.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

#[derive(Serialize, Clone)]
struct SelfUpdateProgress {
    status: String, // "speed_test" | "downloading" | "launching" | "downloaded" | "error"
    percent: u32,
}

fn emit(app: &tauri::AppHandle, status: &str, percent: u32) {
    let _ = app.emit(
        "self-update-progress",
        SelfUpdateProgress { status: status.to_string(), percent },
    );
}

/// One download or installation at a time; a repeated click is refused.
static BUSY: AtomicBool = AtomicBool::new(false);

struct Busy;

impl Busy {
    fn claim() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Busy)
            .map_err(|_| "an update is already running".to_string())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

/// Download the installer. Returns the version now waiting to be installed
/// (Windows), or `None` once the DMG / Downloads folder has been opened
/// (macOS / Linux). `expected` is the version the button showed; it labels
/// the download when no source reported one.
#[tauri::command]
pub async fn download_update(app: tauri::AppHandle, expected: String) -> Result<Option<String>, String> {
    let busy = Busy::claim()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        run_download(&app, &expected)
    })
    .await
    .map_err(|e| format!("self-update task join failed: {e}"))?;
    if let Err(e) = &result {
        eprintln!("[self-update] {e}");
    }
    result
}

/// Whether the installer for `version` is already downloaded and intact, so
/// the button can offer "Install" straight away (Windows, and macOS when the
/// running app can be replaced in place).
#[tauri::command]
pub async fn is_update_downloaded(version: String) -> Result<bool, String> {
    if !installs_in_place() {
        return Ok(false);
    }
    tauri::async_runtime::spawn_blocking(move || {
        Ok(receipt_file().is_some_and(|file| ready_installer(&file, &version).is_some()))
    })
    .await
    .map_err(|e| format!("self-update task join failed: {e}"))?
}

/// Run the downloaded installer for `version` and close Coffee CLI. Returns
/// `false` when the file is gone or no longer matches what was downloaded,
/// so the button goes back to "Download".
#[tauri::command]
pub async fn install_downloaded_update(app: tauri::AppHandle, version: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let busy = Busy::claim()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _busy = busy;
            let Some(receipt) = receipt_file().and_then(|file| ready_installer(&file, &version)) else {
                return Ok(false);
            };
            emit(&app, "launching", 100);
            use std::os::windows::process::CommandExt;
            let launched = installer_command_line(&receipt.path).and_then(|args| {
                std::process::Command::new("cmd")
                    .raw_arg(args)
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn()
                    .map_err(|e| e.to_string())
            });
            if let Err(e) = launched {
                emit(&app, "error", 100);
                return Err(format!("open installer failed: {e}"));
            }
            // Let the installer start before we exit so it can replace our files.
            std::thread::sleep(std::time::Duration::from_millis(800));
            app.exit(0);
            Ok(true)
        })
        .await
        .map_err(|e| format!("self-update task join failed: {e}"))?
    }
    #[cfg(target_os = "macos")]
    {
        let busy = Busy::claim()?;
        tauri::async_runtime::spawn_blocking(move || {
            let _busy = busy;
            let Some(receipt) = receipt_file().and_then(|file| ready_installer(&file, &version)) else {
                return Ok(false);
            };
            emit(&app, "launching", 100);
            match mac::install(&receipt.path, &receipt.version) {
                Ok(()) => {
                    // The swap shell waits for this process to exit.
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    app.exit(0);
                    Ok(true)
                }
                Err(e) => {
                    // Not replaceable after all, or the DMG failed its checks:
                    // hand the user the DMG to drag across themselves.
                    eprintln!("[self-update] in-place install failed: {e}");
                    let _ = std::process::Command::new("open").arg(&receipt.path).spawn();
                    emit(&app, "downloaded", 100);
                    Ok(false)
                }
            }
        })
        .await
        .map_err(|e| format!("self-update task join failed: {e}"))?
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, version);
        Ok(false)
    }
}

/// Whether a downloaded update can be installed by Coffee CLI itself (and so
/// waits behind an "Install" button) rather than handed to the user.
fn installs_in_place() -> bool {
    #[cfg(target_os = "macos")]
    return mac::current_bundle().is_some_and(|bundle| mac::replaceable(&bundle));
    #[cfg(not(target_os = "macos"))]
    cfg!(target_os = "windows")
}

/// The update platform this build runs on, in `update_sources` terms.
fn self_update_os() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        Some("windows")
    } else if cfg!(target_os = "macos") {
        Some("macos")
    } else {
        crate::update_sources::linux_package_kind(program_on_path)
    }
}

fn program_on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

fn run_download(app: &tauri::AppHandle, expected: &str) -> Result<Option<String>, String> {
    let arch = std::env::consts::ARCH;
    let os = self_update_os().ok_or("no installer for this system")?;
    let suffix = crate::update_sources::asset_suffix(os, arch).ok_or("no installer for this system")?;
    let platform = crate::update_sources::website_platform(os, arch).ok_or("no installer for this system")?;
    let official_url = format!("https://coffeecli.com/download/{platform}");
    emit(app, "speed_test", 0);

    let (target, candidates) = crate::update_sources::resolve(os, &official_url);
    let opened = crate::update_sources::probe(&candidates, std::time::Duration::from_millis(1500));
    if opened.is_empty() {
        emit(app, "error", 0);
        return Err("no download source reachable".into());
    }

    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    let file_name = match &target {
        Some(version) => format!("Coffee.CLI_{version}_{suffix}"),
        None => format!("Coffee.CLI_{suffix}"),
    };
    let out_path = dir.join(&file_name);
    // Download beside the final name and rename once verified, so a failed
    // or partial download never leaves a broken installer in Downloads.
    let part_path = dir.join(format!("{file_name}.part"));

    let mut last_err = String::from("download failed");
    let mut done = None;
    for source in opened {
        match download_installer(app, source, &part_path) {
            Ok(file) => { done = Some(file); break; }
            Err(e) => last_err = e,
        }
    }
    let Some(downloaded) = done else {
        let _ = std::fs::remove_file(&part_path);
        emit(app, "error", 0);
        return Err(last_err);
    };
    if let Err(e) = std::fs::rename(&part_path, &out_path) {
        let _ = std::fs::remove_file(&part_path);
        emit(app, "error", 100);
        return Err(format!("save installer failed: {e}"));
    }
    emit(app, "downloading", 100);

    if installs_in_place() {
        let version = target
            .or(downloaded.header_version)
            .unwrap_or_else(|| expected.to_string());
        let version = version.trim_start_matches('v').to_string();
        let receipt = Receipt {
            version: version.clone(),
            path: out_path,
            size: downloaded.size,
            sha256: downloaded.sha256,
        };
        let saved = receipt_file()
            .ok_or_else(|| "home directory unavailable".to_string())
            .and_then(|file| save_receipt(&file, &receipt).map_err(|e| e.to_string()));
        if let Err(e) = saved {
            emit(app, "error", 100);
            return Err(format!("remember installer failed: {e}"));
        }
        emit(app, "downloaded", 100);
        return Ok(Some(version));
    }

    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("open").arg(&out_path).spawn();
    #[cfg(not(target_os = "macos"))]
    let opened = std::process::Command::new("xdg-open").arg(&dir).spawn();
    if let Err(e) = opened {
        emit(app, "error", 100);
        return Err(format!("open installer failed: {e}"));
    }
    emit(app, "downloaded", 100);
    Ok(None)
}

/// `cmd` arguments that install silently (`/S`, relaunch via `/R`) and open
/// the visible wizard when the silent run fails, so a failed update never
/// leaves the user without the app or an explanation.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn installer_command_line(path: &Path) -> Result<String, String> {
    let path = path.to_string_lossy();
    // cmd cannot escape these inside a quoted path.
    if path.contains(['"', '%', '\n', '\r']) {
        return Err("installer path cannot be launched safely".into());
    }
    Ok(format!("/d /c start \"\" /wait \"{path}\" /S /R || start \"\" \"{path}\""))
}

/// A downloaded installer waiting for the user's "Install" click.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Receipt {
    version: String,
    path: PathBuf,
    size: u64,
    sha256: String,
}

fn receipt_file() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".coffee-cli").join("self-update.json"))
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn save_receipt(file: &Path, receipt: &Receipt) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(receipt).map_err(std::io::Error::other)?;
    crate::json_file::write_atomic(file, &bytes)
}

/// The receipt for `version` whose installer is still exactly the file that
/// was downloaded; a removed, replaced or unfinished file does not count.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn ready_installer(file: &Path, version: &str) -> Option<Receipt> {
    let receipt: Receipt = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    if receipt.version != version.trim_start_matches('v') {
        return None;
    }
    let (size, sha256) = hash_file(&receipt.path).ok()?;
    (size == receipt.size && sha256.eq_ignore_ascii_case(&receipt.sha256)).then_some(receipt)
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn hash_file(path: &Path) -> std::io::Result<(u64, String)> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

struct Downloaded {
    size: u64,
    sha256: String,
    header_version: Option<String>,
}

/// Stream one opened source to `out_path`, reporting progress, then check it
/// against the source's manifest entry (size + SHA-256).
fn download_installer(
    app: &tauri::AppHandle,
    source: crate::update_sources::Opened,
    out_path: &Path,
) -> Result<Downloaded, String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    let crate::update_sources::Opened { candidate, head, mut reader, total, header_version, eof, .. } = source;
    // The manifest knows the size even when the mirror sends no Content-Length.
    let total = candidate.expect.as_ref().map(|e| e.size).or(total).unwrap_or(0);
    let mut file = std::fs::File::create(out_path).map_err(|e| format!("create temp file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_pct: u32 = 0;
    emit(app, "downloading", 0);

    let mut write = |chunk: &[u8], downloaded: &mut u64, last_pct: &mut u32| -> Result<(), String> {
        file.write_all(chunk).map_err(|e| format!("write temp file failed: {e}"))?;
        hasher.update(chunk);
        *downloaded += chunk.len() as u64;
        if total > 0 {
            // Cap at 99 during streaming; 100 is reserved for "fully written".
            let pct = (downloaded.saturating_mul(100) / total).min(99) as u32;
            if pct != *last_pct {
                *last_pct = pct;
                emit(app, "downloading", pct);
            }
        }
        Ok(())
    };
    write(&head, &mut downloaded, &mut last_pct)?;
    if !eof {
        let mut buf = [0u8; 65536];
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("{}: download read failed: {e}", candidate.id))?;
            if n == 0 {
                break;
            }
            write(&buf[..n], &mut downloaded, &mut last_pct)?;
        }
    }
    drop(write);
    file.sync_all().map_err(|e| format!("flush temp file failed: {e}"))?;
    drop(file);
    let digest = format!("{:x}", hasher.finalize());
    crate::update_sources::verify(&candidate, header_version.as_deref(), downloaded, &digest)?;
    Ok(Downloaded { size: downloaded, sha256: digest, header_version })
}

/// The `.app` bundle an executable inside `Contents/MacOS` belongs to.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

/// Gatekeeper runs a quarantined app from a randomised read-only copy
/// (App Translocation); replacing that copy would change nothing the user
/// launches next time.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn translocated(bundle: &Path) -> bool {
    bundle.components().any(|c| c.as_os_str() == "AppTranslocation")
}

/// Shell run detached once the new bundle sits beside the old one:
/// `$1` pid to wait for, `$2` installed bundle, `$3` staged new bundle,
/// `$4` relaunch command, `$5` DMG to open if the swap fails. The old bundle
/// is moved aside first and restored if the new one cannot take its place,
/// so a failure never leaves the user without an app.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SWAP_SCRIPT: &str = r#"
pid=$1; app=$2; new=$3; relaunch=$4; dmg=$5; old="$new.old"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -gt 600 ] && exit 1
  sleep 0.1
done
rm -rf "$old"
ok=0
if mv "$app" "$old"; then
  if mv "$new" "$app"; then ok=1; else mv "$old" "$app"; fi
fi
rm -rf "$old" "$new"
"$relaunch" "$app"
[ "$ok" = 1 ] || "$relaunch" "$dmg"
"#;

#[cfg(target_os = "macos")]
mod mac {
    use super::{bundle_of, translocated, SWAP_SCRIPT};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};

    pub fn current_bundle() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        bundle_of(&exe)
    }

    /// The running bundle can be renamed away and replaced: not translocated,
    /// and its folder (usually /Applications) is writable — which also rules
    /// out the read-only DMG volume.
    pub fn replaceable(bundle: &Path) -> bool {
        use std::os::unix::ffi::OsStrExt;
        if translocated(bundle) {
            return false;
        }
        let Some(parent) = bundle.parent() else { return false };
        let Ok(c) = std::ffi::CString::new(parent.as_os_str().as_bytes()) else { return false };
        // SAFETY: a valid NUL-terminated path; access() only reads it.
        unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
    }

    /// Mount `dmg`, check its app, stage it beside the running bundle and
    /// start the detached swap. On Ok the caller exits; the shell relaunches.
    pub fn install(dmg: &Path, version: &str) -> Result<(), String> {
        let bundle = current_bundle().ok_or("not running from an app bundle")?;
        if !replaceable(&bundle) {
            return Err(format!("{} cannot be replaced", bundle.display()));
        }
        let parent = bundle.parent().ok_or("bundle has no parent folder")?;
        let name = bundle.file_name().ok_or("bundle has no name")?.to_string_lossy().into_owned();
        // Same volume as the bundle, so the final swap is a rename.
        let staged = parent.join(format!(".{name}.update"));

        let mount = Mount::attach(dmg)?;
        let new_app = mount.app()?;
        check_new_app(&new_app, &bundle, version)?;
        let _ = std::fs::remove_dir_all(&staged);
        let _ = std::fs::remove_dir_all(staged.with_extension("update.old"));
        run(Command::new("/usr/bin/ditto").arg(&new_app).arg(&staged))
            .map_err(|e| format!("copy new app failed: {e}"))?;
        drop(mount);

        Command::new("/bin/sh")
            .arg("-c")
            .arg(SWAP_SCRIPT)
            .arg("coffee-cli-update")
            .arg(std::process::id().to_string())
            .arg(&bundle)
            .arg(&staged)
            .arg("/usr/bin/open")
            .arg(dmg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map(|_| ())
            .map_err(|e| {
                let _ = std::fs::remove_dir_all(&staged);
                format!("start update helper failed: {e}")
            })
    }

    use std::os::unix::process::CommandExt;

    /// The new app must be intact, be Coffee CLI at the version that was
    /// downloaded, and — once the installed app carries a Developer ID — be
    /// signed by Apple-issued certificates of the same team and notarized.
    fn check_new_app(new_app: &Path, installed: &Path, version: &str) -> Result<(), String> {
        let mut verify = Command::new("/usr/bin/codesign");
        verify.args(["--verify", "--deep", "--strict"]);
        let team = team_id(installed);
        if let Some(team) = &team {
            verify.arg(format!("-R={}", super::same_team_requirement(team)?));
        }
        run(verify.arg(new_app)).map_err(|e| format!("new app signature rejected: {e}"))?;
        if team.is_some() {
            run(Command::new("/usr/sbin/spctl").args(["--assess", "--type", "execute"]).arg(new_app))
                .map_err(|e| format!("new app not accepted by Gatekeeper: {e}"))?;
        }
        let info = |app: &Path, key: &str| -> Option<String> {
            let out = Command::new("/usr/libexec/PlistBuddy")
                .args(["-c", &format!("Print :{key}")])
                .arg(app.join("Contents/Info.plist"))
                .output()
                .ok()?;
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        let id = info(new_app, "CFBundleIdentifier");
        if id.is_none() || id != info(installed, "CFBundleIdentifier") {
            return Err("new app has a different bundle identifier".into());
        }
        if info(new_app, "CFBundleShortVersionString").as_deref() != Some(version.trim_start_matches('v')) {
            return Err(format!("new app is not version {version}"));
        }
        Ok(())
    }

    /// The Developer ID team of a signed app; `None` for ad-hoc signatures.
    fn team_id(app: &Path) -> Option<String> {
        let out = Command::new("/usr/bin/codesign").args(["-dv", "--verbose=2"]).arg(app).output().ok()?;
        super::parse_team_id(&String::from_utf8_lossy(&out.stderr))
    }

    fn run(cmd: &mut Command) -> Result<(), String> {
        let out = cmd.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// A DMG mounted privately (no Finder window); detached on drop.
    struct Mount {
        point: tempfile::TempDir,
    }

    impl Mount {
        fn attach(dmg: &Path) -> Result<Self, String> {
            let point = tempfile::Builder::new()
                .prefix("coffee-cli-update-")
                .tempdir()
                .map_err(|e| format!("create mount point failed: {e}"))?;
            run(Command::new("/usr/bin/hdiutil")
                .args(["attach", "-nobrowse", "-noautoopen", "-readonly", "-mountpoint"])
                .arg(point.path())
                .arg(dmg))
            .map_err(|e| format!("mount update failed: {e}"))?;
            Ok(Mount { point })
        }

        fn app(&self) -> Result<PathBuf, String> {
            let mut apps = std::fs::read_dir(self.point.path())
                .map_err(|e| format!("read update failed: {e}"))?
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "app"));
            match (apps.next(), apps.next()) {
                (Some(app), None) => Ok(app),
                _ => Err("update holds no single app".into()),
            }
        }
    }

    impl Drop for Mount {
        fn drop(&mut self) {
            let _ = Command::new("/usr/bin/hdiutil")
                .args(["detach", "-force"])
                .arg(self.point.path())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// Code requirement for an app signed with an Apple-issued Developer ID
/// certificate of `team` — unlike `TeamIdentifier=`, a self-made
/// certificate cannot satisfy it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn same_team_requirement(team: &str) -> Result<String, String> {
    if team.is_empty() || !team.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("unexpected team identifier {team:?}"));
    }
    Ok(format!(
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
         and certificate leaf[field.1.2.840.113635.100.6.1.13] exists \
         and certificate leaf[subject.OU] = \"{team}\""
    ))
}

/// `TeamIdentifier=…` from `codesign -dv` output; ad-hoc reports "not set".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_team_id(codesign_details: &str) -> Option<String> {
    codesign_details
        .lines()
        .find_map(|line| line.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|team| !team.is_empty() && *team != "not set")
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_silently_and_falls_back_to_the_wizard() {
        let path = Path::new(r"C:\Users\A B\Downloads\Coffee.CLI_4.0.2_x64-setup.exe");
        assert_eq!(
            installer_command_line(path).unwrap(),
            r#"/d /c start "" /wait "C:\Users\A B\Downloads\Coffee.CLI_4.0.2_x64-setup.exe" /S /R || start "" "C:\Users\A B\Downloads\Coffee.CLI_4.0.2_x64-setup.exe""#
        );
        for unsafe_path in [r#"C:\a"b\setup.exe"#, r"C:\%TEMP%\setup.exe"] {
            assert!(installer_command_line(Path::new(unsafe_path)).is_err());
        }
    }

    #[test]
    fn offers_install_only_for_the_intact_installer_of_that_version() {
        let dir = tempfile::tempdir().unwrap();
        let installer = dir.path().join("Coffee.CLI_4.0.8_x64-setup.exe");
        std::fs::write(&installer, b"installer").unwrap();
        let (size, sha256) = hash_file(&installer).unwrap();
        let file = dir.path().join("state").join("self-update.json");
        let receipt = Receipt { version: "4.0.8".into(), path: installer.clone(), size, sha256 };

        assert!(ready_installer(&file, "4.0.8").is_none(), "nothing downloaded yet");
        save_receipt(&file, &receipt).unwrap();
        assert_eq!(ready_installer(&file, "4.0.8"), Some(receipt.clone()));
        assert_eq!(ready_installer(&file, "v4.0.8"), Some(receipt.clone()));
        assert!(ready_installer(&file, "4.0.9").is_none(), "a newer release needs a new download");

        std::fs::write(&installer, b"installex").unwrap();
        assert!(ready_installer(&file, "4.0.8").is_none(), "a replaced file is not installed");
        std::fs::write(&installer, b"install").unwrap();
        assert!(ready_installer(&file, "4.0.8").is_none(), "a truncated file is not installed");
        std::fs::remove_file(&installer).unwrap();
        assert!(ready_installer(&file, "4.0.8").is_none(), "a deleted file goes back to Download");

        std::fs::write(&file, b"{not json").unwrap();
        assert!(ready_installer(&file, "4.0.8").is_none());
    }

    #[test]
    fn finds_the_app_bundle_of_the_running_executable() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Coffee CLI.app/Contents/MacOS/coffee-cli")),
            Some(PathBuf::from("/Applications/Coffee CLI.app"))
        );
        assert_eq!(bundle_of(Path::new("/Volumes/扩展存储/coffee-cli/target/debug/coffee-cli")), None);
        assert_eq!(bundle_of(Path::new("/Applications/Coffee CLI/Contents/MacOS/coffee-cli")), None);
        assert!(translocated(Path::new(
            "/private/var/folders/x/T/AppTranslocation/1234/d/Coffee CLI.app"
        )));
        assert!(!translocated(Path::new("/Applications/Coffee CLI.app")));
    }

    #[test]
    fn reads_the_signing_team_and_treats_ad_hoc_as_none() {
        let signed = "Identifier=com.coffeecli.desktop\nAuthority=Developer ID Application: Coffee (AB12CD34EF)\nTeamIdentifier=AB12CD34EF\n";
        assert_eq!(parse_team_id(signed).as_deref(), Some("AB12CD34EF"));
        assert_eq!(parse_team_id("Signature=adhoc\nTeamIdentifier=not set\n"), None);
        assert_eq!(parse_team_id("Signature=adhoc\n"), None);
    }

    #[test]
    fn requires_an_apple_issued_developer_id_of_the_same_team() {
        let req = same_team_requirement("AB12CD34EF").unwrap();
        assert!(req.starts_with("anchor apple generic and "), "{req}");
        assert!(req.ends_with(r#"certificate leaf[subject.OU] = "AB12CD34EF""#), "{req}");
        assert!(!req.contains("  "), "{req}");
        assert!(same_team_requirement("").is_err());
        assert!(same_team_requirement(r#"X" or true"#).is_err());
    }

    #[cfg(unix)]
    fn run_swap(app: &Path, new: &Path) -> String {
        let dir = app.parent().unwrap();
        let log = dir.join("relaunched");
        // Relaunch command that records what it was asked to open.
        let relaunch = dir.join("relaunch.sh");
        std::fs::write(&relaunch, format!("#!/bin/sh\necho \"$1\" >> '{}'\n", log.display())).unwrap();
        std::process::Command::new("chmod").arg("+x").arg(&relaunch).status().unwrap();
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let pid = gone.id();
        gone.wait().unwrap();
        let status = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(SWAP_SCRIPT)
            .arg("swap")
            .arg(pid.to_string())
            .arg(app)
            .arg(new)
            .arg(&relaunch)
            .arg(dir.join("update.dmg"))
            .status()
            .unwrap();
        assert!(status.success());
        std::fs::read_to_string(log).unwrap_or_default()
    }

    #[cfg(unix)]
    #[test]
    fn swap_replaces_the_bundle_and_relaunches_it() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Coffee CLI.app");
        let new = dir.path().join(".Coffee CLI.app.update");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(app.join("Contents/v"), "old").unwrap();
        std::fs::create_dir_all(new.join("Contents")).unwrap();
        std::fs::write(new.join("Contents/v"), "new").unwrap();

        let opened = run_swap(&app, &new);
        assert_eq!(std::fs::read_to_string(app.join("Contents/v")).unwrap(), "new");
        assert!(!new.exists(), "staged copy is moved, not left behind");
        assert!(!dir.path().join(".Coffee CLI.app.update.old").exists());
        assert_eq!(opened.trim(), app.display().to_string());
    }

    #[cfg(unix)]
    #[test]
    fn failed_swap_keeps_the_old_app_and_opens_the_dmg() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("Coffee CLI.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(app.join("Contents/v"), "old").unwrap();
        // Nothing staged: the second rename fails.
        let opened = run_swap(&app, &dir.path().join(".Coffee CLI.app.update"));
        assert_eq!(std::fs::read_to_string(app.join("Contents/v")).unwrap(), "old");
        let lines: Vec<_> = opened.lines().collect();
        assert_eq!(lines, [app.display().to_string(), dir.path().join("update.dmg").display().to_string()]);
    }

    #[test]
    fn refuses_a_second_update_while_one_runs() {
        let first = Busy::claim().unwrap();
        assert!(Busy::claim().is_err());
        drop(first);
        drop(Busy::claim().unwrap());
    }
}
