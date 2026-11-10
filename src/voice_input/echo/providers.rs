use super::ProxyError;
use http::StatusCode;
use serde_json::{json, Value};

// EchoBird's Antigravity discovery, without its chat/model routing or caches.
pub(super) async fn fetch_project(
    c: &Value,
    client: &reqwest::Client,
    _: bool,
) -> Result<(String, Option<String>), ProxyError> {
    let base = "https://daily-cloudcode-pa.googleapis.com";
    #[cfg(test)]
    let base = c["_voice_test_endpoint"].as_str().unwrap_or(base);
    let response = client
        .post(format!("{base}/v1internal:loadCodeAssist"))
        .bearer_auth(
            c["accessToken"]
                .as_str()
                .ok_or_else(|| ProxyError::new(StatusCode::UNAUTHORIZED, "Sign in required"))?,
        )
        .header(
            "user-agent",
            format!(
                "antigravity/hub/3.1.4 {} /{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        )
        .header("X-Goog-Api-Client", "gl-node/22.21.1")
        .json(&json!({"metadata":{"ideType":"ANTIGRAVITY"}}))
        .send()
        .await
        .map_err(ProxyError::upstream)?;
    if response.status() != StatusCode::OK {
        let status = if response.status().is_success() {
            StatusCode::BAD_GATEWAY
        } else {
            response.status()
        };
        let mut error = ProxyError::new(status, "Speech directory failed");
        error.retry_after = response.headers().get("retry-after").cloned();
        return Err(error);
    }
    let value: Value = response.json().await.map_err(ProxyError::upstream)?;
    if !value.is_object() {
        return Err(ProxyError::upstream("Invalid speech directory"));
    }
    let project = c["projectId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| value["cloudaicompanionProject"].as_str())
        .or_else(|| value["cloudaicompanionProject"]["id"].as_str())
        .unwrap_or("")
        .to_string();
    let tier = value["paidTier"]["id"]
        .as_str()
        .filter(|s| !matches!(*s, "" | "free-tier" | "legacy-tier"))
        .or_else(|| value["currentTier"]["id"].as_str())
        .filter(|s| !matches!(*s, "" | "free-tier" | "legacy-tier"))
        .map(str::to_owned);
    Ok((project, tier))
}
