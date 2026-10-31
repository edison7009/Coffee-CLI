use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: u64 = 1_000_000;
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Debug, Clone)]
pub struct ToolMemoryDocument {
    pub path: Option<String>,
    pub content: Option<String>,
}

fn read_at(path: &Path) -> Result<ToolMemoryDocument, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A broken link is unavailable, not a new document to replace.
            if fs::symlink_metadata(path).is_ok() { return Err("memory_read".into()); }
            return Ok(ToolMemoryDocument { path: Some(path.to_string_lossy().into_owned()), content: None });
        }
        Err(_) => return Err("memory_read".into()),
    };
    if !file.metadata().map_err(|_| "memory_read")?.is_file() { return Err("memory_read".into()); }
    let mut bytes = Vec::new();
    (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "memory_read")?;
    if bytes.len() as u64 > MAX_BYTES { return Err("memory_size".into()); }
    if bytes.contains(&0) { return Err("memory_encoding".into()); }
    let content = String::from_utf8(bytes).map_err(|_| "memory_encoding")?;
    let resolved = fs::canonicalize(path).map_err(|_| "memory_read")?;
    Ok(ToolMemoryDocument { path: Some(dunce::simplified(&resolved).to_string_lossy().into_owned()), content: Some(content) })
}

fn load_from(tool: &str, home: &Path, env: impl Fn(&str) -> Option<std::ffi::OsString>) -> Result<ToolMemoryDocument, String> {
    let root = |name: &str, fallback: PathBuf| env(name).filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or(fallback);
    let (directory, filename) = match tool {
        "claude" => (root("CLAUDE_CONFIG_DIR", home.join(".claude")), "CLAUDE.md"),
        "codex" => (root("CODEX_HOME", home.join(".codex")), "AGENTS.md"),
        "copilot" => (home.join(".copilot"), "copilot-instructions.md"),
        "opencode" => (root("XDG_CONFIG_HOME", home.join(".config")).join("opencode"), "AGENTS.md"),
        "pi" => (root("PI_CODING_AGENT_DIR", home.join(".pi/agent")), "AGENTS.md"),
        "hermes" => (crate::tools::hermes::hermes_home(), "SOUL.md"),
        "dsh" => (root("DSH_HOME", home.join(".dsh")), "AGENTS.md"),
        _ => return Ok(ToolMemoryDocument { path: None, content: None }),
    };
    let directory = if directory.is_absolute() { directory } else {
        std::env::current_dir().map_err(|_| "memory_read")?.join(directory)
    };
    if matches!(tool, "codex" | "pi") {
        let document = read_at(&directory.join("AGENTS.override.md"))?;
        if document.content.as_ref().is_some_and(|text| !text.trim().is_empty()) { return Ok(document); }
    }
    if tool == "pi" {
        for filename in ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] {
            let document = read_at(&directory.join(filename))?;
            if document.content.is_some() { return Ok(document); }
        }
    }
    read_at(&directory.join(filename))
}

fn load(tool: &str) -> Result<ToolMemoryDocument, String> {
    load_from(tool, &dirs::home_dir().ok_or("memory_read")?, |name| std::env::var_os(name))
}

fn save_at(document: ToolMemoryDocument, path: &str, original: Option<&str>, content: &str) -> Result<ToolMemoryDocument, String> {
    if document.path.as_deref() != Some(path) || document.content.as_deref() != original { return Err("memory_conflict".into()); }
    let path = Path::new(path);
    let permissions = if original.is_some() {
        let permissions = fs::metadata(path).map_err(|_| "memory_read")?.permissions();
        if permissions.readonly() { return Err("memory_readonly".into()); }
        Some(permissions)
    } else { None };
    let mut text = content.to_owned();
    if let Some(original) = original {
        if original.contains("\r\n") && !original.replace("\r\n", "").contains('\n') { text = text.replace("\r\n", "\n").replace('\n', "\r\n"); }
        if original.starts_with('\u{feff}') && !text.starts_with('\u{feff}') { text.insert(0, '\u{feff}'); }
    }
    if text.len() as u64 > MAX_BYTES { return Err("memory_size".into()); }
    if text.contains('\0') { return Err("memory_encoding".into()); }
    fs::create_dir_all(path.parent().ok_or("memory_write")?).map_err(|_| "memory_write")?;
    let temp = path.with_file_name(format!(".coffee-memory-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temp).map_err(|_| "memory_write")?;
        file.write_all(text.as_bytes()).map_err(|_| "memory_write")?;
        if let Some(permissions) = permissions { file.set_permissions(permissions).map_err(|_| "memory_write")?; }
        file.sync_all().map_err(|_| "memory_write")?;
        drop(file);
        if read_at(path)?.content.as_deref() != original { return Err("memory_conflict".into()); }
        crate::agent::replace_file(&temp, path).map_err(|_| "memory_write")?;
        read_at(path)
    })();
    if result.is_err() { let _ = fs::remove_file(&temp); }
    result
}

#[tauri::command]
pub async fn read_tool_memory(tool: String) -> Result<ToolMemoryDocument, String> {
    tauri::async_runtime::spawn_blocking(move || load(&tool)).await.map_err(|_| "memory_read")?
}

