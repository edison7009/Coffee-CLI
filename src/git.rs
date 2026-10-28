// git.rs — git-backed "changes" panel (replaces the session-snapshot diff).
//
// P1 surface (read-only): list working-tree changes grouped into
// staged / unstaged / untracked, and produce a per-file unified diff.
// Stage / unstage / commit / init land in P2; history / branches in P3.
//
// Every git call goes through `git_output` (CREATE_NO_WINDOW on Windows so
// no console window flashes).
// All repo queries run with the working dir pinned to the repository ROOT —
// resolved once via `rev-parse --show-toplevel` — so reported paths and diff
// pathspecs are consistently repo-root-relative even when the tab's folder is
// a subdirectory (matches how an IDE's Source Control shows the whole repo).

use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Per-repo session baseline: the HEAD captured when Coffee CLI first saw
/// this repo this process (via `git_capture_baseline`, called at app launch +
/// tab switch). Scopes the "修改记录" session-commits list to commits made
/// this window (`git log <baseline>..HEAD`). In-memory ⇒ cleared on app
/// close, so the list resets on reopen (no persistence / no counting — just a
/// baseline hash per repo). Pattern matches terminal.rs's `JOB` OnceLock.
static BASELINES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn baselines() -> &'static Mutex<HashMap<String, String>> {
    BASELINES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Run `git -C <dir> <args>`, capturing stdout. Err on a missing binary or a
