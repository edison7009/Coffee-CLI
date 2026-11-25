//! EchoBird speech transports, with read-only local account discovery and Coffee's recording lifecycle.
use super::*;
use bytes::Bytes;
use http::{header::HeaderValue, StatusCode};
use std::fmt;

mod accounts;
mod ali_native;
mod antigravity_voice;
mod audio_format;
mod codearts_sign;
mod codearts_voice;
mod cursor_wire;
mod devin;
mod devin_protocol;
mod devin_voice;
mod dumate_voice;
mod grokbot_voice;
mod kilo_voice;
mod minimax_voice;
mod other_native;
mod providers;
mod qoder;
mod qoder_voice;
mod qwenwork_voice;
mod sse;
mod system_native;
mod trae_global_voice;
mod trae_voice;
mod vault;
mod workbuddy_voice;
use codearts_sign::signed_headers as codearts_signed_headers;
use cursor_wire as cursor_voice;
use sse::SseParser;

mod compat {
    pub mod body {
        pub use bytes::Bytes;
    }
    pub mod http {
        pub use http::*;
    }
}
mod claude_voice {
    pub(super) use super::audio_format::pcm;
}
mod voice {
    pub(super) fn media_timeout(bytes: usize) -> std::time::Duration {
        std::time::Duration::from_millis(60_000 + bytes.div_ceil(32).min(300_000) as u64)
    }
}

#[derive(Debug)]
struct ProxyError {
    status: StatusCode,
    message: String,
    error_code: Option<String>,
    retry_after: Option<HeaderValue>,
}
impl ProxyError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            error_code: None,
            retry_after: None,
        }
    }
    fn upstream(_: impl fmt::Display) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "Speech request failed")
    }
}
impl fmt::Display for ProxyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ProxyError {}

pub(super) struct Credentials {
    provider: String,
    pub(super) account_id: String,
    data: Value,
}

pub(super) async fn sources() -> Vec<VoiceSource> {
    let (sources, buddy) = tokio::join!(
        tauri::async_runtime::spawn_blocking(accounts::sources),
        super::workbuddy::account_for("workbuddyai")
    );
    let mut sources = sources.unwrap_or_default();
    if let Ok(c) = buddy {
        sources.push(VoiceSource {
            id: "workbuddyai".into(),
            name: "WorkBuddy AI".into(),
            account_id: Some(c.user_id),
            issue: None,
            transcription_mode: Some("batch"),
        });
    }
    sources
}
pub(super) fn supports(source: &str) -> bool {
    accounts::supports(source)
}
pub(super) fn connection_url(account: &Credentials) -> Option<&'static str> {
    Some(match account.provider.as_str() {
        "minimax" if account.data["region"] == "cn" => "https://agent.minimax.cn",
        "minimax" => "https://agent.minimax.io",
        "kilo" => "https://ai-gateway.kilo.ai",
        "antigravity" => "https://aicode.googleapis.com",
        "grokbot" => "https://api2.cursor.sh",
        "dumate" => "https://dumate-svc.baidu.com",
        "devin" => "https://server.codeium.com",
        "codearts" => "https://snap-access.cn-north-4.myhuaweicloud.com",
        "qoder" => "https://api3.qoder.sh",
        "qodercn" => "https://gateway.qoder.com.cn",
        "qwenwork" => "https://gateway.qwenwork.ai",
        "qwenworkcn" => "https://gateway.qwenwork.cn",
        "traecn" => "https://api.trae.com.cn",
        "trae" => match account.data["storeRegion"].as_str().or(account.data["region"].as_str())? {
            "SG" => "https://icube16-normal-sg.trae.ai",
            "US" => "https://icube-normal.trae.ai",
            "USTTP" => "https://icube-normal.traeapi.us",
            _ => return None,
        },
        "workbuddyai" => "https://www.workbuddy.ai",
        _ => return None,
    })
}
pub(super) async fn account(source: String) -> Result<Credentials, String> {
    if source == "workbuddyai" {
        let c = super::workbuddy::account_for(&source).await?;
        return Ok(Credentials {
            provider: source,
            account_id: c.user_id.clone(),
            data: json!({"accessToken":c.token,"uid":c.user_id,"domain":c.domain,"enterpriseId":c.enterprise_id}),
        });
    }
    tauri::async_runtime::spawn_blocking(move || accounts::account(&source))
        .await
        .map_err(|_| "signed_out")?
}

