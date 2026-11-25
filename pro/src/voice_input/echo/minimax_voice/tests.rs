use super::*;
use axum::{
    body::Body,
    http::{HeaderMap, Method, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use std::{
    collections::VecDeque,
    convert::Infallible,
    sync::{Arc, Mutex},
};

type Requests = Arc<Mutex<Vec<(Method, Uri, HeaderMap, Bytes)>>>;

struct Server {
    url: String,
    requests: Requests,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(responses: Vec<Response>) -> Server {
    let requests: Requests = Arc::default();
    let recorded = requests.clone();
    let responses = Arc::new(Mutex::new(VecDeque::from(responses)));
    let app = Router::new().fallback(any(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let recorded = recorded.clone();
            let responses = responses.clone();
            async move {
                recorded.lock().unwrap().push((method, uri, headers, body));
                responses
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("Extra request")
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        url,
        requests,
        task,
    }
}

fn credentials(server: &Server, region: &str) -> Value {
    json!({"accessToken":"selected-user-token", "region":region,
        "baseUrl":"https://untrusted-metadata.invalid", "userId":"private-user",
        "lane":"untrusted-lane", "_voice_test_endpoint":server.url})
}

fn audio() -> Bytes {
    let mut wav = b"RIFF".to_vec();
    wav.extend_from_slice(&40_u32.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    wav.extend_from_slice(&16000_u32.to_le_bytes());
    wav.extend_from_slice(&32000_u32.to_le_bytes());
    wav.extend_from_slice(b"\x02\0\x10\0data");
    wav.extend_from_slice(&4_u32.to_le_bytes());
    wav.extend_from_slice(&[0, 1, 255, 128]);
    wav.into()
}

fn grant() -> Response {
    Json(json!({"token":"temporary-asr-token", "expires_in":60})).into_response()
}

fn sse(raw: &str) -> Response {
    let chunks: Vec<_> = raw
        .as_bytes()
        .chunks(7)
        .map(|bytes| Ok::<_, Infallible>(Bytes::copy_from_slice(bytes)))
        .collect();
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .body(Body::from_stream(futures_util::stream::iter(chunks)))
        .unwrap()
}

#[tokio::test]
async fn grants_request_local_token_then_uploads_wav_and_joins_final_sse() {
    for region in ["cn", "global"] {
        let server = server(vec![
            grant(),
            sse(":keepalive\r\n\r\ndata: {\"index\":0,\"data\":\"中文\",\"finish\":false}\r\n\r\ndata: {\"index\":1,\"data\":\"最后一句\",\"finish\":true}"),
        ]).await;
        let wav = audio();
        let text = transcribe(
            &reqwest::Client::new(),
            &credentials(&server, region),
            &wav,
            "private-filename.wav",
            "audio/wav",
        )
        .await
        .unwrap();
        assert_eq!(text, "中文最后一句");
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, Method::POST);
        assert_eq!(requests[0].1.path(), "/matrix/api/v1/asr/session_token");
        assert_eq!(
            requests[0].2[header::AUTHORIZATION],
            "Bearer selected-user-token"
        );
        assert_eq!(requests[0].2[header::CONTENT_TYPE], "application/json");
        assert_eq!(
            serde_json::from_slice::<Value>(&requests[0].3).unwrap(),
            json!({"provider":"amadeus", "region":region})
        );
        assert_eq!(requests[1].0, Method::POST);
        assert_eq!(requests[1].1.path(), "/matrix/asr/audio/transcribe");
        assert_eq!(
            requests[1].2[header::AUTHORIZATION],
            "Bearer temporary-asr-token"
        );
        assert_eq!(requests[1].2[header::CONTENT_TYPE], "audio/wav");
        assert_eq!(requests[1].2[header::ACCEPT], "text/event-stream");
        assert_eq!(requests[1].3, wav);
        for (_, _, headers, _) in requests.iter() {
            for name in [
                "lane",
                "bedrock_lane",
                "bedrock-lane",
                "cookie",
                "x-user-id",
            ] {
                assert!(!headers.contains_key(name));
            }
        }
        let expected = if region == "cn" {
            "https://agent.minimax.cn"
        } else {
            "https://agent.minimax.io"
        };
        assert_eq!(
            endpoint(&json!({"region":region,"baseUrl":"https://wrong.invalid"})).unwrap(),
            (expected, region)
        );
    }
}

#[tokio::test]
async fn permits_nonempty_silence_and_returns_empty_final_for_pipeline() {
    let server = server(vec![
        grant(),
        sse("data: {\"index\":0,\"data\":\"\",\"finish\":true}\n\n"),
    ])
    .await;
    let mut wav = audio().to_vec();
    wav[44..].fill(0);
    assert_eq!(
        transcribe(
            &reqwest::Client::new(),
            &credentials(&server, "cn"),
            &wav.into(),
            "audio.wav",
            "audio/x-wav"
        )
        .await
        .unwrap(),
        ""
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn accepts_optional_indices_and_native_zero_business_codes() {
    let raw = concat!(
        "data: {\"status_code\":\" 0 \",\"base_resp\":{\"status_code\":0},\"data\":\"one\"}\n\n",
        "data: {\"index\":null,\"data\":\"two\",\"data_list\":[{\"data_value\":\"{\\\"status_code\\\":\\\"0\\\"}\"}],\"finish\":true}\n\n"
    );
    let server = server(vec![grant(), sse(raw)]).await;
    assert_eq!(
        transcribe(
            &reqwest::Client::new(),
            &credentials(&server, "global"),
            &audio(),
            "audio.wav",
            "audio/wav"
        )
        .await
        .unwrap(),
        "onetwo"
    );
}

#[tokio::test]
async fn rejects_format_region_and_auth_before_network() {
    let server = server(vec![]).await;
    let saved = credentials(&server, "cn");
    let client = reqwest::Client::new();
    let mut empty = audio()[..44].to_vec();
    empty[4..8].copy_from_slice(&36_u32.to_le_bytes());
    empty[40..44].copy_from_slice(&0_u32.to_le_bytes());
    let mut stereo = audio().to_vec();
    stereo[22..24].copy_from_slice(&2_u16.to_le_bytes());
    for (wav, mime, expected) in [
        (audio(), "audio/mpeg", StatusCode::UNSUPPORTED_MEDIA_TYPE),
        (
            Bytes::from_static(b"not WAV"),
            "audio/wav",
            StatusCode::BAD_REQUEST,
        ),
        (empty.into(), "audio/wav", StatusCode::BAD_REQUEST),
        (stereo.into(), "audio/wav", StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(
            transcribe(&client, &saved, &wav, "input", mime)
                .await
                .unwrap_err()
                .status,
            expected
        );
    }
    for (key, value) in [
        ("region", Value::Null),
        ("region", json!("other")),
        ("accessToken", Value::Null),
        ("accessToken", json!("bad\r\nprivate-token")),
    ] {
        let mut bad = saved.clone();
        bad[key] = value;
        let error = transcribe(&client, &bad, &audio(), "audio.wav", "audio/wav")
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert!(!error.message.contains("private-token"));
    }
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejects_bad_session_grants_without_uploading_audio_or_leaking_body() {
    for response in [
        Json(json!({"token":" "})).into_response(),
        Json(json!({"error":"private-upstream"})).into_response(),
        Json(json!({"token":"bad\r\nprivate-upstream"})).into_response(),
        (StatusCode::OK, "private-upstream invalid JSON").into_response(),
    ] {
        let server = server(vec![response]).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &credentials(&server, "cn"),
            &audio(),
            "audio.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert!(!error.message.contains("private-upstream"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn preserves_http_failures_and_retry_after_at_each_stage_without_retry() {
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::BAD_GATEWAY,
    ] {
        for upload_stage in [false, true] {
            let mut failed = (
                status,
                "selected-user-token temporary-asr-token private-audio",
            )
                .into_response();
            failed
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("17"));
            let responses = if upload_stage {
                vec![grant(), failed]
            } else {
                vec![failed]
            };
            let server = server(responses).await;
            let error = transcribe(
                &reqwest::Client::new(),
                &credentials(&server, "cn"),
                &audio(),
                "private-audio",
                "audio/wav",
            )
            .await
            .unwrap_err();
            assert_eq!(error.status, status);
            assert_eq!(error.retry_after.unwrap(), "17");
            for private in [
                "selected-user-token",
                "temporary-asr-token",
                "private-audio",
            ] {
                assert!(!error.message.contains(private));
            }
            assert_eq!(
                server.requests.lock().unwrap().len(),
                if upload_stage { 2 } else { 1 }
            );
        }
    }
}

#[tokio::test]
async fn never_returns_partial_text_for_missing_finish_bad_sequence_or_business_failure() {
    for raw in [
        "data: {\"index\":0,\"data\":\"private-partial\",\"finish\":false}\n\n",
        "data: {\"index\":1,\"data\":\"private-partial\",\"finish\":true}\n\n",
        "data: {\"index\":0,\"data\":\"private-partial\",\"finish\":\"true\"}\n\n",
        "data: {\"data\":\"private-partial\"}\n\ndata: invalid-private-upstream\n\n",
        "data: {\"success\":false,\"error\":\"private-upstream\",\"finish\":true}\n\n",
        "data: {\"base_resp\":{\"status_code\":5,\"status_msg\":\"private-upstream\"},\"finish\":true}\n\n",
        "data: {\"data_list\":[{\"data_value\":\"{\\\"status_code\\\":5,\\\"status_msg\\\":\\\"private-upstream\\\"}\"}],\"finish\":true}\n\n",
    ] {
        let server = server(vec![grant(), sse(raw)]).await;
        let error = transcribe(&reqwest::Client::new(), &credentials(&server, "cn"),
            &audio(), "audio.wav", "audio/wav").await.unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        for private in ["private-partial", "private-upstream"] { assert!(!error.message.contains(private)); }
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn rejects_non_sse_and_interrupted_body_without_returning_partial_text() {
    let broken = futures_util::stream::iter([
        Ok(Bytes::from_static(
            b"data: {\"data\":\"private-partial\"}\n\n",
        )),
        Err(std::io::Error::other("private-upstream")),
    ]);
    let broken = Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from_stream(broken))
        .unwrap();
    for response in [
        Json(json!({"finish":true,"data":"private-upstream"})).into_response(),
        broken,
    ] {
        let server = server(vec![grant(), response]).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &credentials(&server, "cn"),
            &audio(),
            "audio.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert!(!error.message.contains("private-partial"));
        assert!(!error.message.contains("private-upstream"));
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }
}
