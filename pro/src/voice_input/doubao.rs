//! Doubao desktop account dictation. The consumer and Work clients keep separate sessions.
//! Protocol checked against the shipped SDK and EchoBird's historical VoiceGenie adapter.
use super::*;

const ENDPOINT: &str = "wss://frontier-audio-web-ws.doubao.com/api/v2/sami/voicegenie";
const NORMAL_APPKEY: &str = "GOqQpfo1fO7slHv8";
const FEISHU_APPKEY: &str = "F5tdjWzsqEUUQsLJ";

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct Credentials {
    pub name: String,
    pub(super) user_id: String,
    cookie: String,
    profile_cookie: String,
    enterprise: bool,
}

pub(super) fn supports(source: &str) -> bool {
    matches!(source, "doubao" | "doubaowork")
}

pub(super) async fn account(source: &str) -> Result<Credentials, String> {
    #[cfg(not(windows))]
    {
        let _ = source;
        Err("signed_out".into())
    }
    #[cfg(windows)]
    {
        let source = source.to_owned();
        let (profile_cookie, speech_cookie) =
            tauri::async_runtime::spawn_blocking(move || match local::load(&source) {
                Ok(cookies) => Ok((
                    cookie_header(&cookies, "www.doubao.com", "/passport/account/info/v2/"),
                    cookie_header(
                        &cookies,
                        "frontier-audio-web-ws.doubao.com",
                        "/api/v2/sami/voicegenie",
                    ),
                )),
                Err(error) if error == "source_busy" => local::saved(&source)
                    .map(|c| (c.profile_cookie, c.cookie))
                    .map_err(|_| error),
                Err(error) => Err(error),
            })
            .await
            .map_err(|_| "signed_out")??;
        if speech_cookie.is_empty() || profile_cookie.is_empty() {
            return Err("signed_out".into());
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(6))
            .build()
            .map_err(|_| "signed_out")?;
        let response = client
            .get("https://www.doubao.com/passport/account/info/v2/")
            .query(&[
                ("account_sdk_source", "web"),
                ("sdk_version", "2.2.5"),
                ("aid", "497858"),
                ("device_platform", "web"),
                ("samantha_web", "1"),
            ])
            .header("Cookie", &profile_cookie)
            .header("Referer", "https://www.doubao.com/")
            .header("User-Agent", "Mozilla/5.0")
            .header("Agw-Js-Conv", "str")
            .send()
            .await
            .map_err(|_| "signed_out")?;
        if !response.status().is_success() {
            return Err("signed_out".into());
        }
        let value: Value = response.json().await.map_err(|_| "signed_out")?;
        let data = &value["data"];
        let user_id = data["user_id_str"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("signed_out")?
            .to_string();
        let name = data["screen_name"]
            .as_str()
            .or(data["name"].as_str())
            .unwrap_or("")
            .to_string();
        Ok(Credentials {
            name,
            user_id,
            cookie: speech_cookie,
            profile_cookie,
            enterprise: data["passport_enterprise_user_type"].as_str() == Some("102"),
        })
    }
}

pub(super) async fn select(source: &str) -> Result<(), String> {
    let credentials = account(source).await?;
    #[cfg(windows)]
    {
        let source = source.to_owned();
        tauri::async_runtime::spawn_blocking(move || local::save(&source, &credentials))
            .await
            .map_err(|_| "source_save_failed")?
    }
    #[cfg(not(windows))]
    {
        let _ = credentials;
        Err("signed_out".into())
    }
}

#[cfg(any(windows, test))]
struct Cookie {
    host: String,
    path: String,
    name: String,
    value: String,
}

#[cfg(any(windows, test))]
fn cookie_header(cookies: &[Cookie], host: &str, path: &str) -> String {
    let mut selected: Vec<_> = cookies
        .iter()
        .filter(|cookie| {
            let domain = cookie.host.trim_start_matches('.');
            (cookie.host == host
                || (cookie.host.starts_with('.')
                    && (host == domain || host.ends_with(&format!(".{domain}")))))
                && (path == cookie.path
                    || (path.starts_with(&cookie.path)
                        && (cookie.path.ends_with('/')
                            || path.as_bytes().get(cookie.path.len()) == Some(&b'/'))))
        })
        .collect();
    selected.sort_by_key(|cookie| std::cmp::Reverse(cookie.path.len()));
    selected
        .into_iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(windows)]
mod local {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
    use sha2::{Digest, Sha256};

    fn saved_path(source: &str) -> Result<std::path::PathBuf, String> {
        if !supports(source) {
            return Err("signed_out".into());
        }
        Ok(dirs::home_dir()
            .ok_or("signed_out")?
            .join(".coffee-cli/voice-sources")
            .join(format!("{source}.bin")))
    }

    pub(super) fn saved(source: &str) -> Result<Credentials, String> {
        read_saved(&saved_path(source)?)
    }

    fn read_saved(path: &std::path::Path) -> Result<Credentials, String> {
        let protected = std::fs::read(path).map_err(|_| "signed_out")?;
        serde_json::from_slice(&unprotect(&protected)?).map_err(|_| "signed_out".into())
    }

    pub(super) fn save(source: &str, credentials: &Credentials) -> Result<(), String> {
        write_saved(&saved_path(source)?, credentials)
    }

    fn write_saved(path: &std::path::Path, credentials: &Credentials) -> Result<(), String> {
        use std::io::Write;
        let directory = path.parent().ok_or("source_save_failed")?;
        std::fs::create_dir_all(directory).map_err(|_| "source_save_failed")?;
        let serialized = serde_json::to_vec(credentials).map_err(|_| "source_save_failed")?;
        let encrypted = protect(&serialized)?;
        let mut file =
            tempfile::NamedTempFile::new_in(directory).map_err(|_| "source_save_failed")?;
        file.write_all(&encrypted)
            .map_err(|_| "source_save_failed")?;
        file.persist(path).map_err(|_| "source_save_failed")?;
        Ok(())
    }

    pub(super) fn load(source: &str) -> Result<Vec<Cookie>, String> {
        let app = match source {
            "doubao" => "Doubao",
            "doubaowork" => "DoubaoWork",
            _ => return Err("signed_out".into()),
        };
        let root = dirs::data_local_dir()
            .ok_or("signed_out")?
            .join(app)
            .join("User Data");
        let state: Value = serde_json::from_slice(
            &std::fs::read(root.join("Local State")).map_err(|_| "signed_out")?,
        )
        .map_err(|_| "signed_out")?;
        let wrapped = STANDARD
            .decode(
                state["os_crypt"]["encrypted_key"]
                    .as_str()
                    .ok_or("signed_out")?,
            )
            .map_err(|_| "signed_out")?;
        let key = unprotect(wrapped.strip_prefix(b"DPAPI").ok_or("signed_out")?)?;
        let cookie_path = root.join("Default/Network/Cookies");
        // Chromium opens its database without sharing reads while the client runs.
        drop(std::fs::File::open(&cookie_path).map_err(|error| {
            if matches!(error.raw_os_error(), Some(32 | 33)) {
                "source_busy"
            } else {
                "signed_out"
            }
        })?);
        let database = rusqlite::Connection::open_with_flags(
            cookie_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|_| "signed_out")?;
        database
            .busy_timeout(Duration::from_millis(200))
            .map_err(|_| "signed_out")?;
        let version: i64 = database
            .query_row("SELECT value FROM meta WHERE key='version'", [], |row| {
                row.get::<_, String>(0)?
                    .parse::<i64>()
                    .map_err(|_| rusqlite::Error::InvalidQuery)
            })
            .map_err(|_| "signed_out")?;
        let mut query = database.prepare("SELECT host_key,path,name,value,encrypted_value FROM cookies WHERE host_key IN ('.doubao.com','www.doubao.com','frontier-audio-web-ws.doubao.com') AND (expires_utc=0 OR expires_utc>?)").map_err(|_| "signed_out")?;
        let now = (chrono::Utc::now().timestamp() + 11_644_473_600) * 1_000_000;
        let rows = query
            .query_map([now], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                ))
            })
            .map_err(|_| "signed_out")?;
        let mut cookies = Vec::new();
        for row in rows {
            let (host, path, name, plain, encrypted) = row.map_err(|_| "signed_out")?;
            let value = if encrypted.is_empty() {
                plain
            } else {
                decrypt(&key, &encrypted, &host, version)?
            };
            if name.is_empty()
                || value.is_empty()
                || !path.starts_with('/')
                || name
                    .bytes()
                    .any(|b| b.is_ascii_control() || b"=;, ".contains(&b))
                || value.bytes().any(|b| b.is_ascii_control() || b == b';')
            {
                continue;
            }
            cookies.push(Cookie {
                host,
                path,
                name,
                value,
            });
        }
        Ok(cookies)
    }

    fn unprotect(bytes: &[u8]) -> Result<Vec<u8>, String> {
        use windows::Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        };
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len().try_into().map_err(|_| "signed_out")?,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|_| "signed_out")?;
            let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(output.pbData.cast()));
            Ok(result)
        }
    }

    fn protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
        use windows::Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        };
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len().try_into().map_err(|_| "source_save_failed")?,
            pbData: bytes.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                windows::core::PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .map_err(|_| "source_save_failed")?;
            let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(HLOCAL(output.pbData.cast()));
            Ok(result)
        }
    }

    fn decrypt(key: &[u8], bytes: &[u8], host: &str, version: i64) -> Result<String, String> {
        if bytes.len() < 31 || !bytes.starts_with(b"v10") {
            return Err("signed_out".into());
        }
        let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| "signed_out")?);
        let nonce = Nonce::try_assume_unique_for_key(&bytes[3..15]).map_err(|_| "signed_out")?;
        let mut ciphertext = bytes[15..].to_vec();
        let plain = key
            .open_in_place(nonce, Aad::empty(), &mut ciphertext)
            .map_err(|_| "signed_out")?;
        let plain = if version >= 24 {
            let hash = Sha256::digest(host.as_bytes());
            plain.strip_prefix(hash.as_slice()).ok_or("signed_out")?
        } else {
            plain
        };
        String::from_utf8(plain.to_vec()).map_err(|_| "signed_out".into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn imported_sessions_are_protected_for_the_current_windows_user() {
            let encrypted = protect(b"fixture-session").unwrap();
            assert!(!encrypted.windows(15).any(|w| w == b"fixture-session"));
            assert_eq!(unprotect(&encrypted).unwrap(), b"fixture-session");
            assert!(saved_path("../other").is_err());
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("voice.bin");
            let credentials = Credentials {
                name: "fixture".into(),
                user_id: "user".into(),
                cookie: "sessionid=fixture".into(),
                profile_cookie: "sessionid=fixture".into(),
                enterprise: false,
            };
            write_saved(&path, &credentials).unwrap();
            let imported = read_saved(&path).unwrap();
            assert_eq!(imported.user_id, "user");
            assert_eq!(imported.cookie, "sessionid=fixture");
            assert!(!std::fs::read(path)
                .unwrap()
                .windows(7)
                .any(|w| w == b"fixture"));
        }
        #[test]
        fn cookie_decryption_checks_host_binding_and_authentication() {
            let key = [7u8; 32];
            let nonce = [8u8; 12];
            let mut data = Sha256::digest(b".doubao.com").to_vec();
            data.extend_from_slice(b"fixture-session");
            LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).unwrap())
                .seal_in_place_append_tag(
                    Nonce::assume_unique_for_key(nonce),
                    Aad::empty(),
                    &mut data,
                )
                .unwrap();
            let mut blob = b"v10".to_vec();
            blob.extend_from_slice(&nonce);
            blob.extend_from_slice(&data);
            assert_eq!(
                decrypt(&key, &blob, ".doubao.com", 24).unwrap(),
                "fixture-session"
            );
            assert!(decrypt(&key, &blob, "www.doubao.com", 24).is_err());
            assert!(decrypt(&[0; 32], &blob, ".doubao.com", 24).is_err());
            blob[0] = b'x';
            assert!(decrypt(&key, &blob, ".doubao.com", 24).is_err());
        }
    }
}

