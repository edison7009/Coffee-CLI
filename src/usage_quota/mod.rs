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
#[tauri::command]
pub async fn usage_quota_query(tool: String, cwd: Option<String>) -> Result<Value, String> {
    let route = tauri::async_runtime::spawn_blocking(move || route(&tool, cwd)).await.map_err(|e| e.to_string())?;
    let (base_url, api_key) = match route {
        sources::Route::Official => return Ok(json!({"kind":"official"})),
        sources::Route::Unknown => return Ok(json!({"kind":"none"})),
        sources::Route::Endpoint { base_url, api_key } => (base_url, api_key),
    };
    // Keys never become cache keys or leave this process except to their own host.
    let cache_key = format!("{base_url}\n{:x}", Sha256::digest(api_key.as_bytes()));
    if let Some((at, value)) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(&cache_key) {
        if at.elapsed() < FRESH { return Ok(value.clone()); }
    }
    let value = match providers::query_model_usage(&base_url, &api_key).await {
        Ok(result) if result.success => json!({"kind":"provider","quotas":result.data.map(|d| d.quotas).unwrap_or_default()}),
        _ => json!({"kind":"none"}),
    };
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    cache.retain(|_, (at, _)| at.elapsed() < FRESH);
    cache.insert(cache_key, (Instant::now(), value.clone()));
    Ok(value)
}
