//! Read the clients' current native sign-ins. No EchoBird stores or account mutation.
use super::{accounts, devin_protocol as wire, vault};
use aes::Aes128;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

type Login = Result<(String, Value), String>;
const DEVIN_SERVER: &str = "https://server.codeium.com";

pub(super) fn read(provider: &str, home: &Path, config: &Path) -> Login {
    match provider {
        "antigravity" => {
            if version("antigravity").is_empty() {
                return Err("signed_out".into());
            }
            antigravity(&antigravity_secret()?)
        }
        "grokbot" => grokbot(&config.join("Grok Bot")),
        "devin" => devin_desktop(&config.join("Devin"))
            .or_else(|_| devin_cli(&devin_cli_path(home, config))),
        "codearts" => codearts(&config.join("codearts")),
        "trae" | "traecn" => trae(provider, config),
        _ => Err("signed_out".into()),
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "signed_out".into())
}
fn json_file(path: &Path) -> Result<Value, String> {
    accounts::read_json(path)
}
fn claims(token: &str) -> Result<Value, String> {
    let raw = token.split('.').nth(1).ok_or("signed_out")?;
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(raw.trim_end_matches('='))
            .map_err(|_| "signed_out")?,
    )
    .map_err(|_| "signed_out".into())
}
fn unix(value: &Value) -> Option<i64> {
    let number = value.as_i64().or_else(|| value.as_str()?.parse().ok());
    if let Some(number) = number {
        return Some(if number > 1_000_000_000_000 {
            number / 1000
        } else {
            number
        });
    }
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|v| v.timestamp())
}
fn not_expired(value: &Value) -> Result<(), String> {
    if !value.is_null() && unix(value).is_none_or(|v| v <= chrono::Utc::now().timestamp()) {
        return Err("signed_out".into());
    }
    Ok(())
}
fn jwt_identity(token: &str) -> Result<String, String> {
    let value = claims(token)?;
    not_expired(&value["exp"])?;
    Ok(text(&value, "sub")?.into())
}
fn version(tool: &str) -> String {
    let metadata = accounts::app_metadata(tool).unwrap_or(Value::Null);
    metadata["appVersion"]
        .as_str()
        .or_else(|| metadata["version"].as_str())
        .unwrap_or("")
        .into()
}

fn antigravity(raw: &str) -> Login {
    let native: Value = serde_json::from_str(raw).map_err(|_| "signed_out")?;
    let token = text(&native["token"], "access_token")?;
    not_expired(&native["token"]["expiry"])?;
    // id_token establishes identity; its age does not replace the access-token expiry.
    let id = claims(text(&native, "id_token")?)?;
    let user = text(&id, "sub")?.to_string();
    let project = native["project_id"]
        .as_str()
        .or_else(|| native["cloudaicompanionProject"].as_str());
    Ok((
        user,
        json!({"accessToken":token,"projectId":project,"appVersion":version("antigravity")}),
    ))
}
#[cfg(windows)]
fn antigravity_secret() -> Result<String, String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    struct Credential {
        flags: u32,
        kind: u32,
        target: *const u16,
        comment: *const u16,
        written: FileTime,
        blob_size: u32,
        blob: *const u8,
        persist: u32,
        attribute_count: u32,
        attributes: *const c_void,
        alias: *const u16,
        username: *const u16,
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn CredReadW(target: *const u16, kind: u32, flags: u32, value: *mut *mut Credential)
            -> i32;
        fn CredFree(value: *mut c_void);
    }
    let target: Vec<u16> = std::ffi::OsStr::new("gemini:antigravity")
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut value = ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), 1, 0, &mut value) } == 0 || value.is_null() {
        return Err("signed_out".into());
    }
    let bytes = unsafe {
        let item = &*value;
        if item.blob.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(item.blob, item.blob_size as usize).to_vec()
        }
    };
    unsafe {
        CredFree(value.cast());
    }
    String::from_utf8(bytes).map_err(|_| "signed_out".into())
}
#[cfg(target_os = "macos")]
fn antigravity_secret() -> Result<String, String> {
    let output = accounts::command("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "gemini",
            "-a",
            "antigravity",
            "-w",
        ])
        .output()
        .map_err(|_| "signed_out")?;
    if !output.status.success() {
        return Err("signed_out".into());
    }
    let raw = String::from_utf8(output.stdout).map_err(|_| "signed_out")?;
    let raw = raw
        .trim()
        .strip_prefix("go-keyring-base64:")
        .unwrap_or(raw.trim());
    String::from_utf8(STANDARD.decode(raw).map_err(|_| "signed_out")?)
        .map_err(|_| "signed_out".into())
}
#[cfg(target_os = "linux")]
fn antigravity_secret() -> Result<String, String> {
    let output = accounts::command("secret-tool")
        .args(["lookup", "service", "gemini", "username", "antigravity"])
        .output()
        .map_err(|_| "signed_out")?;
    if !output.status.success() {
        return Err("signed_out".into());
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().into())
        .map_err(|_| "signed_out".into())
}

