use super::*;
use axum::{extract::Json, http::HeaderMap, routing::post, Router};
use std::sync::{Arc, Mutex};

type Requests = Arc<Mutex<Vec<(String, HeaderMap, Value)>>>;

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

async fn server(load_status: StatusCode, load: Value, status: StatusCode, result: &str) -> Server {
    let requests: Requests = Arc::default();
    let load_requests = requests.clone();
    let catalog_requests = requests.clone();
    let result = result.to_owned();
    let app = Router::new()
        .route(
            "/v1internal:loadCodeAssist",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let requests = load_requests.clone();
                let load = load.clone();
                async move {
                    requests
                        .lock()
                        .unwrap()
                        .push(("load".into(), headers, body));
                    (load_status, [(header::RETRY_AFTER, "11")], Json(load))
                }
            }),
        )
        .route(
            PATH,
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let requests = catalog_requests.clone();
                let result = result.clone();
                async move {
                    requests
                        .lock()
                        .unwrap()
                        .push(("catalog".into(), headers, body));
                    (
                        status,
                        [
                            (header::CONTENT_TYPE, "application/json"),
                            (header::RETRY_AFTER, "17"),
                        ],
                        result,
                    )
                }
            }),
        );
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
    json!({
        "accessToken":format!("selected-{}", uuid::Uuid::new_v4()),
        "projectId":"selected-project",
        "baseUrl":"http://127.0.0.1:9/untrusted",
        "loadBaseUrl":"http://127.0.0.1:9/untrusted",
        "headers":{"authorization":"untrusted","x-goog-api-client":"untrusted"},
        "appVersion":"untrusted-version",
        "_voice_test_endpoint":server.url,
        "_voice_test_app_version":"2.26.0"
    })
}

fn load(tier: &str) -> Value {
    json!({"cloudaicompanionProject":"fallback-project","currentTier":{"id":tier}})
}

#[tokio::test]
async fn uses_native_directory_shape_and_first_speech_id_with_saved_project() {
    let server = server(
        StatusCode::OK,
        load("paid-tier"),
        StatusCode::OK,
        r#"{"audioTranscriptionModelIds":["speech-z","speech-a"],"models":{"text-only":{}}}"#,
    )
    .await;
    let selected = credentials(&server);
    assert_eq!(
        first_model(&reqwest::Client::new(), &selected)
            .await
            .unwrap(),
        "speech-z"
    );
    assert_eq!(ENDPOINT, "https://daily-cloudcode-pa.googleapis.com");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].1[header::AUTHORIZATION],
        format!("Bearer {}", selected["accessToken"].as_str().unwrap())
    );
    let (kind, headers, body) = &requests[1];
    assert_eq!(kind, "catalog");
    assert_eq!(
        headers[header::AUTHORIZATION],
        format!("Bearer {}", selected["accessToken"].as_str().unwrap())
    );
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        value => value,
    };
    assert_eq!(
        headers[header::USER_AGENT],
        format!("antigravity/2.26.0 (aidev_client; os_type={os}; arch={arch})")
    );
    assert!(!headers.contains_key("x-goog-user-project"));
    assert!(!headers.contains_key("x-goog-api-client"));
    assert!(!headers.contains_key("x-goog-request-reason"));
    assert_eq!(
        body,
        &json!({"project":"selected-project","entitlement":{"userTier":"paid-tier"}})
    );
}

#[tokio::test]
async fn uses_prepared_project_fallback_without_fabricating_tier_location_or_user_project() {
    let server = server(
        StatusCode::OK,
        load("free-tier"),
        StatusCode::OK,
        r#"{"audioTranscriptionModelIds":["speech-only"]}"#,
    )
    .await;
    let mut selected = credentials(&server);
    selected.as_object_mut().unwrap().remove("projectId");
    assert_eq!(
        first_model(&reqwest::Client::new(), &selected)
            .await
            .unwrap(),
        "speech-only"
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].2, json!({"project":"fallback-project"}));
    assert!(!requests[1].1.contains_key("x-goog-user-project"));
}

