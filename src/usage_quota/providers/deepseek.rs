//! DeepSeek balance: GET https://api.deepseek.com/user/balance for API keys, and the
//! DeepSeek Platform account summary for accounts signed in through DeepSeek Harness.

use super::{api_url, fetch_usage, parse_f64, send_usage_request, UsageProvider, UsageQuota, UsageResult};

/// Recharge plus granted wallets, as DeepSeek Harness counts an account's spendable balance.
fn parse_account_summary(body: &serde_json::Value) -> Option<UsageQuota> {
    if body["code"] != 0 || body["data"]["biz_code"] != 0 { return None; }
    let data = &body["data"]["biz_data"];
    let wallets: Vec<&serde_json::Value> = ["normal_wallets", "bonus_wallets"].iter()
        .flat_map(|key| data[*key].as_array().into_iter().flatten()).collect();
    let currency = wallets.iter().find_map(|w| w["currency"].as_str().filter(|c| matches!(*c, "CNY" | "USD")))?;
    let amounts: Vec<f64> = wallets.iter().filter(|w| w["currency"] == currency).map(|w| parse_f64(&w["balance"])).collect::<Option<_>>()?;
    UsageQuota::balance(amounts.iter().sum(), currency)
}

/// Balance of the DeepSeek account DeepSeek Harness signed in, with the token it stored.
pub async fn query_account_balance(token: &str) -> Result<Vec<UsageQuota>, String> {
    let body = send_usage_request(reqwest::Client::new()
        .get("https://platform.deepseek.com/api/v0/users/get_user_summary")
        .header("x-dsh-auth-token", token)).await?;
    parse_account_summary(&body).map(|quota| vec![quota]).ok_or_else(|| "No balance data available".into())
}

pub struct DeepSeekProvider;

/// One account can hold a CNY and a USD wallet, and spending draws on the one
/// with money. Every wallet is shown unless some hold money, which hides the
/// empty ones.
fn parse_balances(body: &serde_json::Value) -> Vec<UsageQuota> {
    let mut quotas: Vec<UsageQuota> = body
        .get("balance_infos")
        .and_then(|infos| infos.as_array())
        .into_iter()
        .flatten()
        .filter_map(|info| {
            let currency = info.get("currency")?.as_str()?;
            if !matches!(currency, "CNY" | "USD") {
                return None;
            }
            UsageQuota::balance(info.get("total_balance").and_then(parse_f64)?, currency)
        })
        .collect();
    if quotas.iter().any(|quota| quota.balance > Some(0.0)) {
        quotas.retain(|quota| quota.balance > Some(0.0));
    }
    quotas
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
        let quotas = parse_balances(&body);
        Ok(if quotas.is_empty() {
            UsageResult::failure("No balance data available")
        } else {
            UsageResult::from_quotas(quotas)
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
            let quotas = parse_balances(&json!({"is_available":true,"balance_infos":[{
                "currency":currency,"total_balance":amount,
                "granted_balance":"1.00","topped_up_balance":"9.50"
            }]}));
            assert_eq!(quotas.len(), 1);
            let quota = &quotas[0];
            assert_eq!(quota.balance, amount.parse::<f64>().ok());
            assert_eq!(quota.balance_unit.as_deref(), Some(currency));
            assert_eq!(quota.reset_at, 0);
        }
    }

    #[test]
    fn account_summary_adds_bonus_wallets_and_rejects_failures() {
        let body = |biz: i64| json!({"code":0,"data":{"biz_code":biz,"biz_data":{
            "normal_wallets":[{"currency":"CNY","balance":"9.4738512800000000"}],
            "bonus_wallets":[{"currency":"CNY","balance":"0.5"},{"currency":"USD","balance":"3"}]}}});
        let quota = parse_account_summary(&body(0)).unwrap();
        assert!((quota.balance.unwrap() - 9.97385128).abs() < 1e-9);
        assert_eq!(quota.balance_unit.as_deref(), Some("CNY"));
        assert!(parse_account_summary(&body(1)).is_none());
        assert!(parse_account_summary(&json!({"code":40003})).is_none());
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
            assert!(parse_balances(&body).is_empty());
        }
    }

    #[test]
    fn both_wallets_are_read_and_an_empty_one_beside_money_is_hidden() {
        let balances = |cny: &str, usd: &str| {
            parse_balances(&json!({"balance_infos":[
                {"currency":"CNY","total_balance":cny},
                {"currency":"USD","total_balance":usd}
            ]}))
            .iter()
            .map(|quota| (quota.balance.unwrap(), quota.balance_unit.clone().unwrap()))
            .collect::<Vec<_>>()
        };
        assert_eq!(balances("0.00", "12.34"), vec![(12.34, "USD".into())]);
        assert_eq!(
            balances("5", "2"),
            vec![(5.0, "CNY".into()), (2.0, "USD".into())]
        );
        assert_eq!(
            balances("0", "0"),
            vec![(0.0, "CNY".into()), (0.0, "USD".into())]
        );
        let after_unsupported = parse_balances(&json!({"balance_infos":[
            {"currency":"EUR","total_balance":"9"},
            {"currency":"CNY","total_balance":"3"}
        ]}));
        assert_eq!(after_unsupported[0].balance_unit.as_deref(), Some("CNY"));
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
