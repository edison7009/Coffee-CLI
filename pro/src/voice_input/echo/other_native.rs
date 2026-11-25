//! Active native MiniMax, DuMate and Kilo sessions. No EchoBird stores or credential writes.
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}
fn read_json(path: &Path) -> Result<Value, String> {
    super::accounts::read_json(path)
}
fn claims(token: &str, now: i64) -> Result<Value, String> {
    let encoded = token.split('.').nth(1).ok_or("signed_out")?;
    let value: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_| "signed_out")?)
            .map_err(|_| "signed_out")?;
    if value["exp"].as_i64().is_none_or(|expiry| expiry <= now) {
        return Err("signed_out".into());
    }
    Ok(value)
}
fn absolute(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("signed_out".into())
    }
}

pub(super) fn read(provider: &str, home: &Path, config: &Path) -> Result<(String, Value), String> {
    match provider {
        "minimax:cn" => minimax(home, config, "cn"),
        "minimax:global" => minimax(home, config, "global"),
        "dumate" => dumate(&config.join("qianfan-desktop-app")),
        "kilo" => {
            let root = std::env::var_os("XDG_DATA_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".local/share"));
            kilo(&absolute(root)?.join("kilo/auth.json"))
        }
        _ => Err("signed_out".into()),
    }
}

fn minimax(home: &Path, config: &Path, region: &str) -> Result<(String, Value), String> {
    let override_dir = ["MINIMAX_DATA_DIR", "MAVIS_DATA_DIR"]
        .iter()
        .find_map(|key| std::env::var_os(key).filter(|v| !v.to_string_lossy().trim().is_empty()))
        .map(PathBuf::from);
    let mut homes = if let Some(root) = override_dir {
        vec![absolute(root)?]
    } else {
        let mut roots = vec![home.join(".minimax")];
        let (app, file) = if region == "cn" {
            ("MiniMax", "minimax-agent-cn-config.json")
        } else {
            ("MiniMax Agent", "minimax-agent-config.json")
        };
        let settings = config.join(app).join(file);
        if settings.is_file() {
            let value = read_json(&settings)?;
            if let Some(parent) = value["config"]
                .get("localRuntimeDataParentDir")
                .filter(|v| !v.is_null())
            {
                let parent = parent.as_str().ok_or("signed_out")?.trim();
                if !parent.is_empty() {
                    roots.push(absolute(Path::new(parent).join(".minimax"))?);
                }
            }
        }
        roots
    };
    homes.dedup();
    let now = chrono::Utc::now().timestamp_millis();
    homes
        .iter()
        .filter_map(|root| minimax_at(root, region, now).ok())
        .max_by_key(|(_, _, expiry)| *expiry)
        .map(|(id, c, _)| (id, c))
        .ok_or("signed_out".into())
}

fn minimax_at(root: &Path, region: &str, now_ms: i64) -> Result<(String, Value, i64), String> {
    let native_region = if region == "cn" { "cn" } else { "en" };
    let auth = root.join("auth");
    let namespace = auth.join("prod").join(native_region).join("mcode-public");
    let state = read_json(&namespace.join("auth-state.json"))?;
    if state["status"] != "authenticated"
        || state["storeKind"] != "file"
        || state["region"] != native_region
        || state["buildEnv"] != "prod"
    {
        return Err("signed_out".into());
    }
    let value = read_json(&namespace.join("auth.json"))?;
    let account_key = URL_SAFE_NO_PAD.encode(Sha256::digest(
        format!("{}\0mcode-public", auth.display()).as_bytes(),
    ));
    let key = format!("com.minimax.mcode.oauth.prod.{native_region}\0{account_key}");
    let record = &value["records"][key];
    let expiry = record["expiresAtMs"]
        .as_i64()
        .filter(|expiry| *expiry > now_ms)
        .ok_or("signed_out")?;
    if state["expiresAtMs"]
        .as_i64()
        .is_none_or(|expiry| expiry <= now_ms)
        || record["generation"].as_u64().is_none()
        || record["generation"].as_u64() != state["generation"].as_u64()
        || record["clientId"] != "mcode-public"
        || record["audience"] != "agent-backend"
    {
        return Err("signed_out".into());
    }
    let token = text(record, "accessToken").ok_or("signed_out")?;
    if !token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("signed_out".into());
    }
    // Native MiniMax leases may carry opaque access tokens. The record/state lease
    // establishes expiry; JWT metadata is optional and never invented for display.
    let jwt = token
        .split('.')
        .nth(1)
        .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(Value::Null);
    if jwt["exp"]
        .as_f64()
        .is_some_and(|expiry| expiry <= now_ms as f64 / 1000.0)
    {
        return Err("signed_out".into());
    }
    let user = text(&jwt, "sub")
        .or_else(|| text(record, "subject"))
        .or_else(|| text(record, "accountId"))
        .unwrap_or("");
    Ok((
        user.into(),
        json!({"accessToken":token,"region":region}),
        expiry,
    ))
}

