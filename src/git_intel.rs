// Coffee Mode — Git Intelligence Module
// Reads working tree diff and formats it for Super Prompt injection.

use git2::{Repository, DiffOptions, DiffFormat, Delta};
use std::path::Path;

/// Summary of git working tree changes.
pub struct GitDiffIntel {
    /// Human-readable diff summary for injection into Super Prompt.
    pub summary: String,
    /// Number of files changed.
    pub files_changed: usize,
    /// Total insertions.
    pub insertions: usize,
    /// Total deletions.
    pub deletions: usize,
}

/// Compute the working tree diff (unstaged + staged vs HEAD) for a project.
/// Returns None if the directory is not a git repo or git fails.
pub fn get_working_diff(project_dir: &Path) -> Option<GitDiffIntel> {
    let repo = Repository::discover(project_dir).ok()?;

    // Get HEAD tree (may fail on a brand new repo with no commits)
    let head_tree = repo.head().ok()
        .and_then(|h| h.peel_to_tree().ok());

    let mut diff_opts = DiffOptions::new();
    diff_opts.include_untracked(true);
    diff_opts.recurse_untracked_dirs(true);

    // Diff: HEAD vs working directory (includes both staged and unstaged)
    let diff = repo.diff_tree_to_workdir_with_index(
        head_tree.as_ref(),
        Some(&mut diff_opts),
    ).ok()?;

    let stats = diff.stats().ok()?;
    let files_changed = stats.files_changed();

    if files_changed == 0 {
        return None; // Clean working tree, nothing to report
    }

    let insertions = stats.insertions();
    let deletions = stats.deletions();

    // Build structured summary
    let mut summary = String::new();

    // Per-file change list
    let num_deltas = diff.deltas().len();
    for i in 0..num_deltas {
        let delta = diff.get_delta(i).unwrap();
        let status = match delta.status() {
            Delta::Added => "ADDED",
            Delta::Deleted => "DELETED",
            Delta::Modified => "MODIFIED",
            Delta::Renamed => "RENAMED",
            Delta::Copied => "COPIED",
            Delta::Untracked => "UNTRACKED",
            _ => "CHANGED",
        };
        let path = delta.new_file().path()
            .and_then(|p| p.to_str())
            .unwrap_or("unknown");
        summary.push_str(&format!("{}: {}\n", status, path));
    }

    // Append actual diff content (truncated to keep prompt size reasonable)
    let mut patch_text = Vec::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            patch_text.push(format!("{}{}", origin, 
                std::str::from_utf8(line.content()).unwrap_or("")));
        }
        true
    }).ok();

    let patch_str = patch_text.join("");
    // Truncate patch to ~8K chars to keep Super Prompt reasonable
    let max_patch = 8000;
    if !patch_str.is_empty() {
        summary.push_str("\n--- diff ---\n");
        if patch_str.len() > max_patch {
            let mut safe_end = max_patch;
            while safe_end > 0 && !patch_str.is_char_boundary(safe_end) {
                safe_end -= 1;
            }
            summary.push_str(&patch_str[..safe_end]);
            summary.push_str(&format!("\n... [truncated, {} more chars]", patch_str.len() - safe_end));
        } else {
            summary.push_str(&patch_str);
        }
    }

    Some(GitDiffIntel {
        summary,
        files_changed,
        insertions,
        deletions,
    })
}

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
