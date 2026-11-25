//! Plan usage for official sign-ins when no CLI session can report it (terminal tabs).
//! The CLI's stored sign-in is read, never written or refreshed: rotating a token here would sign the
//! CLI out. A token only ever goes to its own vendor's usage endpoint; an expired one hides the meter
//! until the CLI renews it.
use super::{QuotaPeriod, UsageQuota};
use serde_json::Value;
use std::{path::Path, time::Duration};

#[derive(Debug, PartialEq)]
pub struct Account {
    pub token: String,
    pub account_id: Option<String>,
}

pub fn credentials(tool: &str, home: &Path, var: &dyn Fn(&str) -> Option<String>) -> Option<Account> {
    let dir = |key: &str, fallback: &str| var(key).filter(|value| !value.trim().is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(fallback));
    match tool {
        "claude" => {
            let now = chrono::Utc::now().timestamp_millis();
            #[cfg(target_os = "macos")]
            if let Some(account) = claude_keychain().and_then(|text| claude_account(&text, now)) { return Some(account); }
            claude_account(&std::fs::read_to_string(dir("CLAUDE_CONFIG_DIR", ".claude").join(".credentials.json")).ok()?, now)
        }
        "codex" => codex_account(&std::fs::read_to_string(dir("CODEX_HOME", ".codex").join("auth.json")).ok()?),
        _ => None,
    }
}

/// Claude Code keeps its sign-in in the login keychain on macOS.
#[cfg(target_os = "macos")]
fn claude_keychain() -> Option<String> {
    let output = std::process::Command::new("security").args(["find-generic-password", "-s", "Claude Code-credentials", "-w"]).output().ok()?;
    output.status.success().then(|| String::from_utf8(output.stdout).ok()).flatten()
}

/// Claude Code's stored sign-in has expired: the tool renews it only while it runs, so opening it once brings it back.
pub fn claude_expired(home: &Path, var: &dyn Fn(&str) -> Option<String>) -> bool {
    let now = chrono::Utc::now().timestamp_millis();
    #[cfg(target_os = "macos")]
    if let Some(text) = claude_keychain() { return claude_expired_at(&text, now); }
    let dir = var("CLAUDE_CONFIG_DIR").filter(|value| !value.trim().is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".claude"));
    std::fs::read_to_string(dir.join(".credentials.json")).is_ok_and(|text| claude_expired_at(&text, now))
}

fn claude_expired_at(text: &str, now_ms: i64) -> bool {
    let Ok(parsed) = serde_json::from_str::<Value>(text) else { return false };
    let Some(entry) = parsed.get("claudeAiOauth").or_else(|| parsed.get("claude.ai_oauth")) else { return false };
    entry["accessToken"].as_str().is_some_and(|token| !token.is_empty()) && entry["expiresAt"].as_i64().is_some_and(|expires| expires <= now_ms)
}

fn claude_account(text: &str, now_ms: i64) -> Option<Account> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    let entry = parsed.get("claudeAiOauth").or_else(|| parsed.get("claude.ai_oauth"))?;
    if entry["expiresAt"].as_i64().is_some_and(|expires| expires <= now_ms) { return None; }
    Some(Account { token: entry["accessToken"].as_str().filter(|token| !token.is_empty())?.to_string(), account_id: None })
}

fn codex_account(text: &str) -> Option<Account> {
    let parsed: Value = serde_json::from_str(text).ok()?;
    // API-key sign-ins have no plan to report.
    if parsed["auth_mode"] != "chatgpt" { return None; }
    let tokens = &parsed["tokens"];
    Some(Account {
        token: tokens["access_token"].as_str().filter(|token| !token.is_empty())?.to_string(),
        account_id: tokens["account_id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned),
    })
}

pub async fn query(tool: &str, account: &Account) -> Option<Vec<UsageQuota>> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().ok()?;
    let request = match tool {
        "claude" => client.get("https://api.anthropic.com/api/oauth/usage").header("anthropic-beta", "oauth-2025-04-20"),
        "codex" => {
            let request = client.get("https://chatgpt.com/backend-api/wham/usage").header("User-Agent", "codex-cli");
            match &account.account_id { Some(id) => request.header("ChatGPT-Account-Id", id), None => request }
        }
        _ => return None,
    };
    let response = request.bearer_auth(&account.token).header("Accept", "application/json").send().await.ok()?;
    if !response.status().is_success() { return None; }
    let body: Value = response.json().await.ok()?;
    Some(if tool == "claude" { claude_quotas(&body) } else { codex_quotas(&body) })
}

fn claude_quotas(body: &Value) -> Vec<UsageQuota> {
    [("five_hour", QuotaPeriod::FiveHour), ("seven_day", QuotaPeriod::Weekly)].into_iter().filter_map(|(key, period)| {
        let window = &body[key];
        let reset = window["resets_at"].as_str().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at| at.timestamp_millis());
        UsageQuota::window(period, window["utilization"].as_f64()?, reset)
    }).collect()
}

