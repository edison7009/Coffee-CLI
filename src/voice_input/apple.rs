//! Apple Speech consumes the same PCM capture and emits the same draft events as other channels.
use super::*;
use std::ffi::{c_char, c_void, CStr, CString};

extern "C" {
    fn coffee_apple_speech_available() -> bool;
    fn coffee_apple_speech_ready() -> bool;
    fn coffee_apple_speech_start(
        id: u64,
        locale: *const c_char,
        callback: extern "C" fn(u64, u32, *const c_char),
    ) -> *mut c_void;
    fn coffee_apple_speech_append(handle: *mut c_void, samples: *const i16, count: u32);
    fn coffee_apple_speech_finish(handle: *mut c_void);
    fn coffee_apple_speech_drop(handle: *mut c_void);
}

static CALLBACKS: LazyLock<Mutex<HashMap<u64, mpsc::UnboundedSender<VoiceEvent>>>> =
    LazyLock::new(Default::default);

extern "C" fn callback(id: u64, kind: u32, text: *const c_char) {
    let text = if text.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    };
    let event = match kind {
        0 => VoiceEvent::Ready,
        1 | 2 => VoiceEvent::Text {
            text,
            done: kind == 2,
        },
        _ => VoiceEvent::Error { message: text },
    };
    if let Ok(callbacks) = CALLBACKS.lock() {
        if let Some(sender) = callbacks.get(&id) {
            let _ = sender.send(event);
        }
    }
}

struct Session {
    handle: *mut c_void,
    id: u64,
}
// The Objective-C session synchronizes all access; Apple authorization runs on the main queue.
unsafe impl Send for Session {}
impl Drop for Session {
    fn drop(&mut self) {
        CALLBACKS.lock().unwrap().remove(&self.id);
        unsafe {
            coffee_apple_speech_drop(self.handle);
        }
    }
}

pub(super) fn available() -> bool {
    unsafe { coffee_apple_speech_available() }
}

pub(super) fn ready() -> bool {
    unsafe { coffee_apple_speech_ready() }
}

pub(super) async fn run(
    language: &str,
    mut audio: mpsc::UnboundedReceiver<Vec<i16>>,
    mut control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let locale = match language {
        "zh" => "zh-CN",
        "en" => "en-US",
        "ja" => "ja-JP",
        "ko" => "ko-KR",
        "es" => "es-ES",
        "fr" => "fr-FR",
        "de" => "de-DE",
        "pt" => "pt-BR",
        "ru" => "ru-RU",
        "vi" => "vi-VN",
        other => other,
    };
    let locale = CString::new(locale).map_err(|_| "speech_unavailable")?;
    let (sender, mut events) = mpsc::unbounded_channel();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    CALLBACKS.lock().unwrap().insert(id, sender);
    let handle = unsafe { coffee_apple_speech_start(id, locale.as_ptr(), callback) };
    if handle.is_null() {
        CALLBACKS.lock().unwrap().remove(&id);
        return Err("speech_unavailable".into());
    }
    let session = Session { handle, id };
    let mut ready = false;
    let mut closing = false;
    let mut deadline = Instant::now() + Duration::from_secs(120);
    loop {
        tokio::select! {
            biased;
            command = control.recv() => match command {
                Some(Control::Finish) if ready && !closing => {
                    stop_capture();
                    while let Ok(chunk) = audio.try_recv() { unsafe { coffee_apple_speech_append(session.handle,chunk.as_ptr(),chunk.len() as u32); } }
                    unsafe { coffee_apple_speech_finish(session.handle); }
                    closing=true;deadline=Instant::now()+Duration::from_secs(10);
                },
                Some(Control::Finish) if !ready => return Ok(()),
                Some(Control::Cancel)|None => return Ok(()),
                _=>{},
            },
            _ = tokio::time::sleep_until(deadline), if !ready || closing => return Err("speech_timeout".into()),
            event = events.recv() => match event {
                Some(VoiceEvent::Ready) => { while audio.try_recv().is_ok() {} ready=true;emit(VoiceEvent::Ready); },
                Some(VoiceEvent::Error {message}) => return Err(message),
                Some(event) => { let done=matches!(event,VoiceEvent::Text {done:true,..});emit(event);if done {return Ok(());} },
                None => return Err("speech_failed".into()),
            },
            chunk = audio.recv(), if ready && !closing => match chunk {
                Some(chunk) => { emit(VoiceEvent::Level {level:level(&chunk)});unsafe { coffee_apple_speech_append(session.handle,chunk.as_ptr(),chunk.len() as u32); } },
                None => return Err("microphone_closed".into()),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    /// Release builds target older macOS versions than the build machine. There, `@available` compiles to a call
    /// into the compiler's runtime library, which the Rust link does not include, and the app failed to link.
    #[test]
    fn speech_bridge_needs_no_compiler_runtime_on_older_macos() {
        let source = concat!(env!("CARGO_MANIFEST_DIR"), "/src/voice_input/apple_speech.m");
        let dir = std::env::temp_dir().join(format!("coffee-apple-speech-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for arch in ["arm64", "x86_64"] {
            let object = dir.join(format!("{arch}.o"));
            let built = std::process::Command::new("xcrun")
                .args(["clang", "-arch", arch, "-mmacosx-version-min=10.13", "-fobjc-arc", "-fblocks", "-c", source, "-o"])
                .arg(&object).status().unwrap();
            assert!(built.success(), "the bridge compiles for {arch}");
            let symbols = std::process::Command::new("nm").arg(&object).output().unwrap();
            assert!(!String::from_utf8_lossy(&symbols.stdout).contains("isPlatformVersionAtLeast"), "{arch} needs the compiler runtime");
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
