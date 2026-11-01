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
    command.arg("-C").arg(dir).args(args).env("GIT_TERMINAL_PROMPT", "0");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().map_err(|_| "Git is not available".to_string())?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if error.is_empty() { format!("git {} failed", args.join(" ")) } else { error });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end_matches(['\r', '\n']).to_string())
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
        std::thread::sleep(std::time::Duration::from_secs(3));
        for worktree in &worktrees { let _ = remove(worktree); }
    });
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
    #[test]
    fn non_repositories_and_empty_repositories_are_refused() {
        let plain = tempfile::tempdir().unwrap();
        assert!(create(plain.path(), "x").unwrap_err().contains("git repository"));
        let empty = tempfile::tempdir().unwrap(); run(empty.path(), &["init", "-q"]);
        assert!(create(empty.path(), "x").unwrap_err().contains("commit"));
    }
}