/// non-zero exit (carrying stderr). Display commands like `diff` exit 0 even
/// when there are differences, so this is the right strictness for them.
fn git_output(dir: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    // Read-only calls (status/diff/log/rev-parse/show) never need git's
    // optional index locks — disabling them here means no polled or on-demand
    // call can stall on the index lock, with zero behavior change for the one
    // write call (git init, which doesn't use them).
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| format!("git not available: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("git {:?} failed", args) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// True if a `git` binary is on PATH. Not cached because the changes panel
/// invokes it only while its polling gate is active.
fn git_on_path() -> bool {
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

#[derive(serde::Serialize)]
pub struct GitFileEntry {
    /// Absolute, forward-slashed path (repo_root + "/" + rel).
    pub path: String,
    /// Repo-relative path exactly as git reports it; diff queries use this.
    pub rel: String,
    /// Single-letter status: M(odified) A(dded) D(eleted) R(enamed)
    /// C(opied) U(nmerged) ?(untracked).
    pub status: String,
    pub added: u32,
    pub deleted: u32,
}

/// Discriminated by `state` so the frontend can branch on no-git / not-a-repo
/// without sentinel values. `Ok` carries the change groups.
#[derive(serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum GitChanges {
    /// No `git` binary on PATH → panel shows the "install git" prompt.
    NoGit,
    /// git present, but `folder` is not inside a work tree → "not a repo"
    /// prompt (+ an "init here" affordance in P2).
    NotRepo,
    Ok {
        /// Absolute, forward-slashed repository root. The frontend passes this
        /// back to `git_show_file` so diff pathspecs resolve from the top.
        repo_root: String,
        /// Current branch name, e.g. "main" / "feature/x". A detached HEAD
        /// reports as "(<short-sha>)" so the header still shows something.
        branch: String,
        /// Tracked files with uncommitted changes (staged OR unstaged, merged —
        /// numstat is HEAD↔worktree so the diff is "what changed since the last
        /// commit"). The staged/unstaged split was collapsed 2026-07-06 because
        /// Coffee CLI's audience doesn't manually `git add`; the 3-way split
        /// was git jargon ("未暂存") that read as black-box. Status letter
        /// prefers the staged state when both apply.
        uncommitted: Vec<GitFileEntry>,
        /// New files git isn't tracking yet.
        untracked: Vec<GitFileEntry>,
        /// Commits made since this Coffee CLI window opened (baseline..HEAD),
        /// metadata only — files fetched lazily via `git_commit_files`.
        session_commits: Vec<CommitMeta>,
    },
}

/// A commit's metadata for the session-commits list. Files are NOT included —
/// fetched lazily via `git_commit_files` when the user expands a commit, so
/// the poll with many session commits stays cheap (one `git log` for metadata).
#[derive(serde::Serialize)]
pub struct CommitMeta {
    /// Short hash (e.g. "abc1234").
    pub hash: String,
    /// Commit subject (first line).
    pub message: String,
    pub author: String,
    /// Commit time, epoch seconds.
    pub time: i64,
}

/// Parse a `git diff --numstat -z` stream into path → (added, deleted).
///
/// MUST use `-z`: without it git applies `core.quotepath` and octal-escapes
/// non-ASCII paths (e.g. a CJK filename becomes `"\344\270\255…"`), which then
/// never matches the RAW path we parse from `status --porcelain -z` — so every
/// non-ASCII-named file would show a "+0 -0" badge. `-z` emits raw, NUL-
/// separated records so the keys line up. Binary files report "-\t-" → 0/0;
/// rename rows (path field empty under -z) simply don't match and degrade to a
/// 0/0 badge. Counts are best-effort by design.
fn parse_numstat(out: String) -> HashMap<String, (u32, u32)> {
    let mut map = HashMap::new();
    for field in out.split('\0') {
        if field.is_empty() {
            continue;
        }
        let mut it = field.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else { continue; };
        if p.is_empty() {
            continue; // rename record under -z carries the path in later fields
        }
        map.insert(
            p.to_string(),
            (a.parse::<u32>().unwrap_or(0), d.parse::<u32>().unwrap_or(0)),
        );
    }
    map
}

/// Uncommitted changes (HEAD↔worktree) numstat: `git diff --numstat HEAD`
/// compares the worktree to HEAD, which folds staged (index vs HEAD) + unstaged
/// (worktree vs index) into the single "what changed since the last commit"
/// delta the "未提交" group displays. Untracked files aren't tracked by git
/// and never appear here — they're handled separately via porcelain.
fn numstat_worktree_vs_head(repo_root: &str) -> HashMap<String, (u32, u32)> {
    let out = git_output(repo_root, &["diff", "--numstat", "-z", "HEAD"])
        .unwrap_or_default();
    parse_numstat(out)
}

/// Most-recent-commit summary (HEAD) for the "已提交" group. `None` on a repo
/// with no commits (fresh `git init`) — `git log -1` exits non-zero there.
/// `files` come from `git diff-tree --numstat --root HEAD`, which compares HEAD
/// to its parent (or to empty for the initial commit, so all files read as
/// additions). `--no-renames` keeps parsing simple (rename → delete+add); the
/// diff viewer doesn't need rename tracking.
/// Files changed in a single commit vs its parent: `diff-tree --numstat`.
/// `--root` makes the initial commit (no parent) read as all-additions;
/// `--no-renames` keeps parsing simple (rename → delete+add). Used by the
/// `git_commit_files` IPC (any commit hash) when a session commit is expanded.
fn commit_files(repo_root: &str, hash: &str) -> Vec<GitFileEntry> {
    let out = git_output(
        repo_root,
        &["diff-tree", "--no-commit-id", "-r", "--numstat", "-z", "--no-renames", "--root", hash],
    )
    .unwrap_or_default();
    let counts = parse_numstat(out);
    let mut files = Vec::new();
    for (rel, (added, deleted)) in counts {
        // Derive a display status from the numstat: add-only → A, del-only → D,
        // else M. (A rename shows here as a D + an A under --no-renames.)
        let status = if added > 0 && deleted == 0 { 'A' }
            else if deleted > 0 && added == 0 { 'D' }
            else { 'M' };
        files.push(GitFileEntry {
            path: join_abs(repo_root, &rel),
            rel,
            status: status.to_string(),
            added,
            deleted,
        });
    }
    // diff-tree gives no ordering guarantee; sort by path for a stable list.
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    files
}

/// Current HEAD hash, or "" on an unborn branch (fresh `git init`, no commits).
/// The empty sentinel means session_commits_since lists ALL commits (every
/// commit IS "made this window" when the repo had none at launch).
fn current_head(repo_root: &str) -> String {
    git_output(repo_root, &["rev-parse", "HEAD"])
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Commits made since the session baseline (`git log <baseline>..HEAD`),
/// metadata only (files are lazy via `git_commit_files`). Empty baseline ⇒
/// fresh repo ⇒ `git log HEAD` (all commits). If the baseline hash no longer
/// resolves (reset/rebase rewrote history below it), re-capture a fresh one
/// inline (git_changes only reads the map) so the next call has a baseline.
fn session_commits_since(repo_root: &str, baseline: &str) -> Vec<CommitMeta> {
    let fmt = "--format=%h%x1f%an%x1f%at%x1f%s";
    let range = if baseline.is_empty() {
        None
    } else {
        Some(format!("{baseline}..HEAD"))
    };
    let result = match &range {
        Some(r) => git_output(repo_root, &["log", "--no-merges", r.as_str(), fmt]),
        None => git_output(repo_root, &["log", "--no-merges", fmt]),
    };
    match result {
        Ok(out) => out
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(4, '\x1f');
                let hash = parts.next()?.to_string();
                let author = parts.next()?.to_string();
                let time: i64 = parts.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                let message = parts.next().unwrap_or("").to_string();
                Some(CommitMeta { hash, message, author, time })
            })
            .collect(),
        Err(_) => {
            // Baseline gone (history rewritten). Re-capture a fresh baseline
            // inline — git_changes only reads the map, so without this the
            // stale baseline would persist the error until the next tab switch.
            if let Ok(mut map) = baselines().lock() {
                map.insert(repo_root.to_string(), current_head(repo_root));
            }
            Vec::new()
        }
    }
}

/// Absolute, forward-slashed key with an upper-cased Windows drive letter —
/// the same normalization `compute_folder_stats` used, so the Explorer file
/// tree keeps matching these paths against its `list_directory` entries.
/// Current branch name. `symbolic-ref --short HEAD` returns the branch even on
/// an UNBORN branch (a fresh `git init` with no commits yet → "main"), which
/// `rev-parse --abbrev-ref` does not (it yields the literal "HEAD" there).
/// Falls through on a detached HEAD to the short SHA as "(abc1234)" so the
/// header always has a label.
fn git_branch(repo_root: &str) -> String {
    if let Ok(s) = git_output(repo_root, &["symbolic-ref", "--short", "HEAD"]) {
        let s = s.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    let sha = git_output(repo_root, &["rev-parse", "--short", "HEAD"]).unwrap_or_default();
    let sha = sha.trim();
    if sha.is_empty() { "HEAD".to_string() } else { format!("({sha})") }
}

/// Line count of a file, used as the "+N" for untracked files (which have no
/// git blob to numstat). Text-only and size-capped; returns 0 on any failure
/// or a binary/oversized file so it degrades to a blank badge, never a hang.
const UNTRACKED_COUNT_CAP: usize = 200;
const UNTRACKED_MAX_BYTES: u64 = 1_000_000;
fn count_lines(path: &str) -> u32 {
    let Ok(meta) = std::fs::metadata(path) else { return 0; };
    if !meta.is_file() || meta.len() > UNTRACKED_MAX_BYTES {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else { return 0; };
    if bytes.is_empty() || bytes[..bytes.len().min(8192)].contains(&0u8) {
        return 0; // empty or binary
    }
    let mut lines = bytes.iter().filter(|&&b| b == b'\n').count();
    if *bytes.last().unwrap() != b'\n' {
        lines += 1; // final line without a trailing newline still counts
    }
    lines.min(u32::MAX as usize) as u32
}

fn join_abs(repo_root: &str, rel: &str) -> String {
    crate::server::normalize_path_key(&format!("{}/{}", repo_root.trim_end_matches('/'), rel))
}

/// List the active folder's git working-tree changes. The frontend refreshes
/// it from filesystem events plus a low-frequency polling backstop.
#[tauri::command]
pub async fn git_changes(folder: String) -> Result<GitChanges, String> {
    tauri::async_runtime::spawn_blocking(move || git_changes_blocking(folder)).await.map_err(|e| e.to_string())
}

fn git_changes_blocking(folder: String) -> GitChanges {
    if !git_on_path() {
        return GitChanges::NoGit;
    }
    // Repo detection + canonical root in one shot (run from the tab folder,
    // which may be a subdir). Failure here = not a work tree.
    let repo_root = match git_output(&folder, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return GitChanges::NotRepo,
    };

    let branch = git_branch(&repo_root);
    // HEAD↔worktree numstat folds staged + unstaged into the single "未提交"
    // delta (the staged/unstaged split was collapsed 2026-07-06 — the audience
    // doesn't manually `git add`, and "未暂存" was git jargon).
    let uncommitted_counts = numstat_worktree_vs_head(&repo_root);

    let mut uncommitted = Vec::new();
    let mut untracked = Vec::new();

    // Porcelain v1, NUL-separated, every untracked file listed. Each record is
    // "XY <path>" where X = index/staged status, Y = worktree/unstaged status.
    // With -z the path is raw (no C-quoting). A rename/copy (X or Y in {R,C})
    // appends ONE extra NUL field — the origin path — which we consume so it
    // isn't mis-parsed as its own entry.
    let porcelain = git_output(
        &repo_root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .unwrap_or_default();
    let fields: Vec<&str> = porcelain.split('\0').collect();
    let mut i = 0;
    while i < fields.len() {
        let rec = fields[i];
        i += 1;
        if rec.len() < 4 {
            continue; // shorter than "XY p" → trailing empty field, skip
        }
        let bytes = rec.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let rel = rec[3..].to_string();
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            i += 1; // skip the origin-path follow-up field
        }

        if x == '?' && y == '?' {
            untracked.push(GitFileEntry {
                path: join_abs(&repo_root, &rel),
                rel,
                status: "?".into(),
                added: 0,
                deleted: 0,
            });
            continue;
        }
        // Uncommitted: staged (x) OR unstaged (y), excluding untracked. One
        // row per file (porcelain gives a single XY record per path). Status
        // letter prefers the staged state (x) when both apply — a file that's
        // staged-added then modified again reads as 'A', not 'M'.
        if (x != ' ' && x != '?') || (y != ' ' && y != '?') {
            let (a, d) = uncommitted_counts.get(&rel).copied().unwrap_or((0, 0));
            let status = if x != ' ' && x != '?' { x } else { y };
            uncommitted.push(GitFileEntry {
                path: join_abs(&repo_root, &rel),
                rel,
                status: status.to_string(),
                added: a,
                deleted: d,
            });
        }
    }

    // Untracked files have no git blob to numstat; show their line count as
    // additions so the badge/header aren't a meaningless "+0 -0". Bounded:
    // skip when there are many untracked (a fresh repo can list thousands) and
    // cap per-file size, keeping the polled call cheap.
    if untracked.len() <= UNTRACKED_COUNT_CAP {
        for e in untracked.iter_mut() {
            e.added = count_lines(&e.path);
        }
    }

    // Session commits: commits made since this Coffee CLI window opened
    // (baseline = HEAD at first sight of this repo, captured by
    // `git_capture_baseline` at app launch + tab switch, in-memory ⇒ reset on
    // close). Push-agnostic — push doesn't move HEAD, so committed entries
    // stay in the list. Metadata only; files are fetched lazily via
    // `git_commit_files` when the user expands a commit, so a poll with many
    // session commits is still one `git log` call.
    let baseline = baselines()
        .lock()
        .ok()
        .and_then(|map| map.get(&repo_root).cloned());
    let session_commits = match baseline {
        Some(b) => session_commits_since(&repo_root, &b),
        None => Vec::new(),
    };
    GitChanges::Ok {
        repo_root,
        branch,
        uncommitted,
        untracked,
        session_commits,
    }
}

/// Content of a file at a git revision, e.g. `git show HEAD:src/a.ts` or
/// `git show :src/a.ts` (the staged/index blob). `spec` is "<ref>:<rel>" with
/// `rel` repo-root-relative. Returns None when the path doesn't exist at that
/// revision (a newly-added file has no HEAD blob) — the frontend treats None
/// as an empty side, so the file renders as all-additions.
///
/// This is the ONLY data the DiffPanel needs: it feeds the returned old/new
/// blobs straight into the existing jsdiff + Shiki pipeline, so the diff
/// rendering (folding, syntax colors, size guards) is reused unchanged. The
/// staged/unstaged old↔new mapping lives in the frontend:
///   • unstaged tracked: old = `:rel` (index)   new = working file on disk
///   • staged   tracked: old = `HEAD:rel`        new = `:rel` (index)
///   • untracked:        old = ""                new = working file on disk
#[tauri::command]
pub async fn git_show_file(repo_root: String, spec: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_show_file_blocking(repo_root, spec)).await.map_err(|e| e.to_string())
}

fn git_show_file_blocking(repo_root: String, spec: String) -> Option<String> {
    // Defense against arg-injection: `spec` is frontend-built (HEAD:rel,
    // <hash>:rel, :rel). Reject a leading '-' so a crafted commitHash can't
    // lead the spec and be parsed as a git option. (A legit spec never starts
    // with '-' — it's HEAD, a hex hash, or ':rel'.)
    if spec.starts_with('-') {
        return None;
    }
    git_output(&repo_root, &["show", &spec]).ok()
}

/// `git init` the given folder so the not-a-repo state's "initialize here"
/// button can turn an ordinary folder into a tracked workspace in one click.
#[tauri::command]
pub async fn git_init(folder: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_init_blocking(folder)).await.map_err(|e| e.to_string())?
}

fn git_init_blocking(folder: String) -> Result<(), String> {
    git_output(&folder, &["init"]).map(|_| ())
}

/// Capture the session baseline (current HEAD) for a repo, idempotently.
/// Called at app launch + on tab switch (NOT poll-gated — one rev-parse).
/// Scopes the "修改记录" session-commits list to commits made this window.
#[tauri::command]
pub async fn git_capture_baseline(folder: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_capture_baseline_blocking(folder)).await.map_err(|e| e.to_string())
}

