//! Adapted from EchoBird account_proxy; only speech transport is included.
use super::compat::{
    body::Bytes,
    http::{HeaderName, HeaderValue, Request, StatusCode},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::{collections::BTreeMap, future::Future, time::Duration};
use tokio::time::{Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::frame::coding::CloseCode, Error, Message,
};

use super::ProxyError;

const ENDPOINT: &str = "wss://snap-access.cn-north-4.myhuaweicloud.com";
const PATH: &str = "/v1/speech/continue-stream";
const END: &str = r#"{"command":"END","params":"command=end&cancel=false"}"#;
const CHUNK_BYTES: usize = 3_200;

pub(crate) async fn transcribe(
    _client: &reqwest::Client,
    credentials: &Value,
    audio: &Bytes,
    _filename: &str,
    mime: &str,
) -> Result<String, ProxyError> {
    let pcm = validated_pcm(audio, mime)?;
    tokio::time::timeout(
        super::voice::media_timeout(pcm.len()),
        recognize(credentials, pcm, Duration::from_secs(5)),
    )
    .await
    .map_err(|_| timed_out())?
}

pub(crate) fn validate_audio(audio: &Bytes, mime: &str) -> Result<(), ProxyError> {
    validated_pcm(audio, mime).map(|_| ())
}

fn validated_pcm<'a>(audio: &'a [u8], mime: &str) -> Result<&'a [u8], ProxyError> {
    if !mime.eq_ignore_ascii_case("audio/wav") && !mime.eq_ignore_ascii_case("audio/x-wav") {
        return Err(ProxyError::new(
            StatusCode::BAD_REQUEST,
            "CodeArts speech requires WAV audio",
        ));
    }
    super::audio_format::pcm(audio).map_err(|_| {
        ProxyError::new(
            StatusCode::BAD_REQUEST,
            "CodeArts speech requires 16 kHz mono PCM16 WAV audio",
        )
    })
}

fn request(credentials: &Value) -> Result<Request<()>, ProxyError> {
    let endpoint = ENDPOINT;
    #[cfg(test)]
    let endpoint = credentials["_voice_test_endpoint"]
        .as_str()
        .unwrap_or(endpoint);
    let mut url = url::Url::parse(endpoint).map_err(|_| failed())?;
    url.set_path(PATH);
    url.set_query(None);
    // Native omission and invalid-language branches both use this exact default.
    url.query_pairs_mut()
        .append_pair("command", "start")
        .append_pair("audioFormat", "pcm16k16bit")
        .append_pair("property", "chinese_16k_general");
    let headers =
        super::codearts_signed_headers("GET", url.as_str(), credentials, "", BTreeMap::new())
            .map_err(|_| login_required())?;
    let mut request = url.as_str().into_client_request().map_err(|_| failed())?;
    for (name, value) in headers {
        request.headers_mut().insert(
            HeaderName::try_from(name).map_err(|_| login_required())?,
            HeaderValue::from_str(&value).map_err(|_| login_required())?,
        );
    }
    Ok(request)
}

