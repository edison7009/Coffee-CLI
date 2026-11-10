//! Cursor's native HTTP/2 Connect-protobuf streaming dictation service.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{path::Path, sync::atomic::AtomicBool};

const LIMIT: usize = 4 * 1024 * 1024;
const ENDPOINT: &str = "https://api2.cursor.sh/aiserver.v1.AiService/StreamStt";

pub(super) struct Credentials {
    pub(super) user_id: String,
    token: String,
    team: Option<u64>,
}

pub(super) async fn account() -> Result<Credentials, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = dirs::config_dir()
            .ok_or("signed_out")?
            .join("Cursor/User/globalStorage/state.vscdb");
        read_account(&path)
    })
    .await
    .map_err(|_| "signed_out".to_string())?
}

fn read_account(path: &Path) -> Result<Credentials, String> {
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| "signed_out")?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|_| "signed_out")?;
    let read = |key: &str| {
        db.query_row("SELECT value FROM ItemTable WHERE key=?1", [key], |r| {
            r.get::<_, String>(0)
        })
    };
    let token = read("cursorAuth/accessToken").map_err(|_| "signed_out")?;
    let claims: Value = token
        .split('.')
        .nth(1)
        .and_then(|v| URL_SAFE_NO_PAD.decode(v.trim_end_matches('=')).ok())
        .and_then(|v| serde_json::from_slice(&v).ok())
        .ok_or("signed_out")?;
    let user_id = claims["sub"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("signed_out")?
        .to_owned();
    if claims["exp"]
        .as_i64()
        .is_some_and(|v| v <= chrono::Utc::now().timestamp())
    {
        return Err("signed_out".into());
    }
    let state: Value = read("src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser").ok().and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(Value::Null);
    let team = state["aiSettings"]["teamId"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991);
    Ok(Credentials {
        user_id,
        token,
        team,
    })
}

pub(super) async fn run(
    account: Credentials,
    mut audio: mpsc::UnboundedReceiver<Vec<i16>>,
    mut control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<Result<Vec<u8>, std::io::Error>>();
    tx.send(Ok(framed(field(1, &[]))))
        .map_err(|_| "speech_failed")?;
    let body = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "speech_failed")?;
    let mut request = client
        .post(ENDPOINT)
        .version(reqwest::Version::HTTP_2)
        .bearer_auth(&account.token)
        .header("content-type", "application/connect+proto")
        .header("connect-protocol-version", "1")
        .header("x-cursor-client-version", "3.27.22")
        .header("x-cursor-client-type", "ide")
        .header(
            "x-cursor-client-os",
            match std::env::consts::OS {
                "windows" => "win32",
                "macos" => "darwin",
                other => other,
            },
        )
        .header("x-cursor-streaming", "true")
        .header("x-ghost-mode", "true")
        .header("x-request-id", uuid::Uuid::new_v4().to_string());
    if let Some(team) = account.team {
        request = request.header("x-cursor-team-id", team.to_string());
    }
    let ready = AtomicBool::new(false);
    let recognize = async {
        let response = request
            .body(reqwest::Body::wrap_stream(body))
            .send()
            .await
            .map_err(|_| "speech_failed".to_string())?;
        if !response.status().is_success() {
            return Err(format!("http_{}", response.status().as_u16()));
        }
        if response.version() != reqwest::Version::HTTP_2
            || !response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| {
                    v.split(';')
                        .next()
                        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/connect+proto"))
                })
        {
            return Err("speech_failed".into());
        }
        ready.store(true, Ordering::Relaxed);
        emit(VoiceEvent::Ready);
        receive(response.bytes_stream(), emit).await
    };
    tokio::pin!(recognize);
    let mut sender = Some(tx);
    let mut deadline = Instant::now() + Duration::from_secs(30);
    loop {
        tokio::select! {
            biased;
            command=control.recv()=>match command {
                Some(Control::Finish) if sender.is_some()=> {
                    stop_capture();
                    let tx=sender.take().unwrap();
                    while let Ok(chunk)=audio.try_recv() {send_audio(&tx,&chunk)?;}
                    tx.send(Ok(framed(vec![0x1a,0x02,0x08,0x01]))).map_err(|_| "speech_failed")?;
                    drop(tx);deadline=Instant::now()+Duration::from_secs(10);
                },
                Some(Control::Cancel)|None=>return Ok(()),
                _=>{},
            },
            _=tokio::time::sleep_until(deadline),if sender.is_none()||!ready.load(Ordering::Relaxed)=>return Err("speech_timeout".into()),
            result=&mut recognize=> {emit(VoiceEvent::Text{text:result?,done:true});return Ok(());},
            chunk=audio.recv(),if sender.is_some()=>match chunk {
                Some(chunk)=>{emit(VoiceEvent::Level{level:level(&chunk)});send_audio(sender.as_ref().unwrap(),&chunk)?;},
                None=>return Err("microphone_closed".into()),
            },
        }
    }
}

