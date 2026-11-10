//! Voice input for the composer: the microphone streams to the signed-in tool's own speech-to-text
//! service, the same one its desktop app uses, and the text streams back into our draft.
//! Claude: `api.anthropic.com/api/ws/speech_to_text/voice_stream` (raw PCM16 frames, bearer header).
//! Codex: `chatgpt.com/backend-api/dictation/stream` (JSON events, bearer in the subprotocol).
//! The stored sign-in is only read, never refreshed, like the usage meter.
use crate::usage_quota::providers::account::{self, Account};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{atomic::{AtomicU64, Ordering}, LazyLock, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::{sync::mpsc, time::Instant};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};
mod doubao;
mod workbuddy;
mod cursor;
mod echo;
pub(crate) mod probe;
#[cfg(target_os = "macos")]
mod apple;

pub const SAMPLE_RATE: u32 = 16_000;
/// 100 ms of audio per frame.
const CHUNK: usize = SAMPLE_RATE as usize / 10;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VoiceEvent {
    /// The service accepted the stream; speech from here on is transcribed.
    Ready,
    /// Recording ended automatically or manually; the batch service is processing it.
    Processing,
    /// Everything heard so far in this recording. `done` marks the service's final text.
    Text { text: String, done: bool },
    Error { message: String },
    /// Loudness of the last 100 ms of microphone audio, 0–1, for the waveform.
    Level { level: f32 },
}

pub enum Control { Finish, Cancel }

static SESSIONS: LazyLock<Mutex<HashMap<u64, mpsc::UnboundedSender<Control>>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn voice_tool(tool: &str) -> Option<&'static str> {
    match tool { "claude" => Some("claude"), "codex" => Some("codex"), _ => None }
}

/// The tool's stored account sign-in, only while the tool itself uses it: a relay or API key configured
/// for this folder means the vendor's speech service is not what the user signed up to reach.
fn signed_in(tool: &str, cwd: Option<String>) -> Option<Account> {
    if !crate::usage_quota::account_mode(voice_tool(tool)?, cwd) { return None; }
    let var = |key: &str| std::env::var(key).ok();
    account::credentials(voice_tool(tool)?, &dirs::home_dir()?, &var)
}

/// A selected dictation account is independent of the tool receiving the text.
fn source_account(source: &str) -> Option<Account> {
    let var = |key: &str| std::env::var(key).ok();
    local_account(source, &dirs::home_dir()?, &var)
}

fn local_account(source: &str, home: &std::path::Path, var: &dyn Fn(&str) -> Option<String>) -> Option<Account> {
    account::credentials(voice_tool(source)?, home, var)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSource { id: String, name: String, account_id: Option<String>, issue: Option<&'static str>, #[serde(skip_serializing_if="Option::is_none")] transcription_mode: Option<&'static str> }

/// Offer usable local sign-ins and system speech. Tokens never cross IPC.
#[tauri::command]
pub async fn voice_input_sources() -> Result<Vec<VoiceSource>, String> {
    let mut sources: Vec<VoiceSource> = tauri::async_runtime::spawn_blocking(|| {
        [("claude", "Claude Code"), ("codex", "Codex / ChatGPT")].into_iter()
            .filter_map(|(id, name)| {
                let account = source_account(id)?;
                let account_id = account.account_id.or_else(|| {
                    if id != "claude" { return None; }
                    let config = std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|path| !path.trim().is_empty())
                        .map(|path| std::path::PathBuf::from(path).join(".claude.json"))
                        .or_else(|| dirs::home_dir().map(|home| home.join(".claude.json")))?;
                    let value: Value = serde_json::from_slice(&std::fs::read(config).ok()?).ok()?;
                    value["oauthAccount"]["accountUuid"].as_str().filter(|id| !id.is_empty()).map(str::to_owned)
                });
                Some(VoiceSource { id:id.into(), name:name.into(), account_id, issue:None, transcription_mode:None })
            }).collect()
    }).await.map_err(|_| "scan_failed".to_string())?;
    #[cfg(target_os = "macos")]
    if apple::available() { sources.push(VoiceSource {id:"macos".into(),name:"macOS".into(),account_id:None,issue:None,transcription_mode:None}); }
    let (consumer, work, buddy, editor) = tokio::join!(doubao::account("doubao"), doubao::account("doubaowork"), workbuddy::account(), cursor::account());
    for (result, id, label) in [(consumer,"doubao","Doubao"),(work,"doubaowork","Doubao Work")] {
        if let Ok(account) = result {
            sources.push(VoiceSource { id:id.into(), name:label.into(),account_id:Some(account.user_id),issue:None,transcription_mode:None });
        } else if result.err().as_deref() == Some("source_busy") {
            sources.push(VoiceSource { id:id.into(),name:label.into(),account_id:None,issue:Some("busy"),transcription_mode:None });
        }
    }
    if let Ok(account) = buddy {
        sources.push(VoiceSource {id:"workbuddy".into(),name:"WorkBuddy".into(),account_id:Some(account.user_id),issue:None,transcription_mode:None});
    }
    if let Ok(account) = editor {
        sources.push(VoiceSource {id:"cursor".into(),name:"Cursor".into(),account_id:Some(account.user_id),issue:None,transcription_mode:None});
    }
    sources.extend(echo::sources().await);
    Ok(sources)
}

