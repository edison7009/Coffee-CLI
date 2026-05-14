use crate::terminal;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{State, Manager, Emitter};
use tauri_plugin_dialog::DialogExt;

/// Shared app state
pub struct AppState {
    pub terminal_session: terminal::SharedSession,
    /// Loopback port of the hook TCP server (set once during setup).
    /// 0 means the hook server failed to start; env var injection is skipped in that case.
    pub hook_port: std::sync::atomic::AtomicU16,
    /// Active OS fs watcher (one per app instance). Some(...) while a
    /// workspace folder is open; None otherwise. Swapping this Mutex'd
    /// Option replaces the watcher atomically on folder switch.
    pub fs_watcher: Mutex<Option<crate::fs_watcher::FsWatcher>>,
    /// Per-pane MCP server endpoints. Each multi-agent pane (Claude /
    /// Codex / Gemini) gets its OWN HTTP listener on its own port with
    /// `self_pane_id` baked in, so `whoami()` / `is_self` in
    /// `list_panes` / `[From <id>]` prefixing in `send_to_pane` all
    /// behave deterministically regardless of which CLI is calling.
    /// Map is keyed by pane id (= terminal session id like
    /// "tab-X::pane-2"). Endpoints persist for the app lifetime —
    /// TCP listeners are cheap and bounded by max concurrent panes.
    pub pane_mcp_endpoints: tokio::sync::Mutex<
        std::collections::HashMap<String, crate::mcp_server::McpEndpoint>,
    >,
    /// Async lock around any MCP-server spawn path. Held only while
    /// a (one-time) spawn is in flight so concurrent first-callers
    /// don't race and bind two listeners for the same pane.
    pub mcp_spawn_lock: tokio::sync::Mutex<()>,
    /// Hyper-Agent global anonymous MCP server — `self_pane_id=None`,
    /// no tab-scope filter. External admin agents (OpenClaw, Hermes Agent
    /// daemons running outside Coffee-CLI's tabs) connect here and see
    /// every pane across every tab. Started lazily when the user opens
    /// the Hyper-Agent tab; users who never open that tab pay zero cost.
    pub hyper_agent_endpoint:
        tokio::sync::Mutex<Option<crate::mcp_server::McpEndpoint>>,
}


#[tauri::command]
fn window_minimize(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_maximize(window: tauri::Window) {
    let is_max = window.is_maximized().unwrap_or(false);
    if is_max { let _ = window.unmaximize(); } else { let _ = window.maximize(); }
}

#[tauri::command]
fn window_close(window: tauri::Window, app: tauri::AppHandle) {
    let label = window.label().to_string();
    if label == "main" {
        // Main window: close entire application (including all detached windows)
        app.exit(0);
    } else {
        // Detached window: just close this one
        let _ = window.close();
    }
}

#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<String, String> {
    let folder = app
        .dialog()
        .file()
        .blocking_pick_folder();

    match folder {
        Some(path) => Ok(path.to_string()),
        None => Err("cancelled".to_string()),
    }
}

// ─── Tool Availability Detection ─────────────────────────────────────────────

/// PATH lookup wrapper. Used by hook_installer + agent_mcp_config to
/// gate config-file writes so we don't materialize stray `~/.codex/`,
/// `~/.config/opencode/`, etc. on machines where the user hasn't
/// installed the upstream CLI yet.
pub(crate) fn binary_on_path(bin: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        check_tool_windows(bin)
    }
    #[cfg(not(target_os = "windows"))]
    {
        check_tool_unix(bin)
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn check_tool_windows(bin: &str) -> bool {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("where")
        .arg(bin)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn check_tool_unix(bin: &str) -> bool {
    std::process::Command::new("which")
        .arg(bin)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Install hook scripts + upstream config patches for a single tool.
/// Called from the launchpad's focus-rescan when `check_tools_installed`
/// flips a CLI from not-installed → installed, so users who install a
/// CLI while Coffee CLI is running pick up tab status indicators
/// without restarting. No-op for tools the hook installer doesn't
/// manage. Idempotent.
#[tauri::command]
fn install_hook_for_tool(tool: String) {
    crate::hook_installer::install_for_tool(&tool);
}

#[tauri::command]
fn check_tools_installed() -> std::collections::HashMap<String, bool> {
    let mut result = std::collections::HashMap::new();
    for tool in crate::tools::TOOLS {
        result.insert(tool.id.to_string(), binary_on_path(tool.binary_name));
    }
    // `terminal` (system shell) and `remote` (SSH) have no binary to
    // probe — always available, not registered.
    result.insert("terminal".to_string(), true);
    result
}

// ─── File System Live Watcher ────────────────────────────────────────────────
//
// Start/stop a recursive fs watcher on the workspace folder so changes
// made by external tools (terminal CLIs, editors, git, etc.) propagate
// into the Explorer tree immediately. See fs_watcher.rs for mechanics.

#[tauri::command]
fn start_fs_watcher(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let root = PathBuf::from(&path);
    let watcher = crate::fs_watcher::FsWatcher::start(app, root)?;
    // Replace atomically; dropping the old FsWatcher stops its OS handle.
    let mut guard = state.fs_watcher.lock().map_err(|e| format!("lock: {}", e))?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
fn stop_fs_watcher(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.fs_watcher.lock().map_err(|e| format!("lock: {}", e))?;
    // Drop releases the OS watcher handle.
    *guard = None;
    Ok(())
}

// ─── File System Browsing API ────────────────────────────────────────────────

/// Information about a single directory entry (file or folder)
#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// List the immediate children of a directory.
/// Returns files and subdirectories sorted: directories first, then files, both alphabetical.
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<DirEntry> = Vec::new();

    let read_dir = std::fs::read_dir(dir).map_err(|e| format!("Cannot read directory: {}", e))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // Skip unreadable entries
        };
        let name = entry.file_name().to_string_lossy().to_string();

        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // Skip unreadable entries
        };

        entries.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // Sort: directories first, then files, both alphabetical (case insensitive)
    entries.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            return if a.is_dir { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater };
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });

    Ok(entries)
}

// ─── Workspace File Diff (since-folder-open snapshot) ───────────────────────
//
// Coffee CLI targets users who don't know git, and may open any folder —
// tmp dirs, AI-generated test projects, downloads. So we don't depend on
// `.git/`. Instead we snapshot the folder's text files when it opens, and
// later compare each file's line count + mtime to compute `+N -M` since
// the snapshot. AI-created files show as +line_count, edits show as
// real deltas, all without git installed or a repo on disk.

#[derive(Clone)]
struct FileSnapshot {
    mtime_nanos: u128,
    /// Per-line hash. Storing hashes (not content) keeps memory bounded
    /// (1000-line file = 8 KB) while letting us compute true `+N -M` deltas
    /// via multiset comparison instead of just net line-count change.
    line_hashes: Vec<u64>,
    /// Original file bytes — captured only on the baseline pass, only for
    /// text files under BASELINE_CONTENT_MAX_BYTES. Used by the right-side
    /// Diff panel to render a unified diff (current vs. session-start).
    /// `None` for files that exceeded the size cap.
    content: Option<Vec<u8>>,
}

/// Global per-file baseline — keyed by absolute (forward-slash) path,
/// shared across every tab and every project the user opens during this
/// Coffee CLI process. First-seen wins: if a file is already in the
/// map, a later `start_folder_snapshot` walk does NOT overwrite it.
/// This is the foundation of the app-lifecycle audit semantics — once
/// Coffee CLI has seen a file, it remembers the original content for
/// the rest of the process so reopening the project later doesn't
/// erase the audit trail. Process exit = full reset.
fn snapshots() -> &'static std::sync::Mutex<std::collections::HashMap<String, FileSnapshot>> {
    static FILE_SNAPSHOTS: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, FileSnapshot>>,
    > = std::sync::OnceLock::new();
    FILE_SNAPSHOTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Set of folders that have completed a baseline walk. Populated at
/// the end of `start_folder_snapshot`. `compute_folder_stats` checks
/// this before diffing — if a folder isn't in the set, returns empty
/// instead of falling through to "+totalLines -0" for every file the
/// walker hasn't reached yet. Without this, the race between a tab's
/// folder-change and the next polling tick produces a brief flood of
/// nonsense diff numbers; with it, ChangesBoard stays empty until the
/// baseline is genuinely ready.
fn baselined_folders() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    SET.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Directory names skipped during snapshot/diff walks. These tend to dominate
/// project folders (node_modules alone is 100k+ files) and are never user-
/// edited content — dragging them in wrecks both perf and noise level.
const STATS_SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt",
    ".venv", "venv", "__pycache__", ".idea", ".vscode", ".vs", ".cache",
    ".pytest_cache", ".mypy_cache", ".gradle", ".m2", "vendor",
];

const STATS_MAX_FILE_BYTES: u64 = 5_000_000;
const STATS_MAX_FILES: usize = 5000;
/// Per-file cap for storing baseline content (separate from STATS_MAX_FILE_BYTES,
/// which gates the hash-based stats path). Files between 1 MB and 5 MB still
/// get +N/-M badges but no diff view — keeps total memory ~1-10 MB per session
/// for typical workspaces while still covering 99% of source files.
const BASELINE_CONTENT_MAX_BYTES: u64 = 1_000_000;
/// Skip a file's badge if reported `+lines + -lines` exceeds this. Catches
/// CRLF/LF mismatches, path-canonicalization weirdness, and binary files
/// that slipped past `stats_is_text` from producing nonsense badges like
/// "+800,000 -750,000". Borrowed from Warp's diff-stats hardening
/// (issue #10193 — millions-of-lines diff on WSL repos).
const STATS_MAX_DIFF_LINES: u32 = 50_000;

/// Hash a single line. DefaultHasher is fast (~500 MB/s) and deterministic
/// within one process — process-restart resets snapshots anyway, so cross-run
/// stability isn't required.
fn stats_hash_line(line: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    line.hash(&mut h);
    h.finish()
}

/// Split `bytes` on '\n' and hash each line. Trailing-newline-less files:
/// the final fragment still counts as a line so the count matches what
/// users see in their editor.
fn stats_line_hashes(bytes: &[u8]) -> Vec<u64> {
    let mut hashes = Vec::new();
    let mut start = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            hashes.push(stats_hash_line(&bytes[start..i]));
            start = i + 1;
        }
    }
    if start < bytes.len() {
        hashes.push(stats_hash_line(&bytes[start..]));
    }
    hashes
}

/// Multiset diff: for each line hash, +1 in new, -1 in old. Sum positives
/// = additions, sum negatives = deletions. Doesn't care about line order
/// (so reordering = 0/0), which is the right "summary" semantics for
/// non-programmer users — "moved 10 lines around" shouldn't read as +10/-10.
fn stats_line_diff(old: &[u64], new: &[u64]) -> (u32, u32) {
    let mut counts: std::collections::HashMap<u64, i64> =
        std::collections::HashMap::with_capacity(old.len() + new.len());
    for h in old { *counts.entry(*h).or_insert(0) -= 1; }
    for h in new { *counts.entry(*h).or_insert(0) += 1; }
    let mut added: u64 = 0;
    let mut deleted: u64 = 0;
    for &delta in counts.values() {
        if delta > 0 { added += delta as u64; }
        else if delta < 0 { deleted += (-delta) as u64; }
    }
    (added.min(u32::MAX as u64) as u32, deleted.min(u32::MAX as u64) as u32)
}

fn stats_is_text(bytes: &[u8]) -> bool {
    // Same heuristic git uses: any null byte in first 8 KB → treat as binary.
    !bytes[..bytes.len().min(8192)].contains(&0u8)
}

fn stats_mtime_nanos(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// Canonical form of a path used as a snapshot map key. Forward-slashes
/// always; on Windows the drive letter is forced to uppercase. Reason:
/// `start_folder_snapshot` walks the dir the user picked (typically
/// uppercase `D:\…`) and writes keys like `D:/Coffee-CLI/…`, but
/// Claude Code's PostToolUse hook reports `tool_input.file_path` with
/// whatever casing the model chose — often lowercase `d:\…`. HashMap
/// is case-sensitive, so without this normalization every per-call
/// hook event misses the baseline and the audit list fills up with
/// bogus "+N -0" rows from the no-baseline fall-through branch.
pub(crate) fn normalize_path_key(path: &str) -> String {
    let s = path.replace('\\', "/");
    #[cfg(windows)]
    {
        let bytes = s.as_bytes();
        if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            let mut out = String::with_capacity(s.len());
            out.push((bytes[0] as char).to_ascii_uppercase());
            out.push_str(&s[1..]);
            return out;
        }
    }
    s
}

/// Recursive walk gathering FileSnapshot for every text file under `root`.
/// Stops once `max_files` are collected to bound work on accidentally-huge
/// trees (user opens home dir, etc.).
///
/// `baseline` lets the diff path skip disk reads entirely for files whose
/// mtime hasn't changed — we just clone the prior snapshot's hashes. On the
/// initial snapshot pass, pass `None` and every file gets read fresh.
/// Parse the project root's `.gitignore` once and extract bare directory
/// names to use as an additional skip list during `stats_walk`. Without
/// this, a project containing a large gitignored subdir (e.g. `reference/`
/// with 5985 files in Coffee CLI itself) drains STATS_MAX_FILES before the
/// walker reaches the actual source tree, leaving every file in `src-ui/`
/// without a baseline and showing nonsense "+totalLines -0" badges.
///
/// Deliberately NOT a real .gitignore implementation:
///   - reads only the root file, not nested .gitignores
///   - only bare names extracted; sub-path patterns (`src-tauri/target/`) skipped
///   - globs (`*.log`, `backup-*/`) skipped — would need glob matching
///   - negations (`!keep`) skipped
///   - over-skip is acceptable: a bare name like "ui" causes ANY dir named
///     "ui" anywhere in the tree to be skipped, but bare names in real
///     .gitignores are almost always unique project-root dirs.
fn gitignore_skip_dirs(root: &std::path::Path) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let bytes = match std::fs::read(root.join(".gitignore")) {
        Ok(b) => b,
        Err(_) => return out,
    };
    let text = String::from_utf8_lossy(&bytes);
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') { continue; }
        let stripped = line.trim_start_matches('/').trim_end_matches('/');
        if stripped.is_empty() || stripped.contains('/') { continue; }
        if stripped.contains(|c: char| c == '*' || c == '?' || c == '[') { continue; }
        out.insert(stripped.to_string());
    }
    out
}

