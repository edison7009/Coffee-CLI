use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
pub(crate) fn signed_headers(
    method: &str,
    url: &str,
    credentials: &Value,
    body: &str,
    headers: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    signed_headers_at(
        method,
        url,
        credentials,
        body,
        headers,
        &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string(),
    )
}
fn encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(encoded, "%{byte:02X}").expect("string formatting");
        }
    }
    encoded
}
fn signed_headers_at(
    method: &str,
    url: &str,
    credentials: &Value,
    body: &str,
    headers: BTreeMap<String, String>,
    date: &str,
) -> Result<BTreeMap<String, String>, String> {
    let field = |name| {
        credentials[name]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "accountError.loginRequired".to_string())
    };
    let access_key = field("accessKey")?;
    let secret_key = field("secretKey")?;
    let token = field("securityToken")?;
    let url = url::Url::parse(url).map_err(|_| "accountError.format")?;
    let mut headers: BTreeMap<_, _> = headers
        .into_iter()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("authorization"))
        .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    headers.insert(
        "host".into(),
        url[url::Position::BeforeHost..url::Position::AfterPort].into(),
    );
    headers.insert("x-security-token".into(), token.into());
    headers.insert("x-sdk-date".into(), date.into());
    let mut uri = url
        .path()
        .split('/')
        .map(encode)
        .collect::<Vec<_>>()
        .join("/");
    if !uri.ends_with('/') {
        uri.push('/');
    }
    let mut query = url
        .query_pairs()
        .map(|(key, value)| format!("{}={}", encode(&key), encode(&value)))
        .collect::<Vec<_>>();
    query.sort();
    let canonical_headers = headers
        .iter()
        .map(|(key, value)| format!("{key}:{value}\n"))
        .collect::<String>();
    let signed = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let body_hash = headers
        .get("x-sdk-content-sha256")
        .cloned()
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(body)));
    let canonical = [
        method.to_uppercase(),
        uri,
        query.join("&"),
        canonical_headers,
        signed.clone(),
        body_hash,
    ]
    .join("\n");
    let to_sign = format!("SDK-HMAC-SHA256\n{date}\n{:x}", Sha256::digest(canonical));
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret_key.as_bytes()).expect("HMAC accepts any key length");
    mac.update(to_sign.as_bytes());
    let signature = format!("{:x}", mac.finalize().into_bytes());
    headers.insert(
        "authorization".into(),
        format!(
            "SDK-HMAC-SHA256 Access={access_key}, SignedHeaders={signed}, Signature={signature}"
        ),
    );
    Ok(headers)
}
