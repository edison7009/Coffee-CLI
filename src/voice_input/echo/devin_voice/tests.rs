use super::*;
use axum::{body::Body, http::Request, routing::post, Router};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::sync::Notify;

struct Fixture {
    credentials: Value,
    requests: Arc<AtomicUsize>,
    seen: Arc<Notify>,
    body: Arc<Mutex<Vec<u8>>>,
    headers: Arc<Mutex<HeaderMap>>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn fixture(mode: &'static str) -> Fixture {
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = Arc::new(Notify::new());
    let body = Arc::new(Mutex::new(Vec::new()));
    let headers = Arc::new(Mutex::new(HeaderMap::new()));
    let (calls, signal, captured_body, captured_headers) = (
        requests.clone(),
        seen.clone(),
        body.clone(),
        headers.clone(),
    );
    let app = Router::new().route(PATH, post(move |request: Request<Body>| {
        let (calls, signal, captured_body, captured_headers) = (calls.clone(), signal.clone(), captured_body.clone(), captured_headers.clone());
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(request.uri().path_and_query().unwrap().as_str(), PATH);
            *captured_headers.lock().unwrap() = request.headers().clone();
            let body = axum::body::to_bytes(request.into_body(), MAX_AUDIO + 4096).await.unwrap().to_vec();
            *captured_body.lock().unwrap() = body;
            signal.notify_one();
            if mode == "wait" { std::future::pending::<()>().await; }
            let mut response = axum::http::Response::new(Body::from(match mode {
                "empty" => vec![],
                "wrong_field" => b"\x0a\x0chello coffee".to_vec(),
                "malformed" => vec![0x12,0xff],
                "invalid_utf8" => vec![0x12,1,0xff],
                "blank" => b"\x12\x02  ".to_vec(),
                "duplicates" => b"\x12\x03old\x12\x05final".to_vec(),
                "unicode" => b"\x12\x06\xe5\x92\x96\xe5\x95\xa1".to_vec(),
                "oversize" => vec![0;MAX_RESPONSE+1],
                "401" | "429" => b"private-upstream-secret".to_vec(),
                "code401" => br#"{"code":"unauthenticated","message":"private-upstream-secret"}"#.to_vec(),
                "code429" => br#"{"error":{"code":"resource_exhausted","message":"private-upstream-secret"},"metadata":{"retry-after":["11"]}}"#.to_vec(),
                "code400" => br#"{"code":"invalid_argument","message":"private-upstream-secret"}"#.to_vec(),
                "code504" => br#"{"code":"deadline_exceeded","message":"private-upstream-secret"}"#.to_vec(),
                "code503" => br#"{"code":"unavailable","message":"private-upstream-secret"}"#.to_vec(),
                // Independent upstream vector: field1 ignored, final text is field2.
                _ => b"\x0a\x03bad\x12\x0chello coffee".to_vec(),
            }));
            if mode == "oversize_chunked" {
                *response.body_mut() = Body::from_stream(futures_util::stream::iter([
                    Ok::<_,std::io::Error>(Bytes::from(vec![0;MAX_RESPONSE])),
                    Ok(Bytes::from_static(b"x")),
                ]));
            } else if mode == "truncated_http" {
                *response.body_mut() = Body::from_stream(futures_util::stream::iter([
                    Ok(Bytes::from_static(b"\x12\x0chello coffee")),
                    Err(std::io::Error::other("fixture-response-interrupted")),
                ]));
            }
            if mode.starts_with("401_") || mode.starts_with("429_") {
                if mode.ends_with("_stalled") {
                    *response.body_mut() = Body::from_stream(futures_util::stream::pending::<Result<Bytes, std::io::Error>>());
                } else if mode.ends_with("_oversize") {
                    *response.body_mut() = Body::from(vec![0; MAX_RESPONSE + 1]);
                } else if mode.ends_with("_truncated") {
                    // Publish headers and initial data before interrupting the body.
                    // The service status must not depend on completing this stream.
                    *response.body_mut() = Body::from_stream(futures_util::stream::unfold(0, |state| async move {
                        match state {
                            0 => Some((Ok(Bytes::from_static(b"private-upstream-body")), 1)),
                            1 => {
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                Some((Err(std::io::Error::other("fixture-error-body-interrupted")), 2))
                            }
                            _ => None,
                        }
                    }));
                }
            }
            *response.status_mut() = match mode { "401"=>StatusCode::UNAUTHORIZED, "429"=>StatusCode::TOO_MANY_REQUESTS, _ if mode.starts_with("401_")=>StatusCode::UNAUTHORIZED, _ if mode.starts_with("429_")=>StatusCode::TOO_MANY_REQUESTS, _=>StatusCode::OK };
            response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(if mode.starts_with("code") {"application/json"} else {"application/proto"}));
            if mode=="429" || mode.starts_with("401_") || mode.starts_with("429_") { response.headers_mut().insert(header::RETRY_AFTER,HeaderValue::from_static("7")); }
            response
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fixture {
        credentials: json!({"accessToken":"devin-session-token$fixture","baseUrl":base,"userId":"fixture-user","model":"must-not-be-sent"}),
        requests,
        seen,
        body,
        headers,
        server,
    }
}

fn wav(bytes: usize) -> Bytes {
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&((bytes + 36) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    out.extend_from_slice(&16_000u32.to_le_bytes());
    out.extend_from_slice(&32_000u32.to_le_bytes());
    out.extend_from_slice(b"\x02\0\x10\0data");
    out.extend_from_slice(&(bytes as u32).to_le_bytes());
    out.extend(vec![1; bytes]);
    out.into()
}

#[tokio::test]
async fn native_api_request_and_field_two_response_use_independent_wire_vectors() {
    let fixture = fixture("ok").await;
    let text = transcribe(
        &reqwest::Client::new(),
        &fixture.credentials,
        &Bytes::from_static(b"abc"),
        "voice.webm",
        "audio/webm;codecs=opus",
    )
    .await
    .unwrap();
    assert_eq!(text, "hello coffee");
    // No production encoder/decoder is used to produce this expected metadata.
    let mut metadata =
        b"\x0a\x09devin-cli\x12\x0a3000.11.92\x1a\x1bdevin-session-token$fixture\x22\x02en"
            .to_vec();
    metadata.extend_from_slice(match std::env::consts::OS {
        "windows" => b"\x2a\x07windows",
        "macos" => b"\x2a\x05macos",
        "linux" => b"\x2a\x05linux",
        _ => panic!("fixture requires a supported desktop OS"),
    });
    metadata.extend_from_slice(b"\x3a\x0a3000.11.92\x62\x06chisel\xe2\x01\x06chisel");
    assert!(metadata.len() < 128);
    let mut expected = vec![0x0a, metadata.len() as u8];
    expected.extend(metadata);
    expected.extend_from_slice(b"\x12\x03abc");
    assert_eq!(*fixture.body.lock().unwrap(), expected);
    let headers = fixture.headers.lock().unwrap();
    assert_eq!(headers[header::CONTENT_TYPE], "application/proto");
    assert_eq!(headers["connect-protocol-version"], "1");
    assert!(!headers.contains_key(header::AUTHORIZATION));
    assert!(!headers.contains_key("x-codeium-csrf-token"));
    assert_eq!(fixture.requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn wav_is_preserved_as_a_controlled_candidate_without_mime_or_model_fields() {
    let fixture = fixture("ok").await;
    let audio = wav(640);
    assert_eq!(
        transcribe(
            &reqwest::Client::new(),
            &fixture.credentials,
            &audio,
            "voice.wav",
            "audio/wav"
        )
        .await
        .unwrap(),
        "hello coffee"
    );
    let body = fixture.body.lock().unwrap();
    assert!(body.ends_with(&audio));
    assert!(!body.windows(9).any(|bytes| bytes == b"audio/wav"));
    assert!(!body.windows(16).any(|bytes| bytes == b"must-not-be-sent"));
}

#[tokio::test]
async fn http_and_connect_errors_keep_status_and_retry_after_without_upstream_details() {
    for (mode, status, retry) in [
        ("401", StatusCode::UNAUTHORIZED, None),
        ("429", StatusCode::TOO_MANY_REQUESTS, Some("7")),
        ("code401", StatusCode::UNAUTHORIZED, None),
        ("code429", StatusCode::TOO_MANY_REQUESTS, Some("11")),
        ("code400", StatusCode::BAD_REQUEST, None),
        ("code504", StatusCode::GATEWAY_TIMEOUT, None),
        ("code503", StatusCode::SERVICE_UNAVAILABLE, None),
    ] {
        let fixture = fixture(mode).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &fixture.credentials,
            &Bytes::from_static(b"abc"),
            "voice.webm",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, status);
        assert_eq!(
            error
                .retry_after
                .as_ref()
                .and_then(|value| value.to_str().ok()),
            retry
        );
        assert!(!error.message.contains("private-upstream-secret"));
        assert!(!error.message.contains("devin-session-token"));
    }
}

#[tokio::test]
async fn known_auth_and_rate_status_do_not_wait_for_or_parse_an_error_body() {
    for (mode, status) in [
        ("401_stalled", StatusCode::UNAUTHORIZED),
        ("401_truncated", StatusCode::UNAUTHORIZED),
        ("401_oversize", StatusCode::UNAUTHORIZED),
        ("429_stalled", StatusCode::TOO_MANY_REQUESTS),
        ("429_truncated", StatusCode::TOO_MANY_REQUESTS),
        ("429_oversize", StatusCode::TOO_MANY_REQUESTS),
    ] {
        let fixture = fixture(mode).await;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            transcribe(
                &reqwest::Client::new(),
                &fixture.credentials,
                &Bytes::from_static(b"abc"),
                "voice.webm",
                "audio/webm",
            ),
        )
        .await
        .expect("known service status must not wait for an error body");
        let error = result.unwrap_err();
        assert_eq!(error.status, status, "{mode}");
        assert_eq!(error.retry_after.unwrap(), "7", "{mode}");
        assert_eq!(fixture.requests.load(Ordering::SeqCst), 1);
        assert!(!error.message.contains("private-upstream"));
    }
}

#[tokio::test]
async fn malformed_empty_oversized_and_ls_responses_do_not_return_a_partial() {
    for mode in [
        "empty",
        "wrong_field",
        "malformed",
        "invalid_utf8",
        "blank",
        "oversize",
        "oversize_chunked",
        "truncated_http",
    ] {
        let fixture = fixture(mode).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &fixture.credentials,
            &Bytes::from_static(b"abc"),
            "voice.webm",
            "audio/webm",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
    }
    let duplicates = fixture("duplicates").await;
    assert_eq!(
        transcribe(
            &reqwest::Client::new(),
            &duplicates.credentials,
            &Bytes::from_static(b"abc"),
            "voice.webm",
            "audio/webm"
        )
        .await
        .unwrap(),
        "final"
    );
    let fixture = fixture("unicode").await;
    assert_eq!(
        transcribe(
            &reqwest::Client::new(),
            &fixture.credentials,
            &Bytes::from_static(b"abc"),
            "voice.webm",
            "audio/webm"
        )
        .await
        .unwrap(),
        "咖啡"
    );
}

#[tokio::test]
async fn invalid_wav_and_mime_fail_before_auth_or_network_and_cancel_drops_request() {
    let fixture = fixture("wait").await;
    for (audio, mime) in [
        (Bytes::new(), "audio/webm"),
        (wav(0), "audio/wav"),
        (Bytes::from_static(b"bad"), "audio/wav"),
        (wav(2), "audio/mp4"),
    ] {
        let error = transcribe(
            &reqwest::Client::new(),
            &Value::Null,
            &audio,
            "voice.wav",
            mime,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(fixture.requests.load(Ordering::SeqCst), 0);
    let credentials = fixture.credentials.clone();
    let call = tokio::spawn(async move {
        transcribe(
            &reqwest::Client::new(),
            &credentials,
            &wav(640),
            "voice.wav",
            "audio/wav",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), fixture.seen.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
    assert_eq!(fixture.requests.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn redirect_does_not_replay_metadata_or_audio_to_another_origin() {
    let received = Arc::new(AtomicUsize::new(0));
    let observed = received.clone();
    let sink = Router::new().route(
        "/sink",
        post(move || {
            let observed = observed.clone();
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                "must-not-be-called"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let location = format!("http://{}/sink", listener.local_addr().unwrap());
    let sink_server = tokio::spawn(async move { axum::serve(listener, sink).await.unwrap() });
    let app = Router::new().route(
        PATH,
        post(move || {
            let location = location.clone();
            async move {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [(header::LOCATION, location)],
                    "private-upstream-secret",
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let result = transcribe(
        &reqwest::Client::new(),
        &json!({"accessToken":"devin-session-token$fixture","baseUrl":base}),
        &Bytes::from_static(b"abc"),
        "voice.webm",
        "audio/webm",
    )
    .await;
    server.abort();
    sink_server.abort();
    assert_eq!(result.unwrap_err().status, StatusCode::BAD_GATEWAY);
    assert_eq!(received.load(Ordering::SeqCst), 0);
}
