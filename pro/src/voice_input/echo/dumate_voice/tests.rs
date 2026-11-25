use super::*;
use axum::{
    http::{Method, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use std::{
    collections::VecDeque,
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

async fn server(replies: Vec<Response>) -> Server {
    let requests: Requests = Arc::default();
    let captured = requests.clone();
    let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
    let app = Router::new().fallback(any(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let captured = captured.clone();
            let replies = replies.clone();
            async move {
                captured.lock().unwrap().push((method, uri, headers, body));
                replies
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected request")
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

fn wav() -> Bytes {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend(40_u32.to_le_bytes());
    bytes.extend(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    bytes.extend(16000_u32.to_le_bytes());
    bytes.extend(32000_u32.to_le_bytes());
    bytes.extend(b"\x02\0\x10\0data");
    bytes.extend(4_u32.to_le_bytes());
    bytes.extend([0, 1, 255, 128]);
    bytes.into()
}

fn credentials(bos: &Server, asr: &Server) -> Value {
    json!({
        "accessToken":"selected-gateway-token", "accountId":"sha-store-key-not-native-id",
        "bceAccountId":"native-bce-account", "cookieHeader":"must-not-forward-cookie",
        "baseUrl":"https://untrusted-metadata.invalid", "deviceId":"must-not-invent-device-id",
        "bosSession":{"accessKeyId":"temporary-ak","secretAccessKey":"temporary-sk",
            "sessionToken":"temporary-bos-token","endpoint":"bj.bcebos.com",
            "bucket":"fixture-bucket","sessionUniqId":"session-prefix"},
        "_voice_test_endpoint":format!("{}/gateway/rest/2.0/speech/publiccloudspeech/v1/asr/topspeed",asr.url),
        "_voice_test_bos_endpoint":bos.url,"_voice_test_timestamp":"2014-06-13T05:57:36Z"
    })
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

// Published independent Baidu SDK authentication vector; not derived from this adapter.
// https://cloud.baidu.com/doc/Reference/s/wjwvz1xt2-en (Javascript Example)
#[test]
fn matches_official_bce_v1_positive_controls() {
    assert_eq!(authorization(("my_ak","my_sk"),"PUT","/v1/bucket/object1",
        &[("A",""),("b",""),("C","d")],
        &[("Host","bce.baidu.com"),("abc","123"),("x-bce-meta-key1","ABC")],
        ("2014-06-13T05:57:36Z",1800)),
        "bce-auth-v1/my_ak/2014-06-13T05:57:36Z/1800/host;x-bce-meta-key1/80c9672aca2ea9af4bb40b9a8ff458d72df94e97d550840727f3a929af271d25");
    assert_eq!(authorization(("my_ak","my_sk"),"DELETE","/v1/test-bucket1361199862",&[],
        &[("Content-Type","application/json; charset=utf-8"),("Content-Length","0"),("User-Agent","ignored")],
        ("2014-06-13T05:57:36Z",1800)),
        "bce-auth-v1/my_ak/2014-06-13T05:57:36Z/1800/content-length;content-type/c9386b15d585960ae5e6972f73ed92a9a682dc81025480ba5b41206d3e489822");
    assert_eq!(
        encode("中文/ a+!'()~", true),
        "%E4%B8%AD%E6%96%87/%20a%2B%21%27%28%29~"
    );
}

#[tokio::test]
async fn uploads_exact_wav_then_separates_bos_and_gateway_authentication() {
    let bos = server(vec![StatusCode::OK.into_response()]).await;
    let asr = server(vec![Json(
        json!({"error_code":0,"result":["中文"," coffee。"]}),
    )
    .into_response()])
    .await;
    let c = credentials(&bos, &asr);
    let audio = wav();
    assert_eq!(
        transcribe(
            &client(),
            &c,
            &audio,
            "private-user-filename.wav",
            "audio/x-wav"
        )
        .await
        .unwrap(),
        "中文 coffee。"
    );
    let upload = bos.requests.lock().unwrap();
    assert_eq!(upload.len(), 1);
    let (method, uri, headers, body) = &upload[0];
    assert_eq!(*method, Method::PUT);
    assert!(uri.path().starts_with("/session-prefix/voice-"));
    assert!(uri.path().ends_with(".wav"));
    assert!(uri.query().is_none());
    assert_eq!(*body, audio);
    assert_eq!(headers[header::HOST], "fixture-bucket.bj.bcebos.com");
    assert_eq!(headers[header::CONTENT_TYPE], "audio/wav");
    assert_eq!(headers[header::CONTENT_LENGTH], audio.len().to_string());
    assert_eq!(headers["x-bce-date"], "2014-06-13T05:57:36Z");
    assert_eq!(headers["x-bce-security-token"], "temporary-bos-token");
    let signature = authorization(
        ("temporary-ak", "temporary-sk"),
        "PUT",
        uri.path(),
        &[],
        &[
            ("host", "fixture-bucket.bj.bcebos.com"),
            ("content-length", &audio.len().to_string()),
            ("content-type", "audio/wav"),
            ("x-bce-date", "2014-06-13T05:57:36Z"),
            ("x-bce-security-token", "temporary-bos-token"),
        ],
        ("2014-06-13T05:57:36Z", 1800),
    );
    assert_eq!(headers[header::AUTHORIZATION], signature);
    for name in [
        "cookie",
        "x-dumate-account-id",
        "x-appbuilder-dumate-account-id",
        "x-dumate-device-id",
    ] {
        assert!(!headers.contains_key(name));
    }
    assert!(!format!("{headers:?}").contains("selected-gateway-token"));
    let recognize = asr.requests.lock().unwrap();
    assert_eq!(recognize.len(), 1);
    let (method, asr_uri, headers, body) = &recognize[0];
    assert_eq!(*method, Method::POST);
    assert_eq!(
        asr_uri.path(),
        "/gateway/rest/2.0/speech/publiccloudspeech/v1/asr/topspeed"
    );
    assert_eq!(
        headers[header::AUTHORIZATION],
        "Bearer selected-gateway-token"
    );
    assert_eq!(headers["x-dumate-account-id"], "global");
    assert_eq!(
        headers["x-appbuilder-dumate-account-id"],
        "native-bce-account"
    );
    for name in [
        "cookie",
        "x-bce-security-token",
        "x-dumate-device-id",
        "x-dumate-client-type",
    ] {
        assert!(!headers.contains_key(name));
    }
    let value: Value = serde_json::from_slice(body).unwrap();
    assert_eq!(value["rate"], 16000);
    assert_eq!(value["dev_pid"], 200001);
    assert!(uuid::Uuid::parse_str(value["cuid"].as_str().unwrap()).is_ok());
    let signed = url::Url::parse(value["speech_url"].as_str().unwrap()).unwrap();
    assert_eq!(signed.scheme(), "https");
    assert_eq!(signed.host_str(), Some("fixture-bucket.bj.bcebos.com"));
    assert_eq!(signed.path(), format!("/v1{}", uri.path()));
    let query = signed
        .query_pairs()
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(query.len(), 2);
    assert_eq!(query["x-bce-security-token"], "temporary-bos-token");
    assert_eq!(
        query["authorization"],
        authorization(
            ("temporary-ak", "temporary-sk"),
            "GET",
            signed.path(),
            &[("x-bce-security-token", "temporary-bos-token")],
            &[("host", "fixture-bucket.bj.bcebos.com")],
            ("2014-06-13T05:57:36Z", -1)
        )
    );
    for forbidden in [
        "private-user-filename",
        "temporary-sk",
        "must-not-forward-cookie",
        "sha-store-key-not-native-id",
        "must-not-invent-device-id",
    ] {
        assert!(!value.to_string().contains(forbidden));
    }
    assert_eq!(
        ASR_URL,
        "https://dumate-svc.baidu.com/gateway/rest/2.0/speech/publiccloudspeech/v1/asr/topspeed"
    );
}

#[tokio::test]
async fn preserves_http_status_and_retry_after_without_exposing_upstream_body() {
    for status in [StatusCode::UNAUTHORIZED, StatusCode::TOO_MANY_REQUESTS] {
        for upload_fails in [true, false] {
            let error = || {
                (
                    status,
                    [(header::RETRY_AFTER, "7")],
                    "private-upstream-body temporary-sk selected-gateway-token",
                )
                    .into_response()
            };
            let bos = server(vec![if upload_fails {
                error()
            } else {
                StatusCode::OK.into_response()
            }])
            .await;
            let asr = server(if upload_fails { vec![] } else { vec![error()] }).await;
            let error = transcribe(
                &client(),
                &credentials(&bos, &asr),
                &wav(),
                "x.wav",
                "audio/wav",
            )
            .await
            .unwrap_err();
            assert_eq!(error.status, status);
            assert_eq!(error.retry_after.unwrap(), "7");
            assert!(!error.message.contains("private-upstream-body"));
            assert!(!error.message.contains("temporary-sk"));
            assert!(!error.message.contains("selected-gateway-token"));
            assert_eq!(
                asr.requests.lock().unwrap().len(),
                usize::from(!upload_fails)
            );
        }
    }
}

#[tokio::test]
async fn rejects_business_errors_and_incomplete_results_but_accepts_final_silence() {
    for (value, expected) in [
        (
            json!({"error_code":17,"error_message":"private-text temporary-sk","result":"partial"}),
            None,
        ),
        (json!({"error_code":0,"result":["partial",false]}), None),
        (json!({"error_code":0}), None),
        (json!({"error_code":0,"result":""}), Some("")),
        (json!({"result":["one"," two"]}), Some("one two")),
    ] {
        let bos = server(vec![StatusCode::OK.into_response()]).await;
        let asr = server(vec![Json(value).into_response()]).await;
        let result = transcribe(
            &client(),
            &credentials(&bos, &asr),
            &wav(),
            "x.wav",
            "audio/wav",
        )
        .await;
        if let Some(expected) = expected {
            assert_eq!(result.unwrap(), expected);
        } else {
            let error = result.unwrap_err();
            assert_eq!(error.status, StatusCode::BAD_GATEWAY);
            assert!(!error.message.contains("private-text"));
            assert!(!error.message.contains("temporary-sk"));
        }
    }
}

#[tokio::test]
async fn invalid_audio_tokens_and_bos_destinations_fail_before_network() {
    let bos = server(vec![]).await;
    let asr = server(vec![]).await;
    let c = credentials(&bos, &asr);
    for (audio, mime) in [
        (wav(), "audio/mp4"),
        (Bytes::new(), "audio/wav"),
        (Bytes::from_static(b"invalid"), "audio/wav"),
    ] {
        assert!(transcribe(&client(), &c, &audio, "x.wav", mime)
            .await
            .is_err());
    }
    for (field, value) in [
        ("endpoint", "evil.invalid"),
        ("endpoint", "bj.bcebos.com@evil.invalid"),
        ("endpoint", "bj.bcebos.com/path"),
        ("bucket", "evil/host"),
        ("sessionUniqId", "../escape"),
        ("sessionToken", "bad\r\nCookie: secret"),
        ("secretAccessKey", ""),
    ] {
        let mut c = c.clone();
        c["bosSession"][field] = json!(value);
        assert!(transcribe(&client(), &c, &wav(), "x.wav", "audio/wav")
            .await
            .is_err());
    }
    let mut bad = c.clone();
    bad["accessToken"] = json!("token\r\nCookie: secret");
    assert_eq!(
        transcribe(&client(), &bad, &wav(), "x.wav", "audio/wav")
            .await
            .unwrap_err()
            .status,
        StatusCode::UNAUTHORIZED
    );
    assert!(bos.requests.lock().unwrap().is_empty());
    assert!(asr.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dropping_pending_upload_does_not_start_recognition() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let notify = entered.clone();
    let wait = release.clone();
    let app = Router::new().fallback(any(move || {
        let notify = notify.clone();
        let wait = wait.clone();
        async move {
            notify.notify_one();
            wait.notified().await;
            StatusCode::OK
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let bos = Server {
        url,
        requests: Arc::default(),
        task: server_task,
    };
    let asr = server(vec![]).await;
    let c = credentials(&bos, &asr);
    let task =
        tokio::spawn(async move { transcribe(&client(), &c, &wav(), "x.wav", "audio/wav").await });
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    release.notify_one();
    tokio::task::yield_now().await;
    assert!(asr.requests.lock().unwrap().is_empty());
}