fn stats_walk(
    root: &std::path::Path,
    files: &mut std::collections::HashMap<String, FileSnapshot>,
    baseline: Option<&std::collections::HashMap<String, FileSnapshot>>,
    max_files: usize,
    extra_skip: &std::collections::HashSet<String>,
) {
    if files.len() >= max_files { return; }
    let entries = match std::fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if files.len() >= max_files { return; }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let path = entry.path();
        // Reject symlinks before any further inspection: entry.metadata()
        // follows symlinks, so a symlinked dir would recurse INTO the link
        // target — escapes the workspace, hits filesystem cycles, or pulls
        // in massive system dirs (e.g. ~/.cache → /tmp). file_type() reads
        // the link's own type without following.
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() { continue; }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            if STATS_SKIP_DIRS.contains(&name_str.as_ref()) { continue; }
            if extra_skip.contains(name_str.as_ref()) { continue; }
            stats_walk(&path, files, baseline, max_files, extra_skip);
        } else if meta.is_file() {
            if meta.len() > STATS_MAX_FILE_BYTES { continue; }
            let key = normalize_path_key(&path.to_string_lossy());
            let mtime = stats_mtime_nanos(&meta);
            // Mtime-stable file with a baseline snapshot → reuse cached hashes.
            // Saves the read+hash on every fs-refresh tick for files the user
            // hasn't touched (i.e., 99% of the tree on most edits).
            if let Some(b) = baseline {
                if let Some(prev) = b.get(&key) {
                    if prev.mtime_nanos == mtime {
                        files.insert(key, prev.clone());
                        continue;
                    }
                }
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if !stats_is_text(&bytes) { continue; }
            // Store content only on the baseline pass (baseline.is_none()) and
            // only when file is small enough to be diff-renderable. The
            // current-state pass throws its FileSnapshot away after diffing,
            // so storing content there would just waste a clone.
            let content = if baseline.is_none() && meta.len() <= BASELINE_CONTENT_MAX_BYTES {
                Some(bytes.clone())
            } else {
                None
            };
            files.insert(key, FileSnapshot {
                mtime_nanos: mtime,
                line_hashes: stats_line_hashes(&bytes),
                content,
            });
        }
    }
}

/// Walk every text file under `path` and add files we've never seen
/// before to the global baseline. Files already in the baseline are
/// kept as-is — first-seen wins. This is the foundation of Coffee
/// CLI's app-lifecycle audit log: once a file's original content is
/// recorded, reopening the same project later (with a new tab, a
/// different tool, or after the original tab closed) preserves the
/// baseline so the audit trail isn't erased. Process exit clears
/// everything (the OnceLock map is dropped with the process).
#[tauri::command]
fn start_folder_snapshot(path: String) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() { return Err(format!("Not a directory: {}", path)); }
    let extra_skip = gitignore_skip_dirs(dir);
    let mut new_files = std::collections::HashMap::new();
    stats_walk(dir, &mut new_files, None, STATS_MAX_FILES, &extra_skip);
    {
        let mut map = snapshots().lock().map_err(|e| format!("lock: {}", e))?;
        for (key, snap) in new_files {
            // last-seen wins — always overwrite to reset baseline on tab reopen
            map.insert(key, snap);
        }
    }
    // Mark this folder as walked AFTER the snapshot insert completes,
    // so `compute_folder_stats` only sees the "ready" flag once the
    // baseline it'll diff against is actually populated.
    baselined_folders()
        .lock()
        .map_err(|e| format!("lock: {}", e))?
        .insert(normalize_path_key(&path));
    Ok(())
}

/// Clear the baseline snapshot for a folder. Called when a tab is closed
/// and no other tabs are using the same folder. Removes all file snapshots
/// under the given path to prevent memory leaks from accumulating snapshots
/// across multiple projects.
#[tauri::command]
fn clear_folder_snapshot(path: String) -> Result<(), String> {
    let mut normalized = normalize_path_key(&path);
    // Ensure trailing slash so "D:/project" doesn't match "D:/project2"
    if !normalized.ends_with('/') {
        normalized.push('/');
    }

    // Clear snapshots for all files under this folder
    {
        let mut map = snapshots().lock().map_err(|e| format!("lock: {}", e))?;
        map.retain(|k, _| !k.starts_with(&normalized));
    }

    // Clear the baselined marker (no trailing slash needed for exact match)
    {
        let normalized_folder = normalized.trim_end_matches('/');
        let mut set = baselined_folders()
            .lock()
            .map_err(|e| format!("lock: {}", e))?;
        set.remove(normalized_folder);
    }

    Ok(())
}

/// Read a text file from disk as UTF-8 string. `None` when the file doesn't
/// exist, can't be read, or fails the text-vs-binary heuristic. Pairs with
/// `get_baseline_content` to feed the right-side Diff panel: baseline +
/// current = both sides of the diff.
#[tauri::command]
fn read_text_file(path: String) -> Option<String> {
    let bytes = std::fs::read(&path).ok()?;
    if !stats_is_text(&bytes) { return None; }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Per-file diff entry returned by `compute_folder_stats`.
///
/// `path` is the absolute, normalized key (forward slashes, uppercase
/// drive on Windows) — i.e. the same shape baseline keys use, so the
/// frontend can correlate without re-normalizing.
#[derive(serde::Serialize, Clone, Debug)]
pub struct FileStats {
    pub path: String,
    pub added: u32,
    pub deleted: u32,
    pub mtime_ms: i64,
}

/// Walk `folder` and return one `FileStats` per file that drifts from
/// the global baseline. This is the sole data source for ChangesBoard
/// and Explorer +/- badges since v2.7.x — the per-tool hook-driven
/// audit path was removed in favor of this folder-level snapshot diff.
///
/// Tool-agnostic by construction: the diff is computed from the file
/// system state vs. baseline, so any modification (Claude, Codex,
/// OpenCode, an external editor, `git pull`, `npm install`) shows up
/// uniformly. No per-tool hook surface required.
///
/// Refresh strategy is decided by the frontend (typically on
/// `fs-refresh` and `agent-status=idle` events plus tab activation);
/// this function does no polling itself.
#[tauri::command]
pub(crate) fn compute_folder_stats(folder: String) -> Vec<FileStats> {
    let mut result = Vec::new();
    let dir = std::path::Path::new(&folder);
    if !dir.is_dir() { return result; }

    // Gate on baseline-completion. If `start_folder_snapshot` hasn't
    // finished walking this folder yet (race window right after a tab
    // change folder / new tab), the per-file map is half-populated —
    // returning [] is the honest answer rather than emitting bogus
    // "+totalLines -0" rows for files that simply haven't been walked.
    let normalized = normalize_path_key(&folder);
    if !baselined_folders()
        .lock()
        .map(|s| s.contains(&normalized))
        .unwrap_or(false)
    {
        return result;
    }

    let baseline = match snapshots().lock() {
        Ok(m) => m.clone(),
        Err(_) => return result,
    };

    let extra_skip = gitignore_skip_dirs(dir);
    let mut current = std::collections::HashMap::new();
    stats_walk(dir, &mut current, Some(&baseline), STATS_MAX_FILES, &extra_skip);

    for (abs_path, cur) in &current {
        let mtime_ms: i64 = (cur.mtime_nanos / 1_000_000).try_into().unwrap_or(i64::MAX);
        match baseline.get(abs_path) {
            Some(base) => {
                if base.mtime_nanos == cur.mtime_nanos { continue; }
                let (added, deleted) = stats_line_diff(&base.line_hashes, &cur.line_hashes);
                if added == 0 && deleted == 0 { continue; }
                if added.saturating_add(deleted) > STATS_MAX_DIFF_LINES { continue; }
                result.push(FileStats { path: abs_path.clone(), added, deleted, mtime_ms });
            }
            None => {
                let added = cur.line_hashes.len() as u32;
                if added > STATS_MAX_DIFF_LINES { continue; }
                result.push(FileStats { path: abs_path.clone(), added, deleted: 0, mtime_ms });
            }
        }
    }
    result
}

/// Return the file's first-seen content as UTF-8 string. `None` when:
///   - the file is not in the global baseline (Coffee CLI has never
///     observed this path during its lifetime)
///   - the file exceeded BASELINE_CONTENT_MAX_BYTES (no content stored,
///     just hashes for `+N -M` badges)
///   - the file was binary (skipped during stats_walk)
/// Lossy UTF-8: invalid bytes become U+FFFD so non-UTF8 source files
/// (latin-1, GBK, etc.) still render in the diff panel.
#[tauri::command]
fn get_baseline_content(path: String) -> Option<String> {
    let map = snapshots().lock().ok()?;
    let normalized = normalize_path_key(&path);
    let file = map.get(&normalized)?;
    let bytes = file.content.as_ref()?;
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// Save a base64-encoded clipboard image to a temp file.
/// Used by the Gambit compose window so pasted screenshots can be referenced
/// by path when forwarded to AI CLI agents (Claude Code, etc.).
///
/// Guards:
/// - Extension whitelisted to common raster formats
/// - Hard 25 MB size cap to prevent runaway base64 payloads filling the disk
/// - Filename uses pid + atomic counter so two concurrent paste calls (same
///   millisecond) can never collide and truncate each other's file
#[tauri::command]
fn save_clipboard_image(data_base64: String, extension: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    const MAX_BYTES: usize = 25 * 1024 * 1024; // 25 MB

    // Only allow common web image formats. Block anything that could
    // execute or exploit a path-traversal quirk in the extension.
    let ext = match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => extension,
        _ => return Err(format!("Unsupported image extension: {}", extension)),
    };

    let bytes = general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("base64 decode: {}", e))?;

    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "Image too large: {} bytes (max {})",
            bytes.len(),
            MAX_BYTES
        ));
    }

    let tmp_dir = std::env::temp_dir().join("coffee-cli").join("pasted-images");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("mkdir: {}", e))?;

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let path = tmp_dir.join(format!("clip-{}-{}-{}.{}", stamp, pid, seq, ext));

    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("create image file: {}", e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("write image bytes: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

// ─── File System Operations ───────────────────────────────────────────────────

/// Open the native file explorer and highlight / reveal the given path.
#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer /select, highlights the item in its parent folder.
        // The frontend normalizes paths to forward slashes, but explorer.exe
        // requires backslashes — forward slashes cause it to silently open Desktop.
        let win_path = path.replace('/', "\\");
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&win_path)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let p = std::path::Path::new(&path);
        std::process::Command::new("open")
            .arg("-R") // Reveal in Finder
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let p = std::path::Path::new(&path);
        // Open the parent directory; most Linux file managers don't support select
        let dir = if p.is_dir() { p.to_path_buf() } else { p.parent().unwrap_or(p).to_path_buf() };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {e}"))?;
    }
    Ok(())
}

/// Validate that a path is safe to operate on:
/// - Canonicalizes the path (resolves `..` and symlinks)
/// - Rejects paths with fewer than 3 components (drive root, OS dirs, etc.)
fn validate_fs_path(path: &str) -> Result<std::path::PathBuf, String> {
    let canonical = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("Invalid path: {e}"))?;
    // Require at least 3 components, e.g. C:\Users\foo or /home/user
    // This blocks C:\, C:\Windows, /, /etc, /usr, etc.
    if canonical.components().count() < 3 {
        return Err("Operation rejected: path is too shallow (system-level directory)".to_string());
    }
    Ok(canonical)
}

/// Delete a file or directory permanently (no recycle bin).
#[tauri::command]
fn fs_delete(path: String) -> Result<(), String> {
    let p = validate_fs_path(&path)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("Delete failed: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("Delete failed: {e}"))
    }
}

/// Rename / move a path to a new name within the same parent directory.
#[tauri::command]
fn fs_rename(path: String, new_name: String) -> Result<(), String> {
    let src = validate_fs_path(&path)?;
    let dest = src.parent()
        .ok_or_else(|| "No parent directory".to_string())?
        .join(&new_name);
    std::fs::rename(&src, dest).map_err(|e| format!("Rename failed: {e}"))
}

/// Paste (copy or move) a file/directory into a target directory.
/// `action` is either "copy" or "cut".
#[tauri::command]
fn fs_paste(action: String, src_path: String, target_dir: String) -> Result<(), String> {
    let src = validate_fs_path(&src_path)?;
    // target_dir may not exist yet for copy — validate its parent instead
    let target_canonical = std::path::Path::new(&target_dir)
        .canonicalize()
        .map_err(|e| format!("Invalid target directory: {e}"))?;
    if target_canonical.components().count() < 3 {
        return Err("Operation rejected: target is a system-level directory".to_string());
    }
    let file_name = src.file_name().ok_or("Invalid source path")?;
    let dest = target_canonical.join(file_name);

    match action.as_str() {
        "cut" => {
            std::fs::rename(&src, &dest).map_err(|e| format!("Move failed: {e}"))
        }
        "copy" => {
            if src.is_dir() {
                copy_dir_all(&src, &dest).map_err(|e| format!("Copy dir failed: {e}"))
            } else {
                std::fs::copy(&src, &dest).map(|_| ()).map_err(|e| format!("Copy failed: {e}"))
            }
        }
        _ => Err(format!("Unknown action: {action}")),
    }
}