async fn recognize(
    credentials: &Value,
    pcm: &[u8],
    tail_wait: Duration,
) -> Result<String, ProxyError> {
    let request = request(credentials)?;
    let (mut socket, _response) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| timed_out())?
    .map_err(|error| match error {
        Error::Http(response) => {
            let mut error = ProxyError::new(response.status(), "CodeArts speech connection failed");
            error.retry_after = response.headers().get("retry-after").cloned();
            error
        }
        _ => failed(),
    })?;
    #[cfg(test)]
    trace(
        "connected",
        serde_json::json!({"status":_response.status().as_u16()}),
    );
    let mut clock = tokio::time::interval_at(
        Instant::now() + Duration::from_millis(100),
        Duration::from_millis(100),
    );
    clock.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let deadline = tokio::time::sleep(tail_wait);
    tokio::pin!(deadline);
    let mut cursor = 0;
    let mut ending = false;
    let mut segments = Vec::new();
    let mut received_segments = false;
    loop {
        match next_event(socket.next(), clock.tick(), deadline.as_mut(), ending).await {
            InputEvent::Read(message) => {
                let message = message.ok_or_else(failed)?.map_err(|_| failed())?;
                match message {
                    Message::Text(text) => {
                        received_segments |= update(text.as_bytes(), &mut segments)?;
                        #[cfg(test)]
                        trace("response", serde_json::json!({"segments":segments.len()}));
                    }
                    Message::Ping(bytes) => {
                        socket
                            .send(Message::Pong(bytes))
                            .await
                            .map_err(|_| failed())?;
                    }
                    Message::Pong(_) => {}
                    Message::Close(frame) => {
                        if !ending || frame.is_some_and(|frame| frame.code != CloseCode::Normal) {
                            return Err(failed());
                        }
                        let _ =
                            tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
                        #[cfg(test)]
                        trace(
                            "return",
                            serde_json::json!({"reason":"clean_close","segments":segments.len()}),
                        );
                        return Ok(finish(segments));
                    }
                    _ => return Err(failed()),
                }
            }
            InputEvent::Audio => {
                let end = (cursor + CHUNK_BYTES).min(pcm.len());
                socket
                    .send(Message::Binary(pcm[cursor..end].to_vec().into()))
                    .await
                    .map_err(|_| failed())?;
                cursor = end;
                if cursor == pcm.len() {
                    socket
                        .send(Message::Text(END.into()))
                        .await
                        .map_err(|_| failed())?;
                    ending = true;
                    deadline.as_mut().reset(Instant::now() + tail_wait);
                    #[cfg(test)]
                    trace("input_end", serde_json::json!({"pcm_bytes":cursor}));
                }
            }
            InputEvent::Fallback => {
                if !received_segments {
                    return Err(timed_out());
                }
                // Native UI retains the latest segments after its five-second stop wait.
                let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
                #[cfg(test)]
                trace(
                    "return",
                    serde_json::json!({"reason":"tail_wait","segments":segments.len()}),
                );
                return Ok(finish(segments));
            }
        }
    }
}

enum InputEvent {
    Read(Option<Result<Message, Error>>),
    Audio,
    Fallback,
}

// Shared by the actual socket loop and ready-future fixtures so the tie is
// exercised directly, without relying on network/timer scheduling in a test.
async fn next_event<M, C, D>(message: M, clock: C, deadline: D, ending: bool) -> InputEvent
where
    M: Future<Output = Option<Result<Message, Error>>>,
    C: Future,
    D: Future,
{
    tokio::select! {
        biased;
        message = message => InputEvent::Read(message),
        _ = clock, if !ending => InputEvent::Audio,
        _ = deadline, if ending => InputEvent::Fallback,
    }
}

fn update(raw: &[u8], segments: &mut Vec<(f64, String)>) -> Result<bool, ProxyError> {
    let value: Value = serde_json::from_slice(raw).map_err(|_| failed())?;
    if !value.is_object()
        || value["status"] == "error"
        || matches!(value["resp_type"].as_str(), Some("ERROR" | "FATAL_ERROR"))
        || value.get("error_code").is_some_and(|code| !code.is_null())
    {
        return Err(failed());
    }
    let Some(incoming) = value.get("segments") else {
        return Ok(false);
    };
    for segment in incoming.as_array().ok_or_else(failed)? {
        let text = &segment["result"]["text"];
        if text.is_null() || text == "" {
            continue;
        }
        let text = text.as_str().ok_or_else(failed)?;
        let start = segment["start_time"]
            .as_f64()
            .or_else(|| segment["start_time"].as_str()?.parse::<f64>().ok())
            .filter(|time| time.is_finite())
            .ok_or_else(failed)?;
        if let Some((_, previous)) = segments.iter_mut().find(|(time, _)| *time == start) {
            *previous = text.into();
        } else {
            segments.push((start, text.into()));
        }
    }
    Ok(true)
}

fn finish(mut segments: Vec<(f64, String)>) -> String {
    segments.sort_by(|left, right| left.0.total_cmp(&right.0));
    segments.into_iter().map(|(_, text)| text).collect()
}

fn failed() -> ProxyError {
    ProxyError::new(StatusCode::BAD_GATEWAY, "CodeArts speech request failed")
}

fn timed_out() -> ProxyError {
    ProxyError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "CodeArts speech request timed out",
    )
}

fn login_required() -> ProxyError {
    ProxyError::new(StatusCode::UNAUTHORIZED, "CodeArts speech login required")
}

#[cfg(test)]
fn trace(stage: &str, value: Value) {
    if std::env::var("ECHOBIRD_ACCOUNT_VOICE_TEST_TRACE").as_deref() == Ok("1") {
        eprintln!("CodeArts speech stage={stage} {value}");
    }
}

#[cfg(test)]
mod tests;
