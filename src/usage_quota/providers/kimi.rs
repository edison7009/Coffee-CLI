//! Kimi Coding usage windows.
use super::{
    api_url, fetch_usage, parse_f64, parse_reset_time, QuotaPeriod, UsageProvider, UsageQuota,
    UsageResult,
};
use serde_json::Value;

pub struct KimiProvider;

fn usage_url(base_url: &str) -> Option<String> {
    let url = api_url(base_url, &["api.kimi.com", "api.kimi.ai"])?;
    (url.path() == "/coding" || url.path().starts_with("/coding/"))
        .then(|| format!("https://{}/coding/v1/usages", url.host_str().unwrap()))
}

fn parse_window(detail: &Value, period: QuotaPeriod) -> Option<UsageQuota> {
    let limit = parse_f64(&detail["limit"]).filter(|value| value.is_finite() && *value > 0.0)?;
    let remaining = parse_f64(&detail["remaining"])?;
    UsageQuota::window(
        period,
        (1.0 - remaining / limit) * 100.0,
        parse_reset_time(&detail["resetTime"]),
    )
}

fn parse_ratio_window(detail: &Value, period: QuotaPeriod) -> Option<UsageQuota> {
    UsageQuota::window(
        period,
        parse_f64(&detail["used_ratio"])? * 100.0,
        parse_reset_time(&detail["reset_time"]),
    )
}

fn parse_quotas(body: &Value) -> Vec<UsageQuota> {
    let usages = &body["usages"];
    let five_hour = parse_ratio_window(&usages["limit_5h"], QuotaPeriod::FiveHour).or_else(|| {
        body["limits"]
            .as_array()?
            .iter()
            .find_map(|item| parse_window(&item["detail"], QuotaPeriod::FiveHour))
    });
    let weekly = parse_ratio_window(&usages["limit_7d"], QuotaPeriod::Weekly)
        .or_else(|| parse_window(&body["usage"], QuotaPeriod::Weekly));
    let monthly = parse_ratio_window(&usages["limit_month_total"], QuotaPeriod::Monthly);
    [five_hour, weekly, monthly].into_iter().flatten().collect()
}

#[async_trait::async_trait]
impl UsageProvider for KimiProvider {
    async fn query_usage(&self, api_key: &str, base_url: &str) -> Result<UsageResult, String> {
        let endpoint = usage_url(base_url).ok_or("Unsupported Kimi endpoint")?;
        Ok(
            match fetch_usage(&endpoint, &format!("Bearer {api_key}")).await {
                Ok(body) => UsageResult::from_quotas(parse_quotas(&body)),
                Err(error) => UsageResult::failure(error),
            },
        )
    }
    fn can_handle(&self, base_url: &str) -> bool {
        usage_url(base_url).is_some()
    }
    fn name(&self) -> &'static str {
        "Kimi"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_ratio_windows_with_their_own_reset_times() {
        let quotas = parse_quotas(&json!({"usages": {
            "limit_5h":{"used_ratio":0.3,"reset_time":"2027-01-01T12:00:00Z"},
            "limit_7d":{"used_ratio":0.2,"reset_time":1800000000},
            "limit_month_total":{"used_ratio":0.4,"reset_time":1800000000000_i64},
            "limit_month_code":{"used_ratio":0.1}
        }}));
        assert_eq!(quotas.len(), 3);
        for (quota, period, used, reset) in [
            (&quotas[0], QuotaPeriod::FiveHour, 30.0, 1798804800000),
            (&quotas[1], QuotaPeriod::Weekly, 20.0, 1800000000000),
            (&quotas[2], QuotaPeriod::Monthly, 40.0, 1800000000000),
        ] {
            assert_eq!(quota.period, Some(period));
            assert!((quota.percentage - used).abs() < 0.001);
            assert_eq!(quota.reset_at, reset);
        }
    }

    #[test]
    fn ratio_windows_take_priority_without_duplicating_legacy_windows() {
        let quotas = parse_quotas(&json!({
            "usages":{
                "limit_5h":{"used_ratio":0},
                "limit_7d":{"used_ratio":0.2},
                "limit_month_total":{"used_ratio":0.4}
            },
            "limits":[{"detail":{"limit":100,"remaining":10,"resetTime":1800000000}}],
            "usage":{"limit":1000,"remaining":100,"resetTime":1800000000}
        }));
        assert_eq!(quotas.len(), 3);
        assert_eq!(quotas[0].percentage, 0.0);
        assert_eq!(quotas[0].reset_at, 0);
        assert!((quotas[1].percentage - 20.0).abs() < 0.001);
        assert_eq!(quotas[1].reset_at, 0);
    }

    #[test]
    fn missing_ratio_falls_back_per_window_without_inventing_quota() {
        let quotas = parse_quotas(&json!({
            "usages":{
                "limit_5h":{"reset_time":1800000000},
                "limit_7d":{"used_ratio":"NaN"},
                "limit_month_total":{"used_ratio":1}
            },
            "limits":[{"detail":{"limit":100,"remaining":75}}],
            "usage":{"limit":1000,"remaining":800}
        }));
        assert_eq!(quotas.len(), 3);
        assert_eq!(quotas[0].percentage, 25.0);
        assert!((quotas[1].percentage - 20.0).abs() < 0.001);
        assert_eq!(quotas[2].percentage, 100.0);
        assert!(quotas.iter().all(|quota| quota.reset_at == 0));
        assert!(parse_quotas(&json!({"usages":{
            "limit_5h":{"reset_time":1800000000},
            "limit_7d":{"used_ratio":"Infinity"},
            "limit_month_total":{},
            "limit_month_code":{"used_ratio":0.1}
        }}))
        .is_empty());
    }

    #[test]
    fn parses_both_windows_and_never_invents_a_reset() {
        let quotas = parse_quotas(&json!({
            "limits":[{"detail":{"limit":"100","remaining":"45","resetTime":"2027-01-01T12:00:00Z"}}],
            "usage":{"limit":1000,"remaining":800}
        }));
        assert_eq!(quotas.len(), 2);
        assert!((quotas[0].percentage - 55.0).abs() < 0.001);
        assert_eq!(quotas[1].period, Some(QuotaPeriod::Weekly));
        assert_eq!(quotas[1].reset_at, 0);
        assert!(
            parse_quotas(&json!({"limits":[{"detail":{"limit":0}}],"usage":{"limit":100}}))
                .is_empty()
        );
    }
    #[test]
    fn detects_coding_hosts_without_matching_platform_or_spoofed_urls() {
        assert!(KimiProvider.can_handle("https://api.kimi.ai/coding/v1"));
        assert!(!KimiProvider.can_handle("https://api.kimi.com/coding-other"));
        assert!(!KimiProvider.can_handle("https://api.kimi.com.evil.test/coding"));
        assert!(!KimiProvider.can_handle("https://api.moonshot.cn/v1"));
    }
}