pub(super) async fn run(
    account: Credentials,
    mut audio: mpsc::UnboundedReceiver<Vec<i16>>,
    mut control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let Some(audio) = record(&account.provider, &mut audio, &mut control, emit, stop_capture).await? else {
        return Ok(());
    };
    if audio.len() == 44 {
        emit(VoiceEvent::Text {
            text: String::new(),
            done: true,
        });
        return Ok(());
    }
    emit(VoiceEvent::Processing);
    let request = transcribe(&account, &audio);
    tokio::pin!(request);
    let result = loop {
        tokio::select! {
            biased;
            command = control.recv() => match command {
                Some(Control::Finish) => {},
                Some(Control::Cancel) | None => return Ok(()),
            },
            result = &mut request => break result?,
        }
    };
    emit(VoiceEvent::Text {
        text: result,
        done: true,
    });
    Ok(())
}

async fn record(
    provider: &str,
    audio: &mut mpsc::UnboundedReceiver<Vec<i16>>,
    control: &mut mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<Option<Bytes>, String> {
    let mut samples = Vec::new();
    let seconds = if provider == "dumate" { 60 } else { 300 };
    let max_samples = seconds as usize * SAMPLE_RATE as usize;
    let deadline = Instant::now() + Duration::from_secs(seconds);
    emit(VoiceEvent::Ready);
    loop {
        tokio::select! {
            biased;
            command = control.recv() => match command {
                Some(Control::Finish) => break,
                Some(Control::Cancel) | None => {stop_capture();return Ok(None);},
            },
            _ = tokio::time::sleep_until(deadline) => break,
            chunk = audio.recv() => match chunk {
                Some(chunk) => {
                    emit(VoiceEvent::Level {level:level(&chunk)});
                    samples.extend(chunk.into_iter().take(max_samples - samples.len()));
                    if samples.len() == max_samples { break; }
                },
                None => {stop_capture();return Err("microphone_closed".into());},
            },
        }
    }
    stop_capture();
    while let Ok(chunk) = audio.try_recv() {
        samples.extend(chunk.into_iter().take(max_samples - samples.len()));
    }
    Ok(Some(wav(&samples)))
}

fn wav(samples: &[i16]) -> Bytes {
    let length = samples.len() as u32 * 2;
    let mut out = b"RIFF".to_vec();
    out.extend((36 + length).to_le_bytes());
    out.extend(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    out.extend(16000u32.to_le_bytes());
    out.extend(32000u32.to_le_bytes());
    out.extend(b"\x02\0\x10\0data");
    out.extend(length.to_le_bytes());
    out.extend(samples.iter().flat_map(|value| value.to_le_bytes()));
    out.into()
}

async fn transcribe(account: &Credentials, audio: &Bytes) -> Result<String, String> {
    match account.provider.as_str() {
        "dumate" => dumate_voice::validate_audio(audio, "audio/wav"),
        "antigravity" => antigravity_voice::validate_audio(audio, "audio/wav"),
        "codearts" => codearts_voice::validate_audio(audio, "audio/wav"),
        "grokbot" => grokbot_voice::validate_audio(audio, "audio/wav"),
        "devin" => devin_voice::validate_audio(audio, "audio/wav"),
        "trae" => trae_global_voice::validate_audio(audio, "audio/wav"),
        _ => audio_format::pcm(audio).map(|_| ()),
    }
    .map_err(status)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(360))
        .build()
        .map_err(|_| "speech_failed")?;
    let mut c = account.data.clone();
    if account.provider == "dumate" {
        c = accounts::dumate_credentials(&client, &c).await?;
    }
    let result = match account.provider.as_str() {
        "minimax" => {
            minimax_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        "kilo" => {
            let models = kilo_voice::list_models(&client, &c).await.map_err(status)?;
            let model = models.first().ok_or("speech_unavailable")?;
            kilo_voice::transcribe(&client, &c, model, audio, "recording.wav", "audio/wav").await
        }
        "antigravity" => {
            let model = antigravity_voice::selected_model(&client, &c)
                .await
                .map_err(status)?;
            antigravity_voice::transcribe(&client, &c, &model, audio, "recording.wav", "audio/wav")
                .await
        }
        "grokbot" => {
            grokbot_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        "dumate" => {
            dumate_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        "devin" => devin_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await,
        "codearts" => {
            codearts_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        "qoder" | "qodercn" => {
            qoder_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        "qwenwork" | "qwenworkcn" => {
            qwenwork_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        "trae" => {
            trae_global_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        "traecn" => trae_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await,
        "workbuddyai" => {
            workbuddy_voice::transcribe(&client, &c, audio, "recording.wav", "audio/wav").await
        }
        _ => return Err("signed_out".into()),
    };
    result.map_err(status)
}
fn status(error: ProxyError) -> String {
    format!("http_{}", error.status.as_u16())
}

#[cfg(test)]
mod tests;
