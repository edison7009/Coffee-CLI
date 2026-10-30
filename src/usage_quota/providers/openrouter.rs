//! OpenRouter account credits require a separate Management API key.
//! EchoBird currently stores only the model inference key.

use super::{api_url, UsageProvider, UsageResult};

pub struct OpenRouterProvider;

#[async_trait::async_trait]
impl UsageProvider for OpenRouterProvider {
    async fn query_usage(&self, _api_key: &str, _base_url: &str) -> Result<UsageResult, String> {
        Ok(UsageResult::failure(
            "OpenRouter account balance querying requires a separate Management API key",
        ))
    }

    fn can_handle(&self, base_url: &str) -> bool {
        api_url(base_url, &["openrouter.ai"]).is_some()
    }

    fn name(&self) -> &'static str {
        "OpenRouter"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn inference_key_is_not_sent_to_a_management_api() {
        let result = OpenRouterProvider
            .query_usage("fixture-key", "https://openrouter.ai/api/v1")
            .await
            .unwrap();
        assert!(!result.success);
        assert!(result.data.is_none());
        let error = result.error.unwrap();
        assert!(error.contains("separate Management API key"));
        assert!(!error.contains("fixture-key"));
    }
}