fn grokbot(dir: &Path) -> Login {
    let document = json_file(&dir.join("sand-secrets.json"))?;
    let cipher = vault::cipher_with_name(dir, "Grok Bot")?;
    grokbot_catalog(&document, |value| vault::decrypt(&cipher, value))
}
fn grokbot_catalog(document: &Value, decrypt: impl Fn(&str) -> Result<String, String>) -> Login {
    let catalog: Value =
        serde_json::from_str(text(document, "cursor-accounts")?).map_err(|_| "signed_out")?;
    let active = text(&catalog, "active")?;
    let row = &catalog["accounts"][active];
    grokbot_row(active, row, decrypt)
}
fn grokbot_row(
    active: &str,
    row: &Value,
    decrypt: impl Fn(&str) -> Result<String, String>,
) -> Login {
    let token = decrypt(text(row, "cursor-access-token")?)?;
    let user = jwt_identity(&token)?;
    if format!("{:x}", Sha256::digest(user.as_bytes())) != active {
        return Err("signed_out".into());
    }
    let team = row
        .get("cursor-selected-team-id")
        .map(|v| {
            decrypt(v.as_str().ok_or("signed_out")?)
                .and_then(|s| s.parse::<u64>().map_err(|_| "signed_out".into()))
        })
        .transpose()?;
    if team.is_some_and(|v| v == 0 || v > 9_007_199_254_740_991) {
        return Err("signed_out".into());
    }
    Ok((user, json!({"accessToken":token,"teamId":team})))
}