/// Recursively copy a directory and all its contents.
fn copy_dir_all(src: &std::path::Path, dest: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

// ─── Tier Terminal API ────────────────────────────────────────────────────────

/// `sentinel_enabled` (multi-agent only): when false, the pane runs its
/// CLI in hands-free mode but with NO peer awareness — no `coffee-cli`
/// MCP server, no cross-pane protocol prompt, no `send_to_pane` /
/// `list_panes` / `whoami` tools. When true, those wirings come back
/// (the historical pre-v1.10 behaviour). Ignored outside multi-agent
/// panes. Defaults to false so non-sentinel panes don't auto-chat.
#[tauri::command]
async fn tier_terminal_start(
    session_id: String,
    tool: Option<String>,
    tool_data: Option<String>,
    cols: u16,
    rows: u16,
    theme_mode: Option<String>,
    locale: Option<String>,
    cwd: Option<String>,
    sentinel_enabled: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sentinel_enabled = sentinel_enabled.unwrap_or(false);
    // ── Per-pane MCP wiring for multi-agent panes ────────────────────
    // For each multi-agent pane (session id like "tab-X::pane-N")
    // running Claude, Codex, or Gemini, spawn an MCP server with that
    // pane's identity baked in and prepare per-pane CLI artifacts:
    //   - Claude: `--mcp-config <pane>/claude-mcp.json` + `--append-system-prompt`
    //   - Codex:  `-c mcp_servers.coffee-cli.url='...'` + `-c experimental_instructions_file='<pane>/inst.md'`
    //   - Gemini: `--extensions coffee-pane-<sanitized>` (stub in `~/.gemini/extensions/`
    //             linking to the real manifest in OS temp)
    // Across all three, `whoami()` returns the deterministic pane id,
    // `list_panes()` marks `is_self: true` on the matching row, and
    // dispatched text auto-prefixes with `[From <pane>]`. No global
    // config injection, no workspace files written, no env var that
    // would redirect the CLI's HOME and break auth.
    //
    // For other tools (qwen, hermes, openclaw, opencode, …) this stays
    // a no-op — their multi-agent participation is just "be a regular
    // PTY the user can read"; they don't get a per-pane MCP server.
    let mut pane_paths: Option<crate::mcp_injector::PaneConfigPaths> = None;
    {
        let in_multi_agent = session_id.contains("::pane-");
        // Sentinel Protocol gates peer-awareness wiring — without it, panes
        // share a workspace but stay otherwise unaware of each other (no
        // MCP server, no protocol prompt, no `send_to_pane` tool). Hands-
        // free flags like `--dangerously-skip-permissions` are NOT gated
        // here; they belong to multi-agent mode unconditionally so all
        // four panes still run without manual approval clicks.
        let pane_cli_kind = match tool.as_deref() {
            Some(k @ ("claude" | "codex" | "gemini" | "opencode"))
                if in_multi_agent && sentinel_enabled => Some(k),
            _ => None,
        };
        if let Some(kind) = pane_cli_kind {
            let endpoint = ensure_pane_mcp_running(&state, &session_id).await?;
            let protocol = crate::multi_agent_protocol::build_pane_system_prompt(&session_id);
            match crate::mcp_injector::prepare_pane_config_dir(
                &session_id,
                kind,
                &endpoint,
                &protocol,
            ) {
                Ok(paths) => pane_paths = Some(paths),
                Err(e) => log::warn!(
                    "[mcp] per-pane config dir for {} ({}) failed: {} \
                     — pane will run without coffee-cli MCP wiring",
                    session_id, kind, e
                ),
            }
        }
    }

    // Offload the whole spawn sequence to a blocking thread so the Tauri
    // command dispatcher returns immediately. Without this, Windows was
    // paying ~cmd.exe boot + Defender AV scan + Node startup on the command
    // thread, stalling every other IPC call (resize, theme, terminal I/O)
    // until the spawn returned. Running in the terminal directly avoids
    // this because no IPC layer is involved — the shell forks directly.
    let terminal_session = state.terminal_session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tier_terminal_start_blocking(
            session_id, tool, tool_data, cols, rows,
            theme_mode, locale, cwd, app, terminal_session,
            pane_paths,
        )
    })
    .await
    .map_err(|e| format!("Spawn task join failed: {e}"))?
}

fn tier_terminal_start_blocking(
    session_id: String,
    tool: Option<String>,
    tool_data: Option<String>,
    cols: u16,
    rows: u16,
    theme_mode: Option<String>,
    locale: Option<String>,
    cwd: Option<String>,
    app: tauri::AppHandle,
    terminal_session: terminal::SharedSession,
    pane_paths: Option<crate::mcp_injector::PaneConfigPaths>,
) -> Result<(), String> {
    // CWD resolution order (first non-empty wins):
    //   1. cwd passed from the frontend (launchpad's folder picker / per-tab cwd)
    //   2. tool_config.default_cwd from ~/.coffee-cli/tools.json (WSL-type users
    //      who want a fixed launch dir regardless of launchpad selection)
    //   3. empty → spawn process inherits Coffee CLI's own cwd
    //
    // The launchpad picker dominates because it's the per-launch user choice;
    // tool_config.default_cwd is the always-on fallback for users who don't
    // want to pick each time (or whose launchpad-side path can't address the
    // tool's actual workspace, e.g. WSL).
    let frontend_cwd = cwd.unwrap_or_default();
    let dir = if !frontend_cwd.is_empty() {
        std::path::PathBuf::from(frontend_cwd)
    } else if let Some(name) = tool.as_deref() {
        let cfg_cwd = crate::tool_config::get(name).default_cwd;
        if cfg_cwd.is_empty() {
            std::path::PathBuf::default()
        } else {
            std::path::PathBuf::from(cfg_cwd)
        }
    } else {
        std::path::PathBuf::default()
    };

    // ── Multi-agent auto-approval ────────────────────────────────────────
    // Multi-agent pane session ids look like `${tabId}::pane-N`. When a
    // CLI spawns in such a pane it is being orchestrated by *another* CLI
    // via send_to_pane; a human isn't going to be there to click "Yes" on
    // every tool-use confirmation, so we boot each primary CLI with its
    // "skip permissions" flag so the full multi-agent workflow runs
    // hands-free. `enable_multi_agent_mode` also pre-sets Claude's
    // `bypassPermissionsModeAccepted` bit so the flag doesn't trip the
    // first-run Bypass Permissions warning screen.
    //
    // Independent-split pane ids use the `::split-N` prefix instead
    // (FourSplitGrid). Those panes are NOT orchestrated — the user is
    // watching each pane and approves tool calls themselves — and the
    // MCP injector has NOT run, so passing `--dangerously-skip-permissions`
    // to Claude there would hit the un-pre-accepted warning screen and
    // kill the process. Keep the flag off for split panes.
    //
    // This is a deliberate trust tradeoff: entering multi-agent mode
    // delegates authority to the controlling pane's LLM. Users who want
    // per-tool supervision should use independent split or single-terminal
    // mode.
    let in_multi_agent = session_id.contains("::pane-");

    // Multi-agent flag sets (claude / codex / gemini) carry per-pane
    // MCP wiring that depends on `pane_paths` and `session_id`, so
    // they live inline. `remote` and the fallback shell are not in
    // the registry — `remote` parses tool_data at runtime, the shell
    // is platform-derived.
    let registry_descriptor = tool.as_deref().and_then(crate::tools::find);
    let (cmd, args): (String, Vec<String>) = match (tool.as_deref(), registry_descriptor) {
        (Some(id), Some(descriptor)) => {
            let mut a: Vec<String> = descriptor
                .default_args
                .iter()
                .map(|s| s.to_string())
                .collect();
            if in_multi_agent {
                match id {
                    "claude" => {
                        // Let the agent use tools without human approval.
                        // MCP's list_panes / send_to_pane / read_pane /
                        // whoami give it pane discovery, dispatch, and
                        // self-identification.
                        a.push("--dangerously-skip-permissions".to_string());
                        // Per-pane MCP config: this Claude session points
                        // at its OWN MCP server (with `self_pane_id`
                        // baked in) so `whoami()` returns deterministic
                        // answers and `list_panes()` marks `is_self:
                        // true` on the matching row. Claude merges this
                        // on top of any user-managed `~/.claude.json`
                        // mcpServers entries.
                        if let Some(p) = pane_paths
                            .as_ref()
                            .and_then(|pp| pp.claude_mcp_config_path.as_ref())
                        {
                            a.push("--mcp-config".to_string());
                            a.push(p.display().to_string());
                            // Per-pane system prompt: bake the pane id
                            // and protocol cheat sheet into THIS Claude
                            // session's system prompt. Survives /clear
                            // and /compact. Replaces writing CLAUDE.md
                            // to the workspace, so multi-agent Claude
                            // users see ZERO files appear in their
                            // project directory. Only injected when
                            // sentinel is on (paired with the MCP
                            // config above) — without it the prompt
                            // would describe tools that aren't wired
                            // in, confusing the model.
                            a.push("--append-system-prompt".to_string());
                            a.push(crate::multi_agent_protocol::build_pane_system_prompt(
                                &session_id,
                            ));
                        }
                    }
                    "codex" => {
                        // Hands-free multi-agent: no human is present to
                        // click through confirmation dialogs (the
                        // originating pane's LLM dispatched this work
                        // via send_to_pane). The earlier conservative
                        // `-s workspace-write -a never` combo still
                        // surfaced sandbox-violation prompts for
                        // cross-workspace ops, login/trust dialogs, and
                        // first-run consent screens that block the
                        // PTY. Codex's own "skip everything" door is
                        // `--dangerously-bypass-approvals-and-sandbox` —
                        // the doc explicitly reads "Skip all
                        // confirmation prompts and execute commands
                        // without sandboxing." That's the right
                        // tradeoff for multi-agent mode: entering it
                        // already delegates trust to the controlling
                        // pane's LLM.
                        a.push("--dangerously-bypass-approvals-and-sandbox".to_string());
                        // Per-pane MCP wiring via Codex's `-c
                        // key=value` config override (it merges onto
                        // `~/.codex/config.toml` rather than replacing
                        // it, so user MCP entries / API keys / auth all
                        // stay live). Two pairs:
                        //   `mcp_servers.coffee-cli.url='<per-pane-url>'`
                        //   `experimental_instructions_file='<pane-temp>/inst.md'`
                        // The instructions file holds the multi-agent
                        // protocol body (same text Claude gets via
                        // --append-system-prompt) and Codex bakes it
                        // into the model's session context. Both the
                        // URL and instructions path are unique per
                        // pane, so 4× same-CLI panes still get
                        // distinct identity.
                        if let Some(extra) =
                            pane_paths.as_ref().map(|pp| pp.codex_extra_args.clone())
                        {
                            a.extend(extra);
                        }
                    }
                    "gemini" => {
                        // Gemini CLI's equivalent of Claude's
                        // --dangerously-skip-permissions. Observed live
                        // on 2026-04-23 (Gemini CLI v0.39.0): the
                        // boolean `--yolo` flag did NOT reliably persist
                        // into the interactive REPL's tool-confirmation
                        // layer — the REPL still prompted "Allow
                        // execution of [...]?" for every tool call,
                        // which defeats hands-free multi-agent
                        // dispatch. `--approval-mode yolo` is the
                        // explicit, documented setting form (see
                        // `gemini --help`) and holds for the entire
                        // REPL session. Preferred over the shorter
                        // `--yolo` for exactly this reason.
                        a.push("--approval-mode".to_string());
                        a.push("yolo".to_string());
                        // Per-pane extension: Gemini reads
                        //   ~/.gemini/extensions/coffee-pane-<sanitized>/
                        // which our injector populated with link
                        // metadata pointing at the real manifest in OS
                        // temp. Loading this extension MERGES
                        // `mcpServers.coffee-cli` (with the per-pane
                        // HTTP URL) and the GEMINI.md context file into
                        // the running session — without touching the
                        // user's settings.json, OAuth creds, or
                        // workspace. The `--extensions <name>` flag
                        // takes the dir basename, NOT a path (Gemini
                        // CLI's loader is hard-coded to
                        // `~/.gemini/extensions/`).
                        if let Some(name) = pane_paths
                            .as_ref()
                            .and_then(|pp| pp.gemini_extension_name.clone())
                        {
                            a.push("--extensions".to_string());
                            a.push(name);
                        }
                    }
                    // Other registered tools have no multi-agent flag
                    // set today — they spawn with default_args inside
                    // a multi-agent pane just like outside one.
                    _ => {}
                }
            }
            (descriptor.binary_name.to_string(), a)
        }
        (Some("remote"), _) => {
            // Parse connection info from toolData JSON
            let data = tool_data.as_deref().unwrap_or("{}");
            let conn: serde_json::Value = serde_json::from_str(data)
                .map_err(|e| format!("Invalid remote connection data: {}", e))?;

            let protocol = conn["protocol"].as_str().unwrap_or("ssh");
            let host = conn["host"].as_str().unwrap_or("localhost");
            let port = conn["port"].as_u64().unwrap_or(if protocol == "ssh" { 22 } else { 7681 });
            let username = conn["username"].as_str().unwrap_or("root");
            let _password = conn["password"].as_str().unwrap_or("");

            if protocol == "ssh" {
                // Build SSH command — user will type password interactively in PTY
                let mut ssh_args = vec![
                    "-o".to_string(),
                    "StrictHostKeyChecking=no".to_string(),
                    "-p".to_string(),
                    port.to_string(),
                    format!("{}@{}", username, host),
                ];

                // If password is provided, try to use sshpass for auto-login
                // Otherwise user types password in terminal
                if !_password.is_empty() {
                    // Check if sshpass is available
                    let has_sshpass = if cfg!(target_os = "windows") {
                        false // sshpass not typically available on Windows
                    } else {
                        std::process::Command::new("which")
                            .arg("sshpass")
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()
                            .map(|s| s.success())
                            .unwrap_or(false)
                    };

                    if has_sshpass {
                        let mut full_args = vec![
                            "-p".to_string(),
                            _password.to_string(),
                            "ssh".to_string(),
                        ];
                        full_args.append(&mut ssh_args);
                        ("sshpass".to_string(), full_args)
                    } else {
                        ("ssh".to_string(), ssh_args)
                    }
                } else {
                    ("ssh".to_string(), ssh_args)
                }
            } else {
                // WebSocket protocol — not handled by PTY backend
                // Frontend will handle this via xterm.js AttachAddon directly
                return Err("ws".to_string());
            }
        },

        _ => if cfg!(target_os = "windows") {
            ("powershell.exe".to_string(), vec!["-NoExit".to_string()])
        } else {
            ("bash".to_string(), vec!["-l".to_string(), "-i".to_string()])
        }
    };

    // ── User-configurable launch overrides ─────────────────────────────────
    // ~/.coffee-cli/tools.json lets users say e.g. "always launch claude with
    // --dangerously-skip-permissions" or "run codex through `docker exec mybox`".
    // `remote` is excluded by design: its argv is protocol-derived from
    // runtime tool_data, not configurable.
    let (cmd, args) = match tool.as_deref() {
        Some(name) if name == "terminal" || crate::tools::find(name).is_some() => {
            let entry = crate::tool_config::get(name);
            let (cmd, mut args) = (cmd, args);
            let (cmd, args) = if let (Some(bin), prefix_args) =
                crate::tool_config::parse_command(&entry.command)
            {
                // User overrode the binary. Prepend any prefix args
                // (e.g. for `wsl claude`, prefix_args = ["claude"]) so
                // the original built-in args (--mcp-config / --append-
                // system-prompt / etc) follow them.
                let mut new_args = prefix_args;
                new_args.append(&mut args);
                (bin, new_args)
            } else {
                (cmd, args)
            };
            // Append user's extra_args after the built-in flags so
            // they take precedence (e.g. user can override --approval-
            // mode by adding their own at the end).
            let mut args = args;
            args.extend(entry.extra_args.iter().cloned());
            (cmd, args)
        }
        // Synthetic / pane-internal tools (remote / multi-agent)
        // intentionally bypass user override.
        _ => (cmd, args),
    };

    // If a session with the same ID already exists (e.g. restart-in-place),
    // forcefully kill and remove it before spawning a fresh one.
    {
        let mut lock = terminal_session.lock().unwrap();
        if let Some(old_session) = lock.remove(&session_id) {
            eprintln!("[Tier Terminal] Killing existing session {} for restart", session_id);
            let _ = old_session.kill_tx.send(());
            // Brief pause to let the OS reclaim PTY resources
            drop(lock);
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    // Determine the CWD to pass to the Agent:
    // 1. If workspace has an explicit dir (from open-folder or resume) → use it
    // 2. Otherwise default to user's home dir (matches most agents' default)
    let spawn_cwd = if dir.as_os_str().is_empty() || !dir.is_dir() {
        dirs::home_dir().map(|p| p.to_string_lossy().to_string())
    } else {
        Some(dir.to_string_lossy().to_string())
    };

    let tool_name = tool.clone();
    let actual_cwd = spawn_cwd.clone().unwrap_or_default();

    eprintln!("[Tier Terminal] Starting tool={:?}, cmd={}, args={:?}, cwd={:?}", tool, cmd, args, spawn_cwd);

    // Per-pane env overrides. OpenCode reads its MCP config from
    // `OPENCODE_CONFIG=<path>` (no equivalent CLI flag in 1.14), so the
    // per-pane wiring lands here rather than in the argv match above.
    // Other CLIs leave this empty.
    let mut extra_env: Vec<(String, String)> = Vec::new();
    if let Some(p) = pane_paths.as_ref().and_then(|pp| pp.opencode_config_path.as_ref()) {
        extra_env.push(("OPENCODE_CONFIG".to_string(), p.display().to_string()));
    }

    terminal::spawn(
        app.clone(),
        session_id.clone(),
        terminal_session.clone(),
        cmd,
        args,
        spawn_cwd,
        locale.clone().unwrap_or_else(|| "en".to_string()),
        cols,
        rows,
        tool_name.clone(),
        theme_mode,
        locale,
        extra_env,
    ).map_err(|e| format!("Failed to spawn PTY: {}", e))?;

    // Emit the initial CWD to the frontend so the left panel can map immediately.
    // On Windows, cmd.exe does not emit OSC 7, and full-screen agents enter alt-screen
    // before any shell prompt appears. This one-time emit bridges the gap.
    if !actual_cwd.is_empty() {
        #[derive(serde::Serialize, Clone)]
        struct CwdPayload { id: String, cwd: String }
        let _ = app.emit("tier-terminal-cwd", CwdPayload {
            id: session_id,
            cwd: actual_cwd,
        });
    }

    Ok(())
}


#[tauri::command]
fn tier_terminal_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Step 1: grab Arc handles while holding the map lock (cheap clones, no IO)
    let (writer_arc, activity_arc) = {
        let map = state.terminal_session.lock().unwrap();
        match map.get(&session_id) {
            Some(s) => (s.writer_lock.clone(), s.activity.clone()),
            None => return Err(format!("No active terminal session for id: {}", session_id)),
        }
    };
    // Map lock released — other tabs can now proceed concurrently

    // Step 2: PTY write (syscall, may block under back-pressure)
    use std::io::Write;
    let mut w = writer_arc.lock().map_err(|e| format!("Writer lock poisoned: {}", e))?;
    w.write_all(data.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
    w.flush().map_err(|e| format!("Flush failed: {}", e))?;
    drop(w);

    // Step 3: Dual-signal — detect user prompt submission
    // Only trigger "working" when user presses Enter while agent is at prompt.
    // System-generated input (auto-skip) uses tier_terminal_raw_write instead.
    if data.contains('\r') || data.contains('\n') {
        if let Ok(mut act) = activity_arc.lock() {
            if act.last_status == "wait_input" {
                act.user_submitted_at = Some(std::time::Instant::now());
            }
        }
    }

    Ok(())
}

/// Raw write to PTY without triggering agent-status detection.
/// Used for system-generated input like auto-skip Enter for Claude trust prompt.
#[tauri::command]
fn tier_terminal_raw_write(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Grab writer Arc, release map lock before PTY I/O
    let writer_arc = {
        let map = state.terminal_session.lock().unwrap();
        match map.get(&session_id) {
            Some(s) => s.writer_lock.clone(),
            None => return Err(format!("No active terminal session for id: {}", session_id)),
        }
    };

    use std::io::Write;
    let mut w = writer_arc.lock().map_err(|e| format!("Writer lock poisoned: {}", e))?;
    w.write_all(data.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
    w.flush().map_err(|e| format!("Flush failed: {}", e))?;
    Ok(())
}

/// Toggle the global background-throttle flag. Called by the frontend
/// from a `document.visibilitychange` listener: when the OS hides the
/// Coffee CLI window (other Space, app switched away, minimized) we
/// widen every per-session worker's polling cadence so the app drops
/// to near-zero CPU instead of running its full foreground loop.
#[tauri::command]
fn set_background_mode(hidden: bool) {
    crate::terminal::BACKGROUND_MODE
        .store(hidden, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn tier_terminal_kill(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let map = state.terminal_session.lock().unwrap();
    if let Some(session) = map.get(&session_id) {
        let _ = session.kill_tx.send(());
    }
    Ok(())
}

#[tauri::command]
fn tier_terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use portable_pty::PtySize;
    let map = state.terminal_session.lock().unwrap();
    if let Some(session) = map.get(&session_id) {
        let master_guard = session._master.lock().unwrap();
        if let Some(ref master) = *master_guard {
            let size = PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            };
            master.resize(size).map_err(|e| format!("Resize failed: {}", e))?;
        }
    }
    Ok(())
}

// ─── Session Resume API ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct SavedSession {
    id: String,
    name: String,
    tool: String,
    cwd: String,
    session_token: Option<String>,
    saved_at: String,
    file_path: Option<String>,
    turn_count: Option<u32>,
}

fn sessions_file_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".coffee-cli");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("sessions.json")
}

