use super::*;
use axum::{body::Body, http::Request, routing::post, Router};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, Notify};

#[derive(Default)]
struct Record {
    headers: HeaderMap,
    path: String,
    version: Option<Version>,
    messages: Vec<Vec<u8>>,
    input_closed: bool,
}

#[derive(Default)]
struct Observed {
    record: Mutex<Record>,
    first_audio: Notify,
    worker_dropped: Notify,
}

struct DropSignal(Arc<Observed>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        self.0.worker_dropped.notify_one();
    }
}

struct Fixture {
    credentials: Value,
    observed: Arc<Observed>,
    server: tokio::task::JoinHandle<()>,
    workers: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        for worker in self.workers.lock().unwrap().iter() {
            worker.abort();
        }
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .http2_prior_knowledge()
        .http2_initial_stream_window_size(65_535)
        .http2_initial_connection_window_size(65_535)
        .build()
        .unwrap()
}

fn wav(bytes: usize) -> Bytes {
    let mut result = b"RIFF".to_vec();
    result.extend_from_slice(&((bytes + 36) as u32).to_le_bytes());
    result.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    result.extend_from_slice(&16_000_u32.to_le_bytes());
    result.extend_from_slice(&32_000_u32.to_le_bytes());
    result.extend_from_slice(b"\x02\0\x10\0data");
    result.extend_from_slice(&(bytes as u32).to_le_bytes());
    result.extend((0..bytes).map(|index| (index % 251) as u8));
    result.into()
}

// Independent fixture wire writer; client setup/start/end are also checked against
// fixed byte vectors below, so an encoder/decoder mistake cannot cancel itself out.
fn pb(number: u8, value: &[u8]) -> Vec<u8> {
    let mut bytes = vec![number * 8 + 2];
    let mut length = value.len();
    loop {
        let next = length >> 7;
        bytes.push((length & 127) as u8 | if next == 0 { 0 } else { 128 });
        length = next;
        if length == 0 {
            break;
        }
    }
    bytes.extend_from_slice(value);
    bytes
}

fn wire(message: &[u8]) -> Bytes {
    let mut bytes = vec![0];
    bytes.extend_from_slice(&(message.len() as u32).to_be_bytes());
    bytes.extend_from_slice(message);
    bytes.into()
}

fn transcription(text: &str, final_segment: bool) -> Bytes {
    wire(&pb(
        2,
        &pb(if final_segment { 6 } else { 11 }, &pb(1, text.as_bytes())),
    ))
}

async fn worker(
    mut body: Body,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    trailers: oneshot::Sender<Option<HeaderMap>>,
    observed: Arc<Observed>,
    mode: &'static str,
) {
    let _signal = DropSignal(observed.clone());
    let mut pending = Vec::new();
    let mut count = 0;
    let mut audio_count = 0;
    loop {
        let frame = match body.frame().await {
            Some(Ok(frame)) => frame,
            Some(Err(_)) => return,
            None => break,
        };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        pending.extend_from_slice(&data);
        while pending.len() >= 5 {
            assert_eq!(pending[0], 0);
            let length = u32::from_be_bytes(pending[1..5].try_into().unwrap()) as usize;
            if pending.len() < length + 5 {
                break;
            }
            let message = pending[5..5 + length].to_vec();
            pending.drain(..5 + length);
            observed
                .record
                .lock()
                .unwrap()
                .messages
                .push(message.clone());
            if count == 0 {
                let ready = match mode {
                    "badsetup" => wire(b"\x0a\x01\xff"),
                    "wrongsetup" => transcription("private-interim", false),
                    "compressed" => Bytes::from_static(b"\x01\0\0\0\x02\x0a\0"),
                    "early_eof" => {
                        let mut headers = HeaderMap::new();
                        headers.insert("grpc-status", HeaderValue::from_static("0"));
                        let _ = trailers.send(Some(headers));
                        return;
                    }
                    _ => Bytes::from_static(b"\0\0\0\0\x02\x0a\0"),
                };
                if tx.send(Ok(ready.slice(..2))).await.is_err()
                    || tx.send(Ok(ready.slice(2..))).await.is_err()
                {
                    return;
                }
            } else if message != b"\x1a\x02\x2a\0" && message != b"\x1a\x02\x32\0" {
                audio_count += 1;
                observed.first_audio.notify_one();
                let reply = if mode == "duplex" && audio_count == 1 {
                    transcription(&"x".repeat(130_000), false)
                } else if mode == "duplex" && audio_count == 2 {
                    transcription("你", true)
                } else {
                    transcription("temporary partial", false)
                };
                // More than the configured HTTP/2 receive window, with backpressure:
                // a client that only uploads and postpones reads cannot finish.
                for chunk in reply.chunks(1024) {
                    if tx.send(Ok(Bytes::copy_from_slice(chunk))).await.is_err() {
                        return;
                    }
                }
                if mode == "cancel" {
                    tx.closed().await;
                    return;
                }
            } else if message == b"\x1a\x02\x32\0" {
                let reply = if mode == "duplex" { "好。" } else { "完成" };
                if tx.send(Ok(transcription(reply, true))).await.is_err() {
                    return;
                }
                if matches!(mode, "duplex" | "fallback")
                    && tx.send(Ok(transcription("coffee", false))).await.is_err()
                {
                    return;
                }
            }
            count += 1;
        }
    }
    observed.record.lock().unwrap().input_closed = true;
    if mode == "fallback" {
        tx.closed().await;
        return;
    }
    if mode == "stalled_frame" {
        if tx
            .send(Ok(Bytes::from_static(b"\0\0\0\0\x07\x12")))
            .await
            .is_ok()
        {
            tx.closed().await;
        }
        return;
    }
    if mode == "truncated" {
        let _ = tx.send(Ok(Bytes::from_static(b"\0\0\0\0\x07\x12"))).await;
    }
    let code = mode.strip_prefix("grpc_").unwrap_or("0");
    let mut headers = HeaderMap::new();
    headers.insert("grpc-status", HeaderValue::from_str(code).unwrap());
    headers.insert(
        "grpc-message",
        HeaderValue::from_static("private-upstream-secret"),
    );
    headers.insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
    let _ = trailers.send(if mode == "missing_status" {
        None
    } else {
        Some(headers)
    });
}

