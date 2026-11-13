//! Crash-safe writes for user-owned JSON files.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Replace `path` with `bytes` so readers only ever see the old or the new
/// content, never a half-written file. The data goes to a uniquely named
/// temp file beside the target (so concurrent saves never share one), is
/// flushed to disk, then renamed over the target. A failure removes the temp
/// file and leaves the existing target untouched.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no file name"))?
        .to_string_lossy();
    let temp = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn replaces_content_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second, longer").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second, longer");
        assert_eq!(entries(dir.path()), ["data.json"]);
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a").join("b").join("data.json");
        write_atomic(&path, b"{}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
    }

    #[test]
    fn concurrent_writes_never_tear_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        let payloads: Vec<Vec<u8>> = (0..12u8).map(|id| vec![b'a' + id; 200_000]).collect();
        let threads: Vec<_> = payloads
            .iter()
            .cloned()
            .map(|payload| {
                let path = path.clone();
                std::thread::spawn(move || write_atomic(&path, &payload).unwrap())
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let content = std::fs::read(&path).unwrap();
        assert!(payloads.contains(&content), "the file must equal exactly one writer's payload");
        assert_eq!(entries(dir.path()), ["data.json"]);
    }

    #[test]
    fn failed_write_keeps_the_target_and_removes_the_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        // A directory in the way makes the final rename fail.
        std::fs::create_dir(&path).unwrap();
        assert!(write_atomic(&path, b"x").is_err());
        assert!(path.is_dir());
        assert_eq!(entries(dir.path()), ["data.json"]);
    }
}

/// Moves a fully written temp file over `path` in one step, replacing it.
/// Windows needs MoveFileExW to replace an existing file atomically.
#[cfg(not(windows))]
pub(crate) fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    std::fs::rename(temp, path).map_err(|_| "Could not save the file".into())
}

#[cfg(windows)]
pub(crate) fn replace_file(temp: &Path, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Both pointers refer to live, null-terminated buffers for this call.
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }
        .map_err(|_| "Could not save the file".into())
}