async fn receive<S, B, E>(
    mut stream: S,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
) -> Result<String, String>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
{
    let mut pending = Vec::new();
    let mut text = String::new();
    while let Some(chunk) = stream.next().await {
        pending.extend_from_slice(chunk.map_err(|_| "speech_failed")?.as_ref());
        while pending.len() >= 5 {
            let length = u32::from_be_bytes(pending[1..5].try_into().unwrap()) as usize;
            if length > LIMIT || !matches!(pending[0], 0 | 2) {
                return Err("speech_failed".into());
            }
            if pending.len() < 5 + length {
                break;
            }
            let packet = &pending[5..5 + length];
            if pending[0] == 2 {
                let end: Value = serde_json::from_slice(packet).map_err(|_| "speech_failed")?;
                if !end.is_object() {
                    return Err("speech_failed".into());
                }
                if !end["error"].is_null() {
                    return Err(connect_error(
                        end["error"]["code"].as_str().unwrap_or("unknown"),
                    ));
                }
                if pending.len() != 5 + length {
                    return Err("speech_failed".into());
                }
                return Ok(text);
            }
            let (next, final_text) = transcript(packet)?;
            text = next;
            if !final_text {
                emit(VoiceEvent::Text {
                    text: text.clone(),
                    done: false,
                });
            }
            pending.drain(..5 + length);
        }
        if pending.len() > LIMIT + 5 {
            return Err("speech_failed".into());
        }
    }
    // HTTP EOF is insufficient: a Connect end frame carries the authoritative status.
    Err("speech_failed".into())
}