fn number(out: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        out.push(value as u8 | 128);
        value >>= 7;
    }
    out.push(value as u8);
}
fn bytes(out: &mut Vec<u8>, field: u64, data: &[u8]) {
    number(out, field * 8 + 2);
    number(out, data.len() as u64);
    out.extend_from_slice(data);
}
fn frame(
    appkey: &str,
    task: &str,
    event: &str,
    payload: Option<&str>,
    audio: Option<&[u8]>,
    sequence: u64,
) -> Message {
    let mut out = Vec::new();
    for (field, value) in [
        (2, appkey),
        (3, "VoiceGenie"),
        (5, event),
        (6, payload.unwrap_or("{}")),
    ] {
        bytes(&mut out, field, value.as_bytes());
    }
    if !task.is_empty() {
        bytes(&mut out, 8, task.as_bytes());
    }
    if let Some(audio) = audio {
        bytes(&mut out, 7, audio);
        number(&mut out, 9 * 8);
        number(&mut out, sequence);
    }
    Message::Binary(out.into())
}
fn read_number(input: &mut &[u8]) -> Result<u64, String> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let (&byte, rest) = input.split_first().ok_or("speech_protocol")?;
        *input = rest;
        if shift == 63 && byte > 1 {
            return Err("speech_protocol".into());
        }
        value |= ((byte & 127) as u64) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err("speech_protocol".into())
}
#[derive(Default)]
struct Event {
    task: String,
    kind: String,
    code: u64,
    payload: String,
}
fn decode(mut input: &[u8]) -> Result<Event, String> {
    let mut event = Event::default();
    while !input.is_empty() {
        let tag = read_number(&mut input)?;
        let field = tag >> 3;
        match tag & 7 {
            0 => {
                let value = read_number(&mut input)?;
                if field == 5 {
                    event.code = value;
                }
            }
            2 => {
                let len =
                    usize::try_from(read_number(&mut input)?).map_err(|_| "speech_protocol")?;
                let value = input.get(..len).ok_or("speech_protocol")?;
                input = &input[len..];
                if matches!(field, 1 | 4 | 7) {
                    let value = std::str::from_utf8(value)
                        .map_err(|_| "speech_protocol")?
                        .to_string();
                    match field {
                        1 => event.task = value,
                        4 => event.kind = value,
                        _ => event.payload = value,
                    }
                }
            }
            _ => return Err("speech_protocol".into()),
        }
    }
    Ok(event)
}