#[tauri::command]
pub async fn save_tool_memory(tool: String, path: String, original: Option<String>, content: String) -> Result<ToolMemoryDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SAVE_LOCK.lock().map_err(|_| "memory_write")?;
        save_at(load(&tool)?, &path, original.as_deref(), &content)
    }).await.map_err(|_| "memory_write")?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self { Self(dunce::canonicalize(std::env::temp_dir()).unwrap().join(format!("coffee-memory-test-{}", uuid::Uuid::new_v4()))) }
        fn load(&self, tool: &str) -> ToolMemoryDocument { load_from(tool, &self.0, |_| None).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    #[test]
    fn paths_respect_overrides_and_reads_do_not_create_files() {
        let f = Fixture::new();
        for (tool, relative) in [("claude", ".claude/CLAUDE.md"), ("codex", ".codex/AGENTS.md"), ("copilot", ".copilot/copilot-instructions.md"), ("opencode", ".config/opencode/AGENTS.md"), ("pi", ".pi/agent/AGENTS.md")] {
            let document = f.load(tool);
            assert_eq!(PathBuf::from(document.path.unwrap()), f.0.join(relative));
            assert!(document.content.is_none());
        }
        let custom = f.0.join("custom");
        let document = load_from("claude", &f.0, |name| (name == "CLAUDE_CONFIG_DIR").then(|| custom.clone().into_os_string())).unwrap();
        assert_eq!(document.path.unwrap(), custom.join("CLAUDE.md").to_string_lossy());
        assert!(f.load("unknown").path.is_none());
        assert!(f.load("../../other").path.is_none());
        assert!(!f.0.exists());
    }

    #[test]
    fn create_edit_conflict_and_format_preservation() {
        let f = Fixture::new();
        let initial = f.load("claude"); let path = initial.path.clone().unwrap();
        let saved = save_at(initial, &path, None, "你好\nfirst").unwrap();
        assert_eq!(saved.content.as_deref(), Some("你好\nfirst"));
        fs::write(&path, "external edit").unwrap();
        assert_eq!(save_at(f.load("claude"), &path, saved.content.as_deref(), "stale edit").unwrap_err(), "memory_conflict");
        assert_eq!(fs::read_to_string(&path).unwrap(), "external edit");
        assert_eq!(save_at(f.load("claude"), "another-file", Some("external edit"), "wrong").unwrap_err(), "memory_conflict");
        fs::write(&path, "\u{feff}one\r\ntwo\r\n").unwrap();
        let document = f.load("claude"); let original = document.content.clone();
        let saved = save_at(document, &path, original.as_deref(), "one\nchanged\n").unwrap();
        assert_eq!(saved.content.as_deref(), Some("\u{feff}one\r\nchanged\r\n"));
        fs::remove_file(&path).unwrap();
        assert_eq!(save_at(f.load("claude"), &path, saved.content.as_deref(), "removed").unwrap_err(), "memory_conflict");
        assert!(!Path::new(&path).exists());
    }

    #[test]
    fn rejects_large_binary_directory_and_readonly_files() {
        let f = Fixture::new(); let initial = f.load("codex"); let path = initial.path.clone().unwrap();
        assert_eq!(save_at(initial.clone(), &path, None, &"x".repeat(MAX_BYTES as usize + 1)).unwrap_err(), "memory_size");
        assert!(!f.0.exists());
        assert_eq!(save_at(initial.clone(), &path, None, "a\0b").unwrap_err(), "memory_encoding");
        save_at(initial, &path, None, "keep").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions(); permissions.set_readonly(true); fs::set_permissions(&path, permissions.clone()).unwrap();
        assert_eq!(save_at(f.load("codex"), &path, Some("keep"), "change").unwrap_err(), "memory_readonly");
        #[allow(clippy::permissions_set_readonly_false)]
        { permissions.set_readonly(false); }
        fs::set_permissions(&path, permissions).unwrap();
        fs::write(&path, vec![0xff, 0xfe]).unwrap(); assert_eq!(read_at(Path::new(&path)).unwrap_err(), "memory_encoding");
        fs::write(&path, "a\0b").unwrap(); assert_eq!(read_at(Path::new(&path)).unwrap_err(), "memory_encoding");
        fs::remove_file(&path).unwrap(); fs::create_dir(&path).unwrap(); assert!(read_at(Path::new(&path)).is_err());
    }

    #[test]
    fn active_override_and_file_appearance_are_not_overwritten() {
        let f = Fixture::new(); let initial = f.load("codex"); let path = initial.path.clone().unwrap();
        save_at(initial.clone(), &path, None, "base").unwrap();
        assert_eq!(save_at(f.load("codex"), &path, None, "new").unwrap_err(), "memory_conflict");
        let other = f.0.join(".codex/AGENTS.override.md"); fs::write(&other, "override").unwrap();
        assert_eq!(f.load("codex").content.as_deref(), Some("override"));
        assert_eq!(save_at(f.load("codex"), &path, Some("base"), "wrong").unwrap_err(), "memory_conflict");
        fs::write(&other, " \n").unwrap(); assert_eq!(f.load("codex").content.as_deref(), Some("base"));
    }

    #[cfg(unix)]
    #[test]
    fn edits_symlink_targets_without_replacing_links() {
        let f = Fixture::new(); fs::create_dir_all(f.0.join(".claude")).unwrap();
        let target = f.0.join("instructions.md"); fs::write(&target, "original").unwrap();
        let link = f.0.join(".claude/CLAUDE.md"); std::os::unix::fs::symlink(&target, &link).unwrap();
        let document = f.load("claude"); let path = document.path.clone().unwrap();
        save_at(document, &path, Some("original"), "updated").unwrap();
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(target).unwrap(), "updated");
    }
}