fn send_audio(
    tx: &mpsc::UnboundedSender<Result<Vec<u8>, std::io::Error>>,
    samples: &[i16],
) -> Result<(), String> {
    let pcm: Vec<u8> = samples.iter().flat_map(|v| v.to_le_bytes()).collect();
    for bytes in pcm.chunks(640) {
        tx.send(Ok(framed(field(2, &field(1, bytes)))))
            .map_err(|_| "speech_failed")?;
    }
    Ok(())
}
fn field(number: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for mut v in [u64::from(number) << 3 | 2, data.len() as u64] {
        while v >= 128 {
            out.push(v as u8 | 128);
            v >>= 7;
        }
        out.push(v as u8);
    }
    out.extend_from_slice(data);
    out
}
fn framed(message: Vec<u8>) -> Vec<u8> {
    let mut out = vec![0];
    out.extend_from_slice(&(message.len() as u32).to_be_bytes());
    out.extend(message);
    out
}
fn connect_error(code: &str) -> String {
    match code {
        "unauthenticated" => "http_401",
        "permission_denied" => "http_403",
        "resource_exhausted" => "http_429",
        _ => "speech_failed",
    }
    .into()
}
fn varint(bytes: &mut &[u8]) -> Result<u64, String> {
    let mut value = 0;
    for shift in (0..=63).step_by(7) {
        let (&byte, rest) = bytes.split_first().ok_or("speech_failed")?;
        *bytes = rest;
        if shift == 63 && byte > 1 {
            return Err("speech_failed".into());
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err("speech_failed".into())
}
fn transcript(mut bytes: &[u8]) -> Result<(String, bool), String> {
    let mut text = String::new();
    let mut final_text = false;
    let mut kind = 0;
    while !bytes.is_empty() {
        let tag = varint(&mut bytes)?;
        let number = tag >> 3;
        if number == 0 || number > 0x1fff_ffff {
            return Err("speech_failed".into());
        }
        let length = match tag & 7 {
            0 => {
                let v = varint(&mut bytes)?;
                if number == 2 {
                    final_text = v != 0;
                }
                if number == 3 {
                    kind = v;
                }
                continue;
            }
            1 => 8,
            2 => usize::try_from(varint(&mut bytes)?).map_err(|_| "speech_failed")?,
            5 => 4,
            _ => return Err("speech_failed".into()),
        };
        let data = bytes.get(..length).ok_or("speech_failed")?;
        if number == 1 && tag & 7 == 2 {
            text = std::str::from_utf8(data)
                .map_err(|_| "speech_failed")?
                .into();
        }
        bytes = &bytes[length..];
    }
    Ok((text, kind == 3 || (!matches!(kind, 1..=3) && final_text)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn end_frame(value: Value) -> Vec<u8> {
        let mut frame = framed(value.to_string().into_bytes());
        frame[0] = 2;
        frame
    }
    #[tokio::test]
    async fn early_cancel_and_cancel_after_finish_do_not_wait_for_network() {
        for finish in [false, true] {
            let (audio_tx, audio) = mpsc::unbounded_channel();
            let (control_tx, control) = mpsc::unbounded_channel();
            audio_tx.send(vec![12; 1600]).unwrap();
            if finish {
                control_tx.send(Control::Finish).unwrap();
                control_tx.send(Control::Finish).unwrap();
            }
            control_tx.send(Control::Cancel).unwrap();
            let stopped = std::sync::atomic::AtomicUsize::new(0);
            let account = Credentials {
                user_id: "fixture".into(),
                token: "fixture".into(),
                team: None,
            };
            tokio::time::timeout(
                Duration::from_secs(1),
                run(
                    account,
                    audio,
                    control,
                    &|_| panic!("cancelled before request polling"),
                    || {
                        stopped.fetch_add(1, Ordering::SeqCst);
                    },
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(stopped.load(Ordering::SeqCst), usize::from(finish));
        }
    }
    #[tokio::test]
    async fn fragmented_stream_requires_a_clean_terminal_even_after_final_text() {
        let mut partial = field(1, b"draft");
        partial.extend([0x18, 1]);
        let mut final_text = field(1, b"final");
        final_text.extend([0x10, 1, 0x18, 3]);
        let normal = [framed(partial), framed(final_text)].concat();
        let events = Mutex::new(Vec::new());
        let emit = |event| {
            if let VoiceEvent::Text { text, done } = event {
                events.lock().unwrap().push((text, done));
            }
        };
        let closed = [normal.clone(), end_frame(json!({}))].concat();
        let chunks = closed
            .chunks(3)
            .map(|v| Ok::<_, ()>(v.to_vec()))
            .collect::<Vec<_>>();
        assert_eq!(
            receive(futures_util::stream::iter(chunks), &emit)
                .await
                .unwrap(),
            "final"
        );
        assert_eq!(*events.lock().unwrap(), vec![("draft".to_string(), false)]);
        for invalid in [
            normal.clone(),
            closed[..closed.len() - 1].to_vec(),
            [
                normal.clone(),
                end_frame(json!({"error":{"code":"unauthenticated"}})),
            ]
            .concat(),
        ] {
            assert!(
                receive(futures_util::stream::iter([Ok::<_, ()>(invalid)]), &|_| {})
                    .await
                    .is_err()
            );
        }
        let late = [
            normal,
            end_frame(json!({"error":{"code":"permission_denied"}})),
        ]
        .concat();
        assert_eq!(
            receive(futures_util::stream::iter([Ok::<_, ()>(late)]), &|_| {})
                .await
                .unwrap_err(),
            "http_403"
        );
    }
    #[test]
    fn partial_and_final_hypotheses_replace_the_draft() {
        let mut partial = field(1, "hello".as_bytes());
        partial.extend([0x18, 1]);
        assert_eq!(transcript(&partial).unwrap(), ("hello".into(), false));
        let mut final_text = field(1, "hello world".as_bytes());
        final_text.extend([0x10, 1, 0x18, 3]);
        assert_eq!(
            transcript(&final_text).unwrap(),
            ("hello world".into(), true)
        );
        for malformed in [&[0x0a, 5, b'a'][..], &[0x0a, 1, 0xff], &[0x80], &[0]] {
            assert!(transcript(malformed).is_err());
        }
    }
    #[test]
    fn account_reads_only_native_signin_and_rejects_expired_tokens() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.vscdb");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT)")
            .unwrap();
        let make = |exp| {
            format!(
                "header.{}.signature",
                URL_SAFE_NO_PAD.encode(json!({"sub":"user-fixture","exp":exp}).to_string())
            )
        };
        db.execute(
            "INSERT INTO ItemTable VALUES('cursorAuth/accessToken',?1)",
            [make(chrono::Utc::now().timestamp() + 3600)],
        )
        .unwrap();
        assert_eq!(read_account(&path).unwrap().user_id, "user-fixture");
        db.execute("UPDATE ItemTable SET value=?1", [make(1)])
            .unwrap();
        assert!(read_account(&path).is_err());
        assert!(read_account(&temp.path().join("missing.db")).is_err());
        assert!(!temp.path().join("missing.db").exists());
    }

    #[tokio::test]
    #[ignore = "requires local Cursor sign-in and an explicitly supplied synthetic PCM fixture"]
    async fn real_cursor_streams_before_finish() {
        let pcm = std::fs::read(
            std::env::var("COFFEE_CURSOR_TEST_PCM").expect("synthetic PCM16 mono 16 kHz fixture"),
        )
        .unwrap();
        let (audio_tx, audio) = mpsc::unbounded_channel();
        let (control_tx, control) = mpsc::unbounded_channel();
        let keep_control = control_tx.clone();
        let finishing = std::sync::Arc::new(AtomicBool::new(false));
        let finished = finishing.clone();
        let producer = tokio::spawn(async move {
            for bytes in pcm.chunks(3200) {
                audio_tx
                    .send(
                        bytes
                            .chunks_exact(2)
                            .map(|v| i16::from_le_bytes([v[0], v[1]]))
                            .collect(),
                    )
                    .unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            finished.store(true, Ordering::SeqCst);
            control_tx.send(Control::Finish).unwrap();
        });
        let events = Mutex::new(Vec::new());
        let result = run(
            account().await.unwrap(),
            audio,
            control,
            &|event| {
                if let VoiceEvent::Text { text, done } = event {
                    events
                        .lock()
                        .unwrap()
                        .push((text, done, !finishing.load(Ordering::SeqCst)));
                }
            },
            || {},
        )
        .await;
        drop(keep_control);
        producer.await.unwrap();
        result.unwrap();
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|(text, done, before)| !text.is_empty() && !*done && *before));
        assert!(events
            .iter()
            .any(|(text, done, _)| *done && text.contains("语音输入测试")));
    }
}