#[derive(Default)]
struct Transcript {
    confirmed: String,
    pending: String,
}
impl Transcript {
    fn apply(&mut self, payload: &str) -> Result<(), String> {
        let value: Value = serde_json::from_str(payload).map_err(|_| "speech_protocol")?;
        let Some(result) = value["results"].as_array().and_then(|v| v.first()) else {
            return Ok(());
        };
        let Some(text) = result["text"].as_str() else {
            return Ok(());
        };
        if self.confirmed.len().saturating_add(text.len()) > 1_048_576 {
            return Err("speech_protocol".into());
        }
        let final_result = result["is_interim"]
            .as_bool()
            .map(|v| !v)
            .or(result["is_final"].as_bool())
            .or(result["isFinal"].as_bool())
            .or(value["is_final"].as_bool())
            .unwrap_or(false);
        if final_result {
            self.confirmed.push_str(text);
            self.pending.clear();
        } else {
            self.pending = text.into();
        }
        Ok(())
    }
    fn text(&self) -> String {
        format!("{}{}", self.confirmed, self.pending)
    }
}

pub(super) async fn run(
    credentials: Credentials,
    mut audio: mpsc::UnboundedReceiver<Vec<i16>>,
    mut control: mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let appkey = if credentials.enterprise {
        FEISHU_APPKEY
    } else {
        NORMAL_APPKEY
    };
    let mut url = url::Url::parse(ENDPOINT).map_err(|_| "speech_protocol")?;
    url.query_pairs_mut().extend_pairs([
        ("api_app_key", appkey),
        ("namespace", "VoiceGenie"),
        ("version_code", "20800"),
        ("language", "zh"),
        ("device_platform", "web"),
        ("pkg_type", "release_version"),
        ("pc_version", "3.9.0"),
        ("region", "CN"),
        ("sys_region", "CN"),
        ("samantha_web", "1"),
        ("use-olympus-account", "1"),
    ]);
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "speech_protocol")?;
    request
        .headers_mut()
        .insert("Cookie", header(&credentials.cookie)?);
    request
        .headers_mut()
        .insert("Origin", header("https://www.doubao.com")?);
    let mut socket = tokio::select! { result = connect(request) => result?, _ = control.recv() => return Ok(()) };
    socket
        .send(frame(appkey, "", "StartTask", None, None, 0))
        .await
        .map_err(|_| "speech_network")?;
    stream(
        &mut socket,
        appkey,
        &credentials.user_id,
        &mut audio,
        &mut control,
        emit,
        stop_capture,
    )
    .await
}