#[tauri::command]
pub async fn voice_input_select_source(source: String) -> Result<(),String> {
    if doubao::supports(&source) { doubao::select(&source).await?; }
    Ok(())
}

fn resolve_account(tool: &str, cwd: Option<String>, source: Option<&str>) -> Option<Account> {
    match source { Some(source) => source_account(source), None => signed_in(tool, cwd) }
}

enum InputAccount { Tool(&'static str, Account), Doubao(doubao::Credentials), WorkBuddy(workbuddy::Credentials), Cursor(cursor::Credentials), Native(echo::Credentials), #[cfg(target_os = "macos")] Apple }

async fn input_account(tool: String, cwd: Option<String>, source: Option<String>) -> Result<InputAccount, String> {
    if source.is_some() && voice_tool(&tool).is_some() {
        let current_tool = tool.clone();
        let current_cwd = cwd.clone();
        let official = tauri::async_runtime::spawn_blocking(move || signed_in(&current_tool, current_cwd))
            .await.ok().flatten();
        if let Some(account) = official {
            return Ok(InputAccount::Tool(voice_tool(&tool).unwrap(), account));
        }
    }
    if let Some(source)=source.as_ref().filter(|s|echo::supports(s)) { return echo::account(source.clone()).await.map(InputAccount::Native); }
    if source.as_deref() == Some("workbuddy") { return workbuddy::account().await.map(InputAccount::WorkBuddy); }
    if source.as_deref() == Some("cursor") { return cursor::account().await.map(InputAccount::Cursor); }
    #[cfg(target_os = "macos")]
    if source.as_deref() == Some("macos") { return if apple::available() {Ok(InputAccount::Apple)} else {Err("speech_unavailable".into())}; }
    if let Some(source) = source.as_deref().filter(|source| doubao::supports(source)) {
        return doubao::account(source).await.map(InputAccount::Doubao);
    }
    let kind = voice_tool(source.as_deref().unwrap_or(&tool)).ok_or("signed_out")?;
    let account = tauri::async_runtime::spawn_blocking(move || resolve_account(&tool, cwd, source.as_deref())).await.ok().flatten().ok_or("signed_out")?;
    Ok(InputAccount::Tool(kind,account))
}

/// Use the explicit local source, or follow the current tool's account mode.
#[tauri::command]
pub async fn voice_input_available(tool: String, cwd: Option<String>, source: Option<String>) -> bool {
    input_account(tool,cwd,source).await.is_ok()
}

#[tauri::command]
pub async fn voice_input_start(tool: String, cwd: Option<String>, source: Option<String>, language: String, device: Option<String>, on_event: Channel<VoiceEvent>) -> Result<u64, String> {
    let account = input_account(tool,cwd,source).await?;
    let (audio_tx, audio_rx) = mpsc::unbounded_channel();
    let capture = capture::start(audio_tx, device)?;
    let (control_tx, control_rx) = mpsc::unbounded_channel();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    SESSIONS.lock().unwrap().insert(id, control_tx);
    tauri::async_runtime::spawn(async move {
        let emit = |event: VoiceEvent| { let _ = on_event.send(event); };
        let result = match account {
            InputAccount::Tool("codex", account) => run_codex(&account.token, audio_rx, control_rx, &emit, || capture.stop()).await,
            InputAccount::Tool(_, account) => run_claude(&account.token, &language, audio_rx, control_rx, &emit, || capture.stop()).await,
            InputAccount::Doubao(account) => doubao::run(account,audio_rx,control_rx,&emit,|| capture.stop()).await,
            InputAccount::WorkBuddy(account) => workbuddy::run(account,audio_rx,control_rx,&emit,|| capture.stop()).await,
            InputAccount::Cursor(account) => cursor::run(account,audio_rx,control_rx,&emit,|| capture.stop()).await,
            InputAccount::Native(account) => echo::run(account,audio_rx,control_rx,&emit,|| capture.stop()).await,
            #[cfg(target_os = "macos")]
            InputAccount::Apple => apple::run(&language,audio_rx,control_rx,&emit,|| capture.stop()).await,
        };
        capture.stop();
        SESSIONS.lock().unwrap().remove(&id);
        if let Err(message) = result { emit(VoiceEvent::Error { message }); }
    });
    Ok(id)
}

fn control(id: u64, command: Control) {
    if let Some(sender) = SESSIONS.lock().unwrap().get(&id) { let _ = sender.send(command); }
}

/// Stop listening and wait for the service's final text.
#[tauri::command]
pub fn voice_input_finish(id: u64) { control(id, Control::Finish); }

/// Stop listening and drop the recording.
#[tauri::command]
pub fn voice_input_cancel(id: u64) { control(id, Control::Cancel); }

#[derive(Serialize)]
pub struct Microphones { devices: Vec<String>, default: Option<String> }

/// Input devices by name, and which one the system uses by default.
#[tauri::command]
pub async fn voice_input_devices() -> Microphones {
    tauri::async_runtime::spawn_blocking(capture::devices).await.unwrap_or(Microphones { devices: Vec::new(), default: None })
}

static TESTS: LazyLock<Mutex<HashMap<u64, std::sync::Arc<capture::Capture>>>> = LazyLock::new(Default::default);

/// Microphone check for Settings: streams the loudness of the chosen device, nothing leaves the machine.
#[tauri::command]
pub async fn voice_mic_test_start(device: Option<String>, on_level: Channel<f32>) -> Result<u64, String> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let capture = std::sync::Arc::new(capture::start(tx, device)?);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    TESTS.lock().unwrap().insert(id, capture);
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = rx.recv().await { if on_level.send(level(&chunk)).is_err() { break; } }
        if let Some(capture) = TESTS.lock().unwrap().remove(&id) { capture.stop(); }
    });
    Ok(id)
}

