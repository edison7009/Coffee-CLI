use super::*;
use axum::{
    http::{Method, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use std::sync::{Arc, Mutex};

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

async fn server(status: StatusCode, body: Value) -> Server {
    let requests: Requests = Arc::default();
    let recorded = requests.clone();
    let app = Router::new().fallback(any(
        move |method: Method, uri: Uri, headers: HeaderMap, bytes: Bytes| {
            let recorded = recorded.clone();
            let body = body.clone();
            async move {
                recorded.lock().unwrap().push((method, uri, headers, bytes));
                let mut response: Response = (status, Json(body)).into_response();
                response
                    .headers_mut()
                    .insert("retry-after", HeaderValue::from_static("9"));
                response
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

fn credentials(server: &Server) -> Value {
    json!({"accessToken":"selected-secret","organizationId":"selected-org",
        "baseUrl":"https://legacy.invalid","_voice_test_endpoint":server.url})
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

#[tokio::test]
async fn discovers_dynamic_speech_models_with_selected_account_and_org() {
    let server = server(StatusCode::OK, json!({"data":[{"id":"new/asr","name":"New ASR"},{"id":"new/asr","name":"Duplicate"},{"id":"missing-name"}]})).await;
    let models = list_models(&reqwest::Client::new(), &credentials(&server))
        .await
        .unwrap();
    assert_eq!(models, ["new/asr"]);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let (method, uri, headers, body) = &requests[0];
    assert_eq!(method, Method::GET);
    assert_eq!(uri.path(), "/api/v1/transcription-models");
    assert!(body.is_empty());
    assert_eq!(headers["authorization"], "Bearer selected-secret");
    assert_eq!(headers["x-kilocode-organizationid"], "selected-org");
    assert_eq!(headers["x-kilocode-feature"], "vscode-extension");
}

#[tokio::test]
async fn sends_json_base64_wav_without_filename_or_legacy_endpoint() {
    let server = server(StatusCode::OK, json!({"text":"recognized words"})).await;
    let wav = audio();
    let value = transcribe(
        &reqwest::Client::new(),
        &credentials(&server),
        "dynamic/model",
        &wav,
        "private-name.wav",
        "audio/wav",
    )
    .await
    .unwrap();
    assert_eq!(value, "recognized words");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let (method, uri, headers, body) = &requests[0];
    assert_eq!(method, Method::POST);
    assert_eq!(uri.path(), "/api/v1/audio/transcriptions");
    assert_eq!(headers["content-type"], "application/json");
    let body: Value = serde_json::from_slice(body).unwrap();
    assert_eq!(
        body,
        json!({"model":"dynamic/model","input_audio":{"data":STANDARD.encode(&wav),"format":"wav"}})
    );
    assert_eq!(
        STANDARD
            .decode(body["input_audio"]["data"].as_str().unwrap())
            .unwrap(),
        wav.as_ref()
    );
}

#[tokio::test]
async fn preserves_http_status_and_retry_after_without_secret_body_or_retry() {
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::TOO_MANY_REQUESTS,
    ] {
        let server = server(status, json!({"error":"selected-secret selected-org"})).await;
        let error = transcribe(
            &reqwest::Client::new(),
            &credentials(&server),
            "asr",
            &audio(),
            "speech.wav",
            "audio/wav",
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, status);
        assert_eq!(error.retry_after.unwrap(), "9");
        assert!(!error.message.contains("selected-"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn rejects_missing_text_and_invalid_model_catalogs() {
    let server = server(StatusCode::OK, json!({"error":"selected-secret"})).await;
    assert!(transcribe(
        &reqwest::Client::new(),
        &credentials(&server),
        "asr",
        &audio(),
        "speech.wav",
        "audio/wav"
    )
    .await
    .is_err());
    for value in [
        json!({"data":[]}),
        json!({"data":[{"id":"asr"}]}),
        json!({"error":"selected-secret"}),
    ] {
        let fixture = self::server(StatusCode::OK, value).await;
        let error = list_models(&reqwest::Client::new(), &credentials(&fixture))
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert!(!error.message.contains("selected-secret"));
    }
}

#[tokio::test]
async fn validates_mime_model_audio_and_headers_before_any_request() {
    let server = server(StatusCode::OK, json!({"text":"unexpected"})).await;
    let client = reqwest::Client::new();
    let mut empty = audio().to_vec();
    empty.truncate(44);
    empty[4..8].copy_from_slice(&36_u32.to_le_bytes());
    empty[40..44].fill(0);
    for (model, wav, mime) in [
        ("asr", audio(), "audio/mpeg"),
        ("", audio(), "audio/wav"),
        ("asr", Bytes::from(empty), "audio/wav"),
    ] {
        assert!(transcribe(
            &client,
            &credentials(&server),
            model,
            &wav,
            "speech.wav",
            mime
        )
        .await
        .is_err());
    }
    for token in ["", "invalid\r\nsecret"] {
        let mut value = credentials(&server);
        value["accessToken"] = json!(token);
        assert!(list_models(&client, &value).await.is_err());
    }
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(
        endpoint(&json!({"baseUrl":"https://legacy.invalid"})),
        ENDPOINT
    );
}

#[test]
fn personal_accounts_have_no_organization_header() {
    let headers = headers(&json!({"accessToken":"personal"})).unwrap();
    assert!(!headers.contains_key("x-kilocode-organizationid"));
}
