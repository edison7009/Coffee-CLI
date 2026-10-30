//! OpenCode Go subscription usage. Zen pay-as-you-go does not expose this API.

use super::{
    api_url, fetch_usage, parse_f64, parse_reset_time, QuotaPeriod, UsageProvider, UsageQuota,
    UsageResult,
};
use serde_json::Value;

pub struct OpenCodeProvider;

fn parse_quotas(body: &Value) -> Vec<UsageQuota> {
    [
        ("rolling", QuotaPeriod::FiveHour),
        ("weekly", QuotaPeriod::Weekly),
        ("monthly", QuotaPeriod::Monthly),
    ]
    .into_iter()
    .filter_map(|(field, period)| {
        let window = &body["usage"][field];
        let used = parse_f64(&window["percent"])?;
        // Empty windows have a moving placeholder reset, not a running countdown.
        let reset = if used > 0.0 {
            parse_reset_time(&window["resetsAt"])
        } else {
            None
        };
        UsageQuota::window(period, used, reset)
    })
    .collect()
}

#[async_trait::async_trait]
impl UsageProvider for OpenCodeProvider {
    async fn query_usage(&self, api_key: &str, _base_url: &str) -> Result<UsageResult, String> {
        Ok(
            match fetch_usage(
                "https://opencode.ai/zen/go/v1/usage",
                &format!("Bearer {api_key}"),
            )
            .await
            {
                Ok(body) => UsageResult::from_quotas(parse_quotas(&body)),
                Err(error) => UsageResult::failure(error),
            },
        )
    }

    fn can_handle(&self, base_url: &str) -> bool {
        api_url(base_url, &["opencode.ai"])
            .is_some_and(|url| url.path() == "/zen/go" || url.path().starts_with("/zen/go/"))
    }
    fn name(&self) -> &'static str {
        "OpenCode Go"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn separates_go_from_zen_and_lookalike_urls() {
        for path in ["/zen/go", "/zen/go/v1", "/zen/go/v1/messages"] {
            assert!(OpenCodeProvider.can_handle(&format!("https://opencode.ai{path}")));
        }
        for url in [
            "https://opencode.ai/zen/v1",
            "https://opencode.ai/zen/gopher",
            "https://opencode.ai.evil.test/zen/go",
            "https://evil.test/opencode.ai/zen/go",
        ] {
            assert!(!OpenCodeProvider.can_handle(url));
        }
    }

    #[test]
    fn preserves_period_identity_and_omits_empty_window_countdowns() {
        let quotas = parse_quotas(&json!({"usage":{
            "rolling":{"percent":1,"resetsAt":"2027-01-01T12:00:00Z"},
            "weekly":{"percent":20,"resetsAt":"2027-01-02T12:00:00Z"},
            "monthly":{"percent":80,"resetsAt":"2027-01-20T12:00:00Z"}
        }}));
        assert_eq!(quotas.len(), 3);
        assert_eq!(quotas[1].period, Some(QuotaPeriod::Weekly));
        assert_eq!(quotas[1].percentage, 20.0);
        assert_eq!(quotas[2].period, Some(QuotaPeriod::Monthly));
        assert_eq!(quotas[0].reset_at, 1798804800000);
        let empty = parse_quotas(
            &json!({"usage":{"weekly":{"percent":0,"resetsAt":"2027-01-02T12:00:00Z"}}}),
        );
        assert_eq!(empty[0].reset_at, 0);
    }

    #[test]
    fn malformed_windows_are_unknown_not_zero() {
        let quotas = parse_quotas(
            &json!({"usage":{"rolling":{},"weekly":{"percent":"20"},"monthly":{"percent":"NaN"}}}),
        );
        assert_eq!(quotas.len(), 1);
        assert_eq!(quotas[0].period, Some(QuotaPeriod::Weekly));
        assert_eq!(quotas[0].reset_at, 0);
        assert!(parse_quotas(&json!({"usage":{}})).is_empty());
    }
}