fn git_capture_baseline_blocking(folder: String) {
    let repo_root = match git_output(&folder, &["rev-parse", "--show-toplevel"]) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return, // not a repo — nothing to baseline
    };
    if let Ok(mut map) = baselines().lock() {
        if !map.contains_key(&repo_root) {
            // rev-parse HEAD fails on an unborn branch (fresh `git init`) —
            // capture "" as a sentinel so session_commits_since lists ALL
            // commits (every commit IS "made this window" when the repo had
            // none at launch). Without this the first commit would be missed
            // until the next tab switch re-captured a baseline.
            let head = current_head(&repo_root);
            map.insert(repo_root, head);
        }
    }
}

/// Files changed in a single commit (lazy — called when the user expands a
/// session commit in the 修改记录 list). Reuses `commit_files`.
#[tauri::command]
pub async fn git_commit_files(repo_root: String, hash: String) -> Result<Vec<GitFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_files_blocking(repo_root, hash)).await.map_err(|e| e.to_string())
}

fn git_commit_files_blocking(repo_root: String, hash: String) -> Vec<GitFileEntry> {
    // Defense against arg-injection: `hash` is round-tripped through the
    // frontend (session_commits[].hash). Reject non-hex so a crafted value
    // can't reach `git diff-tree` as an option. (Internal `commit_files("HEAD")`
    // bypasses this — "HEAD" is a literal, not frontend input.)
    if !hash.bytes().all(|b| b.is_ascii_hexdigit()) || !(4..=40).contains(&hash.len()) {
        return Vec::new();
    }
    commit_files(&repo_root, &hash)
}