/// XML-style tags injected into the user message stream by Claude /
/// Codex / Gemini when integrated with an IDE or shell. These are
/// not things the user typed — filtering them out of the history
/// title extractor keeps the sidebar readable (no more
/// "<ide_opened_file>The user opened the..." or "# AGENTS.md
/// instructions for ..." cards).
const SYSTEM_INJECTION_TAGS: &[&str] = &[
    "<environment_context>",
    "<ide_opened_file>",
    "<ide_closed_file>",
    "<ide_selection>",
    "<system-reminder>",
    "<command-message>",
    "<command-name>",
    // Codex injects the contents of `AGENTS.md` (project) and any
    // pre-v1.5 Coffee-CLI workspace pointer as a synthetic user
    // message at session start.
    "# AGENTS.md",
    // Gemini equivalent for `GEMINI.md`.
    "# GEMINI.md",
];

fn is_system_injected(text: &str) -> bool {
    let t = text.trim();
    SYSTEM_INJECTION_TAGS.iter().any(|tag| t.starts_with(tag))
}

fn parse_agent_jsonl(file_path: &std::path::Path, tool_name: &str) -> Option<SavedSession> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id = file_path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = String::new();
    let mut updated_at = String::new();
    let mut title = String::new();
    let mut total_messages = 0;

    for line in reader.lines().map_while(Result::ok) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(s) = value.get("sessionId").and_then(|v| v.as_str()) {
                if !s.is_empty() { session_id = s.to_string(); }
            }
            if let Some(c) = value.get("cwd").and_then(|v| v.as_str()) {
                if cwd.is_empty() && !c.is_empty() { cwd = c.to_string(); }
            }
            let mut maybe_msg_obj = value.get("message").and_then(|v| v.as_object());
            if maybe_msg_obj.is_none() {
                if let Some(payload) = value.get("payload").and_then(|v| v.as_object()) {
                    if let Some(ptype) = payload.get("type").and_then(|v| v.as_str()) {
                        if ptype == "message" {
                            maybe_msg_obj = Some(payload);
                        }
                    }
                }
            }

            if let Some(msg_obj) = maybe_msg_obj {
                if let Some(role) = msg_obj.get("role").and_then(|v| v.as_str()) {
                    if role == "user" || role == "assistant" {
                        total_messages += 1;
                    }
                    if role == "user" && title.is_empty() {
                        if let Some(content_str) = msg_obj.get("content").and_then(|v| v.as_str()) {
                            // Skip whole-message IDE/system injections so the
                            // next real user line becomes the title.
                            if !is_system_injected(content_str) {
                                let content_safe = content_str.replace('\n', " ");
                                let mut chars = content_safe.chars();
                                let t: String = chars.by_ref().take(40).collect();
                                title = if chars.next().is_some() { format!("{}...", t) } else { t };
                            }
                        } else if let Some(content_arr) = msg_obj.get("content").and_then(|v| v.as_array()) {
                            // Extract text from object array
                            for block in content_arr {
                                if let Some(t) = block.get("type").and_then(|v| v.as_str()) {
                                    if t == "text" || t == "input_text" {
                                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                            if is_system_injected(text) {
                                                continue; // skip IDE / system-injected prompts
                                            }
                                            let safe_text = text.replace('\n', " ");
                                            let mut chars = safe_text.chars();
                                            let chunk: String = chars.by_ref().take(40).collect();
                                            title = if chars.next().is_some() { format!("{}...", chunk) } else { chunk };
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    // Fallback: If cwd is still empty, derive it from the parent project folder name
    // e.g., "D--Coffee-Code" -> "D:\Coffee-Code", "C--Users--..." -> "C:\Users\..."
    if cwd.is_empty() {
        if let Some(parent) = file_path.parent() {
            if let Some(folder_name) = parent.file_name().and_then(|n| n.to_str()) {
                if folder_name.contains("--") {
                    let mut parts = folder_name.split("--");
                    if let Some(drive) = parts.next() {
                        let rest: Vec<&str> = parts.collect();
                        let decoded_path = if cfg!(target_os = "windows") {
                            format!("{}:\\{}", drive, rest.join("\\"))
                        } else {
                            format!("/{}/{}", drive, rest.join("/"))
                        };
                        cwd = decoded_path;
                    }
                }
            }
        }
    }
    let turn_count = if total_messages > 0 { std::cmp::max(1, (total_messages + 1) / 2) } else { 0 };
    
    // Fallback date from file metadata
    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                updated_at = dur.as_millis().to_string();
            }
        }
    }

    if title.is_empty() {
        let mut chars = tool_name.chars();
        let cap_name = match chars.next() {
            None => String::new(),
            Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        };
        title = format!("{} Session", cap_name);
    }

    Some(SavedSession {
        id: format!("{}_native_{}", tool_name, session_id),
        name: title,
        tool: tool_name.to_string(),
        cwd,
        session_token: Some(session_id),
        saved_at: updated_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

/// Codex CLI sessions live at
/// `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`.
/// Schema:
///   - first row: `{type: "session_meta", payload: {id, cwd, originator: "codex-tui", ...}}`
///   - subsequent rows: `{type: "response_item", payload: {type: "message", role, content: [{type: "input_text", text}]}}`
///     (also `user_message`, `event_msg`, `turn_context`, etc. — we ignore the non-message ones)
fn parse_codex_session_jsonl(file_path: &std::path::Path) -> Option<SavedSession> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id = file_path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = String::new();
    let mut updated_at = String::new();
    let mut title = String::new();
    let mut total_messages = 0;

    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let row_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = match value.get("payload") {
            Some(p) => p,
            None => continue,
        };

        // Session meta: pull id + cwd off the first row.
        if row_type == "session_meta" {
            if let Some(id) = payload.get("id").and_then(|v| v.as_str()) {
                if !id.is_empty() {
                    session_id = id.to_string();
                }
            }
            if let Some(c) = payload.get("cwd").and_then(|v| v.as_str()) {
                if !c.is_empty() {
                    cwd = c.to_string();
                }
            }
            continue;
        }

        // Message rows: response_item with payload.type=message, or
        // the dedicated user_message row type. Both wrap content as
        // an array of `{type: "input_text", text}` blocks.
        let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let is_msg = (row_type == "response_item" && payload_type == "message")
            || row_type == "user_message";
        if !is_msg {
            continue;
        }
        let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("");
        if role == "user" || role == "assistant" {
            total_messages += 1;
        }
        if !title.is_empty() || role != "user" {
            continue;
        }
        let Some(content_arr) = payload.get("content").and_then(|v| v.as_array()) else {
            continue;
        };
        for block in content_arr {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if block_type != "input_text" && block_type != "text" {
                continue;
            }
            let Some(text) = block.get("text").and_then(|v| v.as_str()) else {
                continue;
            };
            if is_system_injected(text) {
                continue; // skip AGENTS.md / environment_context wrappers
            }
            let safe = text.replace('\n', " ");
            let mut chars = safe.chars();
            let chunk: String = chars.by_ref().take(40).collect();
            title = if chars.next().is_some() { format!("{}...", chunk) } else { chunk };
            break;
        }
    }

    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                updated_at = dur.as_millis().to_string();
            }
        }
    }
    if title.is_empty() {
        title = "Codex Session".to_string();
    }
    let turn_count = if total_messages > 0 { std::cmp::max(1, (total_messages + 1) / 2) } else { 0 };

    Some(SavedSession {
        id: format!("codex_native_{}", session_id),
        name: title,
        tool: "codex".to_string(),
        cwd,
        session_token: Some(session_id),
        saved_at: updated_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

/// Gemini CLI sessions live at
/// `~/.gemini/tmp/<project-folder>/chats/session-<ts>-<hash>.jsonl`.
/// Schema:
///   - first row: `{sessionId, projectHash, startTime, lastUpdated, kind: "main"}`
///   - subsequent rows: `{id, timestamp, type: "user"|"gemini", content}`
///     where user content is `[{text}]` and gemini content is a string.
///   - interleaved `{$set: {lastUpdated}}` rows that we just skip.
///
/// `cwd` isn't recorded in the file. We resolve it from
/// `~/.gemini/projects.json` which maps absolute cwd → short folder
/// name, so we reverse-lookup short-name → cwd. Falls back to the
/// short folder name itself if the projects.json mapping is missing.
fn parse_gemini_session_jsonl(
    file_path: &std::path::Path,
    project_short_to_cwd: &std::collections::HashMap<String, String>,
) -> Option<SavedSession> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id = file_path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = String::new();
    let mut updated_at = String::new();
    let mut title = String::new();
    let mut total_messages = 0;

    // cwd resolution: file path is `.gemini/tmp/<short>/chats/<file>.jsonl`,
    // so the short project name is the parent's parent dir name.
    if let Some(short) = file_path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
    {
        if let Some(real) = project_short_to_cwd.get(short) {
            cwd = real.clone();
        } else {
            cwd = short.to_string(); // last-resort: show the short folder
        }
    }

    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(s) = value.get("sessionId").and_then(|v| v.as_str()) {
            if !s.is_empty() {
                session_id = s.to_string();
            }
        }
        let row_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if row_type == "user" || row_type == "gemini" {
            total_messages += 1;
        }
        if !title.is_empty() || row_type != "user" {
            continue;
        }
        let Some(content_arr) = value.get("content").and_then(|v| v.as_array()) else {
            continue;
        };
        for block in content_arr {
            let Some(text) = block.get("text").and_then(|v| v.as_str()) else {
                continue;
            };
            if is_system_injected(text) {
                continue;
            }
            let safe = text.replace('\n', " ");
            let mut chars = safe.chars();
            let chunk: String = chars.by_ref().take(40).collect();
            title = if chars.next().is_some() { format!("{}...", chunk) } else { chunk };
            break;
        }
    }

    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                updated_at = dur.as_millis().to_string();
            }
        }
    }
    if title.is_empty() {
        title = "Gemini Session".to_string();
    }
    let turn_count = if total_messages > 0 { std::cmp::max(1, (total_messages + 1) / 2) } else { 0 };

    Some(SavedSession {
        id: format!("gemini_native_{}", session_id),
        name: title,
        tool: "gemini".to_string(),
        cwd,
        session_token: Some(session_id),
        saved_at: updated_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

/// Parse a Qwen Code session jsonl. Layout:
///   `~/.qwen/projects/<sanitized-cwd>/chats/<session>.jsonl`
/// Each line: `{uuid, type: 'user'|'assistant'|'tool_result'|'system',
///   sessionId, cwd, timestamp, message: {role, parts: [{text|functionCall|...}]}}`
/// Differences vs. Gemini CLI's format (these two are cousins, not twins):
///   • cwd is on every row (no separate projects.json reverse map needed)
///   • text lives in `message.parts[].text`, not the top-level `content[]`
///   • assistant rows use `type: 'assistant'`, not `'gemini'`
fn parse_qwen_session_jsonl(file_path: &std::path::Path) -> Option<SavedSession> {
    use std::io::BufRead;
    let file = std::fs::File::open(file_path).ok()?;
    let reader = std::io::BufReader::new(file);

    let mut session_id = file_path.file_stem()?.to_string_lossy().to_string();
    let mut cwd = String::new();
    let mut updated_at = String::new();
    let mut title = String::new();
    let mut total_messages = 0;

    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(s) = value.get("sessionId").and_then(|v| v.as_str()) {
            if !s.is_empty() {
                session_id = s.to_string();
            }
        }
        if cwd.is_empty() {
            if let Some(c) = value.get("cwd").and_then(|v| v.as_str()) {
                cwd = c.to_string();
            }
        }
        let row_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if row_type == "user" || row_type == "assistant" {
            total_messages += 1;
        }
        // Title: first user message, first 40 chars.
        if !title.is_empty() || row_type != "user" {
            continue;
        }
        let Some(parts) = value
            .get("message")
            .and_then(|m| m.get("parts"))
            .and_then(|v| v.as_array())
        else {
            continue;
        };
        for block in parts {
            let Some(text) = block.get("text").and_then(|v| v.as_str()) else {
                continue;
            };
            if is_system_injected(text) {
                continue;
            }
            let safe = text.replace('\n', " ");
            let mut chars = safe.chars();
            let chunk: String = chars.by_ref().take(40).collect();
            title = if chars.next().is_some() { format!("{}...", chunk) } else { chunk };
            break;
        }
    }

    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                updated_at = dur.as_millis().to_string();
            }
        }
    }
    if title.is_empty() {
        title = "Qwen Session".to_string();
    }
    let turn_count = if total_messages > 0 { std::cmp::max(1, (total_messages + 1) / 2) } else { 0 };

    Some(SavedSession {
        id: format!("qwen_native_{}", session_id),
        name: title,
        tool: "qwen".to_string(),
        cwd,
        session_token: Some(session_id),
        saved_at: updated_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

/// Read `~/.gemini/projects.json` and build a reverse map
/// `short_folder_name → real_cwd`. Used by
/// `parse_gemini_session_jsonl` because the per-session jsonl file
/// doesn't include the cwd anywhere — it only encodes which project
/// folder it belongs to via the parent dir name.
///
/// Returns an empty map on any error (missing file, invalid JSON,
/// permission denied) — Gemini sessions just fall back to using
/// the short folder name as the cwd display.
fn load_gemini_project_map() -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    let mut map = HashMap::new();
    let Some(home) = dirs::home_dir() else { return map };
    let path = home.join(".gemini").join("projects.json");
    let Ok(text) = std::fs::read_to_string(path) else { return map };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return map };
    let Some(projects) = value.get("projects").and_then(|v| v.as_object()) else { return map };
    for (cwd, short) in projects {
        if let Some(short_str) = short.as_str() {
            map.insert(short_str.to_string(), cwd.clone());
        }
    }
    map
}

