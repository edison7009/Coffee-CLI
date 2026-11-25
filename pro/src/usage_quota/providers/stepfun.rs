//! StepFun balance: GET /v1/accounts on the selected official regional API.

use super::{api_url, fetch_usage, parse_f64, UsageProvider, UsageQuota, UsageResult};

pub struct StepFunProvider;

fn regional_account_api(base_url: &str) -> Option<(&'static str, &'static str)> {
    let base = api_url(base_url, &["api.stepfun.com", "api.stepfun.ai"])?;
    match base.host_str()? {
        "api.stepfun.com" => Some(("https://api.stepfun.com/v1/accounts", "CNY")),
        "api.stepfun.ai" => Some(("https://api.stepfun.ai/v1/accounts", "USD")),
        _ => None,
    }
}

fn parse_balance(body: &serde_json::Value, currency: &str) -> Option<UsageQuota> {
    UsageQuota::balance(body.get("balance").and_then(parse_f64)?, currency)
}

#[async_trait::async_trait]
impl UsageProvider for StepFunProvider {
    async fn query_usage(&self, api_key: &str, base_url: &str) -> Result<UsageResult, String> {
        let Some((endpoint, currency)) = regional_account_api(base_url) else {
            return Ok(UsageResult::failure("Unsupported StepFun API host"));
        };
        let body = match fetch_usage(endpoint, &format!("Bearer {api_key}")).await {
            Ok(body) => body,
            Err(error) => return Ok(UsageResult::failure(error)),
        };
        Ok(match parse_balance(&body, currency) {
            Some(quota) => UsageResult::from_quotas(vec![quota]),
            None => UsageResult::failure("No balance data available"),
        })
    }

    fn can_handle(&self, base_url: &str) -> bool {
        regional_account_api(base_url).is_some()
    }

    fn name(&self) -> &'static str {
        "StepFun"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn regional_hosts_keep_separate_endpoints_and_currencies() {
        assert_eq!(
            regional_account_api("https://api.stepfun.com/v1"),
            Some(("https://api.stepfun.com/v1/accounts", "CNY"))
        );
        assert_eq!(
            regional_account_api("https://api.stepfun.ai/v1"),
            Some(("https://api.stepfun.ai/v1/accounts", "USD"))
        );
        for base in [
            "http://api.stepfun.ai/v1",
            "https://api.stepfun.ai.relay.example/v1",
            "https://relay.example/api.stepfun.com",
        ] {
            assert!(regional_account_api(base).is_none());
        }
    }

    #[test]
    fn account_fixture_uses_available_balance_instead_of_deposits_or_vouchers() {
        let body = json!({"object":"account","type":"paid","balance":12.5,"total_cash_balance":100,"total_voucher_balance":30});
        for currency in ["CNY", "USD"] {
            let quota = parse_balance(&body, currency).unwrap();
            assert_eq!(quota.balance, Some(12.5));
            assert_eq!(quota.balance_unit.as_deref(), Some(currency));
            assert_eq!(quota.reset_at, 0);
        }
        assert_eq!(
            parse_balance(&json!({"balance":0}), "CNY").unwrap().balance,
            Some(0.0)
        );
    }

    #[test]
    fn missing_or_nonfinite_balance_is_unknown() {
        for body in [
            json!({}),
            json!({"balance":null}),
            json!({"balance":"NaN"}),
            json!({"balance":"inf"}),
        ] {
            assert!(parse_balance(&body, "USD").is_none());
        }
    }
}