#[tauri::command]
pub async fn voice_mic_test_stop(id: u64) {
    if let Some(capture) = TESTS.lock().unwrap().remove(&id) { capture.stop(); }
}

/// Concatenate recognized pieces: a space between two Latin words, nothing between CJK text.
pub fn join(parts: impl IntoIterator<Item = String>) -> String {
    let mut out = String::new();
    for part in parts {
        let part = part.trim();
        if part.is_empty() { continue; }
        let wide = |c: char| (c as u32) >= 0x2E80;
        if let (Some(last), Some(first)) = (out.chars().last(), part.chars().next()) {
            if !wide(last) && !wide(first) { out.push(' '); }
        }
        out.push_str(part);
    }
    out
}

/// Loudness of a chunk on Claude's dictation scale: RMS in dBFS mapped from −50…−20 dB onto 0–1.
pub fn level(samples: &[i16]) -> f32 {
    if samples.is_empty() { return 0.0; }
    let power = samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / samples.len() as f64;
    if power == 0.0 { return 0.0; }
    let db = 20.0 * (power.sqrt() / 32768.0).log10();
    ((db + 50.0) / 30.0).clamp(0.0, 1.0) as f32
}

fn pcm_bytes(samples: &[i16]) -> Vec<u8> { samples.iter().flat_map(|s| s.to_le_bytes()).collect() }

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(request: tokio_tungstenite::tungstenite::handshake::client::Request) -> Result<Socket, String> {
    let connecting = tokio_tungstenite::connect_async(request);
    match tokio::time::timeout(Duration::from_secs(10), connecting).await {
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => Err(format!("http_{}", response.status().as_u16())),
        Ok(Err(error)) => Err(format!("connect: {error}")),
        Err(_) => Err("connect: timed out".into()),
    }
}

fn header(value: &str) -> Result<HeaderValue, String> { HeaderValue::from_str(value).map_err(|e| e.to_string()) }

/// Claude's partial text is the whole current utterance; an endpoint settles it.
#[derive(Default)]
pub struct ClaudeTranscript { settled: Vec<String>, current: String }