fn kilo(path: &Path) -> Result<(String, Value), String> {
    let value = read_json(path)?;
    let auth = &value["kilo"];
    let now = chrono::Utc::now().timestamp_millis();
    if auth["expires"].as_i64().is_some_and(|expiry| expiry <= now) {
        return Err("signed_out".into());
    }
    let token = text(auth, "access")
        .or_else(|| text(auth, "key"))
        .ok_or("signed_out")?;
    let jwt = claims(token, now / 1000)?;
    let user = text(&jwt, "kiloUserId")
        .or_else(|| text(&jwt, "sub"))
        .ok_or("signed_out")?;
    Ok((
        user.into(),
        json!({"accessToken":token,"organizationId":text(auth,"accountId")}),
    ))
}

fn dumate(root: &Path) -> Result<(String, Value), String> {
    let value = read_json(&root.join("auth.json"))?;
    let active = text(&value, "activeProfileId").ok_or("signed_out")?;
    let profile = value["accountProfiles"]
        .as_array()
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|p| p["profileId"].as_str() == Some(active))
        })
        .ok_or("signed_out")?;
    if profile["loginType"] != "bce" {
        return Err("signed_out".into());
    }
    let user = text(profile, "bceUserId").ok_or("signed_out")?;
    text(profile, "bceAccountId").ok_or("signed_out")?;
    let encrypted = text(&value, "cookies")
        .or_else(|| text(profile, "encryptedCookies"))
        .ok_or("signed_out")?;
    let key = std::fs::read(root.join(".cookie-key")).map_err(|_| "signed_out")?;
    let cookies = decrypt_cookies(encrypted, &key)?;
    let credential = json!({"profile":profile,"cookies":cookies});
    cookie_headers(
        &credential,
        &url::Url::parse("https://console.bce.baidu.com/api/dumate/app/token/get").unwrap(),
        chrono::Utc::now().timestamp() as f64,
    )?;
    Ok((user.into(), credential))
}

fn decrypt_cookies(encoded: &str, key: &[u8]) -> Result<Value, String> {
    let raw = STANDARD.decode(encoded).map_err(|_| "signed_out")?;
    if raw.len() < 28 {
        return Err("signed_out".into());
    }
    let mut payload = raw[28..].to_vec();
    payload.extend_from_slice(&raw[12..28]);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "signed_out")?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&raw[..12]), payload.as_slice())
        .map_err(|_| "signed_out")?;
    let value: Value = serde_json::from_slice(&plain).map_err(|_| "signed_out")?;
    if !value.is_array() {
        return Err("signed_out".into());
    }
    Ok(value)
}

fn cookie_headers(c: &Value, url: &url::Url, now: f64) -> Result<(String, Option<String>), String> {
    let allowed = url.scheme() == "https" && url.host_str() == Some("console.bce.baidu.com");
    #[cfg(test)]
    let allowed = allowed || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1"));
    if !allowed {
        return Err("signed_out".into());
    }
    let host = url.host_str().ok_or("signed_out")?;
    let mut cookies = Vec::new();
    let mut csrf = None;
    for cookie in c["cookies"].as_array().ok_or("signed_out")? {
        let (Some(name), Some(value), Some(domain)) = (
            text(cookie, "name"),
            cookie["value"].as_str(),
            text(cookie, "domain"),
        ) else {
            continue;
        };
        let domain = domain.trim_start_matches('.');
        if !(host == domain
            || (cookie["hostOnly"] != true && host.ends_with(&format!(".{domain}"))))
            || cookie["expirationDate"]
                .as_f64()
                .is_some_and(|expiry| expiry <= now)
            || (cookie["secure"] == true && url.scheme() != "https")
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
            || value.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0))
            || !url
                .path()
                .starts_with(cookie["path"].as_str().unwrap_or("/"))
        {
            continue;
        }
        let value = value.trim_matches(['"', '\'']);
        if name == "bce-user-info" {
            csrf = Some(value.into());
        }
        let value = if value.bytes().any(|b| b" :|;=\t".contains(&b)) {
            format!("\"{value}\"")
        } else {
            value.into()
        };
        cookies.push(format!("{name}={value}"));
    }
    if cookies.is_empty() {
        return Err("signed_out".into());
    }
    Ok((cookies.join("; "), csrf))
}