/// Bounded, local-only evidence for Coffee Agent. No fetch or repository writes.
pub(crate) fn project_snapshot(folder: &str) -> serde_json::Value {
    use serde_json::json;
    let observed_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut result = json!({"cwd":folder,"observedAt":observed_at,"state":"error"});
    if let Err(error) = project_git_output(folder, &["--version"]) {
        result["state"] = json!(if error == "Git executable unavailable" { "no_git" } else { "error" });
        result["error"] = json!(error);
        return result;
    }
    let repo_root = match project_git_output(folder, &["rev-parse", "--show-toplevel"]) {
        Ok(value) => value.trim().to_string(),
        Err(error) => {
            result["state"] = json!(if error == "Not a Git repository" { "not_repo" } else { "error" });
            if error != "Not a Git repository" { result["error"] = json!(error); }
            return result;
        }
    };
    let query = || -> Result<serde_json::Value, String> {
        let scope = project_git_output(folder, &["rev-parse", "--show-prefix"])?;
        let scope = scope.trim_end_matches('\n').trim_end_matches('\r');
        let pathspec = if scope.is_empty() { "." } else { scope };
        let head = match project_git_output(&repo_root, &["rev-parse", "--verify", "HEAD"]) {
            Ok(value) => Some(value.trim().to_string()),
            Err(_) if project_git_output(&repo_root, &["symbolic-ref", "--short", "HEAD"]).is_ok() => None,
            Err(error) => return Err(error),
        };
        let branch = project_git_output(&repo_root, &["symbolic-ref", "--short", "HEAD"])
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|_| head.as_deref().unwrap_or("HEAD").chars().take(12).collect());
        let raw = project_git_output(&repo_root, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", pathspec])?;
        let counts = if head.is_some() {
            parse_numstat(project_git_output(&repo_root, &["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "HEAD", "--", pathspec])?)
        } else { HashMap::new() };
        let mut changed = Vec::new();
        let mut untracked = Vec::new();
        let mut fields = raw.split('\0');
        let mut total = 0usize;
        while let Some(record) = fields.next() {
            if record.len() < 4 { continue; }
            let x = record.as_bytes()[0] as char;
            let y = record.as_bytes()[1] as char;
            let path = &record[3..];
            if x == 'R' || x == 'C' || y == 'R' || y == 'C' { fields.next(); }
            total += 1;
            if total > 200 { continue; }
            if x == '?' && y == '?' { untracked.push(json!({"path":path})); }
            else {
                let (added, deleted) = counts.get(path).copied().unwrap_or_default();
                changed.push(json!({"path":path,"status":format!("{x}{y}"),"added":added,"deleted":deleted}));
            }
        }
        let mut recent = if head.is_some() {
            project_git_output(&repo_root, &["log", "-10", "--format=%H%x1f%an%x1f%at%x1f%s", "--", pathspec])?
                .lines().filter_map(|line| {
                    let parts: Vec<_> = line.splitn(4, '\x1f').collect();
                    if parts.len() != 4 { return None; }
                    Some(json!({"hash":parts[0],"author":parts[1].chars().take(100).collect::<String>(),"time":parts[2].parse::<i64>().unwrap_or_default(),"message":parts[3].chars().take(300).collect::<String>()}))
                }).collect::<Vec<_>>()
        } else { Vec::new() };
        for commit in &mut recent {
            if Instant::now() >= deadline { commit["filesState"] = json!("time-budget"); commit["filesTruncated"] = json!(true); commit["files"] = json!([]); continue; }
            let hash = commit["hash"].as_str().unwrap_or_default();
            match project_git_output(&repo_root, &["diff-tree", "--no-commit-id", "-r", "-m", "--first-parent", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--root", hash, "--", pathspec]) {
                Ok(output) => {
                    let counts = parse_numstat(output);
                    let mut paths = counts.keys().collect::<Vec<_>>(); paths.sort();
                    let files = paths.iter().take(20).map(|path| {
                        let (added, deleted) = counts.get(*path).copied().unwrap_or_default();
                        json!({"path":path,"added":added,"deleted":deleted})
                    }).collect::<Vec<_>>();
                    commit["filesCount"] = json!(paths.len());
                    commit["filesTruncated"] = json!(paths.len() > 20);
                    commit["filesState"] = json!("ok");
                    commit["files"] = json!(files);
                }
                Err(_) => { commit["filesState"] = json!("unavailable"); commit["filesTruncated"] = json!(true); commit["files"] = json!([]); }
            }
        }
        let upstream = match project_git_output(&repo_root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) {
            Ok(name) => match project_git_output(&repo_root, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]) {
                Ok(counts) => {
                    let values: Vec<_> = counts.split_whitespace().collect();
                    if values.len() != 2 { return Err("Git upstream counts are invalid".into()); }
                    json!({"state":"known","name":name.trim(),"ahead":values[0].parse::<u64>().map_err(|_| "Invalid ahead count")?,"behind":values[1].parse::<u64>().map_err(|_| "Invalid behind count")?,"basis":"local-tracking-ref; remote may have changed"})
                }
                Err(_) => json!({"state":"unknown","basis":"local-tracking-ref"}),
            },
            Err(_) => json!({"state":"none","basis":"local-tracking-ref"}),
        };
        Ok(json!({"state":"ok","cwd":folder,"repoRoot":repo_root,"scope":scope,"branch":branch,"head":head,"unborn":head.is_none(),"uncommitted":changed,"untracked":untracked,"changedCount":total,"truncated":total>200,"recentCommits":recent,"upstream":upstream,"observedAt":observed_at,"evidence":"Commit messages do not verify task completion or test results."}))
    };
    match query() {
        Ok(mut value) => {
            while serde_json::to_vec(&value).map(|bytes| bytes.len() > 24_000).unwrap_or(true) {
                if let Some(commit) = value["recentCommits"].as_array_mut().and_then(|commits| commits.iter_mut().rev().find(|commit| commit["files"].as_array().is_some_and(|items| !items.is_empty()))) {
                    commit["files"].as_array_mut().unwrap().pop(); commit["filesTruncated"] = json!(true); value["truncated"] = json!(true); continue;
                }
                let key = if value["untracked"].as_array().is_some_and(|items| !items.is_empty()) { "untracked" } else { "uncommitted" };
                if value[key].as_array_mut().is_some_and(|items| items.pop().is_some()) { value["truncated"] = json!(true); }
                else { break; }
            }
            value
        },
        Err(error) => { result["repoRoot"] = json!(repo_root); result["error"] = json!(error); result }
    }
}

pub(crate) fn project_git_output(folder: &str, args: &[&str]) -> Result<String, String> {
    project_git_read(folder, args, false)
}

pub(crate) fn project_ignored(folder: &str, paths: &[&str]) -> Result<std::collections::HashSet<String>, String> {
    if paths.is_empty() { return Ok(Default::default()); }
    let mut input = Vec::new();
    for path in paths {
        if path.contains('\0') || input.len() + path.len() + 1 > 2_097_152 { return Err("Git ignore input exceeds its path budget".into()); }
        input.extend_from_slice(path.as_bytes()); input.push(0);
    }
    project_git_read_input(folder, &["check-ignore", "--no-index", "-z", "--stdin"], true, Some(input))
        .map(|output| output.split('\0').filter(|path| !path.is_empty()).map(str::to_string).collect())
}

fn project_git_read(folder: &str, args: &[&str], no_matches_ok: bool) -> Result<String, String> {
    project_git_read_input(folder, args, no_matches_ok, None)
}

fn project_git_read_input(folder: &str, args: &[&str], no_matches_ok: bool, input: Option<Vec<u8>>) -> Result<String, String> {
    const LIMIT: u64 = 262_144;
    let mut command = Command::new("git");
    command.args(["-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "log.showSignature=false", "-C", folder]).args(args)
        .env("GIT_OPTIONAL_LOCKS", "0").env("GIT_NO_LAZY_FETCH", "1").env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() });
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|_| "Git executable unavailable")?;
    let writer = input.map(|bytes| {
        let mut stdin = child.stdin.take().expect("piped Git stdin");
        std::thread::spawn(move || std::io::Write::write_all(&mut stdin, &bytes))
    });
    let stdout = child.stdout.take().ok_or("Git output unavailable")?;
    let stderr = child.stderr.take().ok_or("Git error output unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.take(LIMIT + 1).read_to_end(&mut bytes).map(|_| bytes)
    });
    let errors = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(16_384).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(4);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("Git snapshot timed out".into()); }
        }
    };
    let bytes = reader.join().map_err(|_| "Git output reader failed")?.map_err(|_| "Git output could not be read")?;
    if let Some(writer) = writer { writer.join().map_err(|_| "Git input writer failed")?.map_err(|_| "Git ignore input could not be written")?; }
    let errors = errors.join().map_err(|_| "Git error reader failed")?;
    if bytes.len() as u64 > LIMIT { return Err("Git snapshot exceeded its output budget".into()); }
    if !status.success() && !(no_matches_ok && status.code() == Some(1)) {
        return Err(if String::from_utf8_lossy(&errors).contains("not a git repository") { "Not a Git repository" } else { "Git command failed" }.into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod project_tests {
    use super::*;
    fn root() -> std::path::PathBuf { std::env::temp_dir().join(format!("coffee-project-git-{}", uuid::Uuid::new_v4())) }
    fn run(root: &std::path::Path, args: &[&str]) {
        let mut command = Command::new("git");
        command.args(["-c", "user.name=Coffee Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath="]).arg("-C").arg(root).args(args);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        assert!(command.output().unwrap().status.success(), "test git command failed: {args:?}");
    }
    #[test]
    fn ignore_queries_use_nul_stdin_beyond_windows_argument_limits() {
        let root = root(); std::fs::create_dir_all(&root).unwrap(); run(&root, &["init", "-b", "main"]);
        std::fs::write(root.join(".gitignore"), "private/\n").unwrap();
        let mut paths = (0..1200).map(|index| format!("src/{}/file-{index}.rs", "long-directory".repeat(5))).collect::<Vec<_>>();
        paths.push("private/空 格.txt".into());
        let refs = paths.iter().map(String::as_str).collect::<Vec<_>>();
        assert!(refs.iter().map(|path| path.len()).sum::<usize>() > 32_768);
        assert_eq!(project_ignored(root.to_str().unwrap(), &refs).unwrap(), ["private/空 格.txt".to_string()].into_iter().collect());
        assert!(project_ignored(root.to_str().unwrap(), &[]).unwrap().is_empty());
        assert!(project_ignored(root.to_str().unwrap(), &["bad\0path"]).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn project_git_is_scoped_bounded_and_does_not_depend_on_session_baselines() {
        let root = root(); std::fs::create_dir_all(root.join("app")).unwrap(); std::fs::create_dir_all(root.join("other")).unwrap(); run(&root, &["init", "-b", "main"]);
        run(&root, &["config", "log.showSignature", "true"]);
        assert_eq!(project_git_output(root.to_str().unwrap(), &["config", "--get", "log.showSignature"]).unwrap().trim(), "false");
        for index in 0..12 {
            std::fs::write(root.join("app/file.txt"), format!("app {index}\n")).unwrap();
            run(&root, &["add", "app/file.txt"]); run(&root, &["commit", "-m", &format!("app {index}")]);
        }
        std::fs::write(root.join("other/other.txt"), "other module").unwrap(); run(&root, &["add", "other/other.txt"]); run(&root, &["commit", "-m", "other module"]);
        std::fs::write(root.join("app/file.txt"), "changed\n").unwrap(); std::fs::write(root.join("app/new.txt"), "new file").unwrap(); std::fs::write(root.join("other/other.txt"), "other change").unwrap();
        let head_before = git_output(root.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let index_before = std::fs::read(root.join(".git/index")).unwrap();
        let snapshot = project_snapshot(root.join("app").to_str().unwrap());
        assert_eq!(snapshot["state"], "ok"); assert_eq!(snapshot["scope"], "app/"); assert_eq!(snapshot["branch"], "main");
        assert_eq!(snapshot["recentCommits"].as_array().unwrap().len(), 10);
        assert_eq!(snapshot["recentCommits"][0]["files"][0]["path"], "app/file.txt"); assert_eq!(snapshot["recentCommits"][0]["filesState"], "ok");
        assert_eq!(snapshot["uncommitted"].as_array().unwrap().len(), 1); assert_eq!(snapshot["untracked"][0]["path"], "app/new.txt");
        assert!(!snapshot.to_string().contains("other.txt")); assert!(!snapshot.to_string().contains("other module"));
        assert_eq!(snapshot["upstream"]["state"], "none");
        assert_eq!(git_output(root.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(), head_before); assert_eq!(std::fs::read(root.join(".git/index")).unwrap(), index_before);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unborn_detached_local_upstream_and_read_failures_are_explicit() {
        let root = root(); std::fs::create_dir_all(&root).unwrap(); assert_eq!(project_snapshot(root.to_str().unwrap())["state"], "not_repo"); run(&root, &["init", "-b", "main"]);
        let initial = project_snapshot(root.to_str().unwrap()); assert_eq!(initial["state"], "ok"); assert_eq!(initial["unborn"], true);
        for index in 0..2 {
            std::fs::write(root.join("file.txt"), format!("{index}\n")).unwrap(); run(&root, &["add", "file.txt"]); run(&root, &["commit", "-m", "Tests passed (unverified claim)"]);
        }
        run(&root, &["remote", "add", "origin", "https://example.invalid/no-network"]); run(&root, &["update-ref", "refs/remotes/origin/main", "HEAD~1"]); run(&root, &["branch", "--set-upstream-to=origin/main", "main"]);
        let before = git_output(root.to_str().unwrap(), &["rev-parse", "refs/remotes/origin/main"]).unwrap();
        let snapshot = project_snapshot(root.to_str().unwrap()); assert_eq!(snapshot["upstream"]["ahead"], 1); assert_eq!(snapshot["upstream"]["behind"], 0);
        assert_eq!(git_output(root.to_str().unwrap(), &["rev-parse", "refs/remotes/origin/main"]).unwrap(), before);
        run(&root, &["checkout", "--detach"]); assert_eq!(project_snapshot(root.to_str().unwrap())["state"], "ok");
        std::fs::write(root.join(".git/index"), "invalid-index").unwrap(); assert_eq!(project_snapshot(root.to_str().unwrap())["state"], "error");
        std::fs::remove_dir_all(root).unwrap();
    }
}