#[tokio::test]
async fn missing_project_is_omitted_instead_of_blocking_the_native_speech_directory() {
    for (load, expected) in [
        (json!({}), json!({})),
        (
            json!({"currentTier":{"id":"paid-tier"}}),
            json!({"entitlement":{"userTier":"paid-tier"}}),
        ),
    ] {
        let server = server(
            StatusCode::OK,
            load,
            StatusCode::OK,
            r#"{"audioTranscriptionModelIds":["speech-only"]}"#,
        )
        .await;
        let mut selected = credentials(&server);
        selected.as_object_mut().unwrap().remove("projectId");
        assert_eq!(
            first_model(&reqwest::Client::new(), &selected)
                .await
                .unwrap(),
            "speech-only"
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].2, expected);
        assert!(!requests[1].1.contains_key("x-goog-user-project"));
    }
}

#[tokio::test]
async fn invalid_credentials_and_version_fail_before_preparation_or_directory_requests() {
    let server = server(StatusCode::OK, load("free-tier"), StatusCode::OK, "{}").await;
    for value in [
        Value::Null,
        json!(""),
        json!("  "),
        json!("private\r\nheader"),
    ] {
        let mut selected = credentials(&server);
        selected["accessToken"] = value;
        let error = first_model(&reqwest::Client::new(), &selected)
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::UNAUTHORIZED);
        assert!(!error.message.contains("private"));
    }
    for version in [
        Value::Null,
        json!(""),
        json!("private\r\nheader"),
        json!("a".repeat(97)),
    ] {
        let mut selected = credentials(&server);
        selected["_voice_test_app_version"] = version;
        let error = first_model(&reqwest::Client::new(), &selected)
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(!error.message.contains("private"));
    }
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn directory_errors_preserve_status_and_retry_after_without_private_response_content() {
    for status in [
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::CREATED,
    ] {
        let server = server(
            StatusCode::OK,
            load("free-tier"),
            status,
            r#"{"error":{"message":"private-token private-response"}}"#,
        )
        .await;
        let error = first_model(&reqwest::Client::new(), &credentials(&server))
            .await
            .unwrap_err();
        assert_eq!(
            error.status,
            if status.is_success() {
                StatusCode::BAD_GATEWAY
            } else {
                status
            }
        );
        assert_eq!(error.retry_after.unwrap(), "17");
        assert!(!error.message.contains("private"));
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn preparation_errors_remain_redacted_and_do_not_start_the_directory() {
    for status in [StatusCode::UNAUTHORIZED, StatusCode::TOO_MANY_REQUESTS] {
        let server = server(
            status,
            json!({"error":{"message":"private-preparation-response"}}),
            StatusCode::OK,
            "{}",
        )
        .await;
        let error = first_model(&reqwest::Client::new(), &credentials(&server))
            .await
            .unwrap_err();
        assert_eq!(error.status, status);
        assert_eq!(error.retry_after.unwrap(), "11");
        assert!(!error.message.contains("private"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn malformed_or_empty_speech_catalog_never_falls_back_to_text_models_or_a_later_id() {
    for response in [
        "private-invalid-json",
        "[]",
        r#"{"models":{"text-only":{}}}"#,
        r#"{"audioTranscriptionModelIds":[]}"#,
        r#"{"audioTranscriptionModelIds":null}"#,
        r#"{"audioTranscriptionModelIds":[7,"speech-later"]}"#,
        r#"{"audioTranscriptionModelIds":["speech-first",7]}"#,
        r#"{"audioTranscriptionModelIds":["","speech-later"]}"#,
        r#"{"audioTranscriptionModelIds":["   ","speech-later"]}"#,
    ] {
        let server = server(StatusCode::OK, load("free-tier"), StatusCode::OK, response).await;
        let error = first_model(&reqwest::Client::new(), &credentials(&server))
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_GATEWAY);
        assert!(!error.message.contains("private"));
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }
}
