use super::*;
use cbc::cipher::BlockDecryptMut;
use rsa::{pkcs8::EncodePublicKey, RsaPrivateKey};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

#[derive(Clone, Copy)]
enum Mode {
    Complete,
    GatedDone,
    FinalWithoutDone,
    FinalAndClose,
    PartialAndClose,
    Error,
    Timeout,
    Silence,
    MissingFinal,
    EmptyFinal,
    Reject(StatusCode),
}

#[derive(Default)]
struct Recording {
    headers: HeaderMap,
    uri: String,
    audio: Vec<u8>,
    frames: Vec<usize>,
    frame_times: Vec<Instant>,
    completion_at: Option<Instant>,
    controls: Vec<Value>,
}

struct Server {
    url: String,
    recording: Arc<Mutex<Recording>>,
    closed: Arc<AtomicBool>,
    final_sent: Arc<AtomicBool>,
    gate: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[allow(clippy::result_large_err)] // The WebSocket handshake callback requires ErrorResponse.
async fn mock(mode: Mode) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let recording = Arc::new(Mutex::new(Recording::default()));
    let closed = Arc::new(AtomicBool::new(false));
    let final_sent = Arc::new(AtomicBool::new(false));
    let gate = Arc::new(Notify::new());
    let observed = recording.clone();
    let finished = closed.clone();
    let final_observed = final_sent.clone();
    let release = gate.clone();
    let task = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let capture = observed.clone();
        let socket =
            tokio_tungstenite::accept_hdr_async(tcp, move |req: &Request, res: Response| {
                let mut record = capture.lock().unwrap();
                record.headers = req.headers().clone();
                record.uri = req.uri().to_string();
                if let Mode::Reject(status) = mode {
                    let mut response = ErrorResponse::new(Some("private upstream body".into()));
                    *response.status_mut() = status;
                    response
                        .headers_mut()
                        .insert("retry-after", "2".parse().unwrap());
                    return Err(response);
                }
                Ok(res)
            })
            .await;
        let Ok(mut socket) = socket else {
            finished.store(true, Ordering::Release);
            return;
        };
        let mut first = true;
        while let Some(Ok(message)) = socket.next().await {
            match message {
                Message::Binary(bytes) => {
                    {
                        let mut record = observed.lock().unwrap();
                        record.audio.extend_from_slice(&bytes);
                        record.frames.push(bytes.len());
                        record.frame_times.push(Instant::now());
                    }
                    if first && !matches!(mode, Mode::Silence) {
                        let interim = json!({"type":"speech_interim","message":"private interim selected-token"});
                        socket
                            .send(Message::Text(interim.to_string().into()))
                            .await
                            .unwrap();
                    }
                    first = false;
                }
                Message::Text(text) => {
                    let control: Value = serde_json::from_str(&text).unwrap();
                    observed.lock().unwrap().controls.push(control.clone());
                    if control["type"] != "voice_completed" {
                        continue;
                    }
                    observed.lock().unwrap().completion_at = Some(Instant::now());
                    if matches!(mode, Mode::PartialAndClose) {
                        socket.close(None).await.unwrap();
                        break;
                    }
                    if matches!(
                        mode,
                        Mode::Complete
                            | Mode::GatedDone
                            | Mode::FinalWithoutDone
                            | Mode::FinalAndClose
                            | Mode::Error
                            | Mode::EmptyFinal
                    ) {
                        for text in [" Earlier final. ", "Final 中文尾标。 "] {
                            let event = json!({"type":"speech_completed","message":text});
                            socket
                                .send(Message::Text(event.to_string().into()))
                                .await
                                .unwrap();
                        }
                        final_observed.store(true, Ordering::Release);
                    }
                    if matches!(mode, Mode::Error) {
                        let event = json!({"type":"speech_err","message":"private transcript selected-token","code":500});
                        socket
                            .send(Message::Text(event.to_string().into()))
                            .await
                            .unwrap();
                    } else if matches!(mode, Mode::FinalAndClose) {
                        socket.close(None).await.unwrap();
                        break;
                    } else if matches!(
                        mode,
                        Mode::Complete
                            | Mode::GatedDone
                            | Mode::Silence
                            | Mode::MissingFinal
                            | Mode::EmptyFinal
                    ) {
                        if matches!(mode, Mode::GatedDone) {
                            release.notified().await;
                        }
                        if matches!(mode, Mode::EmptyFinal) {
                            socket
                                .send(Message::Text(
                                    json!({"type":"speech_completed","message":""})
                                        .to_string()
                                        .into(),
                                ))
                                .await
                                .unwrap();
                        }
                        for event in [
                            json!({"type":"speech_cost","message":"ignored usage"}),
                            json!({"type":"speech_done","status":"completed"}),
                        ] {
                            socket
                                .send(Message::Text(event.to_string().into()))
                                .await
                                .unwrap();
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        finished.store(true, Ordering::Release);
    });
    Server {
        url,
        recording,
        closed,
        final_sent,
        gate,
        task,
    }
}

fn saved_credentials() -> Value {
    json!({"edition":"qwenworkcn","accessToken":"selected-token","userId":"selected-user",
        "name":"Selected 用户","email":"selected@example.invalid","version":"1.3.2"})
}

fn credentials(server: &Server) -> Value {
    let mut credentials = saved_credentials();
    credentials["_voice_test_endpoint"] = json!(server.url);
    credentials
}

fn wav(length: usize) -> Bytes {
    let mut value = vec![0u8; 44 + length];
    value[..4].copy_from_slice(b"RIFF");
    value[4..8].copy_from_slice(&((36 + length) as u32).to_le_bytes());
    value[8..16].copy_from_slice(b"WAVEfmt ");
    value[16..20].copy_from_slice(&16u32.to_le_bytes());
    value[20..22].copy_from_slice(&1u16.to_le_bytes());
    value[22..24].copy_from_slice(&1u16.to_le_bytes());
    value[24..28].copy_from_slice(&16_000u32.to_le_bytes());
    value[28..32].copy_from_slice(&32_000u32.to_le_bytes());
    value[32..34].copy_from_slice(&2u16.to_le_bytes());
    value[34..36].copy_from_slice(&16u16.to_le_bytes());
    value[36..40].copy_from_slice(b"data");
    value[40..44].copy_from_slice(&(length as u32).to_le_bytes());
    for (index, byte) in value[44..].iter_mut().enumerate() {
        *byte = (index % 251) as u8;
    }
    value.into()
}

async fn request(server: &Server) -> Result<String, ProxyError> {
    transcribe(
        &reqwest::Client::new(),
        &credentials(server),
        &wav(64_010),
        "voice.wav",
        "audio/wav",
    )
    .await
}

#[tokio::test]
async fn replays_full_and_partial_frames_on_media_time() {
    let server = mock(Mode::Complete).await;
    let start = Instant::now();
    let text = transcribe(
        &reqwest::Client::new(),
        &credentials(&server),
        &wav(8_000),
        "voice.wav",
        "audio/wav",
    )
    .await
    .unwrap();
    assert_eq!(text, "Earlier final. Final 中文尾标。");
    let record = server.recording.lock().unwrap();
    assert_eq!(record.frames, [3_200, 3_200, 1_600]);
    assert_eq!(record.audio, wav(8_000)[44..]);
    assert!(record.frame_times[0].duration_since(start) >= Duration::from_millis(90));
    assert!(record.frame_times[1].duration_since(start) >= Duration::from_millis(190));
    assert!(record.frame_times[2].duration_since(start) >= Duration::from_millis(240));
    let completion_at = record.completion_at.unwrap();
    assert!(completion_at.duration_since(start) >= Duration::from_millis(240));
    eprintln!(
        "{}",
        json!({"qwenwork_pacing_fixture":true,"pcm_bytes":8_000,"audio_ms":250,
            "frame_ms":record.frame_times.iter().map(|time|time.duration_since(start).as_millis()).collect::<Vec<_>>(),
            "completion_ms":completion_at.duration_since(start).as_millis(),
            "eof_after_last_frame_ms":completion_at.duration_since(record.frame_times[2]).as_millis()})
    );
}

#[tokio::test]
async fn sends_selected_account_pcm_and_native_completion_and_appends_final_segments() {
    let server = mock(Mode::Complete).await;
    assert_eq!(
        request(&server).await.unwrap(),
        "Earlier final. Final 中文尾标。"
    );
    let record = server.recording.lock().unwrap();
    assert_eq!(record.uri, PATH);
    assert_eq!(record.audio, wav(64_010)[44..]);
    assert!(record.frames.iter().all(|length| *length <= CHUNK_BYTES));
    assert_eq!(
        record.controls,
        vec![json!({"type":"voice_completed","message":"close by user"})]
    );
    for (name, value) in [
        ("cosy-user", "selected-user"),
        ("x-ide-platform", "qoder_work"),
        ("x-version", "1.3.2"),
        ("samplerate", "16000"),
        ("framedurationms", "100"),
        ("bitdepth", "16"),
        ("channels", "1"),
    ] {
        assert_eq!(record.headers[name], value);
    }
    assert!(!record.headers.contains_key("x-machine-id"));
    let business: Value =
        serde_json::from_str(record.headers["x-business"].to_str().unwrap()).unwrap();
    assert_eq!(business["product"], "qoder_work");
    assert_eq!(business["type"], "asr_chat");
    assert!(business["begin_at"].as_i64().unwrap() > 0);
    assert_eq!(
        business["name"],
        format!("asr_chat-{}", business["id"].as_str().unwrap())
    );
    uuid::Uuid::parse_str(record.headers["x-asr-session-id"].to_str().unwrap()).unwrap();
    let (payload, signature) = record.headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer COSY.")
        .unwrap()
        .rsplit_once('.')
        .unwrap();
    assert_eq!(
        signature,
        format!(
            "{:x}",
            Md5::digest(format!(
                "{payload}\n{}\n{}\n\n{PATH}",
                record.headers["cosy-key"].to_str().unwrap(),
                record.headers["cosy-date"].to_str().unwrap()
            ))
        )
    );
    let envelope: Value = serde_json::from_slice(&STANDARD.decode(payload).unwrap()).unwrap();
    assert_eq!(envelope["cosyVersion"], "1.0.0");
    assert_eq!(envelope["ideVersion"], "1.3.2");
    assert!(!record.headers["authorization"]
        .to_str()
        .unwrap()
        .contains("selected-token"));
}

#[tokio::test]
async fn concatenates_final_segments_with_original_spaces_and_ignores_empty_final() {
    let server = mock(Mode::EmptyFinal).await;
    assert_eq!(
        request(&server).await.unwrap(),
        "Earlier final. Final 中文尾标。"
    );
}

#[tokio::test]
async fn accepts_the_global_saved_account_with_its_own_native_version() {
    let server = mock(Mode::Complete).await;
    let mut saved = credentials(&server);
    saved["edition"] = json!("qwenwork");
    saved["version"] = json!("1.0.4");
    let result = transcribe(
        &reqwest::Client::new(),
        &saved,
        &wav(6_400),
        "voice.wav",
        "audio/x-wav",
    )
    .await;
    assert_eq!(result.unwrap(), "Earlier final. Final 中文尾标。");
    assert_eq!(
        server.recording.lock().unwrap().headers["x-version"],
        "1.0.4"
    );
}

#[tokio::test]
async fn accepts_explicit_done_and_native_final_settle_fallback() {
    for mode in [Mode::FinalWithoutDone, Mode::FinalAndClose] {
        let server = mock(mode).await;
        assert_eq!(
            request(&server).await.unwrap(),
            "Earlier final. Final 中文尾标。"
        );
    }
    let server = mock(Mode::GatedDone).await;
    let saved = credentials(&server);
    let task = tokio::spawn(async move {
        transcribe(
            &reqwest::Client::new(),
            &saved,
            &wav(6_400),
            "voice.wav",
            "audio/wav",
        )
        .await
    });
    wait_for(&server.final_sent).await;
    assert!(!task.is_finished());
    server.gate.notify_one();
    assert_eq!(
        task.await.unwrap().unwrap(),
        "Earlier final. Final 中文尾标。"
    );
}

#[tokio::test]
async fn silence_requires_successful_completion_and_errors_never_return_partial_text() {
    let server = mock(Mode::Silence).await;
    assert_eq!(request(&server).await.unwrap(), "");
    for (mode, status) in [
        (Mode::PartialAndClose, StatusCode::BAD_GATEWAY),
        (Mode::Error, StatusCode::BAD_GATEWAY),
        (Mode::MissingFinal, StatusCode::BAD_GATEWAY),
        (Mode::Timeout, StatusCode::GATEWAY_TIMEOUT),
    ] {
        let server = mock(mode).await;
        let error = request(&server).await.unwrap_err();
        assert_eq!(error.status, status);
        assert!(!error.message.contains("private"));
        assert!(!error.message.contains("selected-token"));
    }
}

#[tokio::test]
async fn preserves_http_rejection_status_and_retry_after_without_upstream_body() {
    for status in [StatusCode::UNAUTHORIZED, StatusCode::TOO_MANY_REQUESTS] {
        let server = mock(Mode::Reject(status)).await;
        let error = request(&server).await.unwrap_err();
        assert_eq!(error.status, status);
        assert_eq!(error.retry_after.unwrap(), "2");
        assert!(!error.message.contains("private"));
    }
}

async fn wait_for(flag: &AtomicBool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !flag.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_releases_the_owned_connection() {
    let server = mock(Mode::Timeout).await;
    let saved = credentials(&server);
    let task = tokio::spawn(async move {
        transcribe(
            &reqwest::Client::new(),
            &saved,
            &wav(6_400),
            "voice.wav",
            "audio/wav",
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while server.recording.lock().unwrap().audio.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    wait_for(&server.closed).await;
}

#[test]
fn encrypts_the_selected_v2_user_and_uses_the_published_public_key() {
    let private_key = RsaPrivateKey::new(&mut rand::thread_rng(), 1024).unwrap();
    let headers = signed_headers(&saved_credentials(), &RsaPublicKey::from(&private_key)).unwrap();
    let encrypted_key = STANDARD.decode(headers["cosy-key"].as_bytes()).unwrap();
    let key = private_key
        .decrypt(Pkcs1v15Encrypt, &encrypted_key)
        .unwrap();
    assert_eq!(key.len(), 16);
    let authorization = headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Bearer COSY.")
        .unwrap();
    let (payload, _) = authorization.rsplit_once('.').unwrap();
    let payload: Value = serde_json::from_slice(&STANDARD.decode(payload).unwrap()).unwrap();
    let encrypted = STANDARD.decode(payload["info"].as_str().unwrap()).unwrap();
    let clear = cbc::Decryptor::<aes::Aes128>::new_from_slices(&key, &key)
        .unwrap()
        .decrypt_padded_vec_mut::<Pkcs7>(&encrypted)
        .unwrap();
    let user: Value = serde_json::from_slice(&clear).unwrap();
    assert_eq!(
        user,
        json!({"uid":"selected-user","aid":"","name":"Selected 用户","email":"selected@example.invalid","security_oauth_token":"selected-token"})
    );
    let key = RsaPublicKey::from_public_key_pem(PUBLIC_KEY).unwrap();
    assert_eq!(
        format!(
            "{:x}",
            sha2::Sha256::digest(key.to_public_key_der().unwrap().as_bytes())
        ),
        "a6a4aa468d90c618966e38122abfb06e566c18c9b21090d61f3e9b796b33e569"
    );
}

#[test]
fn fixes_regions_and_rejects_non_pcm_wav() {
    let mut saved = saved_credentials();
    saved["baseUrl"] = json!("https://untrusted.invalid");
    assert_eq!(endpoint(&saved).unwrap(), "wss://gateway.qwenwork.cn");
    saved["edition"] = json!("qwenwork");
    assert_eq!(endpoint(&saved).unwrap(), "wss://gateway.qwenwork.ai");
    saved["edition"] = json!("unknown");
    assert_eq!(
        endpoint(&saved).unwrap_err().status,
        StatusCode::UNAUTHORIZED
    );
    assert!(pcm(b"RIFF").is_err());
    assert!(pcm(&wav(0)).is_err());
    assert!(pcm(&wav(1)).is_err());
    assert_eq!(pcm(&wav(10)).unwrap(), &wav(10)[44..]);
    for offset in [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40] {
        let mut changed = wav(10).to_vec();
        changed[offset] ^= 1;
        assert_eq!(pcm(&changed).unwrap_err().status, StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn rejects_missing_credentials_bad_mime_and_empty_audio_before_network_access() {
    let mut saved = saved_credentials();
    saved["_voice_test_endpoint"] = json!("ws://127.0.0.1:9");
    for field in ["edition", "accessToken", "userId", "version"] {
        let mut invalid = saved.clone();
        invalid.as_object_mut().unwrap().remove(field);
        let error = transcribe(
            &reqwest::Client::new(),
            &invalid,
            &wav(10),
            "voice.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
    }
    for (mime, length) in [
        ("audio/mpeg", 10),
        ("application/octet-stream", 10),
        ("audio/wav", 0),
    ] {
        let error = transcribe(
            &reqwest::Client::new(),
            &saved,
            &wav(length),
            "voice.wav",
            mime,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }
}
