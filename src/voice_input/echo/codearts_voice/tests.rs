use super::*;
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio_tungstenite::tungstenite::{
    handshake::server::{ErrorResponse, Request as WsRequest, Response},
    protocol::CloseFrame,
};

#[derive(Clone, Copy)]
enum Mode {
    Normal,
    Silence,
    Fallback,
    NoResult,
    Error,
    Fatal,
    EarlyClose,
    BadClose,
    Hold,
    Reject(u16),
}

#[derive(Default)]
struct Record {
    headers: axum::http::HeaderMap,
    uri: String,
    audio: Vec<u8>,
    sizes: Vec<usize>,
    controls: Vec<Value>,
    pongs: usize,
}

struct Server {
    endpoint: String,
    record: Arc<Mutex<Record>>,
    first_audio: Arc<tokio::sync::Notify>,
    closed: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[allow(clippy::result_large_err)] // tungstenite's handshake callback uses an HTTP Response error.
async fn server(mode: Mode) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let record: Arc<Mutex<Record>> = Arc::default();
    let captured = record.clone();
    let first_audio = Arc::new(tokio::sync::Notify::new());
    let first = first_audio.clone();
    let closed = Arc::new(AtomicBool::new(false));
    let finished = closed.clone();
    let task = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let observed = captured.clone();
        let socket =
            tokio_tungstenite::accept_hdr_async(tcp, move |req: &WsRequest, res: Response| {
                let mut r = observed.lock().unwrap();
                r.headers = req.headers().clone();
                r.uri = req.uri().to_string();
                if let Mode::Reject(status) = mode {
                    let mut error = ErrorResponse::new(Some(
                        "private-upstream-body fixture-token fixture-sk".into(),
                    ));
                    *error.status_mut() = StatusCode::from_u16(status).unwrap();
                    error
                        .headers_mut()
                        .insert("retry-after", "7".parse().unwrap());
                    return Err(error);
                }
                Ok(res)
            })
            .await;
        let Ok(mut socket) = socket else {
            finished.store(true, Ordering::SeqCst);
            return;
        };
        socket.send(Message::Ping(vec![1, 2].into())).await.unwrap();
        while let Some(Ok(message)) = socket.next().await {
            match message {
                Message::Pong(_) => captured.lock().unwrap().pongs += 1,
                Message::Binary(bytes) => {
                    let first_chunk = {
                        let mut r = captured.lock().unwrap();
                        r.audio.extend_from_slice(&bytes);
                        r.sizes.push(bytes.len());
                        r.sizes.len() == 1
                    };
                    first.notify_one();
                    if first_chunk && !matches!(mode, Mode::Silence | Mode::NoResult | Mode::Hold) {
                        socket
                            .send(Message::Text(
                                json!({"segments":[{"start_time":0,"result":{"text":"旧段。"}}]})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                    }
                    if matches!(mode, Mode::EarlyClose) {
                        socket.close(None).await.unwrap();
                    }
                    if matches!(mode, Mode::Fatal) {
                        socket.send(Message::Text(json!({"resp_type":"FATAL_ERROR","error_code":"SIS.fixture","error_msg":"private-upstream-body fixture-token fixture-sk"}).to_string().into())).await.unwrap();
                    }
                }
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    assert_eq!(
                        value,
                        json!({"command":"END","params":"command=end&cancel=false"})
                    );
                    captured.lock().unwrap().controls.push(value);
                    match mode {
                        Mode::Normal => {
                            // Positive control: the last revision arrives only after input END.
                            tokio::time::sleep(Duration::from_millis(30)).await;
                            socket
                                .send(Message::Text(
                                    json!({"segments":[
                                        {"start_time":1.5,"result":{"text":"末句。"}},
                                        {"start_time":"0.0","result":{"text":"开头修订。"}}
                                    ]})
                                    .to_string()
                                    .into(),
                                ))
                                .await
                                .unwrap();
                            socket.close(None).await.unwrap();
                        }
                        Mode::Silence => socket.close(None).await.unwrap(),
                        Mode::Error => {
                            socket.send(Message::Text(json!({"resp_type":"ERROR","error_code":"SIS.fixture","error_msg":"private-upstream-body fixture-token fixture-sk"}).to_string().into())).await.unwrap();
                        }
                        Mode::BadClose => socket
                            .close(Some(CloseFrame {
                                code: CloseCode::Error,
                                reason: "private-upstream-body fixture-token".into(),
                            }))
                            .await
                            .unwrap(),
                        _ => {}
                    }
                }
                Message::Close(_) => {
                    let _ = socket.flush().await;
                    break;
                }
                _ => {}
            }
        }
        finished.store(true, Ordering::SeqCst);
    });
    Server {
        endpoint,
        record,
        first_audio,
        closed,
        task,
    }
}