fn codex_period(seconds: Option<i64>) -> QuotaPeriod {
    match seconds.unwrap_or(0) / 60 {
        0..=300 => QuotaPeriod::FiveHour,
        301..=1440 => QuotaPeriod::Daily,
        1441..=10080 => QuotaPeriod::Weekly,
        _ => QuotaPeriod::Monthly,
    }
}

fn codex_quotas(body: &Value) -> Vec<UsageQuota> {
    let limit = &body["rate_limit"];
    let mut quotas: Vec<UsageQuota> = [&limit["primary_window"], &limit["secondary_window"]].into_iter().filter_map(|window| {
        let used = window["used_percent"].as_f64()?;
        // An unused window reports "now + its length" as a placeholder reset.
        let reset = (used > 0.0).then(|| window["reset_at"].as_i64().map(|at| at * 1000)).flatten();
        UsageQuota::window(codex_period(window["limit_window_seconds"].as_i64()), used, reset)
    }).collect();
    let credits = &body["credits"];
    let balance = credits["balance"].as_f64().or_else(|| credits["balance"].as_str()?.parse().ok());
    if credits["has_credits"] == true && credits["unlimited"] != true {
        quotas.extend(balance.and_then(|amount| UsageQuota::balance(amount, "credits")));
    }
    quotas
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn claude_sign_in_is_read_and_expiry_hides_it() {
        let text = json!({"claudeAiOauth":{"accessToken":"token","expiresAt":2000}}).to_string();
        assert_eq!(claude_account(&text, 1000).unwrap().token, "token");
        assert!(claude_account(&text, 2000).is_none(), "an expired token is left for the CLI to renew");
        assert!(claude_account(r#"{"mcpOAuth":{}}"#, 0).is_none());
        assert!(claude_account(r#"{"claude.ai_oauth":{"accessToken":""}}"#, 0).is_none());
    }
    #[test]
    fn an_expired_claude_sign_in_is_told_apart_from_none() {
        let text = json!({"claudeAiOauth":{"accessToken":"token","expiresAt":2000}}).to_string();
        assert!(!claude_expired_at(&text, 1000), "still valid");
        assert!(claude_expired_at(&text, 2000), "expired, waiting for Claude Code to renew it");
        assert!(!claude_expired_at(r#"{"mcpOAuth":{}}"#, 5000), "no Claude sign-in at all");
        assert!(!claude_expired_at(r#"{"claudeAiOauth":{"accessToken":"","expiresAt":1}}"#, 5000), "an empty token is not a sign-in");
    }
    #[test]
    fn codex_reads_chatgpt_sign_ins_only() {
        let account = codex_account(&json!({"auth_mode":"chatgpt","tokens":{"access_token":"token","account_id":"acct"}}).to_string()).unwrap();
        assert_eq!(account, Account { token: "token".into(), account_id: Some("acct".into()) });
        assert!(codex_account(&json!({"auth_mode":"apikey","OPENAI_API_KEY":"sk"}).to_string()).is_none());
    }
    #[test]
    fn plan_windows_map_to_the_meter() {
        let claude = claude_quotas(&json!({"five_hour":{"utilization":12.5,"resets_at":"2026-10-31T16:00:00+00:00"},"seven_day":{"utilization":40.0,"resets_at":null},"seven_day_opus":{"utilization":1.0}}));
        assert_eq!(claude.len(), 2);
        assert_eq!((claude[0].period, claude[0].percentage), (Some(QuotaPeriod::FiveHour), 12.5));
        assert_eq!(claude[0].reset_at, 1793462400000);
        assert_eq!((claude[1].period, claude[1].reset_at), (Some(QuotaPeriod::Weekly), 0));
        let codex = codex_quotas(&json!({"rate_limit":{"primary_window":{"used_percent":0.0,"limit_window_seconds":18000,"reset_at":1793462400},"secondary_window":{"used_percent":30.0,"limit_window_seconds":604800,"reset_at":1793462400}},"credits":{"has_credits":true,"unlimited":false,"balance":"5.50"}}));
        assert_eq!((codex[0].period, codex[0].reset_at), (Some(QuotaPeriod::FiveHour), 0), "an unused window has no countdown");
        assert_eq!((codex[1].period, codex[1].reset_at), (Some(QuotaPeriod::Weekly), 1793462400000));
        assert_eq!(codex[2].balance, Some(5.5));
        assert_eq!(codex_quotas(&json!({"credits":{"has_credits":true,"unlimited":true,"balance":"0"}})).len(), 0);
    }
    /// The local sign-ins against the real endpoints; prints only percentages:
    /// `cargo test --bin coffee-cli account_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn account_live_usage() {
        let home = dirs::home_dir().unwrap();
        let var = |key: &str| std::env::var(key).ok();
        tauri::async_runtime::block_on(async {
            for tool in ["claude", "codex"] {
                let Some(account) = credentials(tool, &home, &var) else { println!("{tool}: no sign-in"); continue };
                let quotas = query(tool, &account).await;
                println!("{tool}: {:?}", quotas.map(|list| list.iter().map(|q| (q.period, q.percentage, q.reset_at > 0, q.balance)).collect::<Vec<_>>()));
            }
        });
    }
}
