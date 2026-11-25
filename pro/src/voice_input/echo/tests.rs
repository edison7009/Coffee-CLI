use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn fixture(provider: &str) -> Credentials {
    Credentials {
        provider: provider.into(),
        account_id: "fixture-user".into(),
        data: json!({}),
    }
}

#[tokio::test]
async fn dumate_recordings_stay_within_the_services_sixty_second_limit() {
    let (audio_tx, mut audio) = mpsc::unbounded_channel();
    let (tx, mut control) = mpsc::unbounded_channel();
    audio_tx.send(vec![123; 61 * SAMPLE_RATE as usize]).unwrap();
    tx.send(Control::Finish).unwrap();
    let audio = record("dumate", &mut audio, &mut control, &|_| {}, || {}).await.unwrap().unwrap();
    assert!(dumate_voice::validate_audio(&audio, "audio/wav").is_ok(), "recording must fit DuMate's real upload limit");
    assert_eq!(audio_format::pcm(&audio).unwrap().len(), 60 * 32_000);
}

#[tokio::test]
async fn cancelled_or_empty_recordings_never_call_a_provider() {
    for finish in [false, true] {
        let (_audio_tx, audio) = mpsc::unbounded_channel();
        let (tx, control) = mpsc::unbounded_channel();
        tx.send(if finish {
            Control::Finish
        } else {
            Control::Cancel
        })
        .unwrap();
        let stopped = AtomicUsize::new(0);
        let events = Mutex::new(Vec::new());
        run(
            fixture("invalid-provider"),
            audio,
            control,
            &|event| events.lock().unwrap().push(event),
            || {
                stopped.fetch_add(1, Ordering::Relaxed);
            },
        )
        .await
        .unwrap();
        assert_eq!(stopped.load(Ordering::Relaxed), 1);
        assert_eq!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| matches!(e, VoiceEvent::Text { done: true, .. })),
            finish
        );
    }
}

#[tokio::test]
async fn finishing_drains_the_same_pcm_without_emitting_interim_text() {
    let (audio_tx, mut audio) = mpsc::unbounded_channel();
    let (tx, mut control) = mpsc::unbounded_channel();
    audio_tx.send(vec![123; CHUNK]).unwrap();
    audio_tx.send(vec![-321; CHUNK]).unwrap();
    tx.send(Control::Finish).unwrap();
    let events = Mutex::new(Vec::new());
    let stopped = AtomicUsize::new(0);
    let wav = record(
        "kilo",
        &mut audio,
        &mut control,
        &|event| events.lock().unwrap().push(event),
        || {
            stopped.fetch_add(1, Ordering::Relaxed);
        },
    )
    .await
    .unwrap()
    .unwrap();
    let pcm = audio_format::pcm(&wav).unwrap();
    assert_eq!(pcm.len(), 4 * CHUNK);
    assert_eq!(&pcm[..2], &123i16.to_le_bytes());
    assert_eq!(&pcm[2 * CHUNK..2 * CHUNK + 2], &(-321i16).to_le_bytes());
    assert_eq!(stopped.load(Ordering::Relaxed), 1);
    assert!(!events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, VoiceEvent::Text { .. })));
}

#[tokio::test]
async fn dumate_automatically_finishes_at_sixty_seconds_of_audio() {
    let (audio_tx, mut audio) = mpsc::unbounded_channel();
    let (_tx, mut control) = mpsc::unbounded_channel();
    audio_tx.send(vec![123; 60 * SAMPLE_RATE as usize]).unwrap();
    let stopped = AtomicUsize::new(0);
    let result = tokio::time::timeout(Duration::from_secs(1), record(
        "dumate", &mut audio, &mut control, &|_| {}, || { stopped.fetch_add(1, Ordering::Relaxed); },
    )).await.unwrap().unwrap().unwrap();
    assert_eq!(stopped.load(Ordering::Relaxed), 1);
    assert!(dumate_voice::validate_audio(&result, "audio/wav").is_ok());
}