impl ClaudeTranscript {
    /// Returns true when the message changed the text.
    pub fn apply(&mut self, message: &Value) -> Result<bool, String> {
        match message["type"].as_str().unwrap_or("") {
            "TranscriptInterim" | "TranscriptText" => {
                let text = message["data"].as_str().unwrap_or("");
                if text.is_empty() || text == self.current { return Ok(false); }
                self.current = text.to_string();
                Ok(true)
            }
            "TranscriptEndpoint" => { self.settle(); Ok(false) }
            "TranscriptError" => Err(message["description"].as_str().or(message["error_code"].as_str()).unwrap_or("transcription error").to_string()),
            "error" => Err(message["message"].as_str().unwrap_or("transcription error").to_string()),
            _ => Ok(false),
        }
    }
    pub fn settle(&mut self) { if !self.current.is_empty() { self.settled.push(std::mem::take(&mut self.current)); } }
    pub fn text(&self) -> String { join(self.settled.iter().cloned().chain([self.current.clone()])) }
}

async fn run_claude(
    token: &str, language: &str, mut audio: mpsc::UnboundedReceiver<Vec<i16>>, mut control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync), stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("encoding", "linear16").append_pair("sample_rate", &SAMPLE_RATE.to_string()).append_pair("channels", "1")
        .append_pair("endpointing_ms", "300").append_pair("utterance_end_ms", "1000")
        .append_pair("language", if language.trim().is_empty() { "en" } else { language })
        .append_pair("use_conversation_engine", "true").finish();
    let mut request = format!("wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?{query}").into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.insert("Authorization", header(&format!("Bearer {token}"))?);
    headers.insert("x-app", header("cli")?);
    headers.insert("User-Agent", header(concat!("coffee-cli/", env!("CARGO_PKG_VERSION")))?);
    let mut socket = tokio::select! {
        socket = connect(request) => socket?,
        _ = control.recv() => return Ok(()),
    };
    let keep_alive = || Message::Text(r#"{"type":"KeepAlive"}"#.into());
    socket.send(keep_alive()).await.map_err(|e| e.to_string())?;
    emit(VoiceEvent::Ready);
    let mut transcript = ClaudeTranscript::default();
    let mut ticker = tokio::time::interval(Duration::from_secs(8));
    ticker.tick().await;
    // After CloseStream: done at the next endpoint, 1.5 s of silence from the server, or 5 s at most.
    let mut closing: Option<(Instant, Instant)> = None;
    loop {
        let deadline = closing.map(|(hard, idle)| hard.min(idle)).unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            chunk = audio.recv(), if closing.is_none() => if let Some(chunk) = chunk {
                emit(VoiceEvent::Level { level: level(&chunk) });
                socket.send(Message::Binary(pcm_bytes(&chunk).into())).await.map_err(|e| e.to_string())?;
            },
            command = control.recv(), if closing.is_none() => match command {
                Some(Control::Finish) => {
                    stop_capture();
                    while let Ok(chunk) = audio.try_recv() { let _ = socket.send(Message::Binary(pcm_bytes(&chunk).into())).await; }
                    socket.send(Message::Text(r#"{"type":"CloseStream"}"#.into())).await.map_err(|e| e.to_string())?;
                    let now = Instant::now();
                    closing = Some((now + Duration::from_secs(5), now + Duration::from_millis(1500)));
                }
                Some(Control::Cancel) | None => { let _ = socket.close(None).await; return Ok(()); }
            },
            _ = ticker.tick(), if closing.is_none() => { socket.send(keep_alive()).await.map_err(|e| e.to_string())?; }
            _ = tokio::time::sleep_until(deadline), if closing.is_some() => break,
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    if let Some((_, idle)) = closing.as_mut() { *idle = Instant::now() + Duration::from_millis(1500); }
                    if transcript.apply(&value)? { emit(VoiceEvent::Text { text: transcript.text(), done: false }); }
                    if closing.is_some() && value["type"] == "TranscriptEndpoint" { break; }
                }
                Some(Ok(Message::Close(frame))) if closing.is_none() => {
                    return Err(format!("closed: {}", frame.map(|f| f.reason.to_string()).unwrap_or_default()));
                }
                None if closing.is_none() => return Err("closed".into()),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(error)) => return Err(error.to_string()),
                _ => {}
            },
        }
    }
    let _ = socket.close(None).await;
    transcript.settle();
    emit(VoiceEvent::Text { text: transcript.text(), done: true });
    Ok(())
}

