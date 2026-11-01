//! Isolated git worktrees for orchestration workers.
//!
//! A worker that would otherwise share the coordinator's checkout can work in its own worktree and branch, cut from
//! the current HEAD commit. They live under `<repository>/.claude/worktrees/`, the convention Claude Code uses, which
//! history resumes already map back to the project. Removal goes through git's own safety checks, so a worktree with
//! uncommitted files or a branch that was never merged is kept.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree { pub root: String, pub path: String, pub branch: String }

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    // Refusals are recognised by git's English text, which a localized git would translate.
    command.arg("-C").arg(dir).args(args).env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C").env("LANGUAGE", "C");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().map_err(|_| "Git is not available".to_string())?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { format!("git {} failed", args.join(" ")) } else { error });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string())
}

/// A path inside some project's `.claude/worktrees/`, where a further worktree would nest.
pub fn inside_worktrees(path: &str) -> bool {
    let parts = path.split(['/', '\\']).collect::<Vec<_>>();
    parts.windows(2).any(|pair| pair == [".claude", "worktrees"])
}

fn native(path: &str) -> PathBuf { PathBuf::from(path.replace('/', std::path::MAIN_SEPARATOR_STR)) }

/// A short, branch-safe name from the task title, unique by its suffix.
fn name(title: &str, suffix: &str) -> String {
    let mut slug = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() { slug.push(c.to_ascii_lowercase()); }
        else if !slug.ends_with('-') && !slug.is_empty() { slug.push('-'); }
        if slug.len() >= 24 { break; }
    }
    let slug = slug.trim_matches('-');
    format!("{}-{suffix}", if slug.is_empty() { "task" } else { slug })
}

/// Creates a worktree for a worker started from `cwd`, and returns it with the directory the worker opens in,
/// the same subdirectory of the project as `cwd`.
pub fn create(cwd: &Path, title: &str) -> Result<(Worktree, PathBuf), String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| "Worktree isolation needs the project to be a git repository".to_string())?;
    if inside_worktrees(&root) { return Err("This folder is already a worktree; start from the project itself".into()); }
    let prefix = git(cwd, &["rev-parse", "--show-prefix"])?;
    git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"]).map_err(|_| "Worktree isolation needs at least one commit in the repository".to_string())?;
    let root_path = native(&root);
    let name = name(title, &uuid::Uuid::new_v4().simple().to_string()[..6]);
    let path = root_path.join(".claude").join("worktrees").join(format!("coffee-{name}"));
    let branch = format!("coffee/{name}");
    let target = path.to_string_lossy().into_owned();
    git(&root_path, &["worktree", "add", "-b", &branch, &target, "HEAD"])?;
    exclude(&root_path, &path);
    let worktree = Worktree { root: root_path.to_string_lossy().into_owned(), path: target, branch };
    Ok((worktree, path.join(native(prefix.trim_end_matches('/')))))
}

/// Keeps the worktrees out of the project's `git status`, through the local exclude file only.
fn exclude(root: &Path, path: &Path) {
    if git(root, &["check-ignore", "-q", &path.to_string_lossy()]).is_ok() { return; }
    let Ok(file) = git(root, &["rev-parse", "--git-path", "info/exclude"]) else { return };
    let file = root.join(native(&file));
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    if current.lines().any(|line| line.trim() == "/.claude/worktrees/") { return; }
    let separator = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    if let Some(parent) = file.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = std::fs::write(&file, format!("{current}{separator}/.claude/worktrees/\n"));
}

/// Removes a worktree and its branch when git considers that safe: no uncommitted or untracked files, and a branch
/// merged into the project's checkout. Anything else is left for the user.
pub fn remove(worktree: &Worktree) -> (bool, bool) {
    let root = Path::new(&worktree.root);
    let tree = git(root, &["worktree", "remove", &worktree.path]).is_ok();
    let branch = tree && git(root, &["branch", "-d", &worktree.branch]).is_ok();
    (tree, branch)
}

/// Removal after the worker's tab has had time to close, as Windows keeps its directory open until then.
pub fn remove_later(worktrees: Vec<Worktree>) {
    if worktrees.is_empty() { return; }
    std::thread::spawn(move || {
        let mut left = worktrees;
        // A tool that is still shutting down can hold the folder open for a while.
        for wait in [3, 10, 30] {
            std::thread::sleep(std::time::Duration::from_secs(wait));
            left.retain(|worktree| Path::new(&worktree.path).is_dir() && !remove(worktree).0);
            if left.is_empty() { break; }
        }
    });
}

