use super::*;
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Request},
    routing::post,
    Router,
};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

struct Fixture {
    credentials: Value,
    server: tokio::task::JoinHandle<()>,
    seen: Arc<Notify>,
    body: Arc<Mutex<Vec<u8>>>,
    headers: Arc<Mutex<HeaderMap>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn fixture(mode: &'static str) -> Fixture {
    let seen = Arc::new(Notify::new());
    let body = Arc::new(Mutex::new(Vec::new()));
    let headers = Arc::new(Mutex::new(HeaderMap::new()));
    let (capture, request_body, request_headers) = (seen.clone(), body.clone(), headers.clone());
    let app = Router::new().route(
        PATH,
        post(move |request: Request<Body>| {
            let (capture, request_body, request_headers) = (
                capture.clone(),
                request_body.clone(),
                request_headers.clone(),
            );
            async move {
                assert_eq!(request.version(), Version::HTTP_11);
                assert_eq!(request.uri().path_and_query().unwrap().as_str(), PATH);
                *request_headers.lock().unwrap() = request.headers().clone();
                *request_body.lock().unwrap() = axum::body::to_bytes(request.into_body(), 100_000)
                    .await
                    .unwrap()
                    .to_vec();
                capture.notify_one();
                if mode == "wait" {
                    std::future::pending::<()>().await;
                }
                let mut response = axum::http::Response::new(Body::from(match mode {
                    "empty" => vec![0x10, 0x01],
                    "malformed" => vec![0x0a, 0xff],
                    "401" | "429" => b"private-upstream-secret".to_vec(),
                    // text='hello coffee', time_ms=150: fixed unframed protobuf vector.
                    _ => b"\x0a\x0chello coffee\x10\x96\x01".to_vec(),
                }));
                if mode == "401" {
                    *response.status_mut() = StatusCode::UNAUTHORIZED;
                } else if mode == "429" {
                    *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
                }
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/proto"),
                );
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from_static("9"));
                response
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fixture {
        credentials: json!({"accessToken":"bot-secret","teamId":8,"_voice_test_endpoint":base,"baseUrl":"https://never-used.invalid"}),
        server,
        seen,
        body,
        headers,
    }
}

#[tokio::test]
async fn native_unary_protobuf_audio_and_mime_have_independent_wire_vectors() {
    let fixture = fixture("ok").await;
    let audio = Bytes::from_static(b"abc");
    assert_eq!(
        transcribe(
            &reqwest::Client::new(),
            &fixture.credentials,
            &audio,
            "voice.webm",
            "audio/webm;codecs=opus"
        )
        .await
        .unwrap(),
        "hello coffee"
    );
    assert_eq!(
        &*fixture.body.lock().unwrap(),
        b"\x0a\x03abc\x12\x0aaudio/webm"
    );
    let headers = fixture.headers.lock().unwrap();
    assert_eq!(headers[header::AUTHORIZATION], "Bearer bot-secret");
    assert_eq!(headers[header::CONTENT_TYPE], "application/proto");
    assert_eq!(headers["connect-protocol-version"], "1");
    assert_eq!(headers["x-cursor-client-type"], "sand");
    assert_eq!(headers["x-cursor-team-id"], "8");
    assert_eq!(headers["x-sand-box-namespace"], "prod");
    assert_eq!(headers["x-ghost-mode"], "true");
}

#[tokio::test]
async fn auth_rate_malformed_empty_and_cancellation_never_return_secret_or_partial() {
    for (mode, status) in [
        ("401", StatusCode::UNAUTHORIZED),
        ("429", StatusCode::TOO_MANY_REQUESTS),
        ("empty", StatusCode::BAD_GATEWAY),
        ("malformed", StatusCode::BAD_GATEWAY),
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
        assert!(!error.message.contains("private-upstream-secret"));
        assert!(!error.message.contains("bot-secret"));
        if mode == "429" {
            assert_eq!(error.retry_after.unwrap(), "9");
        }
    }
    let fixture = fixture("wait").await;
    let credentials = fixture.credentials.clone();
    let call = tokio::spawn(async move {
        transcribe(
            &reqwest::Client::new(),
            &credentials,
            &Bytes::from_static(b"abc"),
            "voice.webm",
            "audio/webm",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), fixture.seen.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
}

#[test]
fn empty_and_unsupported_inputs_are_rejected_before_a_request() {
    assert!(validate_audio(&Bytes::new(), "audio/webm").is_err());
    assert!(validate_audio(&Bytes::from_static(b"abc"), "audio/mpeg").is_err());
    assert!(validate_audio(&Bytes::from_static(b"abc"), "audio/wav").is_err());
}