fn database(dir: &Path) -> Result<rusqlite::Connection, String> {
    let db = rusqlite::Connection::open_with_flags(
        dir.join("User/globalStorage/state.vscdb"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| "signed_out")?;
    db.busy_timeout(Duration::from_secs(2))
        .map_err(|_| "signed_out")?;
    Ok(db)
}
fn buffer(raw: &str) -> Result<Vec<u8>, String> {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if value["type"] == "Buffer" {
            return value["data"]
                .as_array()
                .ok_or("signed_out")?
                .iter()
                .map(|v| {
                    v.as_u64()
                        .and_then(|n| u8::try_from(n).ok())
                        .ok_or_else(|| "signed_out".into())
                })
                .collect();
        }
    }
    STANDARD.decode(raw).map_err(|_| "signed_out".into())
}
fn devin_desktop(dir: &Path) -> Login {
    let db = database(dir)?;
    let get = |key: &str| {
        db.query_row("SELECT value FROM ItemTable WHERE key=?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|_| "signed_out".to_string())
    };
    let cipher = vault::cipher_with_name(dir, "Devin")?;
    let decode = |raw: &str| {
        String::from_utf8(vault::decrypt_bytes(&cipher, &buffer(raw)?)?)
            .map_err(|_| "signed_out".to_string())
    };
    let sessions: Value = serde_json::from_str(&decode(&get(
        "secret://{\"extensionId\":\"codeium.windsurf\",\"key\":\"windsurf_auth.sessions\"}",
    )?)?)
    .map_err(|_| "signed_out")?;
    let status: Value =
        serde_json::from_str(&get("windsurfAuthStatus")?).map_err(|_| "signed_out")?;
    let server = get(
        "secret://{\"extensionId\":\"codeium.windsurf\",\"key\":\"windsurf_auth.apiServerUrl\"}",
    )
    .ok()
    .map(|v| decode(&v))
    .transpose()?
    .unwrap_or_else(|| DEVIN_SERVER.into());
    devin_snapshot(&sessions, &status, &server)
}
fn devin_snapshot(sessions: &Value, status: &Value, server: &str) -> Login {
    let token = text(status, "apiKey")?;
    let session = sessions
        .as_array()
        .ok_or("signed_out")?
        .iter()
        .find(|s| s["accessToken"].as_str() == Some(token))
        .ok_or("signed_out")?;
    not_expired(&session["expiresAt"])?;
    let user = if let Some(raw) = status["userStatusJson"].as_str() {
        serde_json::from_str(raw).map_err(|_| "signed_out")?
    } else {
        let bytes = STANDARD
            .decode(text(status, "userStatusProtoBinaryBase64")?)
            .map_err(|_| "signed_out")?;
        let fields = wire::fields(&bytes).map_err(|_| "signed_out")?;
        json!({"userId":wire::string(&fields,36)})
    };
    devin_value(token, server, text(&user, "userId")?)
}
fn devin_value(token: &str, server: &str, user: &str) -> Login {
    if !token.starts_with("devin-session-token$")
        || token.len() <= 20
        || server.trim_end_matches('/') != DEVIN_SERVER
    {
        return Err("signed_out".into());
    }
    Ok((
        user.into(),
        json!({"accessToken":token,"baseUrl":DEVIN_SERVER,"userId":user}),
    ))
}
fn devin_cli_path(home: &Path, config: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let _ = home;
        config.join("devin/credentials.toml")
    }
    #[cfg(not(windows))]
    {
        let _ = config;
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("devin/credentials.toml")
    }
}
fn devin_cli(path: &Path) -> Login {
    let raw = std::fs::read_to_string(path).map_err(|_| "signed_out")?;
    let doc: toml::Value = toml::from_str(&raw).map_err(|_| "signed_out")?;
    let token = doc
        .get("windsurf_api_key")
        .and_then(|v| v.as_str())
        .ok_or("signed_out")?;
    let server = doc
        .get("api_server_url")
        .and_then(|v| v.as_str())
        .unwrap_or(DEVIN_SERVER);
    let user = doc.get("user_id").and_then(|v| v.as_str()).unwrap_or("");
    devin_value(token, server, user)
}

fn codearts(dir: &Path) -> Login {
    let path = dir.join("secretStorage").join(format!(
        "{:x}.enc",
        Sha256::digest(b"authSession:cn-north-4")
    ));
    let raw = std::fs::read_to_string(path).map_err(|_| "signed_out")?;
    let cipher = vault::cipher_with_name(dir, "codearts")?;
    let native: Value =
        serde_json::from_str(&vault::decrypt(&cipher, raw.trim())?).map_err(|_| "signed_out")?;
    codearts_value(&native)
}
fn codearts_value(native: &Value) -> Login {
    let session = &native["session"];
    if session.get("clientId").is_some_and(|v| v != "codearts") {
        return Err("signed_out".into());
    }
    let user = text(session, "userId")?.to_string();
    not_expired(&session["expiresAt"])?;
    Ok((
        user,
        json!({"accessKey":text(session,"accessKey")?,"secretKey":text(session,"secretKey")?,"securityToken":text(session,"securityToken")?,"expiresAt":session["expiresAt"],"toolId":"codearts"}),
    ))
}