#[tauri::command]
fn read_native_session(file_path: String) -> Result<String, String> {
    let path = std::path::Path::new(&file_path);

    // Only allow .jsonl / .json files
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext != "jsonl" && ext != "json" {
        return Err("Only .jsonl and .json files are allowed".to_string());
    }

    // Canonicalize to resolve any `..` or symlink traversal
    let canonical_raw = path.canonicalize().map_err(|e| format!("Invalid path: {e}"))?;
    // On Windows, canonicalize() prepends \\?\ (UNC extended-length prefix).
    // Strip it so that starts_with() comparisons against plain home-dir paths work.
    #[cfg(windows)]
    let canonical = {
        let s = canonical_raw.to_string_lossy();
        if s.starts_with(r"\\?\") {
            std::path::PathBuf::from(s[4..].to_string())
        } else {
            canonical_raw
        }
    };
    #[cfg(not(windows))]
    let canonical = canonical_raw;

    // Must reside under a known agent data directory.
    //
    // Built-in defaults cover the standard install locations; any
    // additional paths the user configured via tool_config.history_path
    // are also allowed (otherwise the WSL-redirected scanner would find
    // sessions but reading them back would 403). Path canonicalization
    // already resolved symlinks, so this is a pure prefix check.
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    let mut allowed: Vec<std::path::PathBuf> = vec![
        home.join(".claude"),
        // Hermes Agent's data root is platform-dependent
        // (`%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` elsewhere, or
        // `$HERMES_HOME` if set). See tools/hermes.rs::hermes_home.
        crate::tools::hermes::hermes_home(),
        home.join(".codex").join("sessions"),
        home.join(".gemini").join("tmp"),
        home.join(".qwen").join("projects"),
        home.join(".local").join("share").join("opencode"),
        home.join(".openclaw").join("agents"),
    ];
    for tool in ["claude", "hermes", "codex", "gemini", "qwen", "opencode", "openclaw"] {
        let cfg = crate::tool_config::get(tool).history_path;
        if !cfg.is_empty() {
            allowed.push(crate::tool_config::expand_path(&cfg));
        }
    }
    if !allowed.iter().any(|prefix| canonical.starts_with(prefix)) {
        return Err("Access denied: path is outside allowed agent data directories".to_string());
    }

    std::fs::read_to_string(&canonical).map_err(|e| e.to_string())
}

// ─── OpenCode Session Reader ─────────────────────────────────────────────────
//
// OpenCode stores chat history in two layouts depending on version:
//   • SQLite (current):  `~/.local/share/opencode/opencode.db`
//                         tables `message` (role + metadata) + `part`
//                         (text/tool blocks), joined by message_id.
//   • JSON  (legacy):    `~/.local/share/opencode/storage/message/<sid>/*.json`
//                         one file per message, content blocks inline.
//
// Both are normalized to the same JSONL shape that ChatReader.tsx already
// understands (Claude Code shape with `{message:{role, content[]}}`):
//
//   {"message": {"role": "user", "content": [{"type":"text","text":"..."}]}}
//   {"message": {"role": "assistant", "content": [{"type":"text","text":"..."}]}}
//
// One line per message. Tool calls / patches / snapshots are dropped — the
// preview only cares about the text the user/assistant said. If the session
// has zero text turns, returns an empty string and the frontend renders the
// "no readable conversation records" empty state.

fn read_opencode_sqlite_session(
    db_path: &std::path::Path,
    session_id: &str,
) -> Result<String, String> {
    use rusqlite::Connection;
    let conn = Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open opencode.db: {e}"))?;

    // 1. Pull all messages for the session (ordered by creation time).
    let mut msg_stmt = conn
        .prepare(
            "SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created ASC",
        )
        .map_err(|e| format!("prepare message query: {e}"))?;
    let msg_rows = msg_stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query messages: {e}"))?;

    // (message_id, role)
    let mut messages: Vec<(String, String)> = Vec::new();
    for row in msg_rows.flatten() {
        let (id, data) = row;
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
            if let Some(role) = parsed.get("role").and_then(|v| v.as_str()) {
                messages.push((id, role.to_string()));
            }
        }
    }
    if messages.is_empty() {
        return Ok(String::new());
    }

    // 2. Pull all parts for the session in one query, then bucket by message_id.
    let mut part_stmt = conn
        .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ?1 ORDER BY time_created ASC",
        )
        .map_err(|e| format!("prepare part query: {e}"))?;
    let part_rows = part_stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query parts: {e}"))?;

    use std::collections::HashMap;
    let mut parts_by_msg: HashMap<String, Vec<String>> = HashMap::new();
    for row in part_rows.flatten() {
        let (msg_id, data) = row;
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&data) {
            // Only TextPart contributes to the preview transcript.
            if parsed.get("type").and_then(|v| v.as_str()) == Some("text") {
                if let Some(text) = parsed.get("text").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        parts_by_msg.entry(msg_id).or_default().push(text.to_string());
                    }
                }
            }
        }
    }

    // 3. Emit one JSONL row per message, joining its text parts.
    let mut out = String::new();
    for (msg_id, role) in messages {
        let text_blocks: Vec<serde_json::Value> = parts_by_msg
            .get(&msg_id)
            .map(|v| {
                v.iter()
                    .map(|t| {
                        serde_json::json!({ "type": "text", "text": t })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if text_blocks.is_empty() {
            continue;
        }
        let line = serde_json::json!({
            "message": { "role": role, "content": text_blocks }
        });
        out.push_str(&line.to_string());
        out.push('\n');
    }
    Ok(out)
}

fn read_opencode_json_dir(message_dir: &std::path::Path) -> Result<String, String> {
    // Legacy layout: storage/message/<sid>/<msg-id>.json. Each file is the
    // full message info JSON (including role + content blocks). Sort by file
    // name so chronological order of message creation is preserved (OpenCode
    // file names are time-prefixed IDs).
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(message_dir)
        .map_err(|e| format!("read message dir: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();

    let mut out = String::new();
    for path in files {
        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let role = match parsed.get("role").and_then(|v| v.as_str()) {
            Some(r) => r.to_string(),
            None => continue,
        };
        let mut text_blocks: Vec<serde_json::Value> = Vec::new();
        if let Some(arr) = parsed.get("content").and_then(|v| v.as_array()) {
            for block in arr {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            text_blocks.push(serde_json::json!({ "type": "text", "text": text }));
                        }
                    }
                }
            }
        }
        if text_blocks.is_empty() {
            continue;
        }
        let line = serde_json::json!({
            "message": { "role": role, "content": text_blocks }
        });
        out.push_str(&line.to_string());
        out.push('\n');
    }
    Ok(out)
}

#[tauri::command]
fn read_opencode_session(session_id: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;

    // Honor user-configured OpenCode history path from
    // ~/.coffee-cli/tools.json (same source the listing pass uses
    // at line ~2129). Falls through to the platform default
    // ~/.local/share/opencode when the user hasn't customized it.
    let opencode_root = crate::tool_config::history_path_for(
        "opencode",
        home.join(".local").join("share").join("opencode"),
    );

    // Prefer current SQLite layout.
    let db_path = opencode_root.join("opencode.db");
    if db_path.is_file() {
        return read_opencode_sqlite_session(&db_path, &session_id);
    }

    // Fall back to legacy JSON layout. Message dir name == session_id.
    // Canonicalize and assert containment so a crafted session_id like
    // "../../../etc" can't escape the OpenCode storage root. SQLite
    // branch above is safe because session_id is only bound as a SQL
    // parameter, not joined into a path.
    let message_root = opencode_root.join("storage").join("message");
    let message_dir = message_root.join(&session_id);
    if message_dir.is_dir() {
        let canonical_dir = std::fs::canonicalize(&message_dir)
            .map_err(|e| format!("canonicalize session dir: {e}"))?;
        let canonical_root = std::fs::canonicalize(&message_root)
            .unwrap_or(message_root.clone());
        if !canonical_dir.starts_with(&canonical_root) {
            return Err("Access denied: session_id escapes OpenCode storage root".to_string());
        }
        return read_opencode_json_dir(&canonical_dir);
    }

    Err("OpenCode session storage not found".to_string())
}

fn collect_jsonl_paths_with_mtime(
    dir: std::path::PathBuf,
    depth: u8,
    tool: &'static str,
    out: &mut Vec<(std::time::SystemTime, std::path::PathBuf, &'static str)>,
) {
    if depth == 0 || !dir.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    let mtime = entry.metadata().ok()
                        .and_then(|m| m.modified().ok())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    out.push((mtime, path, tool));
                }
            } else if path.is_dir() {
                collect_jsonl_paths_with_mtime(path, depth - 1, tool, out);
            }
        }
    }
}