/// Codex streams per-utterance segments by revision; a final replaces its segment.
#[derive(Default)]
pub struct CodexTranscript { order: Vec<String>, entries: HashMap<String, (i64, String, bool)> }

impl CodexTranscript {
    pub fn apply(&mut self, message: &Value) -> Result<bool, String> {
        let kind = message["type"].as_str().unwrap_or("");
        match kind {
            "transcript.segment" | "transcript.final" => {
                let Some(id) = message["utterance_id"].as_str() else { return Ok(false) };
                let revision = message["revision"].as_i64().unwrap_or(0);
                let text = message["text"].as_str().unwrap_or("").to_string();
                let is_final = kind == "transcript.final";
                if !self.entries.contains_key(id) { self.order.push(id.to_string()); }
                let entry = self.entries.entry(id.to_string()).or_insert((-1, String::new(), false));
                if entry.2 && !is_final || revision < entry.0 && entry.2 == is_final { return Ok(false); }
                *entry = (revision, text, is_final);
                Ok(true)
            }
            "transcript.failed" => Err(message["error"]["message"].as_str().unwrap_or("transcription failed").to_string()),
            "session.error" if message["fatal"] == true => Err(message["error"]["message"].as_str().unwrap_or("session error").to_string()),
            _ => Ok(false),
        }
    }
    pub fn text(&self) -> String { join(self.order.iter().filter_map(|id| self.entries.get(id)).map(|(_, text, _)| text.clone())) }
}

async fn run_codex(
    token: &str, mut audio: mpsc::UnboundedReceiver<Vec<i16>>, mut control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync), stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let mut request = "wss://chatgpt.com/backend-api/dictation/stream?client_type=desktop&dictation_surface=composer"
        .into_client_request().map_err(|e| e.to_string())?;
    request.headers_mut().insert("Sec-WebSocket-Protocol", header(&format!("chatgpt-dictation, openai-bearer.{token}, codex-desktop"))?);
    let mut socket = tokio::select! {
        socket = connect(request) => socket?,
        _ = control.recv() => return Ok(()),
    };
    let start = json!({
        "type": "session.start",
        "config": {
            "input_audio_format": "pcm16", "sample_rate_hz": SAMPLE_RATE, "num_channels": 1,
            "max_buffer_size_bytes": 4_194_304, "max_utterance_duration_ms": 30_000, "session_ttl_ms": 300_000,
            "provider_mode": "streaming_sse", "transcript_delivery_mode": "segment",
            "vad": { "type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500 },
        },
    });
    socket.send(Message::Text(start.to_string().into())).await.map_err(|e| e.to_string())?;
    let append = |samples: &[i16]| {
        use base64::Engine;
        Message::Text(json!({ "type": "audio.append", "audio": base64::engine::general_purpose::STANDARD.encode(pcm_bytes(samples)) }).to_string().into())
    };
    let mut started = false;
    let mut pending: Vec<Vec<i16>> = Vec::new();
    let mut transcript = CodexTranscript::default();
    let mut closing: Option<Instant> = None;
    loop {
        let deadline = closing.unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        tokio::select! {
            chunk = audio.recv(), if closing.is_none() => if let Some(chunk) = chunk {
                if started { emit(VoiceEvent::Level { level: level(&chunk) }); }
                if started { socket.send(append(&chunk)).await.map_err(|e| e.to_string())?; } else { pending.push(chunk); }
            },
            command = control.recv(), if closing.is_none() => match command {
                Some(Control::Finish) => {
                    stop_capture();
                    if !started { let _ = socket.close(None).await; emit(VoiceEvent::Text { text: String::new(), done: true }); return Ok(()); }
                    while let Ok(chunk) = audio.try_recv() { let _ = socket.send(append(&chunk)).await; }
                    // A quarter second of silence lets the server's VAD close the last utterance.
                    let _ = socket.send(append(&vec![0i16; SAMPLE_RATE as usize / 4])).await;
                    socket.send(Message::Text(r#"{"type":"session.close"}"#.into())).await.map_err(|e| e.to_string())?;
                    closing = Some(Instant::now() + Duration::from_secs(8));
                }
                Some(Control::Cancel) | None => { let _ = socket.close(None).await; return Ok(()); }
            },
            _ = tokio::time::sleep_until(deadline), if closing.is_some() => break,
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                    match value["type"].as_str().unwrap_or("") {
                        "session.started" => {
                            started = true;
                            emit(VoiceEvent::Ready);
                            for chunk in pending.drain(..) { socket.send(append(&chunk)).await.map_err(|e| e.to_string())?; }
                        }
                        "session.updated" if value["session"]["status"] == "closed" => {
                            if closing.is_some() { break; }
                            return Err("closed".into());
                        }
                        _ => if transcript.apply(&value)? { emit(VoiceEvent::Text { text: transcript.text(), done: false }); },
                    }
                }
                Some(Ok(Message::Close(frame))) if closing.is_none() => {
                    return Err(format!("closed: {}", frame.map(|f| f.reason.to_string()).unwrap_or_default()));
                }
                None if closing.is_none() => return Err("closed".into()),
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(error)) => return Err(error.to_string()),
                _ => {}
            },
        }
    }
    let _ = socket.close(None).await;
    emit(VoiceEvent::Text { text: transcript.text(), done: true });
    Ok(())
}