fn trae(provider: &str, config: &Path) -> Login {
    let names: &[&str] = match (std::env::consts::OS, provider) {
        ("linux", "trae") => &["trae", "Trae"],
        ("linux", "traecn") => &["trae-cn", "Trae CN"],
        ("windows", "traecn") => &["Trae CN", "trae-cn"],
        (_, "traecn") => &["Trae CN"],
        _ => &["Trae"],
    };
    let path = names
        .iter()
        .map(|name| config.join(name).join("User/globalStorage/storage.json"))
        .find(|p| p.is_file())
        .ok_or("signed_out")?;
    trae_value(provider, &json_file(&path)?, &version(provider))
}
fn trae_decode(value: &Value) -> Result<Value, String> {
    if value.is_object() {
        return Ok(value.clone());
    }
    let raw = value.as_str().ok_or("signed_out")?.trim();
    if raw.starts_with('{') {
        return serde_json::from_str(raw).map_err(|_| "signed_out".into());
    }
    let bytes = STANDARD.decode(raw).map_err(|_| "signed_out")?;
    if bytes.len() < 118 || (bytes.len() - 38) % 16 != 0 {
        return Err("signed_out".into());
    }
    let salt=match &bytes[..6]{[116,99,5,16,0,0]=>"4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58",[18,57,32,32,2,3]=>"490cc21292b05d0cc06ccbe91fb92e21b5a7c538811dc85e27a96e28104e1cf69c7166efab232807390da78a8b91e49c44b49a43feb941a1e46f2656e613e47b",_=>return Err("signed_out".into())};
    let mut digest = Sha512::new();
    digest.update(Sha512::digest(&bytes[6..38]));
    digest.update(hex::decode(salt).map_err(|_| "signed_out")?);
    let key = digest.finalize();
    let plain = cbc::Decryptor::<Aes128>::new_from_slices(&key[..16], &key[16..32])
        .map_err(|_| "signed_out")?
        .decrypt_padded_vec_mut::<Pkcs7>(&bytes[38..])
        .map_err(|_| "signed_out")?;
    if plain.len() < 64 || Sha512::digest(&plain[64..]).as_slice() != &plain[..64] {
        return Err("signed_out".into());
    }
    serde_json::from_slice(&plain[64..]).map_err(|_| "signed_out".into())
}
fn trae_value(provider: &str, root: &Value, app_version: &str) -> Login {
    let auth = trae_decode(
        root.get("iCubeAuthInfo://icube.cloudide")
            .ok_or("signed_out")?,
    )?;
    let token = auth["token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| auth["accessToken"].as_str())
        .ok_or("signed_out")?;
    not_expired(&auth["expiredAt"])?;
    let user = text(&auth, "userId")?.to_string();
    let region = auth["userRegion"]["region"]
        .as_str()
        .or_else(|| auth["userRegion"].as_str())
        .map(|s| s.to_ascii_uppercase())
        .or_else(|| {
            let host = auth["host"]
                .as_str()
                .or_else(|| auth["loginHost"].as_str())?;
            let url = url::Url::parse(host).ok()?;
            let host = url.host_str()?;
            if host == "trae.cn" || host.ends_with(".trae.cn") || host.ends_with(".trae.com.cn") {
                Some("CN".into())
            } else if host.ends_with(".traeapi.us") {
                Some("USTTP".into())
            } else if host == "growva-normal.trae.ai" {
                Some("US".into())
            } else if host == "trae.ai" || host.ends_with(".trae.ai") {
                Some("SG".into())
            } else {
                None
            }
        })
        .ok_or("signed_out")?;
    if (provider == "traecn" && region != "CN")
        || (provider == "trae" && !matches!(region.as_str(), "SG" | "US" | "USTTP" | "AI"))
    {
        return Err("signed_out".into());
    }
    let devices: Vec<_> = root
        .as_object()
        .ok_or("signed_out")?
        .keys()
        .filter_map(|k| k.strip_prefix("iCubeAuthInfo://icube-dc:"))
        .collect();
    if devices.len() != 1 || devices[0].is_empty() {
        return Err("signed_out".into());
    }
    let mut value = json!({"accessToken":token,"userId":user,"deviceId":devices[0],"machineId":text(root,"telemetry.machineId")?,"appVersion":app_version,"region":region,"edition":provider});
    if provider == "trae" {
        for (from, to) in [("storeRegion", "storeRegion"), ("scope", "accountScope")] {
            if let Some(raw) = auth["account"][from]
                .as_str()
                .filter(|s| !s.trim().is_empty())
            {
                value[to] = if from == "storeRegion" {
                    json!(raw.to_ascii_uppercase())
                } else {
                    json!(raw)
                };
            }
        }
    }
    Ok((user, value))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn jwt(user: &str, exp: i64) -> String {
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(json!({"sub":user,"exp":exp}).to_string())
        )
    }
    #[test]
    fn missing_or_corrupt_native_files_never_create_a_login() {
        let temp = tempfile::tempdir().unwrap();
        for provider in ["grokbot", "codearts", "trae", "traecn", "unknown"] {
            assert!(read(provider, temp.path(), temp.path()).is_err());
        }
        assert!(devin_desktop(temp.path()).is_err());
        assert!(devin_cli(&temp.path().join("missing.toml")).is_err());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 0);
        for value in [json!(null), json!("invalid base64"), json!({"session":{}})] {
            assert!(codearts_value(&value).is_err());
        }
        assert!(buffer(r#"{"type":"Buffer","data":[256]}"#).is_err());
    }
    #[test]
    fn native_expiry_is_respected_without_refresh() {
        let identity = jwt("anti-user", 1);
        let mut anti = json!({"id_token":identity,"token":{"access_token":"fixture","expiry":"2099-01-01T00:00:00Z"},"project_id":"native-project"});
        let login = antigravity(&anti.to_string()).unwrap();
        assert_eq!(login.0, "anti-user");
        assert_eq!(login.1["projectId"], "native-project");
        anti["token"]["expiry"] = json!(1);
        assert!(antigravity(&anti.to_string()).is_err());
        let mut codearts = json!({"session":{"clientId":"codearts","userId":"ca-user","accessKey":"ak","secretKey":"sk","securityToken":"st","expiresAt":4102444800000_i64}});
        assert_eq!(codearts_value(&codearts).unwrap().0, "ca-user");
        codearts["session"]["clientId"] = json!("other");
        assert!(codearts_value(&codearts).is_err());
        codearts["session"]["clientId"] = json!("codearts");
        codearts["session"]["expiresAt"] = json!(1);
        assert!(codearts_value(&codearts).is_err());
    }
    #[test]
    fn grok_uses_only_the_explicitly_active_native_account() {
        let a = format!("{:x}", Sha256::digest(b"a"));
        let b = format!("{:x}", Sha256::digest(b"b"));
        let mut catalog = json!({"active":a,"accounts":{a.clone():{"cursor-access-token":jwt("a",i64::MAX),"cursor-selected-team-id":"17"},b.clone():{"cursor-access-token":jwt("b",i64::MAX)}}});
        let document = |catalog: &Value| json!({"cursor-accounts":catalog.to_string()});
        let login = grokbot_catalog(&document(&catalog), |s| Ok(s.into())).unwrap();
        assert_eq!(login.0, "a");
        assert_eq!(login.1["teamId"], 17);
        catalog["active"] = json!("missing");
        assert!(grokbot_catalog(&document(&catalog), |s| Ok(s.into())).is_err());
        catalog["active"] = json!(a);
        catalog["accounts"][&a]["cursor-access-token"] = json!(jwt("b", i64::MAX));
        assert!(grokbot_catalog(&document(&catalog), |s| Ok(s.into())).is_err());
        catalog["accounts"][&a]["cursor-access-token"] = json!(jwt("a", 1));
        assert!(grokbot_catalog(&document(&catalog), |s| Ok(s.into())).is_err());
    }
    #[test]
    fn devin_status_matches_the_active_session_and_server_cannot_redirect_credentials() {
        let sessions = json!([{"accessToken":"devin-session-token$old"},{"accessToken":"devin-session-token$current"}]);
        let mut status = json!({"apiKey":"devin-session-token$current","userStatusJson":json!({"userId":"native-current"}).to_string()});
        assert_eq!(
            devin_snapshot(&sessions, &status, DEVIN_SERVER).unwrap().0,
            "native-current"
        );
        for server in [
            "http://server.codeium.com",
            "https://server.codeium.com.evil.test",
            "https://server.codeium.com@evil.test",
            "https://server.codeium.com/other",
            "https://server.codeium.com:443",
        ] {
            assert!(devin_snapshot(&sessions, &status, server).is_err());
        }
        status["apiKey"] = json!("devin-session-token$other");
        assert!(devin_snapshot(&sessions, &status, DEVIN_SERVER).is_err());
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("credentials.toml");
        let fixture="windsurf_api_key = 'devin-session-token$cli-only'\napi_server_url = 'https://server.codeium.com'\n";
        std::fs::write(&path, fixture).unwrap();
        let login = devin_cli(&path).unwrap();
        assert!(login.0.is_empty());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), fixture);
        std::fs::write(
            &path,
            fixture.replace("https://server.codeium.com", "https://evil.test"),
        )
        .unwrap();
        assert!(devin_cli(&path).is_err());
    }
    #[test]
    fn trae_encrypted_headers_and_integrity_are_compatible() {
        let expected = json!({"token":"fixture-token","userId":"fixture-user"});
        for raw in ["dGMFEAAAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh+mHR6KVq9kO86Yg2BmPFHhIE8YcHSn/Vx8TMpiF9AeQIsiBmlyhgcCMN4nc3DwGgfs+D2fEP+I0M7QTaC3xcbmg56ErhH2+y3mYTcUuyOJymZC5NCkLdYtzZVa4cQQDF4yTGgLByRiX6sDHOcONkLspRYBvm9G6XkyqDNB+RXY+Q==","EjkgIAIDAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh9nvvStEisfKEJ7fVhP43eQAHKnAN6P/gUCOZMyoH4sq+OgeBeCanxnEpg9RTWgwoGK6kCYpmSr3Ee7uoHMKsldcAlfqpvwpyWUubfHv7kbqU+X1AO+xo4ELe/Gh7giPI/cxJMHMhGUFc6kCoF5edviOxr+M9r4OziSrEFDtfJDpA=="] {
            assert_eq!(trae_decode(&json!(raw)).unwrap(),expected);
            let mut bytes=STANDARD.decode(raw).unwrap();bytes[70]^=1;assert!(trae_decode(&json!(STANDARD.encode(bytes))).is_err());
        }
    }
    #[test]
    fn trae_regions_devices_and_expiry_are_isolated() {
        let mut root = json!({"iCubeAuthInfo://icube.cloudide":{"token":"fixture","userId":"native","userRegion":{"region":"SG"},"expiredAt":4102444800_i64,"account":{"storeRegion":"us","scope":"marscode"}},"iCubeAuthInfo://icube-dc:device":{},"telemetry.machineId":"machine"});
        let login = trae_value("trae", &root, "1.0").unwrap();
        assert_eq!(login.1["storeRegion"], "US");
        assert_eq!(login.1["accountScope"], "marscode");
        assert!(trae_value("traecn", &root, "1.0").is_err());
        root["iCubeAuthInfo://icube.cloudide"]["userRegion"] = json!("CN");
        assert!(trae_value("trae", &root, "1.0").is_err());
        assert!(trae_value("traecn", &root, "1.0").is_ok());
        root["iCubeAuthInfo://icube.cloudide"]["expiredAt"] = json!(1);
        assert!(trae_value("traecn", &root, "1.0").is_err());
        root["iCubeAuthInfo://icube.cloudide"]["expiredAt"] = json!(4102444800_i64);
        root["iCubeAuthInfo://icube-dc:other"] = json!({});
        assert!(trae_value("traecn", &root, "1.0").is_err());
    }
}