fn parse_hermes_json(file_path: &std::path::Path) -> Option<SavedSession> {
    let content = std::fs::read_to_string(file_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;

    let session_id = value.get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| file_path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown"))
        .to_string();

    let mut title = String::new();
    let mut total_messages = 0u32;

    if let Some(messages) = value.get("messages").and_then(|v| v.as_array()) {
        for msg in messages {
            let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("");
            if role == "user" || role == "assistant" {
                total_messages += 1;
            }
            if role == "user" && title.is_empty() {
                if let Some(content_str) = msg.get("content").and_then(|v| v.as_str()) {
                    let s = content_str.trim();
                    // Skip internal/system messages
                    if !s.is_empty() && !s.starts_with("[Note:") && !s.starts_with("[CONTEXT") {
                        let safe = s.replace('\n', " ");
                        let mut chars = safe.chars();
                        let t: String = chars.by_ref().take(40).collect();
                        title = if chars.next().is_some() { format!("{}...", t) } else { t };
                    }
                }
            }
        }
    }

    if title.is_empty() {
        title = "Hermes Agent Session".to_string();
    }

    let turn_count = if total_messages > 0 { std::cmp::max(1, (total_messages + 1) / 2) } else { 0 };

    let mut saved_at = String::new();
    if let Ok(meta) = std::fs::metadata(file_path) {
        if let Ok(mod_time) = meta.modified() {
            if let Ok(dur) = mod_time.duration_since(std::time::SystemTime::UNIX_EPOCH) {
                saved_at = dur.as_millis().to_string();
            }
        }
    }

    Some(SavedSession {
        id: format!("hermes_native_{}", session_id),
        name: title,
        tool: "hermes".to_string(),
        cwd: String::new(),
        session_token: Some(session_id),
        saved_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

fn parse_opencode_session(file_path: &std::path::Path, message_dir: &std::path::Path) -> Option<SavedSession> {
    let content = std::fs::read_to_string(file_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;

    let id = value.get("id").and_then(|v| v.as_str())?.to_string();
    let title = value.get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("OpenCode Session")
        .to_string();
    let cwd = value.get("directory").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let saved_at = value.get("time")
        .and_then(|t| t.get("updated"))
        .and_then(|v| v.as_u64())
        .map(|ms| ms.to_string())
        .unwrap_or_default();

    // Count message files to estimate turn count
    let msg_dir = message_dir.join(&id);
    let msg_count = if msg_dir.is_dir() {
        std::fs::read_dir(&msg_dir)
            .map(|entries| entries.flatten().filter(|e| e.path().is_file()).count() as u32)
            .unwrap_or(0)
    } else {
        0
    };
    let turn_count = std::cmp::max(1, msg_count / 2);

    Some(SavedSession {
        id: format!("opencode_native_{}", id),
        name: title,
        tool: "opencode".to_string(),
        cwd,
        session_token: Some(id),
        saved_at,
        file_path: Some(file_path.to_string_lossy().into_owned()),
        turn_count: Some(turn_count),
    })
}

fn find_opencode_sessions(base_dir: std::path::PathBuf, result: &mut Vec<SavedSession>) {
    // Prefer SQLite DB (current OpenCode format) over legacy JSON files
    let db_path = base_dir.join("opencode.db");
    if db_path.is_file() {
        find_opencode_sessions_sqlite(&db_path, result);
        return;
    }

    // Fallback: legacy JSON layout — storage/session/<project-id>/ses_*.json
    let session_dir = base_dir.join("storage").join("session");
    let message_dir = base_dir.join("storage").join("message");
    if !session_dir.is_dir() { return; }

    if let Ok(projects) = std::fs::read_dir(&session_dir) {
        for project_entry in projects.flatten() {
            let project_path = project_entry.path();
            if !project_path.is_dir() { continue; }
            if let Ok(sessions) = std::fs::read_dir(&project_path) {
                for session_entry in sessions.flatten() {
                    let path = session_entry.path();
                    if !path.is_file() { continue; }
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with("ses_") && name.ends_with(".json") {
                        if let Some(session) = parse_opencode_session(&path, &message_dir) {
                            result.push(session);
                        }
                    }
                }
            }
        }
    }
}

fn find_opencode_sessions_sqlite(db_path: &std::path::Path, result: &mut Vec<SavedSession>) {
    let conn = match rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return,
    };

    // Query sessions with message count, skip archived ones
    let query = "SELECT s.id, s.title, s.directory, s.time_updated, \
                 COUNT(m.id) as msg_count \
                 FROM session s \
                 LEFT JOIN message m ON m.session_id = s.id \
                 WHERE s.time_archived IS NULL \
                 GROUP BY s.id \
                 ORDER BY s.time_updated DESC \
                 LIMIT 30";

    let mut stmt = match conn.prepare(query) {
        Ok(s) => s,
        Err(_) => return,
    };

    let sessions_iter = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let title: String = row.get::<_, Option<String>>(1)
            .unwrap_or(None)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "OpenCode Session".to_string());
        let directory: String = row.get::<_, Option<String>>(2)
            .unwrap_or(None)
            .unwrap_or_default();
        let time_updated: i64 = row.get(3).unwrap_or(0);
        let msg_count: i64 = row.get(4).unwrap_or(0);
        let turn_count = std::cmp::max(1, msg_count / 2) as u32;

        Ok(SavedSession {
            id: format!("opencode_native_{}", id),
            name: title,
            tool: "opencode".to_string(),
            cwd: directory,
            session_token: Some(id),
            saved_at: time_updated.to_string(),
            // Surface the shared SQLite DB path so the ChatReader copy-path
            // button has a target for OpenCode sessions too. Granularity
            // mismatch is OpenCode's own design choice — they bundle every
            // session into ONE opencode.db (vs Claude/Codex/Gemini/Qwen/Hermes
            // jsonl-per-session) — so we expose the path that exists rather
            // than hide the button. Users who paste it into a file manager
            // land on the actual artifact that holds this conversation,
            // even if it also holds the others. Doesn't affect the read
            // path (ChatReader gates on tool==opencode + session_token,
            // not on file_path, so readOpencodeSession still owns parsing).
            file_path: Some(db_path.to_string_lossy().into_owned()),
            turn_count: Some(turn_count),
        })
    });

    if let Ok(iter) = sessions_iter {
        for session in iter.flatten() {
            result.push(session);
        }
    }
}

fn collect_hermes_paths_with_mtime(
    dir: std::path::PathBuf,
    out: &mut Vec<(std::time::SystemTime, std::path::PathBuf, &'static str)>,
) {
    if !dir.is_dir() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Only session_*.json files — skip request_dump_* and state.db
            if name.starts_with("session_") && name.ends_with(".json") {
                let mtime = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                out.push((mtime, path, "hermes"));
            }
        }
    }
}

#[tauri::command]
async fn get_native_history() -> Result<Vec<SavedSession>, String> {
    // Async command + spawn_blocking so the file I/O runs on a dedicated
    // blocking thread pool and never blocks the Tauri command dispatcher.
    // Other IPC calls (resize, theme switches, etc.) stay responsive while
    // history is being scanned on app startup.
    tauri::async_runtime::spawn_blocking(load_native_history_blocking)
        .await
        .map_err(|e| format!("History task join failed: {e}"))?
}

fn load_native_history_blocking() -> Result<Vec<SavedSession>, String> {
    // Cap history to the N most recent entries. Keeps UI responsive when users
    // have hundreds of sessions — parsing a full jsonl/json file is expensive,
    // so we pre-select candidates by file mtime and only parse the top N.
    // 200 covers months of daily use; the frontend renders 30 at a time and
    // pages in the rest progressively as the user scrolls (HistoryBoard).
    const HISTORY_LIMIT: usize = 200;

    let mut file_candidates: Vec<(std::time::SystemTime, std::path::PathBuf, &'static str)> = Vec::new();
    let mut result: Vec<SavedSession> = Vec::new();

    let home = dirs::home_dir();
    if let Some(home) = home.as_ref() {
        collect_registry_history_candidates(home, &mut file_candidates);
    }

    // Sort candidates by mtime desc and parse only the newest HISTORY_LIMIT.
    file_candidates.sort_by(|a, b| b.0.cmp(&a.0));
    file_candidates.truncate(HISTORY_LIMIT);

    // Lazy-load the Gemini project-hash → cwd map only if we actually
    // have Gemini candidates (file I/O isn't free).
    let gemini_project_map = if file_candidates.iter().any(|(_, _, t)| *t == "gemini") {
        load_gemini_project_map()
    } else {
        std::collections::HashMap::new()
    };

    for (_, path, tool) in &file_candidates {
        let parsed = match *tool {
            "hermes" => parse_hermes_json(path),
            "codex"  => parse_codex_session_jsonl(path),
            "gemini" => parse_gemini_session_jsonl(path, &gemini_project_map),
            "qwen"   => parse_qwen_session_jsonl(path),
            other    => parse_agent_jsonl(path, other),
        };
        if let Some(session) = parsed {
            result.push(session);
        }
    }

    // OpenCode second pass — SQLite is cheap (query already caps rows).
    // Bypasses the mtime pipeline: find_opencode_sessions pushes finished
    // SavedSession objects directly.
    if let Some(home) = home.as_ref() {
        if let Some(opencode_dir) = opencode_root(home) {
            find_opencode_sessions(opencode_dir, &mut result);
        }
    }

    result.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    result.truncate(HISTORY_LIMIT);
    Ok(result)
}

/// Walk every registry tool with a JSONL/Hermes history shape and
/// push (mtime, path, tool_id) tuples into `out`. OpenCodeMixed is
/// skipped — its SQLite scanner runs as a second pass and emits
/// finished SavedSession objects, not file candidates.
///
/// Shared between `load_native_history_blocking` (History board)
/// and `load_message_heatmap_blocking` (contribution heatmap) so
/// the two surfaces can't drift.
fn collect_registry_history_candidates(
    home: &std::path::Path,
    out: &mut Vec<(std::time::SystemTime, std::path::PathBuf, &'static str)>,
) {
    for tool in crate::tools::TOOLS {
        let Some(shape) = tool.history_shape.as_ref() else { continue };
        let scan_dir =
            crate::tool_config::history_path_for(tool.id, shape.join_under(home));
        match shape {
            crate::tools::HistoryShape::HermesFlatJson => {
                collect_hermes_paths_with_mtime(scan_dir, out);
            }
            crate::tools::HistoryShape::OpenCodeMixed { .. } => {}
            _ => {
                if let Some(depth) = shape.jsonl_depth() {
                    collect_jsonl_paths_with_mtime(scan_dir, depth, tool.id, out);
                }
            }
        }
    }
}

/// Resolve OpenCode's session-store root (under the user's home,
/// or wherever `~/.coffee-cli/tools.json` redirects). `None` if
/// OpenCode isn't in the registry — should never happen in
/// practice, but keeps the call sites total.
fn opencode_root(home: &std::path::Path) -> Option<std::path::PathBuf> {
    let tool = crate::tools::find("opencode")?;
    let shape = tool.history_shape.as_ref()?;
    Some(crate::tool_config::history_path_for(tool.id, shape.join_under(home)))
}

// Contribution-heatmap entry: one tuple per session file (mtime + message
// count). The frontend buckets these into local-day boxes — doing the
// bucketing here would require a TZ database (chrono/time) just to honour
// the user's local midnight, which isn't worth the dependency.
#[derive(serde::Serialize)]
struct HeatmapEntry {
    ts: i64,    // file mtime, seconds since UNIX_EPOCH
    count: u32, // approximate message count for the session
}

/// Persisted line-count cache for the heatmap scanner. One JSON file at
/// `~/.coffee-cli/cache/heatmap-counts.json`. Best-effort across the board:
/// any I/O / parse error returns an empty map and the scanner just recounts
/// from disk. The mtime stored is seconds-since-epoch (matches the i64 `ts`
/// field on HeatmapEntry) so a single integer comparison decides cache hit.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CachedCount {
    mtime: i64,
    count: u32,
}

fn count_cache_path() -> Option<std::path::PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".coffee-cli").join("cache").join("heatmap-counts.json"))
}

fn read_count_cache() -> std::collections::HashMap<String, CachedCount> {
    let Some(path) = count_cache_path() else { return std::collections::HashMap::new(); };
    let Ok(content) = std::fs::read_to_string(&path) else { return std::collections::HashMap::new(); };
    serde_json::from_str(&content).unwrap_or_default()
}

fn write_count_cache(map: &std::collections::HashMap<String, CachedCount>) {
    let Some(path) = count_cache_path() else { return; };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(map) {
        let _ = std::fs::write(&path, json);
    }
}

#[tauri::command]
async fn get_message_heatmap() -> Result<Vec<HeatmapEntry>, String> {
    tauri::async_runtime::spawn_blocking(load_message_heatmap_blocking)
        .await
        .map_err(|e| format!("Heatmap task join failed: {e}"))?
}