/// Removes the project's Coffee worktrees that nothing uses any more, and merged `coffee/` branches without one, by
/// git's safe rules. Tabs are not kept across restarts, so this is what reclaims a worktree left by a quit.
fn sweep(cwd: &Path, in_use: &[String]) -> Result<u32, String> {
    let root = git(cwd, &["rev-parse", "--show-toplevel"])?;
    if inside_worktrees(&root) { return Ok(0); }
    let root = native(&root);
    let _ = git(&root, &["worktree", "prune"]);
    let base = root.join(".claude").join("worktrees");
    let used = |path: &Path| in_use.iter().any(|known| Path::new(known) == path);
    let mut removed = 0;
    let mut live = vec![];
    for line in git(&root, &["worktree", "list", "--porcelain"])?.lines() {
        let Some(path) = line.strip_prefix("worktree ") else { continue };
        let path = native(path);
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
        if path.parent() != Some(base.as_path()) || !name.starts_with("coffee-") { continue; }
        let worktree = Worktree { root: root.to_string_lossy().into_owned(), path: path.to_string_lossy().into_owned(), branch: format!("coffee/{}", &name["coffee-".len()..]) };
        if used(&path) || !remove(&worktree).0 { live.push(worktree.branch); } else { removed += 1; }
    }
    for branch in git(&root, &["branch", "--merged", "HEAD", "--list", "coffee/*", "--format=%(refname:short)"])?.lines() {
        if !live.iter().any(|known| known == branch) && git(&root, &["branch", "-d", branch]).is_ok() { removed += 1; }
    }
    Ok(removed)
}

