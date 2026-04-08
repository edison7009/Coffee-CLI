// Coffee CLI — Filesystem Watcher Module
// Listens for real-time file changes and streams them to the frontend terminal.

use notify::{RecursiveMode, Watcher, EventKind, event::ModifyKind};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::thread;
use tauri::{AppHandle, Emitter};

/// Start the background watcher manager.
/// Listens to `dir_rx` for new project directories. 
/// When a new directory is received, drops the old watcher and creates a new one,
/// configuring it to emit `analysis-progress` events to the Tauri `AppHandle`.
pub fn start_watcher(app_handle: AppHandle, dir_rx: Receiver<PathBuf>) {
    thread::spawn(move || {
        // Keep the active watcher alive here. When we assign a new one, the old is dropped.
        let mut _active_watcher: Option<notify::RecommendedWatcher> = None;

        for new_dir in dir_rx {
            log::info!("Watcher manager received new directory: {:?}", new_dir);
            
            // Clone the app_handle for the callback closure
            let app = app_handle.clone();
            let base_dir = new_dir.clone();

            let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                match res {
                    Ok(event) => {
                        // Filter events
                        let op = match event.kind {
                            EventKind::Create(_) => "created",
                            EventKind::Modify(m) => {
                                // Only log data changes or name changes, ignore metadata/access changes
                                match m {
                                    ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any => "modified",
                                    _ => return, 
                                }
                            },
                            EventKind::Remove(_) => "deleted",
                            _ => return, // Ignore other events
                        };

                        for path in event.paths {
                            if should_ignore(&path) {
                                continue;
                            }

                            // Calculate relative path for display
                            let relative_path = path.strip_prefix(&base_dir)
                                .unwrap_or(&path)
                                .to_string_lossy()
                                .replace('\\', "/");

                            // Emit raw json to the terminal stream
                            let payload = json!({
                                "type": "fs_change",
                                "op": op,
                                "path": relative_path
                            });

                            let _ = app.emit("analysis-progress", payload);
                        }
                    }
                    Err(e) => log::error!("Watch error: {:?}", e),
                }
            }) {
                Ok(w) => w,
                Err(e) => {
                    log::error!("Failed to create filesystem watcher: {:?}", e);
                    continue;
                }
            };

            // Start watching the new directory
            if let Err(e) = watcher.watch(&new_dir, RecursiveMode::Recursive) {
                log::error!("Failed to watch directory {:?}: {:?}", new_dir, e);
            } else {
                log::info!("Started watching: {:?}", new_dir);
                // Assign to our local state to keep it alive
                _active_watcher = Some(watcher);
            }
        }
    });
}

/// Simple heuristic to ignore noisy directories/files.
fn should_ignore(path: &Path) -> bool {
    let components: Vec<_> = path.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    
    for c in components {
        if c == ".git" || c == "node_modules" || c == "target" || c == "dist" || c == "build" || c == ".coffeemode" || c == "__pycache__" || c == ".next" {
            return true;
        }
    }

    // Ignore temporary files and swap files
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        if ext == "tmp" || ext == "swp" || ext == "bak" || ext == "log" || ext == "pyc" {
            return true;
        }
    }

    if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
        if name == ".DS_Store" {
            return true;
        }
    }

    false
}
