use http::{header, HeaderValue, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use super::super::{providers, ProxyError};

const ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";
const PATH: &str = "/v1internal:fetchAvailableModels";

#[derive(Deserialize)]
struct Catalog {
    #[serde(rename = "audioTranscriptionModelIds", default)]
    audio_transcription_model_ids: Vec<String>,
}

pub(crate) async fn first_model(
    client: &reqwest::Client,
    credentials: &Value,
) -> Result<String, ProxyError> {
    let token = credentials["accessToken"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(login_required)?;
    let authorization =
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| login_required())?;
    let version = app_version(credentials).await?;
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        value => value,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        value => value,
    };
    let user_agent = format!("antigravity/{version} (aidev_client; os_type={os}; arch={arch})");
    let endpoint = ENDPOINT;
    #[cfg(test)]
    let endpoint = credentials["_voice_test_endpoint"]
        .as_str()
        .unwrap_or(endpoint);
    let mut prepared = credentials.clone();
    if let Some(fields) = prepared.as_object_mut() {
        fields.remove("baseUrl");
        fields.remove("loadBaseUrl");
        fields.remove("headers");
        fields.insert("loadBaseUrl".into(), json!(endpoint));
    }
    let (project, tier) = providers::fetch_project(&prepared, client, false)
        .await
        .map_err(|error| {
            let mut sanitized =
                ProxyError::new(error.status, "Antigravity speech directory failed");
            sanitized.retry_after = error.retry_after;
            sanitized
        })?;
    let mut body = json!({});
    if !project.is_empty() {
        body["project"] = json!(project);
    }
    if let Some(tier) = tier {
        body["entitlement"] = json!({"userTier":tier});
    }
    let request = client
        .post(format!("{}{PATH}", endpoint.trim_end_matches('/')))
        .header(header::AUTHORIZATION, authorization)
        .header(header::USER_AGENT, user_agent)
        .json(&body)
        .timeout(Duration::from_secs(30));
    let response = request.send().await.map_err(request_error)?;
    if response.status() != StatusCode::OK {
        let status = if response.status().is_success() {
            StatusCode::BAD_GATEWAY
        } else {
            response.status()
        };
        let mut error = ProxyError::new(status, "Antigravity speech directory failed");
        error.retry_after = response.headers().get(header::RETRY_AFTER).cloned();
        return Err(error);
    }
    let catalog: Catalog = response.json().await.map_err(request_error)?;
    catalog
        .audio_transcription_model_ids
        .into_iter()
        .next()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            ProxyError::new(
                StatusCode::BAD_GATEWAY,
                "Antigravity has no available speech model",
            )
        })
}

fn valid_version(value: Option<&str>) -> Option<String> {
    let version = value?.trim();
    (!version.is_empty()
        && version.len() <= 96
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte)))
    .then(|| version.to_string())
}

async fn app_version(c: &Value) -> Result<String, ProxyError> {
    #[cfg(test)]
    if let Some(version) = c.get("_voice_test_app_version") {
        return valid_version(version.as_str()).ok_or_else(|| {
            ProxyError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Antigravity app version is unavailable",
            )
        });
    }
    valid_version(c["appVersion"].as_str()).ok_or_else(|| {
        ProxyError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Antigravity app version is unavailable",
        )
    })
}

fn login_required() -> ProxyError {
    ProxyError::new(StatusCode::UNAUTHORIZED, "Antigravity login required")
}

fn request_error(error: reqwest::Error) -> ProxyError {
    if error.is_timeout() {
        ProxyError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "Antigravity speech directory timed out",
        )
    } else {
        ProxyError::new(
            StatusCode::BAD_GATEWAY,
            "Antigravity speech directory failed",
        )
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
