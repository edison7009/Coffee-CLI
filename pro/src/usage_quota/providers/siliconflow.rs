//! SiliconFlow international balance: GET https://api.siliconflow.com/v1/user/info.
//! The domestic user-info endpoint was retired on 2026-08-14.

use super::{api_url, fetch_usage, parse_f64, UsageProvider, UsageQuota, UsageResult};

pub struct SiliconFlowProvider;

fn parse_balance(body: &serde_json::Value) -> Option<UsageQuota> {
    if body
        .get("status")
        .is_some_and(|value| value.as_bool() != Some(true))
        || body
            .get("code")
            .is_some_and(|value| value.as_i64() != Some(20000))
    {
        return None;
    }
    let amount = body.get("data")?.get("totalBalance").and_then(parse_f64)?;
    UsageQuota::balance(amount, "USD")
}

#[async_trait::async_trait]
impl UsageProvider for SiliconFlowProvider {
    async fn query_usage(&self, api_key: &str, base_url: &str) -> Result<UsageResult, String> {
        let Some(base) = api_url(base_url, &["api.siliconflow.cn", "api.siliconflow.com"]) else {
            return Ok(UsageResult::failure("Unsupported SiliconFlow API host"));
        };
        if base.host_str() == Some("api.siliconflow.cn") {
            return Ok(UsageResult::failure(
                "SiliconFlow domestic balance querying is unavailable: the user-info API was retired",
            ));
        }
        let body = match fetch_usage(
            "https://api.siliconflow.com/v1/user/info",
            &format!("Bearer {api_key}"),
        )
        .await
        {
            Ok(body) => body,
            Err(error) => return Ok(UsageResult::failure(error)),
        };
        Ok(match parse_balance(&body) {
            Some(quota) => UsageResult::from_quotas(vec![quota]),
            None => UsageResult::failure("No balance data available"),
        })
    }

    fn can_handle(&self, base_url: &str) -> bool {
        api_url(base_url, &["api.siliconflow.cn", "api.siliconflow.com"]).is_some()
    }

    fn name(&self) -> &'static str {
        "SiliconFlow"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn official_international_fixture_uses_total_balance_in_usd() {
        let quota = parse_balance(&json!({"code":20000,"status":true,"data":{
            "balance":"0.88","chargeBalance":"88.00","totalBalance":"88.88"
        }}))
        .unwrap();
        assert_eq!(quota.balance, Some(88.88));
        assert_eq!(quota.balance_unit.as_deref(), Some("USD"));
        assert_eq!(quota.reset_at, 0);
        assert_eq!(
            parse_balance(&json!({"data":{"totalBalance":0}}))
                .unwrap()
                .balance,
            Some(0.0)
        );
    }

    #[test]
    fn missing_nonfinite_or_failed_response_is_unknown() {
        for body in [
            json!({}),
            json!({"data":{}}),
            json!({"data":{"totalBalance":"NaN"}}),
            json!({"data":{"totalBalance":"inf"}}),
            json!({"code":40100,"data":{"totalBalance":"10"}}),
            json!({"status":false,"data":{"totalBalance":"10"}}),
        ] {
            assert!(parse_balance(&body).is_none());
        }
    }

    #[tokio::test]
    async fn retired_domestic_endpoint_returns_failure_without_a_request() {
        let result = SiliconFlowProvider
            .query_usage("fixture-key", "https://api.siliconflow.cn/v1")
            .await
            .unwrap();
        assert!(!result.success);
        assert!(result.data.is_none());
        assert!(result.error.unwrap().contains("retired"));
    }
}
