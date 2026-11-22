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
//! Windows then stops: the installer waits in Downloads, remembered by a
//! receipt (version, path, size, SHA-256), and the update button turns into
//! "Install". Only `install_downloaded_update` — the user's second click —
//! re-checks the file against the receipt, runs it and closes Coffee CLI. The
//! receipt outlives a restart, so a download finished earlier can still be
//! installed later. macOS opens the DMG and Linux opens the Downloads folder
//! right after downloading; both keep running.
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
/// the button can offer "Install" straight away (Windows only).
#[tauri::command]
pub async fn is_update_downloaded(version: String) -> Result<bool, String> {
    if !cfg!(target_os = "windows") {
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
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, version);
        Ok(false)
    }
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

    if cfg!(target_os = "windows") {
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

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn save_receipt(file: &Path, receipt: &Receipt) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(receipt).map_err(std::io::Error::other)?;
    crate::json_file::write_atomic(file, &bytes)
}

/// The receipt for `version` whose installer is still exactly the file that
/// was downloaded; a removed, replaced or unfinished file does not count.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ready_installer(file: &Path, version: &str) -> Option<Receipt> {
    let receipt: Receipt = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    if receipt.version != version.trim_start_matches('v') {
        return None;
    }
    let (size, sha256) = hash_file(&receipt.path).ok()?;
    (size == receipt.size && sha256.eq_ignore_ascii_case(&receipt.sha256)).then_some(receipt)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
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
    fn refuses_a_second_update_while_one_runs() {
        let first = Busy::claim().unwrap();
        assert!(Busy::claim().is_err());
        drop(first);
        drop(Busy::claim().unwrap());
    }
}
