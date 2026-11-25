//! Adapted from EchoBird account_proxy; only speech transport is included.
use super::compat::{
    body::Bytes,
    http::{header, StatusCode, Version},
};
use serde_json::Value;
use std::time::Duration;

use super::{
    cursor_voice::{self, WireValue},
    ProxyError,
};

const PATH: &str = "/aiserver.v1.AiService/TranscribeAudio";

pub(crate) async fn transcribe(
    client: &reqwest::Client,
    credentials: &Value,
    audio: &Bytes,
    _filename: &str,
    mime: &str,
) -> Result<String, ProxyError> {
    validate_audio(audio, mime)?;
    tokio::time::timeout(
        Duration::from_secs(60),
        recognize(client, credentials, audio, mime),
    )
    .await
    .map_err(|_| cursor_voice::timed_out())?
}

pub(crate) fn validate_audio(audio: &Bytes, mime: &str) -> Result<(), ProxyError> {
    let mime = mime.split(';').next().unwrap_or("").trim();
    if audio.is_empty()
        || audio.len() > 32 * 1024 * 1024
        || !matches!(
            mime,
            "audio/wav" | "audio/x-wav" | "audio/webm" | "audio/mp4"
        )
    {
        return Err(ProxyError::new(
            StatusCode::BAD_REQUEST,
            "Grok Bot speech requires nonempty supported audio",
        ));
    }
    if matches!(mime, "audio/wav" | "audio/x-wav") {
        super::audio_format::pcm(audio).map_err(|_| {
            ProxyError::new(
                StatusCode::BAD_REQUEST,
                "Grok Bot WAV audio must be 16 kHz mono PCM16",
            )
        })?;
    }
    Ok(())
}

async fn recognize(
    client: &reqwest::Client,
    credentials: &Value,
    audio: &Bytes,
    mime: &str,
) -> Result<String, ProxyError> {
    let mime = mime.split(';').next().unwrap_or("").trim();
    let mut body = cursor_voice::field(1, audio);
    body.extend(cursor_voice::field(2, mime.as_bytes()));
    let mut response = client
        .post(format!("{}{PATH}", cursor_voice::endpoint(credentials)))
        .version(Version::HTTP_11)
        .headers(cursor_voice::headers(credentials, true)?)
        .header(header::CONTENT_TYPE, "application/proto")
        .timeout(Duration::from_secs(60))
        .body(body)
        .send()
        .await
        .map_err(cursor_voice::request_error)?;
    if !response.status().is_success() {
        return Err(cursor_voice::http_error(
            response.status(),
            response.headers(),
        ));
    }
    if !cursor_voice::content_type(response.headers(), "application/proto") {
        return Err(cursor_voice::failed());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(cursor_voice::request_error)?
    {
        if body.len() + chunk.len() > cursor_voice::MAX_MESSAGE {
            return Err(cursor_voice::failed());
        }
        body.extend_from_slice(&chunk);
    }
    let mut text = "";
    for (number, value) in cursor_voice::fields(&body)? {
        if let (1, WireValue::Bytes(value)) = (number, value) {
            text = std::str::from_utf8(value).map_err(|_| cursor_voice::failed())?;
        }
    }
    cursor_voice::nonempty(text)
}

#[cfg(test)]
mod tests;