async fn dumate_get(
    client: &reqwest::Client,
    c: &Value,
    path: &str,
    desktop: bool,
) -> Result<Value, String> {
    let base = "https://console.bce.baidu.com";
    #[cfg(test)]
    let base = c["_voice_test_endpoint"].as_str().unwrap_or(base);
    let url = url::Url::parse(&format!("{base}{path}")).map_err(|_| "speech_failed")?;
    let (cookie, csrf) = cookie_headers(c, &url, chrono::Utc::now().timestamp() as f64)?;
    let mut request = client
        .get(url)
        .timeout(std::time::Duration::from_secs(20))
        .header("Cookie", cookie)
        .header("Accept", "application/json")
        .header(
            "X-Dumate-Client-Type",
            if desktop { "desktop" } else { "web" },
        )
        .header("Origin", base)
        .header(
            "Referer",
            format!("{base}/{}", if desktop { "" } else { "app" }),
        );
    if let Some(csrf) = csrf {
        request = request.header("csrftoken", csrf);
    }
    if desktop {
        request = request
            .header("Content-Type", "application/json")
            .header("X-Requested-With", "XMLHttpRequest");
        if let Some(version) = super::accounts::app_metadata("dumate")
            .and_then(|v| text(&v, "version").map(str::to_owned))
        {
            request = request.header("dumate-version", version);
        }
    }
    let response = request.send().await.map_err(|_| "speech_failed")?;
    if !response.status().is_success() {
        return Err(format!("http_{}", response.status().as_u16()));
    }
    let value: Value = response.json().await.map_err(|_| "speech_failed")?;
    if matches!(value["code"].as_i64(), Some(10001 | 10006)) {
        return Err("signed_out".into());
    }
    if value["code"] != 0 || value["success"] == false {
        return Err("speech_failed".into());
    }
    value.get("result").cloned().ok_or("speech_failed".into())
}