fn credentials() -> Value {
    json!({"accessKey":"fixture-ak","secretKey":"fixture-sk","securityToken":"fixture-token",
        "baseUrl":"wss://untrusted-metadata.invalid","auth_token":"private-local-basic","accessToken":"not-cloud-bearer"})
}

fn account(server: &Server) -> Value {
    let mut c = credentials();
    c["_voice_test_endpoint"] = json!(server.endpoint);
    c
}

fn wav(pcm: &[u8]) -> Bytes {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend(((pcm.len() + 36) as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    bytes.extend(16000_u32.to_le_bytes());
    bytes.extend(32000_u32.to_le_bytes());
    bytes.extend(b"\x02\0\x10\0data");
    bytes.extend((pcm.len() as u32).to_le_bytes());
    bytes.extend(pcm);
    bytes.into()
}

// Explicit canonical fixture, independently checked in research using Node crypto.
// It is intentionally separate from the shared signer and uses no URL/encoding helpers.
fn expected_authorization(host: &str, date: &str) -> String {
    let canonical=format!("GET\n/v1/speech/continue-stream/\naudioFormat=pcm16k16bit&command=start&property=chinese_16k_general\nhost:{host}\nx-sdk-date:{date}\nx-security-token:fixture-token\n\nhost;x-sdk-date;x-security-token\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    let to_sign = format!("SDK-HMAC-SHA256\n{date}\n{:x}", Sha256::digest(canonical));
    let mut mac = Hmac::<Sha256>::new_from_slice(b"fixture-sk").unwrap();
    mac.update(to_sign.as_bytes());
    format!("SDK-HMAC-SHA256 Access=fixture-ak, SignedHeaders=host;x-sdk-date;x-security-token, Signature={:x}",mac.finalize().into_bytes())
}

#[test]
fn independent_fixed_vector_and_native_default_production_request() {
    assert_eq!(expected_authorization("snap-access.cn-north-4.myhuaweicloud.com","20261026T010203Z"),
        "SDK-HMAC-SHA256 Access=fixture-ak, SignedHeaders=host;x-sdk-date;x-security-token, Signature=8618390fba3c0bf4494f80167a0762d246c9211ffac6c7c3db56fd12247bf190");
    let req = request(&credentials()).unwrap();
    assert_eq!(req.uri().scheme_str(), Some("wss"));
    assert_eq!(
        req.uri().host(),
        Some("snap-access.cn-north-4.myhuaweicloud.com")
    );
    assert_eq!(req.uri().path(), "/v1/speech/continue-stream");
    assert_eq!(
        req.uri().query(),
        Some("command=start&audioFormat=pcm16k16bit&property=chinese_16k_general")
    );
    let date = req.headers()["x-sdk-date"].to_str().unwrap();
    assert_eq!(
        req.headers()["authorization"],
        expected_authorization("snap-access.cn-north-4.myhuaweicloud.com", date)
    );
    assert!(!req.uri().to_string().contains("auth_token"));
    for forbidden in [
        "origin",
        "cookie",
        "agent-type",
        "content-type",
        "x-language",
        "x-auth-token",
    ] {
        assert!(!req.headers().contains_key(forbidden));
    }
}

#[tokio::test]
async fn actual_ws_auth_pcm_tail_revision_sort_and_end_match_native_contract() {
    let server = server(Mode::Normal).await;
    let pcm: Vec<u8> = (0..6400).map(|i| (i % 251) as u8).collect();
    let started = Instant::now();
    let text = transcribe(
        &reqwest::Client::new(),
        &account(&server),
        &wav(&pcm),
        "private.wav",
        "audio/wav",
    )
    .await
    .unwrap();
    assert_eq!(text, "开头修订。末句。");
    let record = server.record.lock().unwrap();
    assert_eq!(record.audio, pcm);
    assert_eq!(record.sizes, vec![3200, 3200]);
    assert!(started.elapsed() >= Duration::from_millis(180));
    assert_eq!(
        record.controls,
        vec![json!({"command":"END","params":"command=end&cancel=false"})]
    );
    assert_eq!(record.uri,"/v1/speech/continue-stream?command=start&audioFormat=pcm16k16bit&property=chinese_16k_general");
    assert_eq!(record.headers["x-security-token"], "fixture-token");
    let host = record.headers["host"].to_str().unwrap();
    let date = record.headers["x-sdk-date"].to_str().unwrap();
    assert_eq!(
        record.headers["authorization"],
        expected_authorization(host, date)
    );
    assert!(record.pongs > 0);
    for forbidden in [
        "cookie",
        "origin",
        "agent-type",
        "content-type",
        "x-language",
        "x-auth-token",
    ] {
        assert!(!record.headers.contains_key(forbidden));
    }
    assert!(!record.headers["authorization"]
        .to_str()
        .unwrap()
        .contains("fixture-sk"));
}

#[tokio::test]
async fn finite_native_latest_segment_fallback_and_clean_silence_are_distinct_from_no_result() {
    let fallback = server(Mode::Fallback).await;
    assert_eq!(
        recognize(
            &account(&fallback),
            &[0, 1, 2, 3],
            Duration::from_millis(80)
        )
        .await
        .unwrap(),
        "旧段。"
    );
    let empty = server(Mode::Silence).await;
    assert_eq!(
        transcribe(
            &reqwest::Client::new(),
            &account(&empty),
            &wav(&[0; 32]),
            "x.wav",
            "audio/x-wav"
        )
        .await
        .unwrap(),
        ""
    );
    let missing = server(Mode::NoResult).await;
    assert_eq!(
        recognize(&account(&missing), &[0; 32], Duration::from_millis(80))
            .await
            .unwrap_err()
            .status,
        StatusCode::GATEWAY_TIMEOUT
    );
}

#[tokio::test]
async fn simultaneously_ready_tail_revision_precedes_fallback_and_audio_clock() {
    // All supplied futures are already ready on entry: there is no sleep or
    // socket scheduling window that could hide the stop-boundary race.
    for ending in [true, false] {
        for _ in 0..32 {
            let tail = json!({"segments":[
                {"start_time":0,"result":{"text":"开头修订。"}},
                {"start_time":1,"result":{"text":"末句。"}}
            ]})
            .to_string();
            let event = next_event(
                std::future::ready(Some(Ok(Message::Text(tail.into())))),
                std::future::ready(()),
                std::future::ready(()),
                ending,
            )
            .await;
            let InputEvent::Read(Some(Ok(Message::Text(tail)))) = event else {
                panic!("a ready reader must precede both ready clocks");
            };
            let mut segments = vec![(0.0, "旧段。".into())];
            assert!(update(tail.as_bytes(), &mut segments).unwrap());
            assert_eq!(finish(segments), "开头修订。末句。");
        }
    }
    // Positive control: without a ready message the existing fallback still runs.
    assert!(matches!(
        next_event(
            std::future::pending::<Option<Result<Message, Error>>>(),
            std::future::ready(()),
            std::future::ready(()),
            true,
        )
        .await,
        InputEvent::Fallback
    ));
}

#[tokio::test]
async fn simultaneously_ready_explicit_error_never_becomes_segment_fallback() {
    for ending in [true, false] {
        for kind in ["ERROR", "FATAL_ERROR"] {
            for _ in 0..32 {
                let error = json!({"resp_type":kind,"error_code":"SIS.fixture",
                    "error_msg":"private-upstream-body fixture-token fixture-sk"})
                .to_string();
                let event = next_event(
                    std::future::ready(Some(Ok(Message::Text(error.into())))),
                    std::future::ready(()),
                    std::future::ready(()),
                    ending,
                )
                .await;
                let InputEvent::Read(Some(Ok(Message::Text(error)))) = event else {
                    panic!("a ready service error must precede both ready clocks");
                };
                let mut segments = vec![(0.0, "旧段。".into())];
                let failure = update(error.as_bytes(), &mut segments).unwrap_err();
                assert_eq!(failure.status, StatusCode::BAD_GATEWAY);
                assert!(!failure.message.contains("private"));
                assert!(!failure.message.contains("fixture-token"));
            }
        }
    }
}

#[tokio::test]
async fn explicit_errors_early_normal_close_and_abnormal_tail_never_return_partial() {
    for mode in [Mode::Error, Mode::Fatal, Mode::EarlyClose, Mode::BadClose] {
        let server = server(mode).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &account(&server),
            &wav(&[0; 9600]),
            "x.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        for private in [
            "private-upstream-body",
            "fixture-token",
            "fixture-sk",
            "旧段",
        ] {
            assert!(!error.message.contains(private));
        }
    }
}

#[tokio::test]
async fn handshake_status_retry_after_and_credentials_remain_isolated() {
    for status in [401, 429] {
        let server = server(Mode::Reject(status)).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &account(&server),
            &wav(&[0; 32]),
            "x.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status.as_u16(), status);
        assert_eq!(error.retry_after.unwrap(), "7");
        assert!(!error.message.contains("fixture-token"));
        assert!(!error.message.contains("private-upstream-body"));
        assert!(server.record.lock().unwrap().audio.is_empty());
    }
}

#[tokio::test]
async fn invalid_audio_and_missing_or_invalid_auth_reject_before_handshake() {
    let server = server(Mode::Hold).await;
    let c = account(&server);
    for (audio, mime) in [
        (Bytes::new(), "audio/wav"),
        (wav(&[]), "audio/wav"),
        (wav(&[0; 32]), "audio/mp4"),
    ] {
        assert_eq!(
            validate_audio(&audio, mime).unwrap_err().status,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            transcribe(&reqwest::Client::new(), &c, &audio, "x.wav", mime)
                .await
                .unwrap_err()
                .status,
            StatusCode::BAD_REQUEST
        );
    }
    let mut invalid = wav(&[0; 32]).to_vec();
    invalid[24..28].copy_from_slice(&48000_u32.to_le_bytes());
    assert!(validate_audio(&Bytes::from(invalid.clone()), "audio/wav").is_err());
    assert!(validate_audio(&wav(&[0; 32]), "audio/wav").is_ok());
    assert!(transcribe(
        &reqwest::Client::new(),
        &c,
        &invalid.into(),
        "x.wav",
        "audio/wav"
    )
    .await
    .is_err());
    for (field, value) in [
        ("accessKey", Value::Null),
        ("secretKey", json!("")),
        ("securityToken", json!("bad\r\nCookie: secret")),
    ] {
        let mut bad = c.clone();
        bad[field] = value;
        assert_eq!(
            transcribe(
                &reqwest::Client::new(),
                &bad,
                &wav(&[0; 32]),
                "x.wav",
                "audio/wav"
            )
            .await
            .unwrap_err()
            .status,
            StatusCode::UNAUTHORIZED
        );
    }
    assert!(server.record.lock().unwrap().headers.is_empty());
}

#[tokio::test]
async fn cancellation_after_positive_audio_control_stops_remaining_audio_and_end() {
    let server = server(Mode::Hold).await;
    let c = account(&server);
    let audio = wav(&[0; 32000]);
    let task = tokio::spawn(async move {
        transcribe(&reqwest::Client::new(), &c, &audio, "x.wav", "audio/wav").await
    });
    tokio::time::timeout(Duration::from_secs(2), server.first_audio.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), async {
        while !server.closed.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await
        }
    })
    .await
    .unwrap();
    let r = server.record.lock().unwrap();
    assert_eq!(r.audio.len(), 3200);
    assert!(r.controls.is_empty());
}

#[test]
fn malformed_segment_and_error_shapes_are_rejected_without_erasing_prior_text() {
    let mut segments = vec![(0.0, "prior".into())];
    for value in [
        json!({"segments":{}}),
        json!({"segments":[{"start_time":0,"result":{"text":true}}]}),
        json!({"segments":[{"result":{"text":"missing time"}}]}),
        json!({"status":"error","message":"private"}),
        json!({"error_code":"SIS.private"}),
    ] {
        assert!(update(value.to_string().as_bytes(), &mut segments).is_err());
    }
    assert_eq!(finish(segments), "prior");
}