/// Mono 16 kHz PCM16 from any input format: average the channels, then resample linearly.
pub struct Resampler { step: f64, position: f64, previous: f32, out: Vec<i16> }

impl Resampler {
    pub fn new(input_rate: u32) -> Self { Self { step: input_rate as f64 / SAMPLE_RATE as f64, position: 0.0, previous: 0.0, out: Vec::with_capacity(CHUNK) } }

    /// Feeds mono samples; returns whole 100 ms chunks.
    pub fn push(&mut self, mono: impl IntoIterator<Item = f32>) -> Vec<Vec<i16>> {
        let mut chunks = Vec::new();
        for sample in mono {
            // `position` is where the next output sample falls, relative to `previous` (0) and `sample` (1).
            while self.position <= 1.0 {
                let value = self.previous + (sample - self.previous) * self.position as f32;
                self.out.push((value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                if self.out.len() == CHUNK { chunks.push(std::mem::replace(&mut self.out, Vec::with_capacity(CHUNK))); }
                self.position += self.step;
            }
            self.position -= 1.0;
            self.previous = sample;
        }
        chunks
    }

    pub fn flush(&mut self) -> Option<Vec<i16>> { (!self.out.is_empty()).then(|| std::mem::take(&mut self.out)) }
}

mod capture {
    use super::Resampler;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::{mpsc as std_mpsc, Arc, Mutex};
    use tokio::sync::mpsc;

    /// The capture thread owns the stream (not `Send` on every platform); dropping the sender stops it.
    pub struct Capture { stop: Mutex<Option<(std_mpsc::Sender<()>, std_mpsc::Receiver<()>)>> }

    impl Capture {
        pub fn stop(&self) {
            let mut stop = self.stop.lock().unwrap();
            if let Some((signal, finished)) = stop.take() {
                drop(signal);
                // Finish drains the audio queue immediately after stop returns.
                let _ = finished.recv();
            }
        }
    }

    pub fn devices() -> super::Microphones {
        let host = cpal::default_host();
        #[allow(deprecated)]
        let devices = host.input_devices().map(|list| list.filter_map(|d| d.name().ok()).collect()).unwrap_or_default();
        #[allow(deprecated)]
        let default = host.default_input_device().and_then(|d| d.name().ok());
        super::Microphones { devices, default }
    }

    /// The named microphone when it is still connected, otherwise the system default.
    fn device(name: Option<&str>) -> Option<cpal::Device> {
        let host = cpal::default_host();
        #[allow(deprecated)]
        let named = name.filter(|n| !n.is_empty()).and_then(|name| host.input_devices().ok()?.find(|d| d.name().ok().as_deref() == Some(name)));
        named.or_else(|| host.default_input_device())
    }

    pub fn start(tx: mpsc::UnboundedSender<Vec<i16>>, name: Option<String>) -> Result<Capture, String> {
        let (stop_tx, stop_rx) = std_mpsc::channel::<()>();
        let (finished_tx, finished_rx) = std_mpsc::channel::<()>();
        let (ready_tx, ready_rx) = std_mpsc::channel::<Result<(), String>>();
        std::thread::Builder::new().name("voice-capture".into()).spawn(move || {
            let opened = open(tx.clone(), name.as_deref());
            let (stream, resampler) = match opened {
                Ok(pair) => { let _ = ready_tx.send(Ok(())); pair }
                Err(error) => { let _ = ready_tx.send(Err(error)); return; }
            };
            let _ = stop_rx.recv();
            drop(stream);
            let rest = resampler.lock().unwrap().flush();
            if let Some(rest) = rest { let _ = tx.send(rest); }
            let _ = finished_tx.send(());
        }).map_err(|e| e.to_string())?;
        ready_rx.recv().map_err(|_| "microphone: capture thread ended".to_string())??;
        Ok(Capture { stop: Mutex::new(Some((stop_tx, finished_rx))) })
    }

    #[test]
    fn stopping_capture_makes_the_last_partial_chunk_available_to_finish() {
        let (stop_tx, stop_rx) = std_mpsc::channel::<()>();
        let (finished_tx, finished_rx) = std_mpsc::channel::<()>();
        let (audio_tx, mut audio) = mpsc::unbounded_channel();
        let capture = Capture { stop: Mutex::new(Some((stop_tx, finished_rx))) };
        let worker = std::thread::spawn(move || {
            let _ = stop_rx.recv();
            audio_tx.send(vec![123; 17]).unwrap();
            let _ = finished_tx.send(());
        });
        capture.stop();
        assert_eq!(audio.try_recv().unwrap(), vec![123; 17], "finish must see the final partial microphone chunk");
        worker.join().unwrap();
        capture.stop();
    }

    fn open(tx: mpsc::UnboundedSender<Vec<i16>>, name: Option<&str>) -> Result<(cpal::Stream, Arc<Mutex<Resampler>>), String> {
        let device = device(name).ok_or("no_microphone")?;
        let config = device.default_input_config().map_err(|e| format!("microphone: {e}"))?;
        let channels = config.channels().max(1) as usize;
        let resampler = Arc::new(Mutex::new(Resampler::new(config.sample_rate().0)));
        let format = config.sample_format();
        let stream_config: cpal::StreamConfig = config.into();
        fn build<T: cpal::SizedSample>(device: &cpal::Device, config: &cpal::StreamConfig, channels: usize, resampler: Arc<Mutex<Resampler>>, tx: mpsc::UnboundedSender<Vec<i16>>) -> Result<cpal::Stream, cpal::BuildStreamError>
        where f32: cpal::FromSample<T> {
            device.build_input_stream(config, move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mono = data.chunks(channels).map(|frame| frame.iter().map(|s| f32::from_sample_(*s)).sum::<f32>() / channels as f32);
                for chunk in resampler.lock().unwrap().push(mono) { let _ = tx.send(chunk); }
            }, |error| log::warn!("voice capture: {error}"), None)
        }
        use cpal::FromSample;
        let stream = match format {
            cpal::SampleFormat::F32 => build::<f32>(&device, &stream_config, channels, resampler.clone(), tx),
            cpal::SampleFormat::I16 => build::<i16>(&device, &stream_config, channels, resampler.clone(), tx),
            cpal::SampleFormat::U16 => build::<u16>(&device, &stream_config, channels, resampler.clone(), tx),
            cpal::SampleFormat::I32 => build::<i32>(&device, &stream_config, channels, resampler.clone(), tx),
            other => return Err(format!("microphone: unsupported sample format {other}")),
        }.map_err(|e| format!("microphone: {e}"))?;
        stream.play().map_err(|e| format!("microphone: {e}"))?;
        Ok((stream, resampler))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_dictation_source_requires_account_credentials() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".codex");
        std::fs::create_dir_all(&config).unwrap();
        let auth = config.join("auth.json");
        let no_vars = |_: &str| None;
        assert!(local_account("codex", home.path(), &no_vars).is_none());
        std::fs::write(&auth, r#"{"auth_mode":"apikey","OPENAI_API_KEY":"fixture"}"#).unwrap();
        assert!(local_account("codex", home.path(), &no_vars).is_none());
        std::fs::write(&auth, r#"{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-token","account_id":"fixture-account"}}"#).unwrap();
        let found = local_account("codex", home.path(), &no_vars).unwrap();
        assert_eq!(found.account_id.as_deref(), Some("fixture-account"));
        assert!(local_account("wechat", home.path(), &no_vars).is_none());
        assert!(resolve_account("codex", None, Some("wechat")).is_none(), "an unavailable selected source must not fall back to another account");
        std::fs::remove_file(auth).unwrap();
        assert!(local_account("codex", home.path(), &no_vars).is_none());
    }

    #[test]
    fn joins_latin_with_spaces_and_cjk_without() {
        assert_eq!(join(["hello".into(), "world".into()]), "hello world");
        assert_eq!(join(["今天".into(), "天气不错。".into(), "OK".into()]), "今天天气不错。OK");
        assert_eq!(join(["".into(), " a ".into()]), "a");
    }

    #[test]
    fn claude_partials_replace_the_current_utterance() {
        let mut t = ClaudeTranscript::default();
        assert!(t.apply(&json!({"type":"TranscriptText","data":"今"})).unwrap());
        assert!(t.apply(&json!({"type":"TranscriptText","data":"今天"})).unwrap());
        t.apply(&json!({"type":"TranscriptEndpoint"})).unwrap();
        t.apply(&json!({"type":"TranscriptInterim","data":"好"})).unwrap();
        assert_eq!(t.text(), "今天好");
        assert!(t.apply(&json!({"type":"TranscriptError","description":"bad"})).is_err());
    }

    #[test]
    fn codex_final_replaces_segment_and_ignores_stale_revisions() {
        let mut t = CodexTranscript::default();
        t.apply(&json!({"type":"transcript.segment","utterance_id":"a","revision":2,"text":"helo"})).unwrap();
        assert!(!t.apply(&json!({"type":"transcript.segment","utterance_id":"a","revision":1,"text":"he"})).unwrap());
        t.apply(&json!({"type":"transcript.segment","utterance_id":"b","revision":1,"text":"wor"})).unwrap();
        assert_eq!(t.text(), "helo wor");
        t.apply(&json!({"type":"transcript.final","utterance_id":"a","revision":3,"text":"Hello,"})).unwrap();
        assert!(!t.apply(&json!({"type":"transcript.segment","utterance_id":"a","revision":4,"text":"x"})).unwrap());
        assert_eq!(t.text(), "Hello, wor");
        assert!(t.apply(&json!({"type":"session.error","fatal":true,"error":{"message":"m"}})).is_err());
        assert!(!t.apply(&json!({"type":"session.error","fatal":false,"error":{"message":"m"}})).unwrap());
    }

    #[test]
    fn level_is_zero_for_silence_and_capped_at_one() {
        assert_eq!(level(&[0; 1600]), 0.0);
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&[i16::MAX; 1600]), 1.0);
        assert_eq!(level(&[100; 1600]), 0.0, "below −50 dB is silence");
        let speech = level(&[3000; 1600]);
        assert!(speech > 0.5 && speech < 1.0);
    }

