// Coffee CLI — Git Intelligence Module

use git2::{Repository, DiffOptions};
use std::path::Path;

/// Lightweight git status: only returns stats (files changed, insertions, deletions).
/// Much cheaper than get_working_diff() — no patch text generation.
pub fn get_git_status_summary(project_dir: &Path) -> Option<(usize, usize, usize)> {
    let repo = Repository::discover(project_dir).ok()?;
    let head_tree = repo.head().ok()
        .and_then(|h| h.peel_to_tree().ok());
    let mut diff_opts = DiffOptions::new();
    diff_opts.include_untracked(true);
    diff_opts.recurse_untracked_dirs(true);
    let diff = repo.diff_tree_to_workdir_with_index(
        head_tree.as_ref(),
        Some(&mut diff_opts),
    ).ok()?;
    let stats = diff.stats().ok()?;
    let fc = stats.files_changed();
    if fc == 0 { return None; }
    Some((fc, stats.insertions(), stats.deletions()))
}