/// Only worktrees Coffee made: under the project's `.claude/worktrees/coffee-*`, on a `coffee/` branch.
fn checked(worktree: &Worktree) -> Result<(), String> {
    let path = Path::new(&worktree.path);
    let inside = path.parent().is_some_and(|parent| parent == Path::new(&worktree.root).join(".claude").join("worktrees"));
    let named = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("coffee-"));
    let branch = worktree.branch.strip_prefix("coffee/").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    if inside && named && branch { Ok(()) } else { Err("Not a Coffee worktree".into()) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus { pub exists: bool, pub ahead: u32, pub dirty: bool, pub target: String }

fn status(worktree: &Worktree) -> Result<WorktreeStatus, String> {
    checked(worktree)?;
    let root = Path::new(&worktree.root);
    let target = git(root, &["branch", "--show-current"]).unwrap_or_default();
    if !Path::new(&worktree.path).is_dir() { return Ok(WorktreeStatus { exists: false, ahead: 0, dirty: false, target }); }
    let ahead = git(root, &["rev-list", "--count", &format!("HEAD..{}", worktree.branch)])?.trim().parse().unwrap_or(0);
    let dirty = !git(Path::new(&worktree.path), &["status", "--porcelain"])?.trim().is_empty();
    Ok(WorktreeStatus { exists: true, ahead, dirty, target })
}

/// Commits what the conversation left uncommitted, then merges the branch into the project's checkout. A conflict
/// is aborted, and changes in the checkout that the merge would overwrite are refused, both by git's own rules.
fn merge(worktree: &Worktree, message: &str) -> Result<u32, String> {
    checked(worktree)?;
    let (root, tree) = (Path::new(&worktree.root), Path::new(&worktree.path));
    let committed = !git(tree, &["status", "--porcelain"])?.trim().is_empty();
    if committed {
        git(tree, &["add", "-A"])?;
        git(tree, &["commit", "-q", "-m", message])?;
    }
    let ahead: u32 = git(root, &["rev-list", "--count", &format!("HEAD..{}", worktree.branch)])?.trim().parse().unwrap_or(0);
    if ahead == 0 { return Ok(0); }
    if let Err(error) = git(root, &["merge", "--no-edit", &worktree.branch]) {
        // A merge that did not happen leaves the worktree as it was, so the next attempt starts from the same place.
        if committed { let _ = git(tree, &["reset", "-q", "--soft", "HEAD~1"]); }
        if git(root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_ok() {
            let _ = git(root, &["merge", "--abort"]);
            return Err("COFFEE_MERGE:conflict".into());
        }
        if error.contains("would be overwritten") { return Err("COFFEE_MERGE:local_changes".into()); }
        return Err(error);
    }
    Ok(ahead)
}

#[derive(Serialize)]
pub struct Created { worktree: Worktree, cwd: String }

#[tauri::command]
pub async fn worktree_available(cwd: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&cwd);
        dir.is_dir() && git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
    }).await.unwrap_or(false)
}
#[tauri::command]
pub async fn worktree_create(cwd: String, title: String) -> Result<Created, String> {
    tauri::async_runtime::spawn_blocking(move || create(Path::new(&cwd), &title).map(|(worktree, cwd)| Created { worktree, cwd: cwd.to_string_lossy().into_owned() }))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn worktree_status(worktree: Worktree) -> Result<WorktreeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&worktree)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn worktree_merge(worktree: Worktree, message: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || merge(&worktree, &message)).await.map_err(|e| e.to_string())?
}
/// `in_use` lists the worktrees open tabs hold; orchestration workers' worktrees are added here.
#[tauri::command]
pub async fn worktree_sweep(cwd: String, in_use: Vec<String>) -> Result<u32, String> {
    let mut in_use = in_use; in_use.extend(crate::orchestration::worktree_paths());
    tauri::async_runtime::spawn_blocking(move || sweep(Path::new(&cwd), &in_use)).await.map_err(|e| e.to_string())?
}
/// For a tab that closed or turned the worktree off; git keeps anything uncommitted or unmerged.
#[tauri::command]
pub fn worktree_remove(worktree: Worktree) -> Result<(), String> {
    checked(&worktree)?;
    remove_later(vec![worktree]); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(dir: &Path, args: &[&str]) { assert!(Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success(), "git {args:?}"); }
    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "-q"]);
        run(dir.path(), &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"]);
        std::fs::create_dir_all(dir.path().join("app")).unwrap();
        dir
    }
    #[test]
    fn names_are_branch_safe_and_unique_by_suffix() {
        assert_eq!(name("Fix the login page!", "a1b2c3"), "fix-the-login-page-a1b2c3");
        assert_eq!(name("修复登录", "a1b2c3"), "task-a1b2c3");
        assert!(name(&"x".repeat(80), "a1b2c3").len() <= 31);
    }
    #[test]
    fn a_worktree_opens_in_the_same_subdirectory_and_stays_out_of_status() {
        let repo = repository();
        let (worktree, cwd) = create(&repo.path().join("app"), "Write docs").unwrap();
        assert!(Path::new(&worktree.path).is_dir());
        assert!(cwd.ends_with("app"));
        assert!(worktree.branch.starts_with("coffee/write-docs-"));
        assert_eq!(git(repo.path(), &["status", "--porcelain"]).unwrap(), "", "the worktree folder is excluded locally");
        create(repo.path(), "Second").unwrap();
        let exclude = std::fs::read_to_string(repo.path().join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.matches("/.claude/worktrees/").count(), 1);
    }
    #[test]
    fn removal_keeps_uncommitted_and_unmerged_work() {
        let repo = repository();
        let (dirty, _) = create(repo.path(), "Dirty").unwrap();
        std::fs::write(Path::new(&dirty.path).join("note.txt"), "work").unwrap();
        assert_eq!(remove(&dirty), (false, false));
        let (unmerged, _) = create(repo.path(), "Unmerged").unwrap();
        let tree = Path::new(&unmerged.path);
        std::fs::write(tree.join("note.txt"), "work").unwrap();
        run(tree, &["add", "note.txt"]);
        run(tree, &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "work"]);
        assert_eq!(remove(&unmerged), (true, false), "the branch keeps the commit");
        let (clean, _) = create(repo.path(), "Clean").unwrap();
        assert_eq!(remove(&clean), (true, true));
    }
    fn commit_in(dir: &Path, file: &str, text: &str) {
        std::fs::write(dir.join(file), text).unwrap(); run(dir, &["add", file]);
        run(dir, &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", file]);
    }
    fn identity(dir: &Path) { run(dir, &["config", "user.email", "t@example.com"]); run(dir, &["config", "user.name", "t"]); }
    #[test]
    fn merging_commits_leftovers_and_brings_the_branch_into_the_checkout() {
        let repo = repository(); identity(repo.path());
        let (worktree, _) = create(repo.path(), "Feature").unwrap();
        let tree = Path::new(&worktree.path);
        commit_in(tree, "a.txt", "a");
        std::fs::write(tree.join("b.txt"), "b").unwrap();
        let before = status(&worktree).unwrap();
        assert_eq!((before.exists, before.ahead, before.dirty), (true, 1, true));
        assert_eq!(merge(&worktree, "Coffee: Feature").unwrap(), 2);
        assert!(repo.path().join("a.txt").exists() && repo.path().join("b.txt").exists());
        let after = status(&worktree).unwrap();
        assert_eq!((after.ahead, after.dirty), (0, false));
        assert_eq!(merge(&worktree, "again").unwrap(), 0);
        assert_eq!(remove(&worktree), (true, true), "a merged worktree is removed with its branch");
    }
    #[test]
    fn a_conflicting_merge_is_aborted_and_overwritten_changes_are_refused() {
        let repo = repository(); identity(repo.path());
        commit_in(repo.path(), "shared.txt", "base");
        let (worktree, _) = create(repo.path(), "Conflict").unwrap();
        commit_in(Path::new(&worktree.path), "shared.txt", "theirs");
        commit_in(repo.path(), "shared.txt", "ours");
        assert_eq!(merge(&worktree, "m").unwrap_err(), "COFFEE_MERGE:conflict");
        assert!(git(repo.path(), &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_err(), "the merge was aborted");
        assert_eq!(std::fs::read_to_string(repo.path().join("shared.txt")).unwrap(), "ours");
        let (other, _) = create(repo.path(), "Local").unwrap();
        commit_in(Path::new(&other.path), "local.txt", "theirs");
        std::fs::write(repo.path().join("local.txt"), "unsaved").unwrap();
        std::fs::write(Path::new(&other.path).join("left.txt"), "leftover").unwrap();
        assert_eq!(merge(&other, "m").unwrap_err(), "COFFEE_MERGE:local_changes");
        assert_eq!(std::fs::read_to_string(repo.path().join("local.txt")).unwrap(), "unsaved", "the user's file is untouched");
        assert_eq!(status(&other).unwrap().ahead, 1, "the leftover commit was undone");
        assert!(status(&other).unwrap().dirty, "and its files are uncommitted again");
    }
    #[test]
    fn worktrees_do_not_nest_and_unused_ones_are_swept() {
        let repo = repository(); identity(repo.path());
        let (kept, _) = create(repo.path(), "Kept").unwrap();
        let (unused, _) = create(repo.path(), "Unused").unwrap();
        let (busy, _) = create(repo.path(), "Busy").unwrap();
        std::fs::write(Path::new(&busy.path).join("work.txt"), "x").unwrap();
        assert!(create(Path::new(&kept.path), "Nested").unwrap_err().contains("already a worktree"));
        assert_eq!(sweep(repo.path(), std::slice::from_ref(&kept.path)).unwrap(), 1, "the unused worktree, with its merged branch");
        assert!(Path::new(&kept.path).is_dir() && Path::new(&busy.path).is_dir() && !Path::new(&unused.path).exists());
        assert!(git(repo.path(), &["rev-parse", "--verify", "--quiet", &unused.branch]).is_err());
        assert!(inside_worktrees("D:\\p\\.claude\\worktrees\\coffee-x") && !inside_worktrees("D:\\p\\worktrees"));
    }
    #[test]
    fn only_coffee_worktrees_are_accepted() {
        let root = Path::new("project");
        let good = Worktree { root: root.to_string_lossy().into_owned(), path: root.join(".claude").join("worktrees").join("coffee-x-1").to_string_lossy().into_owned(), branch: "coffee/x-1".into() };
        assert!(checked(&good).is_ok());
        assert!(checked(&Worktree { path: "project".into(), ..good.clone() }).is_err());
        assert!(checked(&Worktree { branch: "main".into(), ..good.clone() }).is_err());
        assert!(checked(&Worktree { branch: "coffee/x;rm".into(), ..good }).is_err());
    }
    #[test]
    fn non_repositories_and_empty_repositories_are_refused() {
        let plain = tempfile::tempdir().unwrap();
        assert!(create(plain.path(), "x").unwrap_err().contains("git repository"));
        let empty = tempfile::tempdir().unwrap(); run(empty.path(), &["init", "-q"]);
        assert!(create(empty.path(), "x").unwrap_err().contains("commit"));
    }
}
