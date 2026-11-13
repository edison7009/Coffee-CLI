//! Files a browser sends to this computer (Web 端): attachments uploaded from
//! the device in hand, pasted screenshots, dropped files. Tools run on this
//! computer and read files by path, so an upload becomes a file in the temp
//! directory and the browser gets its path back.
//!
//! Sent in chunks: one encrypted frame is capped well below a screenshot.

use base64::Engine as _;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_FILE: u64 = 100 * 1024 * 1024;
/// Raw bytes per chunk, before base64; keeps each frame far under the cap.
pub const MAX_CHUNK: usize = 512 * 1024;
const MAX_OPEN: usize = 8;

pub struct Upload { file: std::fs::File, path: PathBuf, size: u64, written: u64 }

#[derive(Default)]
pub struct Uploads { open: HashMap<u64, Upload> }

static NEXT: AtomicU64 = AtomicU64::new(1);

fn dir() -> PathBuf { std::env::temp_dir().join("coffee-cli").join("uploads") }

/// Keeps a readable base name; anything that could leave the folder or confuse
/// a shell becomes `_`.
pub fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = base.chars().map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '`' | '$') { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let short: String = trimmed.chars().take(120).collect();
    if short.is_empty() { "file".into() } else { short }
}

impl Uploads {
    pub fn begin(&mut self, name: &str, size: u64) -> Result<u64, String> {
        if size > MAX_FILE { return Err(format!("File too large (max {} MB)", MAX_FILE / 1024 / 1024)); }
        if self.open.len() >= MAX_OPEN { return Err("Too many uploads at once".into()); }
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let folder = dir().join(format!("{}-{id}", chrono::Utc::now().timestamp_millis()));
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let path = folder.join(safe_name(name));
        let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        self.open.insert(id, Upload { file, path, size, written: 0 });
        Ok(id)
    }

    pub fn chunk(&mut self, id: u64, base64: &str) -> Result<u64, String> {
        let upload = self.open.get_mut(&id).ok_or("Unknown upload")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(base64).map_err(|_| "Bad chunk")?;
        if bytes.len() > MAX_CHUNK || upload.written + bytes.len() as u64 > upload.size {
            self.abort(id);
            return Err("Chunk does not fit the declared size".into());
        }
        if let Err(e) = upload.file.write_all(&bytes) { let message = e.to_string(); self.abort(id); return Err(message); }
        upload.written += bytes.len() as u64;
        Ok(upload.written)
    }

    pub fn finish(&mut self, id: u64) -> Result<String, String> {
        let upload = self.open.remove(&id).ok_or("Unknown upload")?;
        if upload.written != upload.size {
            let _ = std::fs::remove_file(&upload.path);
            return Err("Upload incomplete".into());
        }
        upload.file.sync_all().map_err(|e| e.to_string())?;
        Ok(upload.path.to_string_lossy().into_owned())
    }

    pub fn abort(&mut self, id: u64) {
        if let Some(upload) = self.open.remove(&id) { drop(upload.file); let _ = std::fs::remove_file(&upload.path); }
    }

    /// A disconnected browser leaves no half-written files behind.
    pub fn abort_all(&mut self) { for id in self.open.keys().copied().collect::<Vec<_>>() { self.abort(id); } }
}
