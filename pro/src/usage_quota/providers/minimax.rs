//! MiniMax Token Plan usage, queried with the model's regional API key.

use super::{
    api_url, fetch_usage, parse_f64, parse_reset_time, QuotaPeriod, UsageProvider, UsageQuota,
    UsageResult,
};
use serde_json::Value;

pub struct MiniMaxProvider;

fn usage_url(base_url: &str) -> Option<String> {
    let url = api_url(
        base_url,
        &["api.minimax.cn", "api.minimaxi.com", "api.minimax.io"],
    )?;
    // The legacy China API also serves keys issued on the current China platform.
    let host = if url.host_str()? == "api.minimax.io" {
        "api.minimax.io"
    } else {
        "api.minimaxi.com"
    };
    Some(format!("https://{host}/v1/token_plan/remains"))
}

fn parse_quotas(body: &Value) -> Vec<UsageQuota> {
    let Some(items) = body["model_remains"].as_array() else {
        return vec![];
    };
    let item = items
        .iter()
        .find(|item| item["model_name"] == "general")
        .or_else(|| items.iter().find(|item| item["model_name"] == "MiniMax-M*"));
    let Some(item) = item else {
        return vec![];
    };
    let mut quotas = Vec::new();
    for (period, prefix, end) in [
        (QuotaPeriod::FiveHour, "current_interval", "end_time"),
        (QuotaPeriod::Weekly, "current_weekly", "weekly_end_time"),
    ] {
        let status = item[format!("{prefix}_status")].as_i64();
        if period == QuotaPeriod::Weekly && status.is_some_and(|status| status != 1) {
            continue;
        }
        let limit = parse_f64(&item[format!("{prefix}_total_count")]).filter(|limit| *limit > 0.0);
        // Weekly percentages can be placeholders on plans without a weekly bucket.
        if period == QuotaPeriod::Weekly && status != Some(1) && limit.is_none() {
            continue;
        }
        let used = parse_f64(&item[format!("{prefix}_remaining_percent")])
            .map(|left| 100.0 - left)
            .or_else(|| {
                Some((1.0 - parse_f64(&item[format!("{prefix}_usage_count")])? / limit?) * 100.0)
            });
        if let Some(quota) =
            used.and_then(|used| UsageQuota::window(period, used, parse_reset_time(&item[end])))
        {
            quotas.push(quota);
        }
    }
    quotas
}

#[async_trait::async_trait]
impl UsageProvider for MiniMaxProvider {
    async fn query_usage(&self, api_key: &str, base_url: &str) -> Result<UsageResult, String> {
        let endpoint = usage_url(base_url).ok_or("Unsupported MiniMax endpoint")?;
        let body = match fetch_usage(&endpoint, &format!("Bearer {api_key}")).await {
            Ok(body) => body,
            Err(error) => return Ok(UsageResult::failure(error)),
        };
        if body.get("base_resp").is_some() && body["base_resp"]["status_code"].as_i64() != Some(0) {
            return Ok(UsageResult::failure(
                "MiniMax rejected the quota query; check the Token Plan key and subscription",
            ));
        }
        Ok(UsageResult::from_quotas(parse_quotas(&body)))
    }

    fn can_handle(&self, base_url: &str) -> bool {
        usage_url(base_url).is_some()
    }
    fn name(&self) -> &'static str {
        "MiniMax"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn routes_regional_keys_without_matching_lookalike_hosts() {
        for base in [
            "https://api.minimax.cn/anthropic",
            "https://api.minimaxi.com/v1",
        ] {
            assert_eq!(
                usage_url(base).unwrap(),
                "https://api.minimaxi.com/v1/token_plan/remains"
            );
        }
        assert_eq!(
            usage_url("https://api.minimax.io/v1").unwrap(),
            "https://api.minimax.io/v1/token_plan/remains"
        );
        for url in [
            "https://api.minimax.cn.evil.test/v1",
            "https://evil.test/api.minimax.io",
            "https://api.minimax.io@evil.test/v1",
        ] {
            assert!(!MiniMaxProvider.can_handle(url));
        }
    }

    #[test]
    fn chooses_text_bucket_and_converts_remaining_to_used() {
        let quotas = parse_quotas(&json!({"model_remains":[
            {"model_name":"video", "current_interval_remaining_percent":0},
            {"model_name":"general", "current_interval_remaining_percent":"99", "end_time":1800000000000_i64,
             "current_weekly_status":1, "current_weekly_remaining_percent":80, "weekly_end_time":1800400000000_i64}
        ]}));
        assert_eq!(quotas.len(), 2);
        assert_eq!(quotas[0].percentage, 1.0);
        assert_eq!(quotas[0].period, Some(QuotaPeriod::FiveHour));
        assert_eq!(quotas[1].percentage, 20.0);
        assert_eq!(quotas[1].period, Some(QuotaPeriod::Weekly));
        assert_eq!(quotas[1].reset_at, 1800400000000);
    }

    #[test]
    fn skips_inactive_and_missing_windows_without_fabricating_values() {
        for status in [2, 3] {
            let quotas = parse_quotas(&json!({"model_remains":[{"model_name":"general",
                "current_interval_remaining_percent":50, "current_weekly_status":status,
                "current_weekly_remaining_percent":100}]}));
            assert_eq!(quotas.len(), 1);
            assert_eq!(quotas[0].reset_at, 0);
        }
        assert!(parse_quotas(&json!({"model_remains":[{"model_name":"general"}]})).is_empty());
        assert!(parse_quotas(&json!({"model_remains":[{"model_name":"video","current_interval_remaining_percent":100}]})).is_empty());
    }

    #[test]
    fn accepts_legacy_count_response_only_with_a_positive_limit() {
        let quotas = parse_quotas(&json!({"model_remains":[{"model_name":"MiniMax-M*",
            "current_interval_total_count":1000, "current_interval_usage_count":250,
            "current_weekly_total_count":0, "current_weekly_usage_count":0}]}));
        assert_eq!(quotas.len(), 1);
        assert_eq!(quotas[0].percentage, 75.0);
    }
}