pub(super) async fn dumate_credentials(
    client: &reqwest::Client,
    c: &Value,
) -> Result<Value, String> {
    let profile = &c["profile"];
    if profile["loginType"] != "bce" {
        return Err("signed_out".into());
    }
    let account = text(profile, "bceAccountId").ok_or("signed_out")?;
    let token = dumate_get(client, c, "/api/dumate/app/token/get", false).await?;
    let access = text(&token, "token").ok_or("speech_failed")?;
    let expiry = text(&token, "expired_at")
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .ok_or("speech_failed")?;
    if expiry.timestamp() <= chrono::Utc::now().timestamp() {
        return Err("signed_out".into());
    }
    let session = dumate_get(client, c, "/api/dumate/system/sessionToken", true).await?;
    for name in ["accessKeyId", "secretAccessKey", "sessionToken"] {
        text(&session, name).ok_or("speech_failed")?;
    }
    Ok(json!({"accessToken":access,"bceAccountId":account,"bosSession":session}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn write(path: &Path, value: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn jwt(value: Value) -> String {
        format!(
            "e30.{}.fixture",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
        )
    }
    fn minimax_fixture(root: &Path, region: &str, expiry: i64) -> PathBuf {
        let auth = root.join("auth");
        let dir = auth.join("prod").join(region).join("mcode-public");
        let key = format!(
            "com.minimax.mcode.oauth.prod.{region}\0{}",
            URL_SAFE_NO_PAD.encode(Sha256::digest(
                format!("{}\0mcode-public", auth.display()).as_bytes()
            ))
        );
        let token = jwt(json!({"sub":"native-user","exp":expiry/1000}));
        write(
            &dir.join("auth.json"),
            &json!({"schemaVersion":1,"records":{key:{"accessToken":token,"expiresAtMs":expiry,"generation":3,"clientId":"mcode-public","audience":"agent-backend"}}}),
        );
        write(
            &dir.join("auth-state.json"),
            &json!({"status":"authenticated","storeKind":"file","region":region,"buildEnv":"prod","generation":3,"expiresAtMs":expiry}),
        );
        dir
    }
    #[test]
    fn minimax_uses_current_namespaced_state_and_rejects_expired_or_signed_out() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("missing");
        assert!(minimax_at(&root, "cn", 1000).is_err());
        assert!(!root.exists());
        let dir = minimax_fixture(&root, "cn", 3000);
        let (id, c, _) = minimax_at(&root, "cn", 1000).unwrap();
        assert_eq!(id, "native-user");
        assert_eq!(c["region"], "cn");
        assert!(minimax_at(&root, "global", 1000).is_err());
        assert!(minimax_at(&root, "cn", 3000).is_err());
        let mut state = read_json(&dir.join("auth-state.json")).unwrap();
        state["status"] = json!("unauthenticated");
        write(&dir.join("auth-state.json"), &state);
        assert!(minimax_at(&root, "cn", 1000).is_err());
        state["status"] = json!("authenticated");
        state["generation"] = json!(4);
        write(&dir.join("auth-state.json"), &state);
        assert!(minimax_at(&root, "cn", 1000).is_err());
        std::fs::write(dir.join("auth.json"), "{").unwrap();
        assert!(minimax_at(&root, "cn", 1000).is_err());
    }
    #[test]
    fn minimax_opaque_native_leases_do_not_require_a_jwt_or_invent_an_identity() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("native");
        let dir = minimax_fixture(&root, "cn", 3000);
        let path = dir.join("auth.json");
        let mut value = read_json(&path).unwrap();
        let record = value["records"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        record["accessToken"] = json!("opaque-native-fixture");
        write(&path, &value);
        let (id, credential, _) = minimax_at(&root, "cn", 1000).unwrap();
        assert!(id.is_empty());
        assert_eq!(credential["accessToken"], "opaque-native-fixture");
        assert_eq!(credential["region"], "cn");
        assert!(minimax_at(&root, "global", 1000).is_err());
        assert!(minimax_at(&root, "cn", 3000).is_err());
        let record = value["records"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        record["subject"] = json!("native-record-subject");
        write(&path, &value);
        assert_eq!(
            minimax_at(&root, "cn", 1000).unwrap().0,
            "native-record-subject"
        );
        let record = value["records"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        record["accessToken"] = json!(jwt(json!({"sub":"expired-jwt","exp":1})));
        write(&path, &value);
        assert!(minimax_at(&root, "cn", 2000).is_err());
    }
    #[test]
    fn kilo_reads_native_user_id_and_rejects_expired_auth_without_creating_files() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("kilo/auth.json");
        assert!(kilo(&path).is_err());
        assert!(!path.parent().unwrap().exists());
        let expiry = chrono::Utc::now().timestamp_millis() + 60000;
        write(
            &path,
            &json!({"kilo":{"access":jwt(json!({"kiloUserId":"real-native-id","exp":expiry/1000})),"expires":expiry,"accountId":"org-fixture"}}),
        );
        let (id, c) = kilo(&path).unwrap();
        assert_eq!(id, "real-native-id");
        assert_eq!(c["organizationId"], "org-fixture");
        assert!(c.get("model").is_none());
        let mut value = read_json(&path).unwrap();
        value["kilo"]["expires"] = json!(1);
        write(&path, &value);
        assert!(kilo(&path).is_err());
        std::fs::write(&path, "{").unwrap();
        assert!(kilo(&path).is_err());
    }
    fn encrypt_cookies(cookies: &Value, key: &[u8]) -> String {
        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let nonce = [7; 12];
        let data = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                serde_json::to_vec(cookies).unwrap().as_slice(),
            )
            .unwrap();
        let tag = data.len() - 16;
        let mut raw = nonce.to_vec();
        raw.extend_from_slice(&data[tag..]);
        raw.extend_from_slice(&data[..tag]);
        STANDARD.encode(raw)
    }
    fn profile() -> Value {
        json!({"profileId":"active","loginType":"bce","bceUserId":"native-id","bceAccountId":"account-fixture"})
    }
    #[test]
    fn dumate_active_profile_cipher_and_cookie_scopes_are_preserved() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("dumate");
        assert!(dumate(&root).is_err());
        assert!(!root.exists());
        let cookies = json!([
            {"name":"BDUSS","value":"fixture","domain":".baidu.com","path":"/","secure":true},
            {"name":"bce-user-info","value":"csrf-fixture","domain":"console.bce.baidu.com","hostOnly":true,"path":"/api/dumate"},
            {"name":"wrong-host","value":"never","domain":"attacker.invalid","path":"/"},
            {"name":"expired","value":"never","domain":".baidu.com","path":"/","expirationDate":1},
            {"name":"wrong-path","value":"never","domain":".baidu.com","path":"/unrelated"},
            {"name":"bad-value","value":"no\r\nheader","domain":".baidu.com","path":"/"}
        ]);
        let key = [9; 32];
        write(
            &root.join("auth.json"),
            &json!({"activeProfileId":"active","accountProfiles":[profile(),{"profileId":"inactive","loginType":"enterprise"}],"cookies":encrypt_cookies(&cookies,&key)}),
        );
        std::fs::write(root.join(".cookie-key"), key).unwrap();
        let (id, c) = dumate(&root).unwrap();
        assert_eq!(id, "native-id");
        let url = url::Url::parse("https://console.bce.baidu.com/api/dumate/system/sessionToken")
            .unwrap();
        let (header, csrf) =
            cookie_headers(&c, &url, chrono::Utc::now().timestamp() as f64).unwrap();
        assert_eq!(header, "BDUSS=fixture; bce-user-info=csrf-fixture");
        assert_eq!(csrf.as_deref(), Some("csrf-fixture"));
        assert!(cookie_headers(
            &c,
            &url::Url::parse("https://attacker.invalid/api").unwrap(),
            2.0
        )
        .is_err());
        let mut auth = read_json(&root.join("auth.json")).unwrap();
        auth["activeProfileId"] = json!("inactive");
        write(&root.join("auth.json"), &auth);
        assert!(dumate(&root).is_err());
        assert!(decrypt_cookies("invalid", &key).is_err());
        let raw = encrypt_cookies(&cookies, &key);
        assert!(decrypt_cookies(&raw, &[8; 32]).is_err());
    }
    #[tokio::test]
    async fn dumate_exchanges_only_on_use_and_keeps_cookies_out_of_speech_credentials() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for desktop in [false, true] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut b = [0; 1024];
                    let n = socket.read(&mut b).await.unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&b[..n]);
                    if request.windows(4).any(|s| s == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.contains("cookie: bduss=fixture; bce-user-info=csrf-fixture"));
                assert!(request.contains("csrftoken: csrf-fixture"));
                assert!(!request.contains("authorization:"));
                let result = if desktop {
                    assert!(request.starts_with("get /api/dumate/system/sessiontoken "));
                    assert!(request.contains("x-dumate-client-type: desktop"));
                    assert!(request.contains("x-requested-with: xmlhttprequest"));
                    json!({"accessKeyId":"fixture-ak","secretAccessKey":"fixture-sk","sessionToken":"fixture-session"})
                } else {
                    assert!(request.starts_with("get /api/dumate/app/token/get "));
                    assert!(request.contains("x-dumate-client-type: web"));
                    json!({"token":"gateway-fixture","expired_at":(chrono::Utc::now()+chrono::Duration::minutes(10)).to_rfc3339()})
                };
                let body = json!({"code":0,"result":result}).to_string();
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let c = json!({"profile":profile(),"cookies":[{"name":"BDUSS","value":"fixture","domain":"127.0.0.1","path":"/"},{"name":"bce-user-info","value":"csrf-fixture","domain":"127.0.0.1","path":"/"}],"_voice_test_endpoint":base});
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let prepared = dumate_credentials(&client, &c).await.unwrap();
        server.await.unwrap();
        assert_eq!(prepared["accessToken"], "gateway-fixture");
        assert_eq!(prepared["bceAccountId"], "account-fixture");
        assert_eq!(prepared["bosSession"]["secretAccessKey"], "fixture-sk");
        assert!(prepared.get("cookies").is_none());
        assert!(prepared.get("profile").is_none());
        let mut enterprise = c;
        enterprise["profile"]["loginType"] = json!("enterprise");
        assert!(dumate_credentials(&client, &enterprise).await.is_err());
    }
}