#[tokio::test]
async fn a_cancel_after_finish_does_not_start_an_upload() {
    let (audio_tx, audio) = mpsc::unbounded_channel();
    let (tx, control) = mpsc::unbounded_channel();
    audio_tx.send(vec![123; CHUNK]).unwrap();
    tx.send(Control::Finish).unwrap();
    tx.send(Control::Cancel).unwrap();
    run(
        fixture("invalid-provider"),
        audio,
        control,
        &|e| assert!(!matches!(e, VoiceEvent::Text { .. })),
        || {},
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelling_an_inflight_batch_upload_returns_without_a_final_draft() {
    use axum::{routing::post, Json, Router};
    let entered = Arc::new(tokio::sync::Notify::new());
    let request_seen = entered.clone();
    let app = Router::new().route(
        "/agenttool/v1/asr",
        post(move || {
            let entered = request_seen.clone();
            async move {
                entered.notify_one();
                std::future::pending::<()>().await;
                Json(json!({"text":"unreachable"}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (audio_tx, audio) = mpsc::unbounded_channel();
    let (tx, control) = mpsc::unbounded_channel();
    audio_tx.send(vec![100; CHUNK]).unwrap();
    tx.send(Control::Finish).unwrap();
    let mut c = fixture("workbuddyai");
    c.data =
        json!({"accessToken":"fixture-token","uid":"fixture-user","_voice_test_endpoint":endpoint});
    let events = Mutex::new(Vec::new());
    let emit = |event| events.lock().unwrap().push(event);
    let session = run(c, audio, control, &emit, || {});
    let driver = async {
        entered.notified().await;
        tx.send(Control::Cancel).unwrap();
    };
    let (result, _) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(session, driver)
    })
    .await
    .unwrap();
    result.unwrap();
    assert!(!events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, VoiceEvent::Text { .. })));
    server.abort();
}

#[tokio::test]
async fn a_repeated_finish_does_not_cancel_batch_transcription() {
    let app = axum::Router::new().route("/agenttool/v1/asr", axum::routing::post(|| async {
        axum::Json(json!({"text":"completed batch"}))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (audio_tx, audio) = mpsc::unbounded_channel();
    let (tx, control) = mpsc::unbounded_channel();
    audio_tx.send(vec![100; CHUNK]).unwrap();
    tx.send(Control::Finish).unwrap();
    tx.send(Control::Finish).unwrap();
    let mut credentials = fixture("workbuddyai");
    credentials.data = json!({"accessToken":"fixture-token","uid":"fixture-user","_voice_test_endpoint":endpoint});
    let events = Mutex::new(Vec::new());
    run(credentials, audio, control, &|event| events.lock().unwrap().push(event), || {}).await.unwrap();
    assert!(events.lock().unwrap().iter().any(|event| matches!(event, VoiceEvent::Text { text, done:true } if text == "completed batch")));
    server.abort();
}

#[tokio::test]
#[ignore = "reads actual native client sign-ins; optional synthetic fixture submits only public test speech"]
async fn native_channels_live() {
    for tool in [
        "antigravity",
        "grokbot",
        "qwenwork",
        "qwenworkcn",
        "traecn",
        "codearts",
    ] {
        if let Some(metadata) = accounts::app_metadata(tool) {
            eprintln!(
                "native_voice metadata={tool} version={}",
                metadata["appVersion"].as_str().unwrap_or("unknown")
            );
        }
    }
    let sources = sources().await;
    for source in &sources {
        let value = serde_json::to_value(source).unwrap();
        assert!(value.as_object().unwrap().keys().all(|key| matches!(
            key.as_str(),
            "id" | "name" | "accountId" | "issue" | "transcriptionMode"
        )));
        eprintln!(
            "native_voice source={} logged_in=true mode=batch",
            source.id
        );
    }
    let Some(path) = std::env::var_os("COFFEE_NATIVE_TEST_WAV") else {
        return;
    };
    let wav_file = std::fs::read(path).expect("explicit synthetic WAV");
    assert_eq!(&wav_file[..4], b"RIFF");
    let start = wav_file.windows(4).position(|w| w == b"data").unwrap() + 8;
    let samples: Vec<i16> = wav_file[start..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let filter = std::env::var("COFFEE_NATIVE_TEST_SOURCES").unwrap_or_default();
    assert!(
        !sources.is_empty(),
        "no active native sign-ins were discovered"
    );
    for selected in filter.split(',').filter(|v| !v.is_empty()) {
        assert!(
            sources.iter().any(|s| s.id == selected),
            "requested native source is unavailable: {selected}"
        );
    }
    let mut failed = Vec::new();
    for source in sources
        .iter()
        .filter(|s| filter.is_empty() || filter.split(',').any(|id| id == s.id))
    {
        let account = account(source.id.clone()).await.unwrap();
        let result = transcribe(&account, &wav(&samples)).await;
        match result {
            Ok(text) if !text.trim().is_empty() => eprintln!(
                "native_voice source={} transcription=ok chars={}",
                source.id,
                text.chars().count()
            ),
            Ok(_) => {
                eprintln!("native_voice source={} transcription=empty", source.id);
                failed.push(source.id.clone());
            }
            Err(code) => {
                eprintln!(
                    "native_voice source={} transcription=failed reason={code}",
                    source.id
                );
                failed.push(source.id.clone());
            }
        }
    }
    assert!(
        failed.is_empty(),
        "native channels failed: {}",
        failed.join(",")
    );
}