fn load_message_heatmap_blocking() -> Result<Vec<HeatmapEntry>, String> {
    // Frontend renders a 26-week (≈ 6-month) grid. ~210 days back so
    // the leftmost column is always populated even mid-week.
    const LOOKBACK_SECS: u64 = 210 * 86400;
    let now = std::time::SystemTime::now();
    let cutoff = now.checked_sub(std::time::Duration::from_secs(LOOKBACK_SECS))
        .unwrap_or(std::time::UNIX_EPOCH);

    let mut candidates: Vec<(std::time::SystemTime, std::path::PathBuf, &'static str)> = Vec::new();

    let home = dirs::home_dir();
    if let Some(home) = home.as_ref() {
        collect_registry_history_candidates(home, &mut candidates);
    }

    // Per-file count cache. Heatmap re-scans every app launch and counts
    // every jsonl line in every history file — for users with hundreds of
    // past sessions that's the bulk of the cold-start I/O. Past sessions are
    // immutable: once a session file's mtime is stable, its line count is
    // stable forever. So we cache `path -> (mtime, count)` to disk, and on
    // subsequent runs skip the open+read for any file whose mtime is
    // unchanged from the cached entry. Cache corruption / partial writes
    // are safe — `read_count_cache` returns empty on any error and we just
    // recount once.
    let mut count_cache = read_count_cache();
    let mut cache_dirty = false;
    let mut keep_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    let mut out: Vec<HeatmapEntry> = Vec::with_capacity(candidates.len());
    for (mtime, path, tool) in &candidates {
        if *mtime < cutoff { continue; }
        let ts = mtime
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let path_key = path.to_string_lossy().into_owned();
        keep_paths.insert(path_key.clone());

        // Cache hit only when mtime exactly matches — any append to the jsonl
        // bumps mtime and forces a recount.
        let count = if let Some(entry) = count_cache.get(&path_key) {
            if entry.mtime == ts {
                entry.count
            } else {
                let c = if *tool == "hermes" {
                    count_hermes_messages(path)
                } else {
                    count_jsonl_message_lines(path)
                };
                count_cache.insert(path_key.clone(), CachedCount { mtime: ts, count: c });
                cache_dirty = true;
                c
            }
        } else {
            let c = if *tool == "hermes" {
                count_hermes_messages(path)
            } else {
                count_jsonl_message_lines(path)
            };
            count_cache.insert(path_key.clone(), CachedCount { mtime: ts, count: c });
            cache_dirty = true;
            c
        };
        if count > 0 {
            out.push(HeatmapEntry { ts, count });
        }
    }

    // Prune stale entries (files that disappeared from disk). Non-jsonl tools
    // like opencode use a separate cache layer below, so don't get caught
    // here; the heuristic is "if we didn't see the path this scan, drop it".
    let before = count_cache.len();
    count_cache.retain(|k, _| keep_paths.contains(k));
    if count_cache.len() != before { cache_dirty = true; }
    if cache_dirty { write_count_cache(&count_cache); }

    // OpenCode SQLite second pass — one GROUP BY query gets the same
    // (timestamp, message_count) tuples the heatmap consumes, pre-
    // filtered by the same 210-day cutoff so we don't read rows the
    // frontend would discard anyway.
    if let Some(home) = home.as_ref() {
        if let Some(db_path) = opencode_root(home).map(|r| r.join("opencode.db")) {
            if db_path.is_file() {
                let cutoff_secs = cutoff
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                collect_opencode_heatmap_entries(&db_path, cutoff_secs, &mut out);
            }
        }
    }

    Ok(out)
}

/// One-shot SQLite scan of opencode's session table for heatmap entries.
/// Mirrors `find_opencode_sessions_sqlite` (same WHERE/GROUP BY shape) so
/// any schema drift in opencode.db hits both queries together. Best-effort:
/// any error (locked DB, schema change, file missing) silently yields zero
/// rows — opencode just doesn't appear in the heatmap that session.
fn collect_opencode_heatmap_entries(
    db_path: &std::path::Path,
    cutoff_secs: i64,
    out: &mut Vec<HeatmapEntry>,
) {
    let conn = match rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return,
    };
    // opencode.db stores time_updated in MILLISECONDS since epoch (verified
    // via parse_opencode_session at L2006 which treats the JSON `time.updated`
    // as `u64 ms`). Heatmap entries downstream are seconds (frontend does
    // `new Date(ts * 1000)` in ContributionHeatmap.tsx). So compare and emit
    // in millis at the SQL boundary, then divide by 1000 once.
    let cutoff_ms: i64 = cutoff_secs.saturating_mul(1000);
    let query = "SELECT s.time_updated, COUNT(m.id) AS msg_count \
                 FROM session s \
                 LEFT JOIN message m ON m.session_id = s.id \
                 WHERE s.time_archived IS NULL AND s.time_updated >= ?1 \
                 GROUP BY s.id";
    let mut stmt = match conn.prepare(query) {
        Ok(s) => s,
        Err(_) => return,
    };
    let rows = match stmt.query_map([cutoff_ms], |row| {
        let ts_ms: i64 = row.get(0)?;
        let count: i64 = row.get(1)?;
        Ok((ts_ms, count))
    }) {
        Ok(r) => r,
        Err(_) => return,
    };
    for row in rows.flatten() {
        let (ts_ms, count) = row;
        if count > 0 {
            out.push(HeatmapEntry { ts: ts_ms / 1000, count: count as u32 });
        }
    }
}

// Cheap line-count for JSONL session files. We treat every non-empty
// line as one "turn" — including system / tool-result rows. The heatmap
// is an activity proxy, not a strict user-message tally, so over-
// counting tool spam is fine (more chatter = darker square).
fn count_jsonl_message_lines(path: &std::path::Path) -> u32 {
    use std::io::{BufRead, BufReader, Read};
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return 0,
    };
    // Cap reading at ~32 MiB to keep one runaway session from stalling
    // the whole heatmap scan. 32 MiB of JSONL is ~50k+ lines — already
    // off the chart visually, so capping doesn't affect the bucket.
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    let mut br = BufReader::new(file.take(MAX_BYTES));
    let mut buf: Vec<u8> = Vec::with_capacity(512);
    let mut count = 0u32;
    while let Ok(n) = br.read_until(b'\n', &mut buf) {
        if n == 0 { break; }
        if buf.iter().any(|&b| !b.is_ascii_whitespace()) {
            count = count.saturating_add(1);
        }
        buf.clear();
    }
    count
}

// Hermes stores one big JSON file per session, not JSONL — so line-
// counting wouldn't work. Approximate message count by counting
// "role" key occurrences. Cheaper than a full serde_json parse.
fn count_hermes_messages(path: &std::path::Path) -> u32 {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return 0,
    };
    let needle = b"\"role\"";
    let mut count = 0u32;
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            count = count.saturating_add(1);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    count
}

#[tauri::command]
fn tier_terminal_resume(
    session_id: String,
    saved_session_id: String, // The UUID of the new terminal tab
    tool: String,
    session_token: String,
    cols: u16,
    rows: u16,
    cwd: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {

    let preset = terminal::find_preset(&tool)
        .ok_or_else(|| format!("Unknown tool: {}", tool))?;
    let resume_program = preset.resume_program
        .ok_or_else(|| format!("Tool '{}' does not support resume", tool))?;

    // Validate session_token against the tool's token_format.
    // Prevents flag injection: "uuid --dangerously-skip-permissions" would fail this check.
    if let Some(fmt) = preset.token_format {
        let re = regex::Regex::new(fmt)
            .map_err(|e| format!("Invalid token format pattern: {e}"))?;
        if !re.is_match(&session_token) {
            return Err(format!("Invalid session token format for tool '{}'", tool));
        }
    }

    // Build args without string interpolation: token is always a separate element,
    // never concatenated into a command string that gets split by whitespace.
    let program = resume_program.to_string();
    let mut args: Vec<String> = preset.resume_args_before.iter().map(|s| s.to_string()).collect();
    args.push(session_token.clone());
    args.extend(preset.resume_args_after.iter().map(|s| s.to_string()));

    let actual_cwd = cwd.clone();
    let emit_session_id = saved_session_id.clone();

    terminal::spawn(
        app.clone(),
        saved_session_id,
        state.terminal_session.clone(),
        program,
        args,
        Some(cwd),
        "en".to_string(),
        cols,
        rows,
        Some(tool),
        None, // theme_mode: resume sessions use default detection
        None, // locale: resume sessions use env detection
        Vec::new(), // extra_env: single-terminal resume — no per-pane MCP wiring
    ).map_err(|e| format!("Failed to resume: {}", e))?;

    // Emit CWD so the left panel maps the resumed session's directory
    if !actual_cwd.is_empty() {
        #[derive(serde::Serialize, Clone)]
        struct CwdPayload { id: String, cwd: String }
        let _ = app.emit("tier-terminal-cwd", CwdPayload {
            id: emit_session_id,
            cwd: actual_cwd,
        });
    }

    // Remove from saved sessions file
    let path = sessions_file_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(mut saved) = serde_json::from_str::<Vec<SavedSession>>(&content) {
                saved.retain(|s| s.id != session_id);
                let _ = std::fs::write(&path, serde_json::to_string_pretty(&saved).unwrap_or_default());
            }
        }
    }

    Ok(())
}



// ─── Task Board Persistence ──────────────────────────────────────────────────

fn tasks_file_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".coffee-cli");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("tasks.json")
}

#[tauri::command]
fn load_tasks() -> Result<String, String> {
    let path = tasks_file_path();
    if path.exists() {
        std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read tasks: {}", e))
    } else {
        Ok("[]".to_string())
    }
}

#[tauri::command]
fn save_tasks(data: String, app: tauri::AppHandle) -> Result<(), String> {
    // Validate JSON before writing to disk — guards against corrupted broadcasts
    serde_json::from_str::<serde_json::Value>(&data)
        .map_err(|e| format!("Invalid task data (not valid JSON): {e}"))?;
    let path = tasks_file_path();
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to save tasks: {}", e))?;
    // Notify all windows so other instances can reload
    let _ = app.emit("tasks-changed", &data);
    Ok(())
}

// ─── Credential Store (OS Keychain) ──────────────────────────────────────────

const KEYRING_SERVICE: &str = "coffee-cli";

/// Persist a remote password in the OS keychain (Windows Credential Manager /
/// macOS Keychain / Linux Secret Service). The key is `username@host`.
#[tauri::command]
fn save_password(host: String, username: String, password: String) -> Result<(), String> {
    let account = format!("{}@{}", username, host);
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .set_password(&password)
        .map_err(|e| e.to_string())
}

/// Load a previously saved password from the OS keychain.
/// Returns `None` if no entry exists (user hasn't saved one yet).
#[tauri::command]
fn load_password(host: String, username: String) -> Result<Option<String>, String> {
    let account = format!("{}@{}", username, host);
    match keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .get_password()
    {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Remove a saved password from the OS keychain (e.g. user clicked "forget").
#[tauri::command]
fn delete_password(host: String, username: String) -> Result<(), String> {
    let account = format!("{}@{}", username, host);
    match keyring::Entry::new(KEYRING_SERVICE, &account)
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already gone, not an error
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn check_network_port(host: String, port: u16) -> Result<bool, String> {
    use std::time::Duration;
    use std::net::ToSocketAddrs;
    
    let target = format!("{}:{}", host, port);
    
    // Run blocking network check in a dedicated blocking task to avoid stalling the async runtime
    let reachable = tauri::async_runtime::spawn_blocking(move || {
        match target.to_socket_addrs() {
            Ok(mut addrs) => {
                if let Some(addr) = addrs.next() {
                    std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(3)).is_ok()
                } else {
                    false
                }
            },
            Err(_) => false
        }
    }).await.unwrap_or(false);

    Ok(reachable)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    Ok(())
}

// ─── Hyper-Agent: global anonymous MCP server for external orchestrators ──
//
// Started lazily when the user opens the Hyper-Agent tab. `self_pane_id=None`,
// so list_panes / send_to_pane bypass tab-scope filtering — exactly the
// "super admin can see and dispatch to every pane" semantics the product
// needs. Uses a port persisted across launches so OpenClaw / Hermes Agent
// configs stay stable (no config-file thrash → no gateway restart loops).
//
// Tauri commands here are all the frontend needs to know about.

fn hyper_agent_port_path() -> Option<std::path::PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".coffee-cli")
            .join("hyper-agent-port"),
    )
}

fn read_persisted_hyper_agent_port() -> Option<u16> {
    let path = hyper_agent_port_path()?;
    let s = std::fs::read_to_string(&path).ok()?;
    s.trim().parse::<u16>().ok().filter(|p| *p != 0)
}

fn write_persisted_hyper_agent_port(port: u16) -> std::io::Result<()> {
    let Some(path) = hyper_agent_port_path() else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, port.to_string())
}

#[derive(Serialize, Clone)]
pub struct HyperAgentStatus {
    pub endpoint: crate::mcp_server::McpEndpoint,
}

#[tauri::command]
pub async fn start_hyper_agent_server(
    state: tauri::State<'_, AppState>,
) -> Result<HyperAgentStatus, String> {
    {
        let guard = state.hyper_agent_endpoint.lock().await;
        if let Some(ep) = guard.as_ref() {
            // Server already up — return cached endpoint. Registrations
            // were performed on first spawn; re-running on every panel
            // mount would just be a no-op file read after the [unchanged]
            // short-circuit. If a user hand-deletes their OpenClaw config,
            // restarting Coffee-CLI re-seeds it.
            return Ok(HyperAgentStatus { endpoint: ep.clone() });
        }
    }
    let _spawn_guard = state.mcp_spawn_lock.lock().await;
    {
        let guard = state.hyper_agent_endpoint.lock().await;
        if let Some(ep) = guard.as_ref() {
            return Ok(HyperAgentStatus { endpoint: ep.clone() });
        }
    }

    let panes = std::sync::Arc::new(
        crate::mcp_server::PaneStore::new(state.terminal_session.clone()),
    );
    let persisted = read_persisted_hyper_agent_port();
    let preferred = persisted.unwrap_or(0);
    let endpoint = crate::mcp_server::spawn_with_port(panes, None, preferred)
        .await
        .map_err(|e| format!("hyper-agent mcp spawn: {}", e))?;
    log::info!(
        "[hyper-agent] anonymous server up at {} (preferred port {})",
        endpoint.url, preferred
    );
    // Only write the port file when we got the port we asked for, or when
    // there was no file to begin with. If preferred was non-zero and we
    // ended up on a different port, another Coffee-CLI instance owns that
    // port — don't clobber its file (would force its OpenClaw config out
    // of sync on the next config-watch tick).
    let should_write = match persisted {
        None => true,
        Some(p) => p == endpoint.port,
    };
    if should_write {
        let _ = write_persisted_hyper_agent_port(endpoint.port);
    }
    *state.hyper_agent_endpoint.lock().await = Some(endpoint.clone());

    let _ = crate::agent_mcp_config::register_all(&endpoint.url).await;
    Ok(HyperAgentStatus { endpoint })
}