    #[test]
    fn resampler_downsamples_48k_to_16k_chunks() {
        let mut r = Resampler::new(48_000);
        let chunks = r.push(std::iter::repeat_n(0.5f32, 48_000));
        assert_eq!(chunks.len(), 10);
        assert!(chunks.iter().all(|c| c.len() == CHUNK));
        assert!(chunks[5].iter().all(|&s| (s - 16_383).abs() <= 1));
    }

    /// Live check against Claude's service with the signed-in account: `cargo test voice_live -- --ignored`.
    /// Needs `/tmp/voice-probe/zh.wav` (16 kHz mono PCM16).
    #[test]
    #[ignore]
    fn voice_live_claude() {
        let account = signed_in("claude", None).expect("Claude Code signed in");
        let pcm = std::fs::read("/tmp/voice-probe/zh.wav").unwrap();
        let samples: Vec<i16> = pcm[44..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let events = std::sync::Arc::new(Mutex::new(Vec::new()));
        runtime.block_on(async {
            let (audio_tx, audio_rx) = mpsc::unbounded_channel();
            let (control_tx, control_rx) = mpsc::unbounded_channel();
            let sink = events.clone();
            let emit = move |event: VoiceEvent| sink.lock().unwrap().push(event);
            let feeder = async move {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                for chunk in samples.chunks(CHUNK) { audio_tx.send(chunk.to_vec()).unwrap(); tokio::time::sleep(Duration::from_millis(100)).await; }
                control_tx.send(Control::Finish).unwrap();
            };
            let (result, _) = tokio::join!(run_claude(&account.token, "zh", audio_rx, control_rx, &emit, || {}), feeder);
            result.unwrap();
        });
        let events = events.lock().unwrap();
        println!("{:?}", events.iter().filter(|e| !matches!(e, VoiceEvent::Level { .. })).collect::<Vec<_>>());
        assert_eq!(events.first(), Some(&VoiceEvent::Ready));
        assert!(events.iter().any(|e| matches!(e, VoiceEvent::Level { level } if *level > 0.0)));
        assert!(matches!(events.last(), Some(VoiceEvent::Text { text, done: true }) if text.contains("语音")));
    }
}
