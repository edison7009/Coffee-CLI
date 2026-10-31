//! Usage and balance for the endpoint a tab's CLI is configured to call.
//! Official sign-ins report through the CLI protocol in the frontend; this module
//! covers third-party keys found in the tool's own configuration.
mod providers;
mod sources;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::{Duration, Instant}};

const FRESH: Duration = Duration::from_secs(60);
static CACHE: Mutex<Option<HashMap<String, (Instant, Value)>>> = Mutex::new(None);

fn claude_managed_settings() -> Option<PathBuf> {
    #[cfg(windows)] { Some(PathBuf::from(r"C:\Program Files\ClaudeCode\managed-settings.json")) }
    #[cfg(target_os = "macos")] { Some(PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json")) }
    #[cfg(all(unix, not(target_os = "macos")))] { Some(PathBuf::from("/etc/claude-code/managed-settings.json")) }
}

fn route(tool: &str, cwd: Option<String>) -> sources::Route {
    let var = |key: &str| std::env::var(key).ok();
    sources::resolve(tool, &sources::Context {
        home: dirs::home_dir().unwrap_or_default(),
        cwd: cwd.filter(|p| !p.trim().is_empty()).map(PathBuf::from),
        var: &var,
        claude_managed: claude_managed_settings(),
    })
}

/// `{kind:"official"}` lets the frontend ask the CLI; `{kind:"provider",quotas}`
/// carries third-party usage; `{kind:"none"}` hides the meter.
/// DeepSeek Harness tabs pass the provider their runtime uses; `force` (a click on the meter) skips the cache.
#[tauri::command]
pub async fn usage_quota_query(tool: String, cwd: Option<String>, provider: Option<String>, force: Option<bool>) -> Result<Value, String> {
    let force = force.unwrap_or(false);
    if tool == "dsh" {
        let Some(provider) = provider else { return Ok(json!({"kind":"none"})) };
        let source = tauri::async_runtime::spawn_blocking(move || crate::dsh_session::quota_source(&provider)).await.map_err(|e| e.to_string())?;
        return Ok(match source {
            None => json!({"kind":"none"}),
            Some(crate::dsh_session::QuotaSource::Account { token }) => {
                let key = format!("dsh-account\n{:x}", Sha256::digest(token.as_bytes()));
                cached(key, force, async move { providers::deepseek::query_account_balance(&token).await.ok() }).await
            }
            Some(crate::dsh_session::QuotaSource::Endpoint { base_url, api_key }) => endpoint(base_url, api_key, force).await,
        });
    }
    let route = tauri::async_runtime::spawn_blocking(move || route(&tool, cwd)).await.map_err(|e| e.to_string())?;
    Ok(match route {
        sources::Route::Official => json!({"kind":"official"}),
        sources::Route::Unknown => json!({"kind":"none"}),
        sources::Route::Endpoint { base_url, api_key } => endpoint(base_url, api_key, force).await,
    })
}

async fn endpoint(base_url: String, api_key: String, force: bool) -> Value {
    // Keys never become cache keys or leave this process except to their own host.
    let key = format!("{base_url}\n{:x}", Sha256::digest(api_key.as_bytes()));
    cached(key, force, async move {
        match providers::query_model_usage(&base_url, &api_key).await {
            Ok(result) if result.success => Some(result.data.map(|d| d.quotas).unwrap_or_default()),
            _ => None,
        }
    }).await
}

async fn cached(cache_key: String, force: bool, query: impl std::future::Future<Output = Option<Vec<providers::UsageQuota>>>) -> Value {
    if !force {
        if let Some((at, value)) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&cache_key) {
            if at.elapsed() < FRESH { return value.clone(); }
        }
    }
    let value = match query.await {
        Some(quotas) => json!({"kind":"provider","quotas":quotas}),
        None => json!({"kind":"none"}),
    };
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    cache.retain(|_, (at, _)| at.elapsed() < FRESH);
    cache.insert(cache_key, (Instant::now(), value.clone()));
    value
}
