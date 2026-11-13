use std::{io::ErrorKind, path::Path};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectoryStatus { Available, Missing, NotDirectory, Unavailable }

fn failed_lookup(kind: ErrorKind, root_available: bool) -> DirectoryStatus {
    match (kind, root_available) {
        (ErrorKind::NotFound, true) => DirectoryStatus::Missing,
        (ErrorKind::NotADirectory, true) => DirectoryStatus::NotDirectory,
        _ => DirectoryStatus::Unavailable,
    }
}

pub fn status(path: &Path) -> DirectoryStatus {
    match std::fs::metadata(path) {
        Ok(metadata) if !metadata.is_dir() => DirectoryStatus::NotDirectory,
        Ok(_) => match std::fs::read_dir(path) {
            Ok(_) => DirectoryStatus::Available,
            Err(_) => DirectoryStatus::Unavailable,
        },
        Err(error) => {
            // An offline drive or share must not erase remembered projects.
            let root_available = path.is_absolute() && path.ancestors().last()
                .and_then(|root| std::fs::metadata(root).ok()).is_some_and(|m| m.is_dir());
            failed_lookup(error.kind(), root_available)
        }
    }
}

pub fn validate(path: &Path) -> Result<(), String> {
    let reason = match status(path) {
        DirectoryStatus::Available => return Ok(()),
        DirectoryStatus::Missing => "missing",
        DirectoryStatus::NotDirectory => "not_directory",
        DirectoryStatus::Unavailable => "unavailable",
    };
    Err(format!("COFFEE_DIRECTORY:{reason}:{}", path.display()))
}

#[derive(Serialize)]
pub struct DirectoryCheck { path: String, status: DirectoryStatus }

#[tauri::command]
pub async fn check_project_directories(paths: Vec<String>) -> Result<Vec<DirectoryCheck>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.into_iter().map(|path| {
        let status = status(&crate::tool_config::expand_path(&path));
        DirectoryCheck { path, status }
    }).collect()).await.map_err(|error| error.to_string())
}

/// The folder a coordinator's worker opens in: an absolute path to an existing
/// directory, in the form the shell accepts (Windows verbatim prefixes removed).
#[tauri::command]
pub fn resolve_project_directory(path: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(path.trim());
    if !path.is_absolute() { return Err("请指定完整的绝对目录路径，不能默认使用上次工作目录".into()); }
    let canonical = path.canonicalize().map_err(|_| "Directory does not exist")?;
    if !canonical.is_dir() { return Err("Choose an existing directory".into()); }
    let compatible = crate::terminal::shell_working_directory(&canonical).map_err(|e| e.to_string())?;
    Ok(compatible.to_string_lossy().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deleted_directory_and_replaced_file_are_rejected() {
        let path = std::env::temp_dir().join(format!("coffee-directory-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        assert_eq!(status(&path), DirectoryStatus::Available);
        assert!(validate(&path).is_ok());
        std::fs::remove_dir(&path).unwrap();
        assert_eq!(status(&path), DirectoryStatus::Missing);
        assert_eq!(validate(&path).unwrap_err(), format!("COFFEE_DIRECTORY:missing:{}", path.display()));
        std::fs::write(&path, "not a directory").unwrap();
        assert_eq!(status(&path), DirectoryStatus::NotDirectory);
        assert!(validate(&path).unwrap_err().starts_with("COFFEE_DIRECTORY:not_directory:"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unavailable_roots_and_permissions_do_not_mean_deleted() {
        assert_eq!(failed_lookup(ErrorKind::NotFound, false), DirectoryStatus::Unavailable);
        assert_eq!(failed_lookup(ErrorKind::NotADirectory, false), DirectoryStatus::Unavailable);
        assert_eq!(failed_lookup(ErrorKind::PermissionDenied, true), DirectoryStatus::Unavailable);
        assert_eq!(failed_lookup(ErrorKind::Other, true), DirectoryStatus::Unavailable);
    }
}
