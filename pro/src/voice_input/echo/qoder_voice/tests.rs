use super::*;
use std::sync::{Arc, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};

#[derive(Default)]
struct Record {
    headers: axum::http::HeaderMap,
    uri: String,
    audio: Vec<u8>,
    controls: Vec<Value>,
}

struct Server {
    url: String,
    record: Arc<Mutex<Record>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[allow(clippy::result_large_err)]
async fn server(mode: &'static str) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let record: Arc<Mutex<Record>> = Arc::default();
    let observed = record.clone();
    let task = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let captured = observed.clone();
        let socket =
            tokio_tungstenite::accept_hdr_async(tcp, move |req: &Request, res: Response| {
                let mut record = captured.lock().unwrap();
                record.headers = req.headers().clone();
                record.uri = req.uri().to_string();
                if mode == "401" {
                    let mut response = ErrorResponse::new(Some("private-device-token".into()));
                    *response.status_mut() = StatusCode::UNAUTHORIZED;
                    response
                        .headers_mut()
                        .insert("retry-after", "3".parse().unwrap());
                    return Err(response);
                }
                Ok(res)
            })
            .await;
        let Ok(mut socket) = socket else { return };
        while let Some(Ok(message)) = socket.next().await {
            match message {
                Message::Binary(bytes) => {
                    observed.lock().unwrap().audio.extend_from_slice(&bytes);
                    if mode == "early-final" {
                        socket
                            .send(Message::Text(
                                json!({"type":"speech_completed","message":"录音中已确认。"})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                    }
                    socket
                        .send(Message::Text(
                            json!({"type":"speech_delta","message":"interim"})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                    if mode == "delta-close" {
                        socket.close(None).await.unwrap();
                        break;
                    }
                    if mode == "error" {
                        socket
                            .send(Message::Text(
                                json!({"type":"speech_err","message":"private-device-token"})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                        break;
                    }
                }
                Message::Text(value) => {
                    let control: Value = serde_json::from_str(&value).unwrap();
                    observed.lock().unwrap().controls.push(control.clone());
                    if control["type"] == "voice_completed" {
                        if mode == "early-final" {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                        socket
                            .send(Message::Text(
                                json!({"type":"speech_completed","message":"第一段。"})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                        if mode == "close" {
                            socket.close(None).await.unwrap();
                            break;
                        }
                        socket
                            .send(Message::Text(
                                json!({"type":"speech_completed","message":"第二段。"})
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .unwrap();
                        if mode != "settle" {
                            socket
                                .send(Message::Text(
                                    json!({"type":"speech_done"}).to_string().into(),
                                ))
                                .await
                                .unwrap();
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    Server { url, record, task }
}

fn wav() -> Bytes {
    let mut data = b"RIFF".to_vec();
    data.extend(40_u32.to_le_bytes());
    data.extend(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    data.extend(16000_u32.to_le_bytes());
    data.extend(32000_u32.to_le_bytes());
    data.extend(b"\x02\0\x10\0data");
    data.extend(4_u32.to_le_bytes());
    data.extend([1, 2, 3, 4]);
    data.into()
}

fn credentials(server: &Server, edition: &str) -> Value {
    json!({"edition":edition,"deviceToken":"selected-device-token","accessToken":"must-not-use-job-token\r\n", "userId":"selected-user","name":"User","email":"user@example.test","machineId":"selected-machine","appVersion":"0.4.9","baseUrl":"https://untrusted.invalid","_voice_test_endpoint":server.url})
}

#[tokio::test]
async fn waits_for_the_tail_after_a_segment_was_finalized_during_playback() {
    let server = server("early-final").await;
    let result = transcribe(
        &reqwest::Client::new(),
        &credentials(&server, "qodercn"),
        &wav(),
        "speech.wav",
        "audio/wav",
    )
    .await
    .unwrap();
    assert_eq!(result, "录音中已确认。第一段。第二段。");
}

#[tokio::test]
async fn both_editions_use_device_auth_pcm_and_explicit_completion() {
    for edition in ["qoder", "qodercn"] {
        let server = server("ok").await;
        let result = transcribe(
            &reqwest::Client::new(),
            &credentials(&server, edition),
            &wav(),
            "speech.wav",
            "audio/wav",
        )
        .await
        .unwrap();
        assert_eq!(result, "第一段。第二段。");
        let record = server.record.lock().unwrap();
        assert_eq!(record.uri, PATH);
        assert_eq!(record.audio, [1, 2, 3, 4]);
        assert_eq!(record.headers["cosy-user"], "selected-user");
        assert_eq!(record.headers["cosy-clienttype"], "10");
        assert!(record.headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("Bearer COSY."));
        assert_eq!(record.headers["x-ide-platform"], "app");
        assert_eq!(record.headers["x-version"], "0.4.9");
        assert_eq!(record.headers["samplerate"], "16000");
        assert_eq!(record.headers["framedurationms"], "100");
        assert_eq!(record.controls[0]["type"], "asr_polish_config");
        assert_eq!(record.controls[0]["enabled"], false);
        assert_eq!(record.controls[1]["type"], "voice_completed");
    }
}

#[tokio::test]
async fn errors_and_partial_disconnect_never_return_partial_transcripts() {
    for mode in ["error", "delta-close", "401"] {
        let server = server(mode).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &credentials(&server, "qodercn"),
            &wav(),
            "speech.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.status,
            if mode == "401" {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::BAD_GATEWAY
            }
        );
        assert!(!error.message.contains("private-device-token"));
        if mode == "401" {
            assert_eq!(error.retry_after.unwrap(), "3");
        }
    }
}

#[tokio::test]
async fn confirmed_segments_settle_without_done_even_after_native_close() {
    for (mode, expected) in [("close", "第一段。"), ("settle", "第一段。第二段。")] {
        let server = server(mode).await;
        assert_eq!(
            transcribe(
                &reqwest::Client::new(),
                &credentials(&server, "qodercn"),
                &wav(),
                "speech.wav",
                "audio/wav"
            )
            .await
            .unwrap(),
            expected
        );
    }
}

#[tokio::test]
async fn rejects_bad_region_device_token_and_audio_before_connection() {
    let server = server("ok").await;
    for field in ["edition", "deviceToken", "appVersion"] {
        let mut c = credentials(&server, "qodercn");
        c[field] = json!("");
        assert!(transcribe(
            &reqwest::Client::new(),
            &c,
            &wav(),
            "speech.wav",
            "audio/wav"
        )
        .await
        .is_err());
    }
    for (audio, mime) in [(Bytes::new(), "audio/wav"), (wav(), "audio/mpeg")] {
        assert!(transcribe(
            &reqwest::Client::new(),
            &credentials(&server, "qodercn"),
            &audio,
            "speech.wav",
            mime
        )
        .await
        .is_err());
    }
    assert!(server.record.lock().unwrap().headers.is_empty());
    assert_eq!(
        endpoint(&json!({"edition":"qoder","baseUrl":"https://wrong.invalid"})).unwrap(),
        "wss://api3.qoder.sh/api/v2/service/ws/asr"
    );
}
