//! Adapted from EchoBird account_proxy; only speech transport is included.
//! Devin's native upstream unary ASR, using the selected saved subscription.
use super::compat::{
    body::Bytes,
    http::{header, HeaderMap, HeaderValue, StatusCode},
};
use serde_json::Value;
use std::time::Duration;

use super::devin_protocol::{self as wire, Field, Message};
use super::{devin, ProxyError};

const PATH: &str = "/exa.api_server_pb.ApiServerService/GetTranscription";
const MAX_AUDIO: usize = 32 * 1024 * 1024;
const MAX_RESPONSE: usize = 4 * 1024 * 1024;

pub(crate) async fn transcribe(
    _client: &reqwest::Client,
    credentials: &Value,
    audio: &Bytes,
    _filename: &str,
    mime: &str,
) -> Result<String, ProxyError> {
    validate_audio(audio, mime)?;
    tokio::time::timeout(Duration::from_secs(60), recognize(credentials, audio))
        .await
        .map_err(|_| timed_out())?
}

pub(crate) fn validate_audio(audio: &Bytes, mime: &str) -> Result<(), ProxyError> {
    let mime = mime.split(';').next().unwrap_or("").trim();
    if audio.is_empty()
        || audio.len() > MAX_AUDIO
        || !matches!(mime, "audio/wav" | "audio/x-wav" | "audio/webm")
    {
        return Err(invalid_audio());
    }
    if matches!(mime, "audio/wav" | "audio/x-wav") {
        super::audio_format::pcm(audio).map_err(|_| invalid_audio())?;
    }
    Ok(())
}

async fn recognize(credentials: &Value, audio: &Bytes) -> Result<String, ProxyError> {
    let (key, server) = devin::auth(credentials)?;
    // Retain the existing CLI-compatible metadata identity; do not read desktop
    // fingerprints or add an invented MIME field to this bytes-only API.
    let body = Message::default()
        .bytes(1, devin::metadata(key))
        .bytes(2, audio)
        .0;
    // The existing subscription client disables redirects. The session token is
    // inside protobuf metadata, so following a 307 could leak it in a new body.
    let mut response = devin::client()?
        .post(format!("{server}{PATH}"))
        .header(header::CONTENT_TYPE, "application/proto")
        .header("connect-protocol-version", "1")
        .timeout(Duration::from_secs(60))
        .body(body)
        .send()
        .await
        .map_err(request_error)?;
    let status = response.status();
    let headers = response.headers().clone();
    if matches!(
        status,
        StatusCode::UNAUTHORIZED | StatusCode::TOO_MANY_REQUESTS
    ) {
        return Err(upstream_error(status, &[], &headers));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE as u64)
    {
        return Err(failed());
    }
    let mut payload = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if payload.len().saturating_add(chunk.len()) > MAX_RESPONSE {
            return Err(failed());
        }
        payload.extend_from_slice(&chunk);
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if status != StatusCode::OK
        || content_type.is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
    {
        return Err(upstream_error(status, &payload, &headers));
    }
    if !content_type.is_some_and(|value| value.eq_ignore_ascii_case("application/proto")) {
        return Err(failed());
    }
    let fields = wire::fields(&payload).map_err(|_| failed())?;
    // Upstream response is field 2; field 1 belongs to the separate LS response.
    let text = fields
        .iter()
        .rev()
        .find_map(|field| match field {
            Field::Bytes(2, value) => Some(*value),
            _ => None,
        })
        .ok_or_else(failed)?;
    let text = std::str::from_utf8(text).map_err(|_| failed())?.trim();
    if text.is_empty() {
        return Err(failed());
    }
    Ok(text.to_string())
}

fn upstream_error(status: StatusCode, payload: &[u8], headers: &HeaderMap) -> ProxyError {
    let value: Value = serde_json::from_slice(payload).unwrap_or_default();
    let details = value.get("error").unwrap_or(&value);
    let mut error = devin::error(status, payload);
    error.status = match details["code"].as_str() {
        Some("deadline_exceeded") => StatusCode::GATEWAY_TIMEOUT,
        Some("unavailable") => StatusCode::SERVICE_UNAVAILABLE,
        _ => error.status,
    };
    error.message = "Devin speech request failed".into();
    error.retry_after = headers.get(header::RETRY_AFTER).cloned().or_else(|| {
        value
            .get("metadata")
            .or_else(|| details.get("metadata"))?
            .get("retry-after")?
            .as_array()?
            .first()?
            .as_str()
            .and_then(|value| HeaderValue::from_str(value).ok())
    });
    error
}

fn invalid_audio() -> ProxyError {
    ProxyError::new(
        StatusCode::BAD_REQUEST,
        "Devin speech requires nonempty WebM or 16 kHz mono PCM16 WAV audio",
    )
}
fn failed() -> ProxyError {
    ProxyError::new(StatusCode::BAD_GATEWAY, "Devin speech recognition failed")
}
fn timed_out() -> ProxyError {
    ProxyError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "Devin speech recognition timed out",
    )
}
fn request_error(error: reqwest::Error) -> ProxyError {
    if error.is_timeout() {
        timed_out()
    } else {
        failed()
    }
}

#[cfg(test)]
mod tests;