#[tauri::command]
pub async fn get_hyper_agent_endpoint(
    state: tauri::State<'_, AppState>,
) -> Result<Option<crate::mcp_server::McpEndpoint>, String> {
    Ok(state.hyper_agent_endpoint.lock().await.clone())
}

// ─── Per-tool launch overrides (~/.coffee-cli/tools.json) ────────────────
//
// Lets users tell Coffee CLI things like "my claude is at
// `/opt/coffee/bin/claude`, not on PATH" or "always launch claude with
// --dangerously-skip-permissions". Replaces what the abandoned in-app
// installer was supposed to handle by auto-detection — defer to the
// user, who knows their machine better than we do.

#[tauri::command]
pub fn get_tool_config(tool: String) -> crate::tool_config::ToolConfigEntry {
    crate::tool_config::get(&tool)
}

#[tauri::command]
pub fn get_all_tool_configs() -> crate::tool_config::ToolConfig {
    crate::tool_config::load()
}

#[tauri::command]
pub fn set_tool_config(
    tool: String,
    entry: crate::tool_config::ToolConfigEntry,
) -> Result<(), String> {
    crate::tool_config::set(&tool, entry).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct MultiAgentModeReport {
    pub ok: bool,
    pub warnings: Vec<String>,
}

/// Snapshot the current MCP topology to `~/.coffee-cli/mcp-state.json`
/// so the `coffee-cli mcp-status` subcommand can read it from any
/// terminal. Called after every successful per-pane MCP spawn. The
/// `anonymous` slot in the manifest is always `None` post-v1.5: every
/// multi-agent pane has its own `self_pane_id`-baked server now, no
/// shared anonymous endpoint exists.
async fn refresh_mcp_state_manifest(state: &AppState) {
    let panes_snapshot = state.pane_mcp_endpoints.lock().await.clone();
    crate::mcp_server::write_state_manifest(None, &panes_snapshot);
}

/// Lazy-spawn a PER-PANE MCP server bound to a specific pane id, on
/// its own dedicated port. Idempotent — if a server already exists
/// for `pane_id`, returns it. This is how a multi-agent Claude Code
/// pane gets a unique MCP endpoint with its own identity baked in:
/// every call to its `whoami()` returns the same `pane_id`,
/// `list_panes` marks the matching row `is_self: true`, and
/// `send_to_pane` prefixes dispatched text with `[From <pane_id>]`.
///
/// Uses `mcp_spawn_lock` to serialize concurrent first-callers for
/// the same pane id so we never bind two listeners.
pub async fn ensure_pane_mcp_running(
    state: &AppState,
    pane_id: &str,
) -> Result<crate::mcp_server::McpEndpoint, String> {
    // Fast path — already spawned for this pane.
    {
        let guard = state.pane_mcp_endpoints.lock().await;
        if let Some(ep) = guard.get(pane_id) {
            return Ok(ep.clone());
        }
    }

    // Slow path — take the global spawn lock, double-check, then bind.
    let _spawn_guard = state.mcp_spawn_lock.lock().await;
    {
        let guard = state.pane_mcp_endpoints.lock().await;
        if let Some(ep) = guard.get(pane_id) {
            return Ok(ep.clone());
        }
    }

    let panes = std::sync::Arc::new(
        crate::mcp_server::PaneStore::new(state.terminal_session.clone()),
    );
    let endpoint = crate::mcp_server::spawn(panes, Some(pane_id.to_string()))
        .await
        .map_err(|e| format!("mcp spawn for {}: {}", pane_id, e))?;
    log::info!(
        "[mcp] per-pane server up at {} (pane={})",
        endpoint.url, pane_id
    );

    state
        .pane_mcp_endpoints
        .lock()
        .await
        .insert(pane_id.to_string(), endpoint.clone());
    refresh_mcp_state_manifest(state).await;
    Ok(endpoint)
}

/// Enable multi-agent mode for the given workspace.
///
/// Post-v1.5 this is a thin handshake — per-pane MCP servers and
/// per-pane CLI artifacts (Claude `mcp.json` / Codex `instructions.md`
/// / Gemini extension stub) are all created lazily inside
/// `tier_terminal_start` when each pane spawns its CLI. No workspace
/// files are written, no global `~/.codex` / `~/.gemini` `mcp_servers`
/// blocks get injected, no env var redirects the CLI's HOME (so auth
/// stays live).
///
/// The frontend still calls this on tab mount as a structured place
/// for cross-cutting validation (workspace must exist, future license
/// gating, etc.) — kept around for that hook, not because it does any
/// heavy lifting today.
///
/// `_tools` and `_state` are kept in the signature for API
/// compatibility with the existing TS `commands.enableMultiAgentMode`
/// invocation; they're unused here.
#[tauri::command]
async fn enable_multi_agent_mode(
    workspace: String,
    _tools: Vec<String>,
    _state: tauri::State<'_, AppState>,
) -> Result<MultiAgentModeReport, String> {
    let ws = PathBuf::from(&workspace);
    if !ws.is_dir() {
        return Err(format!("workspace is not a directory: {}", workspace));
    }
    Ok(MultiAgentModeReport {
        ok: true,
        warnings: Vec::new(),
    })
}

/// Disable multi-agent mode for the given workspace.
///
/// Post-v1.5 this is a no-op for the workspace itself — multi-agent
/// mode no longer writes any workspace files or global config entries
/// to clean up here. Per-pane MCP servers and their temp artifacts
/// persist for the app's lifetime (they live under
/// `<temp>/coffee-cli/panes/` + `~/.gemini/extensions/coffee-pane-*`
/// and are pruned by `mcp_injector::prune_pane_artifacts()` at the
/// next launch and at app shutdown).
///
/// `_workspace` is kept in the signature for API compat with the TS
/// caller in `MultiAgentGrid.tsx`'s unmount cleanup.
#[tauri::command]
fn disable_multi_agent_mode(
    _workspace: String,
) -> Result<MultiAgentModeReport, String> {
    Ok(MultiAgentModeReport {
        ok: true,
        warnings: Vec::new(),
    })
}

pub fn start_ui() -> anyhow::Result<()> {
    // Drop the previous run's per-pane artifacts before we boot —
    // `<temp>/coffee-cli/panes/*` and `~/.gemini/extensions/coffee-pane-*`
    // stub dirs from a crashed or hard-killed prior session would
    // otherwise accumulate. New artifacts are recreated lazily by
    // `tier_terminal_start` as multi-agent panes spawn.
    crate::mcp_injector::prune_pane_artifacts();

    // Create shared session BEFORE the builder so we can clone it for the exit handler
    let terminal_session = terminal::SharedSession::default();

    let builder = tauri::Builder::default();

    // Single-instance plugin MUST be the first plugin registered (per
    // Tauri docs) so its argv-forwarding hook runs before any other
    // plugin's init touches state. When a user double-launches Coffee CLI,
    // the second process sends its argv+cwd to this callback in the first
    // process and exits — the first process then refocuses the main window.
    // Side effect we want: only ever one WebView2 instance, which kills
    // the multi-process IME-jumps-to-(0,0) bug.
    //
    // Release-only: in debug builds we skip the lock so a dev `cargo tauri
    // dev` window can run side-by-side with an installed production build
    // (devs working on Coffee CLI inside Coffee CLI). Both builds otherwise
    // share the bundle identifier, and the lock would silently redirect the
    // dev launch to the production process and exit.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState {
            terminal_session,
            hook_port: std::sync::atomic::AtomicU16::new(0),
            fs_watcher: Mutex::new(None),
            pane_mcp_endpoints: tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            ),
            mcp_spawn_lock: tokio::sync::Mutex::new(()),
            hyper_agent_endpoint: tokio::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            window_minimize,
            window_maximize,
            window_close,
            show_main_window,
            tier_terminal_start,
            tier_terminal_input,
            tier_terminal_raw_write,
            tier_terminal_kill,
            tier_terminal_resize,
            set_background_mode,
            tier_terminal_resume,
            get_native_history,
            get_message_heatmap,
            read_native_session,
            read_opencode_session,
            check_network_port,
            check_tools_installed,
            crate::tools::list_tools,
            install_hook_for_tool,
            start_fs_watcher,
            stop_fs_watcher,
            save_clipboard_image,
            list_directory,
            start_folder_snapshot,
            compute_folder_stats,
            clear_folder_snapshot,
            get_baseline_content,
            read_text_file,
            show_in_folder,
            fs_delete,
            fs_rename,
            fs_paste,
            load_tasks,
            save_tasks,
            save_password,
            load_password,
            delete_password,
            open_url,
            enable_multi_agent_mode,
            disable_multi_agent_mode,
            start_hyper_agent_server,
            get_hyper_agent_endpoint,
            get_tool_config,
            get_all_tool_configs,
            set_tool_config,
            crate::skills::skills_ensure_dirs,
            crate::skills::skills_write_file,
            crate::skills::skills_list,
            crate::skills::skills_toggle,
            crate::skills::skills_delete,
            crate::skills::skills_relink_for_tool,
        ])
        .setup(|app| {
            // Install Claude/Qwen hook scripts + settings patches.
            // Runs once per launch; safe to call on a machine without either agent.
            crate::hook_installer::install_all();

            // Seed bundled skills (screenshot, vibeid) into
            // ~/.coffee-cli/skills-library/ so first-time users find
            // them in the Skills panel without having to open it
            // once to trigger seeding. Idempotent.
            if let Err(e) = crate::skills::skills_ensure_dirs() {
                log::warn!("[skills] seed at boot failed: {}", e);
            }

            // Start loopback TCP listener that receives events from the hook
            // script and forwards them to the frontend as `agent-status` events.
            match crate::hook_server::start(app.handle().clone()) {
                Ok(port) => {
                    app.state::<AppState>()
                        .hook_port
                        .store(port, std::sync::atomic::Ordering::SeqCst);
                }
                Err(e) => {
                    eprintln!("[hook-server] start failed: {}", e);
                }
            }

            // Per-pane MCP servers are spawned lazily inside
            // `tier_terminal_start` when each multi-agent pane boots
            // its CLI. Users who never open a multi-agent tab pay
            // zero MCP cost.

            // ── Bulletproof window-reveal fallback ──────────────────
            // The window is created with `visible: false` so the user
            // never sees the platform's chrome flash — main.tsx
            // invokes `show_main_window` after the first paint via
            // double-RAF and the window appears already-themed.
            //
            // BUT: if the WebView never paints (Gatekeeper rejection
            // on adhoc-signed macOS bundles, WebKit2GTK Wayland blank
            // window on Ubuntu 24.04, or any JS error before
            // ReactDOM mount), the `invoke` never fires, the window
            // stays hidden forever, and users see "process is running,
            // hook-server is listening, but there is no window".
            // Multiple users have hit this across both platforms.
            //
            // Force a reveal after 3s as a safety net. Healthy
            // startups call show_main_window in ~50ms, well before
            // this fires, so the no-flash UX is preserved. Broken
            // startups at least get a (possibly blank) window the
            // user can interact with — they can quit it, file a bug
            // with devtools, or report what they see, instead of
            // staring at nothing.
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if let Some(window) = handle.get_webview_window("main") {
                        if !window.is_visible().unwrap_or(false) {
                            eprintln!(
                                "[main-window] frontend never called show_main_window after 3s — forcing reveal (likely WebView render failure)"
                            );
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                });
            }

            // Force square corners + no shadow on the borderless window.
            // Windows 11's DWM rounds borderless windows by default and adds
            // a subtle drop-shadow; both create the visible "edge ring" we
            // want gone for the flat look.
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_shadow(false);
                    if let Ok(hwnd) = window.hwnd() {
                        unsafe {
                            use windows::Win32::Foundation::HWND;
                            use windows::Win32::Graphics::Dwm::{
                                DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE,
                                DWMWCP_DONOTROUND,
                            };
                            let pref: i32 = DWMWCP_DONOTROUND.0;
                            let _ = DwmSetWindowAttribute(
                                HWND(hwnd.0 as *mut _),
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &pref as *const _ as *const _,
                                std::mem::size_of_val(&pref) as u32,
                            );
                        }
                    }
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!("Error while building tauri application: {}", e))?
        .run(|app_handle, event| {
            // ── Graceful PTY-child cleanup on app exit ─────────────────
            // Issue #28: closing Coffee CLI without first killing tabs
            // left orphan `claude.exe` / `node.exe` alive on Windows
            // (they don't share a job with the parent by default), which
            // held `~/.claude/` session locks and broke the NEXT launch's
            // Claude Code tab.
            //
            // Two-layer fix:
            //   1. Here (graceful path): on ExitRequested, drain every
            //      session and fire kill_tx → drops PTY master → SIGHUP
            //      flows down the pipe → child exits cleanly.
            //   2. Job Object (crash-proof path, see terminal.rs): every
            //      child is bound to a kill-on-close job so even a hard
            //      crash / force-quit takes them with us.
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                let state = app_handle.state::<AppState>();
                let mut n = 0usize;
                if let Ok(mut map) = state.terminal_session.lock() {
                    n = map.len();
                    for (_, session) in map.drain() {
                        let _ = session.kill_tx.send(());
                    }
                }
                if n > 0 {
                    eprintln!(
                        "[Tier Terminal] App exiting — sent kill_tx to {} session(s)",
                        n
                    );
                }
            }
        });

    // App has fully exited. Per-pane MCP servers and their temp
    // artifacts get GC'd by the OS along with the process, but be
    // explicit about pruning so a long-running dev workstation never
    // accumulates stale dirs even if the next launch never happens.
    // Symmetric with the launch-time prune — belt-and-suspenders.
    crate::mcp_injector::prune_pane_artifacts();

    Ok(())
}
