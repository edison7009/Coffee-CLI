use super::{devin_protocol::Message, ProxyError};
use http::StatusCode;
use serde_json::Value;
use std::{sync::OnceLock, time::Duration};
pub(super) fn client() -> Result<&'static reqwest::Client, ProxyError> {
    static CLIENT: OnceLock<Result<reqwest::Client, &'static str>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .tcp_keepalive(Duration::from_secs(60))
                .build()
                .map_err(|_| "Devin HTTP client is unavailable")
        })
        .as_ref()
        .map_err(|e| ProxyError::upstream(*e))
}
pub(super) fn auth(c: &Value) -> Result<(&str, &str), ProxyError> {
    let key = c["accessToken"]
        .as_str()
        .filter(|s| s.starts_with("devin-session-token$"))
        .ok_or_else(|| {
            ProxyError::new(StatusCode::UNAUTHORIZED, "Devin account requires sign-in")
        })?;
    let server = c["baseUrl"]
        .as_str()
        .unwrap_or("https://server.codeium.com")
        .trim_end_matches('/');
    let url = url::Url::parse(server).map_err(|_| ProxyError::upstream("Invalid Devin server"))?;
    #[cfg(test)]
    if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") {
        return Ok((key, server));
    }
    if url.scheme() != "https"
        || url.host_str() != Some("server.codeium.com")
        || url.port().is_some()
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ProxyError::upstream("Invalid Devin server"));
    }
    Ok((key, server))
}
pub(super) fn metadata(key: &str) -> Vec<u8> {
    Message::default()
        .bytes(1, "devin-cli")
        .bytes(2, "3000.11.92")
        .bytes(3, key)
        .bytes(4, "en")
        .bytes(5, std::env::consts::OS)
        .bytes(7, "3000.11.92")
        .bytes(12, "chisel")
        .bytes(28, "chisel")
        .0
}
pub(super) fn error(status: StatusCode, payload: &[u8]) -> ProxyError {
    let v: Value = serde_json::from_slice(payload).unwrap_or(Value::Null);
    let v = v.get("error").unwrap_or(&v);
    let code = v["code"].as_str().unwrap_or("");
    let status = match code {
        "unauthenticated" => StatusCode::UNAUTHORIZED,
        "permission_denied" => StatusCode::FORBIDDEN,
        "resource_exhausted" => StatusCode::TOO_MANY_REQUESTS,
        "invalid_argument" | "out_of_range" => StatusCode::BAD_REQUEST,
        _ if status.is_redirection() => StatusCode::BAD_GATEWAY,
        _ if status.is_success() => StatusCode::BAD_GATEWAY,
        _ => status,
    };
    // Upstream payloads can include request details. Keep credentials out of errors.
    let message = match status {
        StatusCode::UNAUTHORIZED => "Devin sign-in has expired",
        StatusCode::FORBIDDEN => "Devin account cannot use this model",
        StatusCode::TOO_MANY_REQUESTS => "Devin usage limit reached",
        StatusCode::BAD_REQUEST => "Devin rejected the model or request parameters",
        StatusCode::PAYLOAD_TOO_LARGE => "Devin request is too large",
        _ => "Devin upstream request failed",
    };
    ProxyError::new(status, message)
}
