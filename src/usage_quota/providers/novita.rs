//! Novita balance: GET https://api.novita.ai/openapi/v1/billing/balance/detail.
//! availableBalance is in units of 0.0001 USD.

use super::{api_url, fetch_usage, parse_f64, UsageProvider, UsageQuota, UsageResult};

pub struct NovitaProvider;

fn parse_balance(body: &serde_json::Value) -> Option<UsageQuota> {
    let amount = body.get("availableBalance").and_then(parse_f64)? / 10000.0;
    UsageQuota::balance(amount, "USD")
}

#[async_trait::async_trait]
impl UsageProvider for NovitaProvider {
    async fn query_usage(&self, api_key: &str, base_url: &str) -> Result<UsageResult, String> {
        if !self.can_handle(base_url) {
            return Ok(UsageResult::failure("Unsupported Novita API host"));
        }
        let body = match fetch_usage(
            "https://api.novita.ai/openapi/v1/billing/balance/detail",
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
        api_url(base_url, &["api.novita.ai"]).is_some()
    }

    fn name(&self) -> &'static str {
        "Novita AI"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn documented_fixture_converts_available_balance_to_usd() {
        let quota = parse_balance(&json!({
            "availableBalance":"1000000","cashBalance":"800000","creditLimit":"500000",
            "outstandingInvoices":"100000","pendingCharges":"200000"
        }))
        .unwrap();
        assert_eq!(quota.balance, Some(100.0));
        assert_eq!(quota.balance_unit.as_deref(), Some("USD"));
        assert_eq!(quota.reset_at, 0);
        assert_eq!(
            parse_balance(&json!({"availableBalance":0}))
                .unwrap()
                .balance,
            Some(0.0)
        );
    }

    #[test]
    fn missing_or_nonfinite_available_balance_is_unknown() {
        for body in [
            json!({}),
            json!({"cashBalance":"1000000"}),
            json!({"availableBalance":"NaN"}),
            json!({"availableBalance":"inf"}),
        ] {
            assert!(parse_balance(&body).is_none());
        }
    }
}
