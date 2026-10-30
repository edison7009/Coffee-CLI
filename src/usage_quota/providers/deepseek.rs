//! DeepSeek balance: GET https://api.deepseek.com/user/balance.

use super::{api_url, fetch_usage, parse_f64, UsageProvider, UsageQuota, UsageResult};

pub struct DeepSeekProvider;

fn parse_balance(body: &serde_json::Value) -> Option<UsageQuota> {
    let info = body.get("balance_infos")?.as_array()?.first()?;
    let amount = info.get("total_balance").and_then(parse_f64)?;
    let currency = info.get("currency")?.as_str()?;
    if !matches!(currency, "CNY" | "USD") {
        return None;
    }
    UsageQuota::balance(amount, currency)
}

#[async_trait::async_trait]
impl UsageProvider for DeepSeekProvider {
    async fn query_usage(&self, api_key: &str, base_url: &str) -> Result<UsageResult, String> {
        if !self.can_handle(base_url) {
            return Ok(UsageResult::failure("Unsupported DeepSeek API host"));
        }
        let body = match fetch_usage(
            "https://api.deepseek.com/user/balance",
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
        api_url(base_url, &["api.deepseek.com"]).is_some()
    }

    fn name(&self) -> &'static str {
        "DeepSeek"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn official_balance_fixture_preserves_currency_and_zero() {
        for (amount, currency) in [("10.50", "CNY"), ("0", "USD")] {
            let quota = parse_balance(&json!({"is_available":true,"balance_infos":[{
                "currency":currency,"total_balance":amount,
                "granted_balance":"1.00","topped_up_balance":"9.50"
            }]}))
            .unwrap();
            assert_eq!(quota.balance, amount.parse::<f64>().ok());
            assert_eq!(quota.balance_unit.as_deref(), Some(currency));
            assert_eq!(quota.reset_at, 0);
        }
    }

    #[test]
    fn missing_or_nonfinite_balance_and_missing_currency_are_unknown() {
        for body in [
            json!({}),
            json!({"balance_infos":[]}),
            json!({"balance_infos":[{"currency":"CNY"}]}),
            json!({"balance_infos":[{"total_balance":"10"}]}),
            json!({"balance_infos":[{"currency":"CNY","total_balance":"NaN"}]}),
            json!({"balance_infos":[{"currency":"USD","total_balance":"inf"}]}),
        ] {
            assert!(parse_balance(&body).is_none());
        }
    }

    #[tokio::test]
    async fn relay_host_cannot_send_a_key_to_the_official_balance_api() {
        let result = DeepSeekProvider
            .query_usage("fixture-key", "https://relay.example/api.deepseek.com")
            .await
            .unwrap();
        assert!(!result.success);
        assert!(result.data.is_none());
    }
}
