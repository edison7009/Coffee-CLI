use super::ProxyError;
use base64::{engine::general_purpose::STANDARD, Engine};
use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use http::{HeaderMap, HeaderValue};
use md5::{Digest, Md5};
use rsa::{pkcs8::DecodePublicKey, Pkcs1v15Encrypt, RsaPublicKey};
use serde_json::{json, Value};
const PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc\n4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l\n6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17\nXcW+ML9FoCI6AOvOzwIDAQAB\n-----END PUBLIC KEY-----";
fn text<'a>(c: &'a Value, key: &str) -> Result<&'a str, ProxyError> {
    c[key].as_str().filter(|s| !s.is_empty()).ok_or_else(|| {
        ProxyError::new(
            http::StatusCode::UNAUTHORIZED,
            "Qoder account credentials are incomplete",
        )
    })
}
pub(super) fn speech_headers(c: &Value, path: &str) -> Result<HeaderMap, ProxyError> {
    headers_with_versions(c, path, "", "1.0.0", text(c, "appVersion")?)
}
fn headers_with_versions(
    c: &Value,
    path: &str,
    body: &str,
    cosy_version: &str,
    ide_version: &str,
) -> Result<HeaderMap, ProxyError> {
    let user = text(c, "userId")?;
    let token = text(c, "accessToken")?;
    let machine = text(c, "machineId")?;
    let key = uuid::Uuid::new_v4().simple().to_string();
    let key = &key.as_bytes()[..16];
    let blob=json!({"uid":user,"aid":"","name":c["name"].as_str().unwrap_or(""),"email":c["email"].as_str().unwrap_or(""),"security_oauth_token":token}).to_string();
    let info = STANDARD.encode(
        cbc::Encryptor::<aes::Aes128>::new_from_slices(key, key)
            .map_err(ProxyError::upstream)?
            .encrypt_padded_vec_mut::<Pkcs7>(blob.as_bytes()),
    );
    let rsa = RsaPublicKey::from_public_key_pem(PUBLIC_KEY).map_err(ProxyError::upstream)?;
    let wrapped = STANDARD.encode(
        rsa.encrypt(&mut rand::thread_rng(), Pkcs1v15Encrypt, key)
            .map_err(ProxyError::upstream)?,
    );
    let payload=STANDARD.encode(json!({"version":"v1","requestId":uuid::Uuid::new_v4().simple().to_string(),"info":info,"cosyVersion":cosy_version,"ideVersion":ide_version}).to_string());
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let path = path
        .split('?')
        .next()
        .unwrap_or(path)
        .strip_prefix("/algo")
        .unwrap_or(path.split('?').next().unwrap_or(path));
    let signature = format!(
        "{:x}",
        Md5::digest(format!("{payload}\n{wrapped}\n{timestamp}\n{body}\n{path}"))
    );
    let authorization = format!("Bearer COSY.{payload}.{signature}");
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        os => os,
    };
    let architecture = std::env::consts::ARCH;
    let machine_os = format!("{architecture}_{os}");
    let mut headers = HeaderMap::new();
    for (key, value) in [
        ("accept", "application/json"),
        ("accept-encoding", "identity"),
        ("content-type", "application/json"),
        ("authorization", authorization.as_str()),
        ("cosy-business-product", "app"),
        ("cosy-business-type", "agent"),
        ("cosy-clientip", machine),
        ("cosy-clienttype", "10"),
        ("cosy-data-policy", "disagree"),
        ("cosy-date", timestamp.as_str()),
        ("cosy-key", wrapped.as_str()),
        ("cosy-machineid", machine),
        ("cosy-machinetoken", machine),
        ("cosy-machinetype", "5"),
        ("cosy-machineos", machine_os.as_str()),
        ("cosy-scene", "app"),
        ("cosy-user", user),
        ("cosy-version", cosy_version),
        ("login-version", "v2"),
    ] {
        headers.insert(
            key,
            HeaderValue::from_str(value).map_err(|_| {
                ProxyError::new(
                    http::StatusCode::UNAUTHORIZED,
                    "Qoder account identity contains invalid header data",
                )
            })?,
        );
    }
    Ok(headers)
}