async fn fixture(mode: &'static str) -> Fixture {
    let observed = Arc::new(Observed::default());
    let workers: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::default();
    let captured = observed.clone();
    let tasks = workers.clone();
    let app = Router::new().route(
        PATH,
        post(move |request: Request<Body>| {
            let captured = captured.clone();
            let tasks = tasks.clone();
            async move {
                let (parts, body) = request.into_parts();
                {
                    let mut record = captured.record.lock().unwrap();
                    record.headers = parts.headers;
                    record.path = parts.uri.path_and_query().unwrap().to_string();
                    record.version = Some(parts.version);
                }
                if matches!(mode, "http401" | "http429" | "header16") {
                    let mut response =
                        axum::http::Response::new(Body::from("private-upstream-secret"));
                    *response.status_mut() = match mode {
                        "http401" => StatusCode::UNAUTHORIZED,
                        "http429" => StatusCode::TOO_MANY_REQUESTS,
                        _ => StatusCode::OK,
                    };
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("application/grpc"),
                    );
                    response
                        .headers_mut()
                        .insert("grpc-status", HeaderValue::from_static("16"));
                    response
                        .headers_mut()
                        .insert(header::RETRY_AFTER, HeaderValue::from_static("7"));
                    return response;
                }
                let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(2);
                let (trailer_tx, trailer_rx) = oneshot::channel();
                tasks
                    .lock()
                    .unwrap()
                    .push(tokio::spawn(worker(body, tx, trailer_tx, captured, mode)));
                let stream = Body::from_stream(ReceiverStream::new(rx)).with_trailers(async move {
                    trailer_rx.await.ok().flatten().map(Ok::<_, axum::Error>)
                });
                let mut response = axum::http::Response::new(Body::new(stream));
                response.headers_mut().insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("application/grpc+proto"),
                );
                response
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Fixture {
        credentials: json!({"accessToken":"fixture-account-secret","_voice_test_endpoint":base,
            "projectId":"must-not-send","location":"must-not-send","baseUrl":"https://untrusted.invalid"}),
        observed,
        server,
        workers,
    }
}

#[tokio::test]
async fn native_http2_duplex_setup_pcm_close_and_trailers() {
    let fixture = fixture("duplex").await;
    let audio = wav(200_000);
    let text = transcribe(
        &client(),
        &fixture.credentials,
        "native-first",
        &audio,
        "speech.wav",
        "audio/wav",
    )
    .await
    .unwrap();
    assert_eq!(text, "你好。 coffee");
    let record = fixture.observed.record.lock().unwrap();
    assert_eq!(record.version, Some(Version::HTTP_2));
    assert_eq!(record.path, PATH);
    assert_eq!(
        record.headers[header::AUTHORIZATION],
        "Bearer fixture-account-secret"
    );
    assert_eq!(record.headers[header::CONTENT_TYPE], "application/grpc");
    assert_eq!(record.headers[header::TE], "trailers");
    for name in ["x-goog-user-project", "x-goog-request-params"] {
        assert!(!record.headers.contains_key(name));
    }
    assert!(record.input_closed);
    assert_eq!(
        record.messages[0],
        b"\x0a\x16\x0a\x0cnative-first\x2a\x04\x32\x02\x08\x01\x42\0"
    );
    assert_eq!(record.messages[1], b"\x1a\x02\x2a\0");
    assert_eq!(record.messages.last().unwrap(), b"\x1a\x02\x32\0");
    let expected: Vec<_> = audio[44..]
        .chunks(32_000)
        .map(|chunk| {
            let mut blob = b"\x0a\x14audio/pcm;rate=16000".to_vec();
            blob.extend(pb(2, chunk));
            pb(3, &pb(1, &blob))
        })
        .collect();
    assert_eq!(&record.messages[2..record.messages.len() - 1], expected);
}

#[tokio::test]
async fn http_and_grpc_errors_never_return_partial_or_upstream_secrets() {
    for (mode, status) in [
        ("http401", StatusCode::UNAUTHORIZED),
        ("http429", StatusCode::TOO_MANY_REQUESTS),
        ("header16", StatusCode::UNAUTHORIZED),
        ("grpc_16", StatusCode::UNAUTHORIZED),
        ("grpc_7", StatusCode::FORBIDDEN),
        ("grpc_8", StatusCode::TOO_MANY_REQUESTS),
        ("grpc_4", StatusCode::GATEWAY_TIMEOUT),
        ("grpc_14", StatusCode::SERVICE_UNAVAILABLE),
        ("grpc_13", StatusCode::BAD_GATEWAY),
    ] {
        let fixture = fixture(mode).await;
        let error = transcribe(
            &client(),
            &fixture.credentials,
            "native-first",
            &wav(8),
            "speech.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, status, "{mode}");
        assert_eq!(error.retry_after.unwrap(), "7");
        assert!(!error.message.contains("secret"));
        assert!(!error.message.contains("temporary"));
        assert!(!error.message.contains("完成"));
    }
}

#[tokio::test]
async fn invalid_setup_compression_truncation_and_missing_grpc_status_fail() {
    for mode in [
        "badsetup",
        "wrongsetup",
        "compressed",
        "early_eof",
        "truncated",
        "missing_status",
    ] {
        let fixture = fixture(mode).await;
        let error = transcribe(
            &client(),
            &fixture.credentials,
            "native-first",
            &wav(8),
            "speech.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY, "{mode}");
        assert!(!error.message.contains("private"));
    }
}

#[tokio::test]
async fn native_ten_second_fallback_keeps_final_segments_and_latest_partial() {
    let fixture = fixture("fallback").await;
    let start = tokio::time::Instant::now();
    let text = transcribe(
        &client(),
        &fixture.credentials,
        "native-first",
        &wav(8),
        "speech.wav",
        "audio/wav",
    )
    .await
    .unwrap();
    assert_eq!(text, "完成 coffee");
    assert!(start.elapsed() >= FINISH_WAIT);
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.observed.worker_dropped.notified(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn incomplete_response_frame_never_becomes_a_successful_fallback() {
    let fixture = fixture("stalled_frame").await;
    let error = transcribe(
        &client(),
        &fixture.credentials,
        "native-first",
        &wav(8),
        "speech.wav",
        "audio/wav",
    )
    .await
    .unwrap_err();
    assert_eq!(error.status, StatusCode::GATEWAY_TIMEOUT);
    assert!(fixture.observed.record.lock().unwrap().input_closed);
}

async fn response_ready_at_finish(mode: &'static str) -> Result<String, ProxyError> {
    use std::{
        future::{poll_fn, Future},
        sync::atomic::{AtomicBool, Ordering},
        task::{Poll, Waker},
    };

    let fixture = fixture(mode).await;
    let observed = fixture.observed.clone();
    let held = Arc::new(Notify::new());
    let resumed = Arc::new(AtomicBool::new(false));
    let waker = Arc::new(Mutex::new(None::<Waker>));
    let task = {
        let held = held.clone();
        let resumed = resumed.clone();
        let waker = waker.clone();
        let credentials = fixture.credentials.clone();
        tokio::spawn(async move {
            let client = client();
            let audio = wav(200_000);
            let recognition = transcribe(
                &client,
                &credentials,
                "native-first",
                &audio,
                "speech.wav",
                "audio/wav",
            );
            tokio::pin!(recognition);
            poll_fn(|cx| {
                // Keep HTTP/2 and the server running, but defer the recognition
                // future until both the response and its finish timer are ready.
                if observed.record.lock().unwrap().input_closed && !resumed.load(Ordering::Acquire)
                {
                    *waker.lock().unwrap() = Some(cx.waker().clone());
                    held.notify_one();
                    Poll::Pending
                } else {
                    recognition.as_mut().poll(cx)
                }
            })
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(3), held.notified())
        .await
        .unwrap();
    tokio::time::sleep(FINISH_WAIT + Duration::from_millis(100)).await;
    resumed.store(true, Ordering::Release);
    waker.lock().unwrap().take().unwrap().wake();
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn ready_final_response_wins_over_the_finish_timer() {
    assert_eq!(
        response_ready_at_finish("duplex").await.unwrap(),
        "你好。 coffee"
    );
}

#[tokio::test]
async fn ready_grpc_error_wins_over_the_finish_timer() {
    let error = response_ready_at_finish("grpc_16").await.unwrap_err();
    assert_eq!(error.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn cancellation_drops_request_response_and_fixture_worker() {
    let fixture = fixture("cancel").await;
    let credentials = fixture.credentials.clone();
    let task = tokio::spawn(async move {
        transcribe(
            &client(),
            &credentials,
            "native-first",
            &wav(200_000),
            "speech.wav",
            "audio/wav",
        )
        .await
    });
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.observed.first_audio.notified(),
    )
    .await
    .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.observed.worker_dropped.notified(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn invalid_model_credentials_and_wave_are_rejected_before_network() {
    let fixture = fixture("duplex").await;
    let client = client();
    let cases = [
        (
            fixture.credentials.clone(),
            "",
            wav(8),
            "audio/wav",
            StatusCode::BAD_REQUEST,
        ),
        (
            fixture.credentials.clone(),
            "bad\nmodel",
            wav(8),
            "audio/wav",
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"_voice_test_endpoint":fixture.credentials["_voice_test_endpoint"]}),
            "native-first",
            wav(8),
            "audio/wav",
            StatusCode::UNAUTHORIZED,
        ),
        (
            json!({"accessToken":"bad\r\ntoken","_voice_test_endpoint":fixture.credentials["_voice_test_endpoint"]}),
            "native-first",
            wav(8),
            "audio/wav",
            StatusCode::UNAUTHORIZED,
        ),
        (
            fixture.credentials.clone(),
            "native-first",
            wav(8),
            "audio/mp3",
            StatusCode::BAD_REQUEST,
        ),
        (
            fixture.credentials.clone(),
            "native-first",
            wav(0),
            "audio/wav",
            StatusCode::BAD_REQUEST,
        ),
        (
            fixture.credentials.clone(),
            "native-first",
            wav(3),
            "audio/wav",
            StatusCode::BAD_REQUEST,
        ),
        (
            fixture.credentials.clone(),
            "native-first",
            Bytes::from_static(b"not-wav"),
            "audio/wav",
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (credentials, model, audio, mime, status) in cases {
        let error = transcribe(&client, &credentials, model, &audio, "speech.wav", mime)
            .await
            .unwrap_err();
        assert_eq!(error.status, status);
    }
    assert!(fixture.observed.record.lock().unwrap().path.is_empty());
}

#[test]
fn protobuf_boundaries_and_native_cjk_ranges_are_exact() {
    for bytes in [&b"\0"[..], &b"\x0a\xff"[..], &b"\x0b"[..], &b"\x09\0"[..]] {
        assert!(proto_fields(bytes).is_err());
    }
    for (input, output) in [
        ("你   好 ， 世 界", "你好，世界"),
        ("hello   world", "hello   world"),
        ("한 국", "한 국"),
        ("你\t好  ", "你\t好  "),
        ("你\u{3000}好", "你\u{3000}好"),
        ("Ａ Ｂ", "ＡＢ"),
        ("ㄅ ㄆ", "ㄅㄆ"),
        ("あ カ", "あカ"),
    ] {
        assert_eq!(collapse_cjk_spaces(input), output);
    }
    for rune in [0x1b132, 0x1b150, 0x1b000, 0x1b120, 0x33479, 0x02ea] {
        assert!(spaceless_cjk(char::from_u32(rune).unwrap()), "{rune:x}");
    }
    for rune in [0x1b133, 0x1b153, 0x3347a, 0x2e9a, 0xac00] {
        assert!(!spaceless_cjk(char::from_u32(rune).unwrap()), "{rune:x}");
    }
}
