use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSourceProbe {
    latency_ms: f64,
    account_id: Option<String>,
}

/// Check this channel's active sign-in and measure its service's HTTPS response time.
/// This connection request carries no credentials or recorded audio.
#[tauri::command]
pub async fn voice_input_probe_source(source: String) -> Option<VoiceSourceProbe> {
    let account = tokio::time::timeout(
        Duration::from_secs(10),
        input_account(String::new(), None, Some(source)),
    )
    .await
    .ok()?
    .ok()?;
    let (endpoint, account_id) = match account {
        InputAccount::Tool(kind, account) => (
            if kind == "claude" {
                "https://api.anthropic.com"
            } else {
                "https://chatgpt.com"
            },
            account.account_id,
        ),
        InputAccount::Doubao(account) => (
            "https://frontier-audio-web-ws.doubao.com",
            Some(account.user_id),
        ),
        InputAccount::WorkBuddy(account) => ("https://www.workbuddy.cn", Some(account.user_id)),
        InputAccount::Cursor(account) => ("https://api2.cursor.sh", Some(account.user_id)),
        InputAccount::Native(account) => (
            echo::connection_url(&account)?,
            (!account.account_id.is_empty()).then_some(account.account_id),
        ),
        #[cfg(target_os = "macos")]
        InputAccount::Apple => {
            return apple::ready().then_some(VoiceSourceProbe {
                latency_ms: 0.0,
                account_id: None,
            })
        }
    };
    Some(VoiceSourceProbe {
        latency_ms: connection_latency(endpoint).await?,
        account_id,
    })
}

async fn connection_latency(endpoint: &str) -> Option<f64> {
    // Each measurement includes a fresh connection, without redirecting to a different host.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(4))
        .build()
        .ok()?;
    let start = Instant::now();
    let response = client.head(endpoint).send().await.ok()?;
    let status = response.status();
    if status.is_server_error() || matches!(status.as_u16(), 402 | 408 | 429) {
        return None;
    }
    // A speech-only server may reject HEAD while still completing its TLS/HTTP connection.
    Some(start.elapsed().as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "checks actual native sign-ins and public service connections, without recording"]
    async fn native_connections_live() {
        for source in ["grokbot", "dumate"] {
            let probe = voice_input_probe_source(source.into()).await;
            eprintln!(
                "native_connection source={source} available={} latency_ms={:?}",
                probe.is_some(),
                probe.as_ref().map(|value| value.latency_ms)
            );
            assert!(
                probe.is_some(),
                "native source connection unavailable: {source}"
            );
        }
        for tool in ["claude", "codex"] {
            let official = signed_in(tool, None).is_some();
            assert_eq!(
                voice_input_available(tool.into(), None, Some("unknown-channel".into())).await,
                official,
                "official account mode must retain its own voice channel"
            );
        }
    }

    #[tokio::test]
    async fn connection_checks_accept_speech_only_routes_and_reject_unavailable_servers() {
        let app = axum::Router::new()
            .route(
                "/speech",
                axum::routing::head(|| async { axum::http::StatusCode::METHOD_NOT_ALLOWED }),
            )
            .route(
                "/quota",
                axum::routing::head(|| async { axum::http::StatusCode::PAYMENT_REQUIRED }),
            )
            .route(
                "/down",
                axum::routing::head(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        assert!(connection_latency(&format!("http://{address}/speech"))
            .await
            .is_some());
        assert!(connection_latency(&format!("http://{address}/quota"))
            .await
            .is_none());
        assert!(connection_latency(&format!("http://{address}/down"))
            .await
            .is_none());
        assert!(voice_input_probe_source("unknown-channel".into())
            .await
            .is_none());
        server.abort();
    }
}
