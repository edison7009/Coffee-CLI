//! WorkBuddy's desktop PCM16 streaming ASR, using its active local sign-in read-only.
use super::*;
use serde::Deserialize;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};

#[derive(Deserialize)]
pub(super) struct Credentials {
    pub(super) token: String,
    pub(super) user_id: String,
    pub(super) domain: Option<String>,
    pub(super) enterprise_id: Option<String>,
}

// Use the installed client's build-key binding; keys and tokens stay in an anonymous pipe.
// This reads only the active auth file and never refreshes or rewrites WorkBuddy credentials.
const READ_AUTH: &str = r#"
try {
 const fs=require('fs'),c=require('crypto'),path=process.argv[1];
 if(fs.existsSync(path+'.logged-out'))throw Error();
 const v=JSON.parse(fs.readFileSync(path,'utf8'));
 let token=v.auth.accessToken;
 if(typeof token!=='string') {
  const p=JSON.parse(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
  const key=c.createHash('sha256').update(p.atRestSecretKey,'utf8').digest();
  const id=c.createHash('sha256').update(key).digest('hex').slice(0,16);
  const u32=n=>{let b=Buffer.alloc(4);b.writeUInt32BE(n);return b};
  const field=s=>Buffer.concat([u32(Buffer.byteLength(s)),Buffer.from(s)]);
  const aad=Buffer.concat([Buffer.from('WB-AAD\0\x01'),field('WBEV1'),field('sym-v1'),u32(1),field(id),Buffer.from([2,0,0])]);
  if(token.$wbEncrypted!==1)throw Error();
  const e=JSON.parse(Buffer.from(token.envelope,'base64'));
  if(e.keyId!==id||e.suite!==1)throw Error();
  const d=c.createDecipheriv('aes-256-gcm',key,Buffer.from(e.nonce,'base64'));
  d.setAAD(aad);d.setAuthTag(Buffer.from(e.authTag,'base64'));
  token=Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64')),d.final()]).toString('utf8');key.fill(0);
 }
 if(!token||token.length>16384||typeof v.account.uid!=='string'||!v.account.uid)throw Error();
 process.stdout.write(JSON.stringify({token,user_id:v.account.uid,domain:v.auth.domain,enterprise_id:v.account.enterpriseId}));
}catch {process.exitCode=2;}
"#;

fn paths(source: &str) -> Option<(PathBuf, PathBuf)> {
    let (auth_file, app, app_mac) = match source {
        "workbuddy" => ("workbuddy-desktop.info", "WorkBuddy", "WorkBuddy"),
        "workbuddyai" => ("workbuddy-desktop-ai.info", "WorkBuddyAI", "WorkBuddy AI"),
        _ => return None,
    };
    let home = dirs::home_dir()?;
    #[cfg(target_os = "windows")]
    let (auth, candidates) = {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
        (
            local
                .join("CodeBuddyExtension/Data/Public/auth")
                .join(auth_file),
            vec![local.join(format!("Programs/{app}/{app}.exe"))],
        )
    };
    #[cfg(target_os = "macos")]
    let (auth, candidates) = (
        home.join("Library/Application Support/CodeBuddyExtension/Data/Public/auth")
            .join(auth_file),
        vec![
            PathBuf::from(format!(
                "/Applications/{app_mac}.app/Contents/MacOS/{app_mac}"
            )),
            home.join(format!(
                "Applications/{app_mac}.app/Contents/MacOS/{app_mac}"
            )),
        ],
    );
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let (auth, candidates) = (
        home.join(".local/share/CodeBuddyExtension/Data/Public/auth")
            .join(auth_file),
        vec![
            PathBuf::from(format!("/opt/{app}/{}", app.to_ascii_lowercase())),
            PathBuf::from(format!("/opt/{app}/{app}")),
        ],
    );
    #[cfg(target_os = "windows")]
    let _ = (&home, app_mac);
    Some((auth, candidates.into_iter().find(|path| path.is_file())?))
}

fn validate_session(path: &std::path::Path, now_ms: u64) -> Result<(), String> {
    let mut marker = path.as_os_str().to_os_string();
    marker.push(".logged-out");
    if std::path::Path::new(&marker).exists() {
        return Err("signed_out".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "signed_out")?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "signed_out")?;
    if value["account"]["uid"].as_str().is_none_or(str::is_empty)
        || value["auth"]["accessToken"].is_null()
    {
        return Err("signed_out".into());
    }
    if value["auth"]["expiresAt"]
        .as_u64()
        .is_some_and(|expiry| expiry <= now_ms)
    {
        return Err("signed_out".into());
    }
    Ok(())
}

pub(super) async fn account() -> Result<Credentials, String> {
    account_for("workbuddy").await
}
pub(super) async fn account_for(source: &str) -> Result<Credentials, String> {
    let (auth, exe) = paths(source).ok_or("signed_out")?;
    let auth_path = auth.clone();
    tauri::async_runtime::spawn_blocking(move || {
        validate_session(
            &auth_path,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        )
    })
    .await
    .map_err(|_| "signed_out")??;
    let mut command = Command::new(exe);
    command
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env_remove("NODE_OPTIONS")
        .args(["-e", READ_AUTH])
        .arg(auth)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let child = command.spawn().map_err(|_| "signed_out")?;
    let mut output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .map_err(|_| "source_busy")?
        .map_err(|_| "signed_out")?;
    let credentials = if output.status.success() {
        serde_json::from_slice::<Credentials>(&output.stdout).map_err(|_| "signed_out".to_string())
    } else {
        Err("signed_out".into())
    };
    output.stdout.fill(0);
    credentials
}

fn request(
    account: &Credentials,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, String> {
    // Keep local auth-domain/config values from redirecting credentials to another host.
    let mut request =
        "wss://www.workbuddy.cn/clientcap/v2/asr/stream?source=chat&interim_results=1"
            .into_client_request()
            .map_err(|_| "speech_failed")?;
    let headers = request.headers_mut();
    headers.insert(
        "Authorization",
        header(&format!("Bearer {}", account.token))?,
    );
    headers.insert("X-User-Id", header(&account.user_id)?);
    if let Some(domain) = &account.domain {
        headers.insert("X-Domain", header(domain)?);
    }
    if let Some(enterprise) = &account.enterprise_id {
        headers.insert("X-Enterprise-Id", header(enterprise)?);
        headers.insert("X-Tenant-Id", header(enterprise)?);
    }
    Ok(request)
}

pub(super) async fn run(
    account: Credentials,
    audio: mpsc::UnboundedReceiver<Vec<i16>>,
    control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    run_request(request(&account)?, audio, control, emit, stop_capture).await
}

async fn run_request(
    request: tokio_tungstenite::tungstenite::handshake::client::Request,
    mut audio: mpsc::UnboundedReceiver<Vec<i16>>,
    mut control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let mut socket =
        tokio::select! {result=connect(request)=>result?,_=control.recv()=>return Ok(())};
    let mut ready = false;
    let mut closing = false;
    let mut latest = String::new();
    let mut deadline = Instant::now() + Duration::from_secs(10);
    loop {
        tokio::select! {
            biased;
            command=control.recv()=>match command {
                Some(Control::Finish) if ready && !closing=>{
                    stop_capture();
                    while let Ok(chunk)=audio.try_recv(){socket.send(Message::Binary(pcm_bytes(&chunk).into())).await.map_err(|_|"speech_failed")?;}
                    socket.send(Message::Binary(Vec::new().into())).await.map_err(|_|"speech_failed")?;
                    closing=true;deadline=Instant::now()+Duration::from_secs(25);
                },
                Some(Control::Cancel)|None=>{let _=socket.close(None).await;return Ok(());},
                _=>{},
            },
            _=tokio::time::sleep_until(deadline),if !ready||closing=>return Err("speech_timeout".into()),
            chunk=audio.recv(),if ready&&!closing=>match chunk {
                Some(chunk)=>{emit(VoiceEvent::Level{level:level(&chunk)});socket.send(Message::Binary(pcm_bytes(&chunk).into())).await.map_err(|_|"speech_failed")?;},
                None=>return Err("microphone_closed".into()),
            },
            message=socket.next()=>match message {
                Some(Ok(Message::Text(text)))=>{
                    let value:Value=serde_json::from_str(&text).map_err(|_|"speech_failed")?;
                    if let Some(code)=value["code"].as_i64().filter(|code|*code!=0){return Err(if code==401||code==403{format!("http_{code}")}else{"speech_failed".into()});}
                    if !ready {while audio.try_recv().is_ok(){} ready=true;emit(VoiceEvent::Ready);}
                    let done=value["final"].as_bool().unwrap_or(false);
                    if let Some(text)=value["text"].as_str().filter(|text|!text.is_empty()){latest=text.into();}
                    if done && value["noise_reject"].as_bool()==Some(true){latest.clear();}
                    if !latest.is_empty()||done {emit(VoiceEvent::Text{text:latest.clone(),done});}
                    if done {let _=socket.close(None).await;return Ok(());}
                },
                Some(Ok(Message::Close(_)))|None=>return Err("speech_closed".into()),
                Some(Err(_))=>return Err("speech_failed".into()),
                _=>{},
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "uses the local WorkBuddy sign-in and real ASR with synthetic audio"]
    async fn desktop_voice_live() {
        let path = std::env::var("COFFEE_WORKBUDDY_TEST_WAV").expect("synthetic 16kHz PCM16 WAV");
        let wav = std::fs::read(path).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        let offset = wav.windows(4).position(|bytes| bytes == b"data").unwrap() + 8;
        let samples: Vec<i16> = wav[offset..]
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect();
        let account = account().await.expect("active desktop login");
        let (audio_tx, audio_rx) = mpsc::unbounded_channel();
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let ready = tokio::sync::Notify::new();
        let events = Mutex::new(Vec::new());
        let finishing = std::sync::atomic::AtomicBool::new(false);
        let partial = std::sync::atomic::AtomicBool::new(false);
        let emit = |event| {
            match &event {
                VoiceEvent::Ready => ready.notify_one(),
                VoiceEvent::Text { done: false, text }
                    if !text.is_empty() && !finishing.load(Ordering::Relaxed) =>
                {
                    partial.store(true, Ordering::Relaxed)
                }
                _ => {}
            }
            events.lock().unwrap().push(event);
        };
        let feed = async {
            ready.notified().await;
            for chunk in samples.chunks(CHUNK) {
                audio_tx.send(chunk.to_vec()).unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            assert!(
                partial.load(Ordering::Relaxed),
                "text must arrive before finish"
            );
            finishing.store(true, Ordering::Relaxed);
            control_tx.send(Control::Finish).unwrap();
        };
        let result = run(account, audio_rx, control_rx, &emit, || {});
        let (_, result) = tokio::time::timeout(Duration::from_secs(70), async {
            tokio::join!(feed, result)
        })
        .await
        .unwrap();
        result.unwrap();
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event,VoiceEvent::Text{done:true,text} if !text.is_empty())));
    }
    #[test]
    fn invalid_or_logged_out_sessions_are_not_imported() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.info");
        assert!(validate_session(&path, 100).is_err());
        std::fs::write(&path, "{").unwrap();
        assert!(validate_session(&path, 100).is_err());
        std::fs::write(
            &path,
            r#"{"account":{"uid":"fixture"},"auth":{"accessToken":"fixture","expiresAt":99}}"#,
        )
        .unwrap();
        assert!(validate_session(&path, 100).is_err());
        std::fs::write(
            &path,
            r#"{"account":{"uid":"fixture"},"auth":{"accessToken":"fixture","expiresAt":101}}"#,
        )
        .unwrap();
        assert!(validate_session(&path, 100).is_ok());
        std::fs::write(dir.path().join("auth.info.logged-out"), "logout").unwrap();
        assert!(validate_session(&path, 100).is_err());
        let req = request(&Credentials {
            token: "fixture".into(),
            user_id: "fixture-id".into(),
            domain: Some("attacker.invalid".into()),
            enterprise_id: None,
        })
        .unwrap();
        assert_eq!(req.uri().host(), Some("www.workbuddy.cn"));
    }

    #[tokio::test]
    async fn authorization_errors_and_cancel_during_handshake_stop_the_session() {
        for code in [401, 403] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let request = format!("ws://{}", listener.local_addr().unwrap())
                .into_client_request()
                .unwrap();
            let (_audio_tx, audio_rx) = mpsc::unbounded_channel();
            let (_control_tx, control_rx) = mpsc::unbounded_channel();
            let server = async {
                let (connection, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(connection).await.unwrap();
                socket
                    .send(Message::Text(json!({"code":code}).to_string().into()))
                    .await
                    .unwrap();
            };
            let emit = |_| panic!("rejected accounts must not start recording");
            let session = run_request(request, audio_rx, control_rx, &emit, || {});
            let (_, result) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(server, session)
            })
            .await
            .unwrap();
            assert_eq!(result, Err(format!("http_{code}")));
        }
        let (_audio_tx, audio_rx) = mpsc::unbounded_channel();
        let (control_tx, control_rx) = mpsc::unbounded_channel();
        control_tx.send(Control::Cancel).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            run_request(
                "ws://192.0.2.1".into_client_request().unwrap(),
                audio_rx,
                control_rx,
                &|_| panic!("cancelled"),
                || {},
            ),
        )
        .await
        .unwrap();
        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn streaming_results_precede_finish_and_cancel_closes_the_socket() {
        for (cancel, empty_final) in [(false, false), (true, false), (false, true)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let request = format!("ws://{}", listener.local_addr().unwrap())
                .into_client_request()
                .unwrap();
            let (audio_tx, audio_rx) = mpsc::unbounded_channel();
            let (control_tx, control_rx) = mpsc::unbounded_channel();
            let events = Mutex::new(Vec::new());
            let ready = tokio::sync::Notify::new();
            let partial = tokio::sync::Notify::new();
            let stopped = std::sync::atomic::AtomicBool::new(false);
            let server = async {
                let (connection, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(connection).await.unwrap();
                socket
                    .send(Message::Text(r#"{"code":0,"voice_id":"fixture"}"#.into()))
                    .await
                    .unwrap();
                assert_eq!(
                    socket.next().await.unwrap().unwrap(),
                    Message::Binary(pcm_bytes(&[123i16; CHUNK]).into())
                );
                socket
                    .send(Message::Text(r#"{"text":"实时草稿","final":false}"#.into()))
                    .await
                    .unwrap();
                if cancel {
                    assert!(matches!(
                        socket.next().await.unwrap().unwrap(),
                        Message::Close(_)
                    ));
                } else {
                    assert_eq!(
                        socket.next().await.unwrap().unwrap(),
                        Message::Binary(Vec::new().into())
                    );
                    socket
                        .send(Message::Text(
                            if empty_final {
                                r#"{"text":"","final":true}"#
                            } else {
                                r#"{"text":"最终文本","final":true}"#
                            }
                            .into(),
                        ))
                        .await
                        .unwrap();
                }
            };
            let driver = async {
                ready.notified().await;
                audio_tx.send(vec![123; CHUNK]).unwrap();
                partial.notified().await;
                assert!(!stopped.load(Ordering::Relaxed));
                control_tx
                    .send(if cancel {
                        Control::Cancel
                    } else {
                        Control::Finish
                    })
                    .unwrap();
            };
            let emit = |event| {
                match &event {
                    VoiceEvent::Ready => ready.notify_one(),
                    VoiceEvent::Text { done: false, .. } => partial.notify_one(),
                    _ => {}
                }
                events.lock().unwrap().push(event);
            };
            let session = run_request(request, audio_rx, control_rx, &emit, || {
                stopped.store(true, Ordering::Relaxed)
            });
            let (_, _, result) = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::join!(server, driver, session)
            })
            .await
            .unwrap();
            result.unwrap();
            assert_eq!(
                events.lock().unwrap().iter().any(
                    |event| matches!(event,VoiceEvent::Text{done:true,text} if text==if empty_final{"实时草稿"}else{"最终文本"})
                ),
                !cancel
            );
            assert_eq!(stopped.load(Ordering::Relaxed), !cancel);
        }
    }
}
