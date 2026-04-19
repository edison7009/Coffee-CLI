// fs_watcher.rs — Live file-system watcher for the left Explorer panel.
//
// Coffee CLI's brand promise is "beautified host for AI CLIs". That means
// when a CLI tool (Claude / Codex / etc.) writes, renames, or deletes a
// file in the workspace, the user expects the left tree to reflect it
// *immediately*. Previously the tree only refreshed when the user hit
// commands.fsDelete / fsRename / fsPaste through the context menu —
// every other path (terminal `rm`, editor save, git checkout, CLI
// artifact dump) was invisible.
//
// Approach: subscribe to OS-native fs events via the `notify` crate,
// coalesce bursts with `notify-debouncer-full` (200 ms window), then
// emit a single `fs-refresh` Tauri event per affected directory. The
// frontend already has a global listener that re-scans when this event
// fires, so no UI plumbing changes are needed.

use notify_debouncer_full::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode, Watcher},
    DebounceEventResult, Debouncer, FileIdMap,
};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Refuse to recursively watch paths that are so broad they'd flood the
/// event loop — drive roots, the user's home directory, or `/`. Returns
/// Some(reason) to reject, None to allow.
///
/// We don't try to be exhaustive (e.g. `C:\Windows` or `/usr` are still
/// allowed); the goal is to catch the clearly accidental cases and give
/// the user a clear error instead of a frozen UI.
fn rejected_root_reason(root: &Path) -> Option<&'static str> {
    // Filesystem root.
    if root.parent().is_none() {
        return Some("filesystem root");
    }
    // Windows drive root: "C:\" has one component, a Prefix and a RootDir.
    // Easier heuristic: path equals its own ancestor chain's first stop.
    #[cfg(target_os = "windows")]
    {
        // e.g. C:\  -> components = [Prefix(C:), RootDir]
        let comp_count = root.components().count();
        if comp_count <= 2 {
            return Some("drive root");
        }
    }
    // User home directory — catches the actual case that surfaced this bug.
    if let Some(home) = dirs::home_dir() {
        if root == home {
            return Some("user home directory");
        }
    }
    None
}

/// Debounce window. Short enough to feel live, long enough to collapse
/// the write-rename-close-fsync event storm that editors and CLIs emit
/// when saving a single file.
const DEBOUNCE_MS: u64 = 200;

/// Tauri event payload. `dirPath` matches the camelCase key the
/// frontend's fs-refresh listeners already expect.
#[derive(Serialize, Clone)]
struct FsRefreshPayload {
    #[serde(rename = "dirPath")]
    dir_path: String,
}

/// Owns the debouncer (and transitively the OS watcher handle).
/// Dropping this struct stops the watch.
pub struct FsWatcher {
    _debouncer: Debouncer<RecommendedWatcher, FileIdMap>,
    /// Retained for future diagnostics (restart-on-change, logging).
    #[allow(dead_code)]
    pub root: PathBuf,
}

impl FsWatcher {
    /// Start watching `root` recursively. Errors if the path doesn't
    /// exist or isn't a directory. Caller should store the returned
    /// handle (e.g. in AppState) so it lives as long as the watch is
    /// wanted.
    pub fn start(app: AppHandle, root: PathBuf) -> Result<Self, String> {
        if !root.is_dir() {
            return Err(format!("Not a directory: {}", root.display()));
        }
        if let Some(reason) = rejected_root_reason(&root) {
            return Err(format!(
                "Refusing to watch {} ({}). Pick a specific project folder instead.",
                root.display(),
                reason,
            ));
        }
        let root_clone = root.clone();

        let mut debouncer = new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            None,
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    // Collect every touched *directory* into a set so we
                    // emit once per dir even if 50 files changed inside.
                    let mut dirs: HashSet<String> = HashSet::new();
                    for event in events {
                        for path in &event.event.paths {
                            // Directory entry itself? Use as-is.
                            // File? Use its parent.
                            let dir = if path.is_dir() {
                                path.clone()
                            } else if let Some(p) = path.parent() {
                                p.to_path_buf()
                            } else {
                                continue;
                            };
                            // Forward-slash normalize — frontend dispatchFsRefresh
                            // stores paths this way, so match semantics stay cheap.
                            let norm = dir.to_string_lossy().replace('\\', "/");
                            dirs.insert(norm);
                        }
                    }
                    for dir_path in dirs {
                        let _ = app.emit("fs-refresh", FsRefreshPayload { dir_path });
                    }
                }
                Err(errors) => {
                    for e in errors {
                        eprintln!("[fs-watcher] error: {:?}", e);
                    }
                }
            },
        )
        .map_err(|e| format!("create debouncer: {}", e))?;

        debouncer
            .watcher()
            .watch(&root_clone, RecursiveMode::Recursive)
            .map_err(|e| format!("watch {}: {}", root_clone.display(), e))?;
        // Intentionally *not* calling `debouncer.cache().add_root(...)` —
        // that would recursively stat every file under `root` on startup
        // to build a file-id index, which freezes the UI on large repos
        // (node_modules, target/, etc). The cache only adds value for
        // precise cross-dir rename tracking, which we don't need since
        // our frontend re-scans the whole workspace on any `fs-refresh`.

        Ok(FsWatcher {
            _debouncer: debouncer,
            root: root_clone,
        })
    }
}
