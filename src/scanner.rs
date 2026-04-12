// Coffee CLI — Directory scanner using the `ignore` crate
// Same engine as ripgrep — respects .gitignore automatically

use crate::config::{MAX_DEPTH, MAX_FILES, MAX_FILE_SIZE};
use anyhow::Result;
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Metadata about a single scanned file
#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    /// Absolute path to the file
    pub path: PathBuf,
    /// Path relative to the scanned root directory
    pub relative_path: String,
    /// File size in bytes
    pub size: u64,
    /// File extension (lowercase)
    pub extension: String,
}

/// Result of scanning a directory
#[derive(Debug, Serialize)]
pub struct ScanResult {
    /// Root directory that was scanned
    pub root: PathBuf,
    /// All text files found
    pub files: Vec<FileEntry>,
    /// Files that were skipped (too large, binary, etc.)
    pub skipped: Vec<String>,
    /// Total files scanned
    pub total_scanned: usize,
}



/// Scan a directory and return all user-visible files
pub fn scan_directory(root: &Path) -> Result<ScanResult> {
    let root = root.canonicalize()?;
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total_scanned = 0;

    let walker = WalkBuilder::new(&root)
        .max_depth(Some(MAX_DEPTH))
        .hidden(true) // skip OS-hidden files (Windows Hidden attr, Unix dotfiles)
        .git_ignore(true) // respect .gitignore
        .git_global(true)
        .git_exclude(true)
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip directories themselves (they're created implicitly from file paths)
        if entry.file_type().map_or(true, |ft| !ft.is_file()) {
            continue;
        }

        // Exclude internal build/cache directories that are never useful to browse
        let rel = entry.path().strip_prefix(&root).unwrap_or(entry.path());
        let segments: Vec<&str> = rel.iter()
            .filter_map(|s| s.to_str())
            .collect();
        let in_excluded_dir = segments.iter().any(|seg| matches!(*seg,
            "node_modules" | ".git" | "target" | "__pycache__" |
            ".next" | ".nuxt" | ".svelte-kit" | ".parcel-cache" |
            ".turbo" | ".terraform" | ".serverless"
        ));
        if in_excluded_dir {
            continue;
        }

        total_scanned += 1;

        // Safety: cap at MAX_FILES
        if files.len() >= MAX_FILES {
            skipped.push(format!(
                "Reached file limit ({}), stopping scan",
                MAX_FILES
            ));
            break;
        }

        let path = entry.path().to_path_buf();
        let relative = path
            .strip_prefix(&root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");

        // Get file extension
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        // Get file size
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

        // Skip files that are too large
        if size > MAX_FILE_SIZE {
            skipped.push(format!("{} (too large: {} KB)", relative, size / 1024));
            continue;
        }

        files.push(FileEntry {
            path,
            relative_path: relative,
            size,
            extension,
        });
    }

    // Sort files by path for deterministic output
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    Ok(ScanResult {
        root,
        files,
        skipped,
        total_scanned,
    })
}