async fn stream(
    socket: &mut Socket,
    appkey: &str,
    uid: &str,
    audio: &mut mpsc::UnboundedReceiver<Vec<i16>>,
    control: &mut mpsc::UnboundedReceiver<Control>,
    emit: &(dyn Fn(VoiceEvent) + Send + Sync),
    stop_capture: impl Fn() + Send,
) -> Result<(), String> {
    let mut task = String::new();
    // Task → session → audio → end-ASR → finish-session.
    let mut stage = 0;
    let mut sequence = 1;
    let mut transcript = Transcript::default();
    let mut deadline = Instant::now() + Duration::from_secs(10);
    let mut heartbeat = tokio::time::interval_at(
        Instant::now() + Duration::from_secs(8),
        Duration::from_secs(8),
    );
    let mut pong_deadline = None;
    loop {
        tokio::select! {
            biased;
            command = control.recv() => match command {
                Some(Control::Cancel) | None => { let _ = socket.close(None).await; return Ok(()); },
                Some(Control::Finish) if stage == 2 => {
                    stop_capture();
                    while let Ok(chunk) = audio.try_recv() { socket.send(frame(appkey,&task,"TaskRequest",None,Some(&pcm_bytes(&chunk)),sequence)).await.map_err(|_| "speech_network")?; sequence += 1; }
                    socket.send(frame(appkey,&task,"EndASR",None,None,0)).await.map_err(|_| "speech_network")?;
                    stage = 3; deadline = Instant::now() + Duration::from_secs(20);
                },
                Some(Control::Finish) if stage < 2 => return Ok(()),
                _ => {},
            },
            _ = tokio::time::sleep_until(deadline), if stage != 2 => return Err("speech_timeout".into()),
            _ = tokio::time::sleep_until(pong_deadline.unwrap_or_else(Instant::now)), if pong_deadline.is_some() => return Err("speech_timeout".into()),
            _ = heartbeat.tick() => { socket.send(frame(appkey,&task,"Ping",None,None,0)).await.map_err(|_| "speech_network")?; pong_deadline.get_or_insert(Instant::now() + Duration::from_secs(12)); },
            chunk = audio.recv(), if stage == 2 => match chunk {
                Some(chunk) => {
                    emit(VoiceEvent::Level { level: level(&chunk) });
                    socket.send(frame(appkey,&task,"TaskRequest",None,Some(&pcm_bytes(&chunk)),sequence)).await.map_err(|_| "speech_network")?; sequence += 1;
                },
                None => return Err("microphone_closed".into()),
            },
            message = socket.next() => {
                let message = message.ok_or("speech_closed")?.map_err(|_| "speech_network")?;
                let data = match message { Message::Binary(data) => data, Message::Ping(data) => { socket.send(Message::Pong(data)).await.map_err(|_| "speech_network")?; continue; }, Message::Pong(_) => continue, _ => return Err("speech_closed".into()) };
                let event = decode(&data)?;
                if !matches!(event.code,0|20_000_000) || matches!(event.kind.as_str(),"TaskFailed"|"SessionFailed"|"SessionCanceled"|"TaskCanceled"|"Error") { return Err(format!("speech_rejected_{}",event.code)); }
                if !task.is_empty() && !event.task.is_empty() && task != event.task { return Err("speech_protocol".into()); }
                match event.kind.as_str() {
                    "Pong" => pong_deadline = None,
                    "TaskStarted" if stage == 0 && !event.task.is_empty() => {
                        task = event.task;
                        let payload = json!({
                            "business":1,"enable_audio_input":true,"query_mode":2,"interrupt_type":0,"request_type":3,
                            "chat":{"uid":uid},
                            "asr":{
                                "model":"bigasr-acllm-release-grpc-main",
                                "audio_info":{"channel":1,"format":"pcm","sample_rate":16000},
                                "lang":"zh","enable_vad":true,"enable_punctuation":true,"enable_itn":true,"enable_disfluency":true,
                                "extra":{
                                    "enable_asr_twopass":true,
                                    "minor_model":"bigasr-acllm-release-grpc-mlg-0",
                                    "nonstream_model":"bigasr-acllm-release-grpc-main",
                                    "stream_model":"bigasr-acllm-release-streaming-grpc-4"
                                }
                            },
                            "extra":{"uid":uid}
                        }).to_string();
                        socket.send(frame(appkey,&task,"StartSession",Some(&payload),None,0)).await.map_err(|_| "speech_network")?;
                        stage = 1;
                    },
                    "SessionStarted" if stage == 1 => { stage = 2; emit(VoiceEvent::Ready); },
                    "ASRResponse" if stage >= 2 => { transcript.apply(&event.payload)?; emit(VoiceEvent::Text { text: transcript.text(), done: false }); },
                    "ASREnded" if stage == 3 => { socket.send(frame(appkey,&task,"FinishSession",None,None,0)).await.map_err(|_| "speech_network")?; stage = 4; },
                    "SessionFinished" if stage == 4 => {
                        let _ = socket.close(None).await;
                        emit(VoiceEvent::Text { text: transcript.confirmed, done: true }); return Ok(());
                    },
                    "TaskStarted"|"SessionStarted"|"ASREnded"|"SessionFinished" => return Err("speech_protocol".into()),
                    _ => {},
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires both locally signed-in desktop clients"]
    async fn desktop_account_scan_live() {
        let sources = super::super::voice_input_sources().await.unwrap();
        for id in ["doubao", "doubaowork"] {
            assert!(
                sources
                    .iter()
                    .any(|source| source.id == id && source.issue.is_none()),
                "{id}: expected usable locally signed-in desktop account"
            );
        }
        println!("both local desktop accounts discovered; credentials stay native");
    }

    #[tokio::test]
    #[ignore = "imports both local desktop sessions into the current user's encrypted Coffee store"]
    async fn desktop_account_import_live() {
        for source in ["doubao", "doubaowork"] {
            select(source).await.expect("import local desktop sign-in");
            #[cfg(windows)]
            {
                let saved = local::saved(source).expect("read encrypted imported session");
                assert!(!saved.user_id.is_empty());
                assert!(!saved.cookie.is_empty());
            }
            println!("{source}: encrypted account import passed");
        }
    }
    fn response(task: &str, kind: &str, payload: &str) -> Message {
        let mut out = Vec::new();
        number(&mut out, 5 * 8);
        number(&mut out, 20_000_000);
        for (field, value) in [(1, task), (4, kind), (7, payload)] {
            bytes(&mut out, field, value.as_bytes());
        }
        Message::Binary(out.into())
    }
    #[tokio::test]
    async fn streaming_session_finalizes_and_cancel_drops_the_session() {
        for cancel in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let ready = tokio::sync::Notify::new();
            let heard = tokio::sync::Notify::new();
            let (audio_tx, mut audio_rx) = mpsc::unbounded_channel();
            let (control_tx, mut control_rx) = mpsc::unbounded_channel();
            let events = Mutex::new(Vec::new());
            let server = async {
                let (connection, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(connection).await.unwrap();
                assert_eq!(
                    ws.next().await.unwrap().unwrap(),
                    frame("fixture", "", "StartTask", None, None, 0)
                );
                ws.send(response("task", "TaskStarted", "{}"))
                    .await
                    .unwrap();
                let Message::Binary(start) = ws.next().await.unwrap().unwrap() else {
                    panic!("start session")
                };
                assert!(start.windows(12).any(|bytes| bytes == b"StartSession"));
                assert!(
                    start
                        .windows(b"stream_model".len())
                        .any(|bytes| bytes == b"stream_model"),
                    "dictation must request the streaming recognizer before recording starts"
                );
                ws.send(response("task", "SessionStarted", "{}"))
                    .await
                    .unwrap();
                if cancel {
                    assert!(matches!(
                        ws.next().await.unwrap().unwrap(),
                        Message::Close(_)
                    ));
                    return;
                }
                assert_eq!(
                    ws.next().await.unwrap().unwrap(),
                    frame(
                        "fixture",
                        "task",
                        "TaskRequest",
                        None,
                        Some(&pcm_bytes(&[100; CHUNK])),
                        1
                    )
                );
                ws.send(response(
                    "task",
                    "ASRResponse",
                    r#"{"results":[{"text":"你","is_interim":true}]}"#,
                ))
                .await
                .unwrap();
                heard.notify_one();
                assert_eq!(
                    ws.next().await.unwrap().unwrap(),
                    frame("fixture", "task", "EndASR", None, None, 0)
                );
                ws.send(response(
                    "task",
                    "ASRResponse",
                    r#"{"results":[{"text":"你好","is_interim":false}]}"#,
                ))
                .await
                .unwrap();
                ws.send(response("task", "ASREnded", "{}")).await.unwrap();
                assert_eq!(
                    ws.next().await.unwrap().unwrap(),
                    frame("fixture", "task", "FinishSession", None, None, 0)
                );
                ws.send(response("task", "SessionFinished", "{}"))
                    .await
                    .unwrap();
            };
            let client = async {
                let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
                socket
                    .send(frame("fixture", "", "StartTask", None, None, 0))
                    .await
                    .unwrap();
                stream(
                    &mut socket,
                    "fixture",
                    "test-user",
                    &mut audio_rx,
                    &mut control_rx,
                    &|event| {
                        if matches!(event, VoiceEvent::Ready) {
                            ready.notify_one();
                        }
                        events.lock().unwrap().push(event);
                    },
                    || {},
                )
                .await
                .unwrap();
            };
            let recording = async {
                ready.notified().await;
                if cancel {
                    control_tx.send(Control::Cancel).unwrap();
                    return;
                }
                audio_tx.send(vec![100; CHUNK]).unwrap();
                heard.notified().await;
                control_tx.send(Control::Finish).unwrap();
            };
            tokio::time::timeout(Duration::from_secs(3), async {
                tokio::join!(server, client, recording)
            })
            .await
            .unwrap();
            let events = events.lock().unwrap();
            assert_eq!(events.first(), Some(&VoiceEvent::Ready));
            if cancel {
                assert_eq!(events.len(), 1);
            } else {
                assert_eq!(
                    events.last(),
                    Some(&VoiceEvent::Text {
                        text: "你好".into(),
                        done: true
                    })
                );
            }
        }
    }
    #[tokio::test]
    #[ignore = "uses local desktop sign-ins and the real speech service with a synthetic WAV"]
    async fn desktop_voice_live() {
        let path = std::env::var("COFFEE_DOUBAO_TEST_WAV").expect("synthetic 16 kHz PCM WAV");
        let wav = std::fs::read(path).unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        let offset = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
        let samples: Vec<i16> = wav[offset..]
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect();
        for source in ["doubao", "doubaowork"] {
            let credentials = account(source).await.expect("desktop sign-in");
            let (audio_tx, audio_rx) = mpsc::unbounded_channel();
            let (control_tx, control_rx) = mpsc::unbounded_channel();
            let ready = std::sync::Arc::new(tokio::sync::Notify::new());
            let events = Mutex::new(Vec::new());
            let finishing = std::sync::atomic::AtomicBool::new(false);
            let text_before_finish = std::sync::atomic::AtomicBool::new(false);
            let emit = |event| {
                if matches!(event, VoiceEvent::Ready) {
                    ready.notify_one();
                }
                if matches!(&event,VoiceEvent::Text {text,..} if !text.trim().is_empty())
                    && !finishing.load(Ordering::SeqCst)
                {
                    text_before_finish.store(true, Ordering::SeqCst);
                }
                events.lock().unwrap().push(event);
            };
            let feeder = async {
                ready.notified().await;
                for chunk in samples.chunks(CHUNK) {
                    audio_tx.send(chunk.to_vec()).unwrap();
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                finishing.store(true, Ordering::SeqCst);
                control_tx.send(Control::Finish).unwrap();
            };
            let result = tokio::time::timeout(Duration::from_secs(45), async {
                tokio::try_join!(
                    run(credentials, audio_rx, control_rx, &emit, || {}),
                    async {
                        feeder.await;
                        Ok::<_, String>(())
                    }
                )
            })
            .await
            .expect("live deadline");
            result.unwrap_or_else(|error| panic!("{source}: {error}"));
            assert!(
                text_before_finish.load(Ordering::SeqCst),
                "{source}: no text arrived before stopping the recording"
            );
            let events = events.lock().unwrap();
            assert!(
                matches!(events.last(),Some(VoiceEvent::Text {text,done:true}) if text.contains("语音")),
                "{source}: expected synthetic transcript"
            );
            println!("{source}: text arrived before stop; final transcription passed");
        }
    }
    #[test]
    fn speech_cookies_respect_host_and_path() {
        let cookies = vec![
            Cookie {
                host: ".doubao.com".into(),
                path: "/".into(),
                name: "sessionid".into(),
                value: "fixture".into(),
            },
            Cookie {
                host: "www.doubao.com".into(),
                path: "/".into(),
                name: "www-only".into(),
                value: "fixture".into(),
            },
            Cookie {
                host: ".doubao.com".into(),
                path: "/api/v2/sami/voicegenie-other".into(),
                name: "wrong-path".into(),
                value: "fixture".into(),
            },
        ];
        assert_eq!(
            cookie_header(
                &cookies,
                "frontier-audio-web-ws.doubao.com",
                "/api/v2/sami/voicegenie"
            ),
            "sessionid=fixture"
        );
    }
    #[test]
    fn malformed_events_fail_and_interim_text_is_replaced() {
        assert!(decode(&[34, 255]).is_err());
        assert!(decode(&[255; 11]).is_err());
        let mut transcript = Transcript::default();
        transcript
            .apply(r#"{"results":[{"text":"你","is_interim":true}]}"#)
            .unwrap();
        transcript
            .apply(r#"{"results":[{"text":"你好","is_interim":false}]}"#)
            .unwrap();
        assert_eq!(transcript.text(), "你好");
    }
}
