//! Notification sounds: the two built-in chimes, or a file the user chose in Settings.
//!
//! A chosen file is copied to `~/.coffee-cli/sounds/<kind>/`, so moving the original changes nothing and the folder
//! alone says what is chosen. Anything that stops a chosen file from playing falls back to the built-in chime.
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const EXTENSIONS: [&str; 2] = ["mp3", "wav"];
const MAX_BYTES: u64 = 20 * 1024 * 1024;

fn folder() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or("Home directory unavailable")?.join(".coffee-cli").join("sounds"))
}
fn kind_dir(root: &Path, kind: &str) -> Result<PathBuf, String> {
    if matches!(kind, "done" | "wait") { Ok(root.join(kind)) } else { Err("Unknown notification sound".into()) }
}
fn extension(path: &Path) -> Option<String> {
    path.extension()?.to_str().map(str::to_ascii_lowercase).filter(|ext| EXTENSIONS.contains(&ext.as_str()))
}
/// The chosen file of a kind. A leftover temporary file from an interrupted copy has another extension.
fn stored(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().map(|entry| entry.path()).find(|path| path.is_file() && extension(path).is_some())
}
/// Removes the chosen file. A sound that was just stopped holds it for a moment longer.
fn clear(dir: &Path) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(1);
    while let Some(path) = stored(dir) {
        if let Err(error) = std::fs::remove_file(path) {
            if Instant::now() >= deadline { return Err(error.to_string()); }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    Ok(())
}
fn choose(root: &Path, kind: &str, source: &Path) -> Result<String, String> {
    let dir = kind_dir(root, kind)?;
    extension(source).ok_or("Unsupported sound file")?;
    let name = source.file_name().ok_or("Unsupported sound file")?;
    if std::fs::metadata(source).map_err(|e| e.to_string())?.len() > MAX_BYTES { return Err("Sound file is too large".into()); }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Copied aside first, so a failed copy keeps the sound already chosen; the source may be that sound.
    let temporary = dir.join("choosing.tmp");
    std::fs::copy(source, &temporary).map_err(|e| e.to_string())?;
    let placed = clear(&dir).and_then(|()| std::fs::rename(&temporary, dir.join(name)).map_err(|e| e.to_string()));
    if placed.is_err() { let _ = std::fs::remove_file(&temporary); }
    placed.map(|()| name.to_string_lossy().into_owned())
}
fn stored_name(root: &Path, kind: &str) -> Option<String> {
    Some(stored(&kind_dir(root, kind).ok()?)?.file_name()?.to_string_lossy().into_owned())
}

#[derive(Serialize)]
pub struct Files { done: Option<String>, wait: Option<String> }

#[tauri::command]
pub fn notify_sound_files() -> Result<Files, String> {
    let root = folder()?;
    Ok(Files { done: stored_name(&root, "done"), wait: stored_name(&root, "wait") })
}
#[tauri::command]
pub async fn notify_sound_choose(kind: String, path: String) -> Result<String, String> {
    blocking(move || {
        let path = Path::new(&path);
        #[cfg(windows)]
        if extension(path).is_some() && !native::playable(path) { return Err("Unsupported sound file".into()); }
        #[cfg(windows)]
        native::stop();
        choose(&folder()?, &kind, path)
    }).await
}
#[tauri::command]
pub async fn notify_sound_clear(kind: String) -> Result<(), String> {
    blocking(move || {
        #[cfg(windows)]
        native::stop();
        clear(&kind_dir(&folder()?, &kind)?)
    }).await
}
/// The chosen file's bytes for playback in the WebView, or nothing when the built-in chime applies.
#[tauri::command]
pub async fn notify_sound_read(kind: String) -> Result<tauri::ipc::Response, String> {
    let bytes = blocking(move || {
        let path = stored(&kind_dir(&folder()?, &kind)?);
        path.map_or(Ok(vec![]), std::fs::read).map_err(|e| e.to_string())
    }).await?;
    Ok(tauri::ipc::Response::new(bytes))
}
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn play_notify_sound(kind: &str) -> Result<(), String> {
    #[cfg(windows)]
    { native::play(kind) }
    #[cfg(not(windows))]
    {
        let _ = kind;
        Err("Native notification sounds are Windows-only".into())
    }
}

#[cfg(windows)]
mod native {
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use super::{Duration, Instant};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    use windows::Win32::Media::Multimedia::mciSendStringW;

    /// A notification, not music: a long file stops here.
    const LONGEST: Duration = Duration::from_secs(10);
    /// The newest sound; an older one stops when it sees this has moved on.
    static LATEST: AtomicU64 = AtomicU64::new(0);

    pub fn play(kind: &str) -> Result<(), String> {
        let dir = super::kind_dir(&super::folder()?, kind)?;
        let turn = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(path) = super::stored(&dir) else { return built_in(kind) };
        let kind = kind.to_string();
        // MCI decodes and plays from the thread that opened the file, which stays to close it.
        std::thread::spawn(move || { if !play_file(&path, turn) && current(turn) { let _ = built_in(&kind); } });
        Ok(())
    }

    /// Stops whatever is playing, which lets go of its file.
    pub fn stop() { LATEST.fetch_add(1, Ordering::SeqCst); }
    fn current(turn: u64) -> bool { LATEST.load(Ordering::SeqCst) == turn }

    /// Whether Windows can open the file as audio at all.
    pub fn playable(path: &Path) -> bool {
        let alias = format!("coffee_sound_check_{:?}", std::thread::current().id()).replace(['(', ')'], "");
        let opened = mci(&open_command(path, &alias), None);
        if opened { mci(&format!("close {alias}"), None); }
        opened
    }
    // `mpegvideo` is the DirectShow device, which plays MP3 as well as WAV.
    fn open_command(path: &Path, alias: &str) -> String { format!("open \"{}\" type mpegvideo alias {alias}", path.display()) }

    fn built_in(kind: &str) -> Result<(), String> {
        let wav: &'static [u8] = match kind {
            "done" => include_bytes!("assets/notify-done.wav"),
            "wait" => include_bytes!("assets/notify-wait.wav"),
            _ => return Err("Unknown notification sound".into()),
        };
        // SND_MEMORY interprets the pointer as WAV bytes. Static storage must
        // outlive this asynchronous call; no WebView audio renderer is involved.
        unsafe {
            PlaySoundW(PCWSTR(wav.as_ptr().cast()), None, SND_ASYNC | SND_MEMORY | SND_NODEFAULT)
                .ok()
                .map_err(|error| error.to_string())
        }
    }

    fn mci(command: &str, reply: Option<&mut [u16]>) -> bool {
        unsafe { mciSendStringW(&HSTRING::from(command), reply, HWND::default()) == 0 }
    }

    /// False when the file could not start.
    pub(super) fn play_file(path: &Path, turn: u64) -> bool {
        let alias = format!("coffee_sound_{turn}");
        let opened = mci(&open_command(path, &alias), None);
        // Opening can be slow, and a newer sound may have begun meanwhile; that is no failure of this one.
        let started = opened && (!current(turn) || mci(&format!("play {alias}"), None));
        let begun = Instant::now();
        while started && current(turn) && begun.elapsed() < LONGEST {
            std::thread::sleep(Duration::from_millis(50));
            let mut mode = [0u16; 32];
            if !mci(&format!("status {alias} mode"), Some(&mut mode)) { break; }
            if String::from_utf16_lossy(&mode).trim_end_matches('\0') == "stopped" { break; }
        }
        if opened { mci(&format!("close {alias}"), None); }
        started
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chosen_sound_replaces_the_last_and_survives_its_source() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let first = source.path().join("完成.MP3");
        let second = source.path().join("second.wav");
        std::fs::write(&first, "one").unwrap();
        std::fs::write(&second, "two").unwrap();
        assert_eq!(choose(root.path(), "done", &first).unwrap(), "完成.MP3");
        assert_eq!(stored_name(root.path(), "done").as_deref(), Some("完成.MP3"));
        choose(root.path(), "done", &second).unwrap();
        std::fs::remove_file(&second).unwrap();
        assert_eq!(stored_name(root.path(), "done").as_deref(), Some("second.wav"));
        assert_eq!(std::fs::read_dir(root.path().join("done")).unwrap().count(), 1, "nothing is left beside it");
        assert_eq!(stored_name(root.path(), "wait"), None, "the other kind is untouched");
        clear(&root.path().join("done")).unwrap();
        assert_eq!(stored_name(root.path(), "done"), None);
    }
    #[test]
    fn choosing_again_from_the_stored_copy_keeps_it() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let file = source.path().join("a.mp3");
        std::fs::write(&file, "one").unwrap();
        choose(root.path(), "wait", &file).unwrap();
        let copy = root.path().join("wait").join("a.mp3");
        choose(root.path(), "wait", &copy).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"one");
    }
    #[test]
    fn unusable_files_change_nothing() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let good = source.path().join("good.mp3");
        std::fs::write(&good, "one").unwrap();
        choose(root.path(), "done", &good).unwrap();
        let text = source.path().join("notes.txt");
        std::fs::write(&text, "x").unwrap();
        let large = source.path().join("large.wav");
        std::fs::File::create(&large).unwrap().set_len(MAX_BYTES + 1).unwrap();
        assert!(choose(root.path(), "done", &text).is_err());
        assert_eq!(choose(root.path(), "done", &large).unwrap_err(), "Sound file is too large");
        assert!(choose(root.path(), "other", &good).is_err());
        assert_eq!(stored_name(root.path(), "done").as_deref(), Some("good.mp3"));
    }
    /// Plays through the real audio stack, so it stays out of ordinary runs. `COFFEE_SOUND_FILE` picks the file.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn plays_a_real_file() {
        let path = std::env::var("COFFEE_SOUND_FILE").unwrap();
        assert!(native::playable(Path::new(&path)));
        let fake = tempfile::Builder::new().suffix(".mp3").tempfile().unwrap();
        std::fs::write(fake.path(), "not audio").unwrap();
        assert!(!native::playable(fake.path()), "a renamed text file is refused");
        assert!(native::play_file(Path::new(&path), 0));
        assert!(!native::play_file(Path::new("C:/missing/sound.mp3"), 0), "a file that cannot start reports it");
    }
}
