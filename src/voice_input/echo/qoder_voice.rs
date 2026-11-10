//! Adapted from EchoBird account_proxy; only speech transport is included.
use super::compat::{body::Bytes, http::StatusCode};
use super::{audio_format, qoder, ProxyError};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Error, Message};

const PATH: &str = "/api/v2/service/ws/asr";

pub(crate) async fn transcribe(
    _client: &reqwest::Client,
    credentials: &Value,
    audio: &Bytes,
    _filename: &str,
    mime: &str,
) -> Result<String, ProxyError> {
    if !matches!(mime, "audio/wav" | "audio/x-wav") {
        return Err(invalid_audio());
    }
    let pcm = audio_format::pcm(audio).map_err(|_| invalid_audio())?;
    tokio::time::timeout(
        super::voice::media_timeout(pcm.len()),
        recognize(credentials, pcm),
    )
    .await
    .map_err(|_| timed_out())?
}

fn endpoint(credentials: &Value) -> Result<String, ProxyError> {
    let base = match credentials["edition"].as_str() {
        Some("qoder") => "wss://api3.qoder.sh",
        Some("qodercn") => "wss://gateway.qoder.com.cn",
        _ => return Err(login_required()),
    };
    #[cfg(test)]
    let base = credentials["_voice_test_endpoint"].as_str().unwrap_or(base);
    Ok(format!("{}{PATH}", base.trim_end_matches('/')))
}

async fn recognize(credentials: &Value, pcm: &[u8]) -> Result<String, ProxyError> {
    let endpoint = endpoint(credentials)?;
    let token = credentials["deviceToken"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(login_required)?;
    let version = credentials["appVersion"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(login_required)?;
    let mut selected = credentials.clone();
    selected["accessToken"] = json!(token);
    let mut request = endpoint.into_client_request().map_err(|_| failed())?;
    request
        .headers_mut()
        .extend(qoder::speech_headers(&selected, PATH)?);
    let session = uuid::Uuid::new_v4().to_string();
    let business = uuid::Uuid::new_v4().to_string();
    for (name, value) in [
        ("x-ide-platform", "app".to_owned()),
        ("x-version", version.to_owned()),
        ("x-machine-os", match std::env::consts::OS { "windows" => "win32", "macos" => "darwin", os => os }.to_owned()),
        ("samplerate", "16000".to_owned()),
        ("framedurationms", "100".to_owned()),
        ("bitdepth", "16".to_owned()),
        ("channels", "1".to_owned()),
        ("x-asr-session-id", session),
        ("x-business", json!({"product":"app","type":"asr_chat","id":business,"begin_at":chrono::Utc::now().timestamp_millis(),"name":format!("asr_chat-{business}")}).to_string()),
    ] {
        request.headers_mut().insert(name, value.parse().map_err(|_| login_required())?);
    }
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| timed_out())?
    .map_err(|error| match error {
        Error::Http(response) => {
            let mut error = ProxyError::new(response.status(), "Qoder speech connection failed");
            error.retry_after = response.headers().get("retry-after").cloned();
            error
        }
        _ => failed(),
    })?;
    socket.send(Message::Text(json!({"type":"asr_polish_config","enabled":false,"request_id":uuid::Uuid::new_v4().to_string(),"client_type":10,"source":"chat_input","messages":[]}).to_string().into())).await.map_err(|_| failed())?;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut cursor = 0;
    let mut sent_end = false;
    let mut text = String::new();
    let mut has_final = false;
    let mut socket_closed = false;
    // Arm the settle deadline after playback, including recordings near one minute.
    let settle = tokio::time::sleep(Duration::ZERO);
    let finish = tokio::time::sleep(Duration::from_secs(60));
    tokio::pin!(settle, finish);
    loop {
        tokio::select! {
            _ = tick.tick(), if !sent_end => {
                if cursor < pcm.len() {
                    let end = (cursor + 3200).min(pcm.len());
                    socket.send(Message::Binary(pcm[cursor..end].to_vec().into())).await.map_err(|_| failed())?;
                    cursor = end;
                } else {
                    socket.send(Message::Text(r#"{"type":"voice_completed","message":"close by user"}"#.into())).await.map_err(|_| failed())?;
                    sent_end = true;
                    let final_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
                    settle.as_mut().reset(final_deadline);
                    finish.as_mut().reset(final_deadline);
                }
            }
            _ = &mut settle, if sent_end && has_final => { let _ = socket.close(None).await; return Ok(text); }
            _ = &mut finish, if sent_end => {
                let _ = socket.close(None).await;
                return if has_final { Ok(text) } else { Err(timed_out()) };
            }
            event = socket.next(), if !socket_closed => {
                let event = match event {
                    Some(Ok(event)) => event,
                    _ if sent_end && has_final => { socket_closed = true; continue; }
                    _ => return Err(failed()),
                };
                let bytes = match event {
                    Message::Text(value) => value.as_bytes().to_vec(),
                    Message::Binary(value) => value.to_vec(),
                    Message::Ping(value) => { socket.send(Message::Pong(value)).await.map_err(|_| failed())?; continue; }
                    Message::Close(_) if sent_end && has_final => { socket_closed = true; continue; }
                    Message::Close(_) => return Err(failed()),
                    _ => continue,
                };
                let event: Value = serde_json::from_slice(&bytes).map_err(|_| failed())?;
                match event["type"].as_str() {
                    Some("speech_completed") => {
                        let value = event["message"].as_str().ok_or_else(failed)?;
                        if !value.is_empty() {
                            text.push_str(value);
                            has_final = true;
                            if sent_end { settle.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(1)); }
                        }
                    }
                    Some("speech_done") if sent_end => { let _ = socket.close(None).await; return Ok(text); }
                    Some("speech_err") => return Err(failed()),
                    _ => {}
                }
            }
        }
    }
}

fn invalid_audio() -> ProxyError {
    ProxyError::new(
        StatusCode::BAD_REQUEST,
        "Qoder speech requires 16 kHz mono PCM16 WAV audio",
    )
}

fn login_required() -> ProxyError {
    ProxyError::new(
        StatusCode::UNAUTHORIZED,
        "Qoder speech device login required",
    )
}

fn failed() -> ProxyError {
    ProxyError::new(StatusCode::BAD_GATEWAY, "Qoder speech recognition failed")
}

fn timed_out() -> ProxyError {
    ProxyError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "Qoder speech recognition timed out",
    )
}

#[cfg(test)]
mod tests;
