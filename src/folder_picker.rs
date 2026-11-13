//! Starting places for Coffee CLI's own folder picker, which every surface
//! (desktop window, browser, phone) shares. Folders themselves are read with
//! `list_directory`; this lists where browsing can begin on this computer.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    pub path: String,
    /// "home", "desktop", "documents", "downloads", "drive" (a disk, a volume or `/`).
    pub kind: &'static str,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Places {
    pub home: Option<String>,
    /// The computer's path separator, so the picker splits and walks paths the computer's way.
    pub separator: char,
    pub places: Vec<Place>,
}

fn text(path: &Path) -> String { path.to_string_lossy().into_owned() }

/// Home and its common folders, when they exist.
fn home_places(home: &Path, exists: &dyn Fn(&Path) -> bool) -> Vec<Place> {
    let mut list = vec![Place { name: home.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| text(home)), path: text(home), kind: "home" }];
    for (dir, kind) in [("Desktop", "desktop"), ("Documents", "documents"), ("Downloads", "downloads")] {
        let path = home.join(dir);
        if exists(&path) { list.push(Place { name: dir.into(), path: text(&path), kind }); }
    }
    list
}

/// Disks: drive letters on Windows; `/` plus mounted volumes elsewhere.
fn drive_places(volume_dirs: &[PathBuf], exists: &dyn Fn(&Path) -> bool, list_dir: &dyn Fn(&Path) -> Vec<(String, bool)>) -> Vec<Place> {
    if cfg!(windows) {
        return (b'A'..=b'Z').map(|letter| format!("{}:\\", letter as char)).filter(|root| exists(Path::new(root)))
            .map(|root| Place { name: root.trim_end_matches('\\').to_owned(), path: root, kind: "drive" }).collect();
    }
    let mut list = vec![Place { name: "/".into(), path: "/".into(), kind: "drive" }];
    for dir in volume_dirs {
        // Mount points are folders; the boot volume's alias in /Volumes is a symlink back to `/`.
        for (name, is_real_dir) in list_dir(dir) {
            if is_real_dir && !name.starts_with('.') { list.push(Place { path: text(&dir.join(&name)), name, kind: "drive" }); }
        }
    }
    list
}

fn volume_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    if cfg!(target_os = "macos") { return vec![PathBuf::from("/Volumes")]; }
    let mut dirs = vec![PathBuf::from("/mnt")];
    if let Some(user) = home.and_then(|h| h.file_name()) { dirs.insert(0, Path::new("/media").join(user)); }
    dirs
}

pub fn places() -> Places {
    let home = dirs::home_dir();
    let exists = |p: &Path| p.is_dir();
    let list_dir = |dir: &Path| -> Vec<(String, bool)> {
        std::fs::read_dir(dir).map(|entries| entries.flatten().map(|e| {
            let is_real_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (e.file_name().to_string_lossy().into_owned(), is_real_dir)
        }).collect()).unwrap_or_default()
    };
    let mut list = home.as_deref().map(|h| home_places(h, &exists)).unwrap_or_default();
    list.extend(drive_places(&volume_dirs(home.as_deref()), &exists, &list_dir));
    Places { home: home.as_deref().map(text), separator: std::path::MAIN_SEPARATOR, places: list }
}

#[tauri::command]
pub async fn folder_picker_places() -> Places {
    tauri::async_runtime::spawn_blocking(places).await.unwrap_or(Places { home: None, separator: std::path::MAIN_SEPARATOR, places: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_lists_only_existing_common_folders() {
        let home = Path::new("/Users/me");
        let existing = |p: &Path| p.ends_with("Desktop") || p.ends_with("Downloads");
        let list = home_places(home, &existing);
        assert_eq!(list.iter().map(|p| (p.kind, p.name.as_str())).collect::<Vec<_>>(), [("home", "me"), ("desktop", "Desktop"), ("downloads", "Downloads")]);
        assert_eq!(list[1].path, text(&home.join("Desktop")));
    }

    #[cfg(not(windows))]
    #[test]
    fn drives_are_root_and_mounted_volumes_without_symlinks_or_hidden() {
        let dirs = [PathBuf::from("/Volumes")];
        let listing = |_: &Path| vec![("Macintosh HD".to_string(), false), ("扩展存储".to_string(), true), (".timemachine".to_string(), true)];
        let list = drive_places(&dirs, &|_| true, &listing);
        assert_eq!(list.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(), ["/", "/Volumes/扩展存储"]);
        assert!(list.iter().all(|p| p.kind == "drive"));
    }
}
