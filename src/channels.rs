//! Private phone channels. Credentials stay in the OS keyring; consumed messages
//! are never replayed into the agent after an application restart.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

const WEIXIN_URL: &str = "https://ilinkai.weixin.qq.com";
const KEYRING_SERVICE: &str = "coffee-cli-channels";
const PAIRING_TTL_MS: u64 = 10 * 60_000;
const TELEGRAM_IDLE_RESET_MS: u64 = 7 * 24 * 60 * 60_000;

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TelegramConfig {
    enabled: bool,
    bot_name: String,
    #[serde(default)]
    bot_id: String,
    allowed_user_id: String,
    authorization: String,
    #[serde(default)]
    conversation_route: String,
    #[serde(default)]
    pending_resume_user_id: String,
    #[serde(default)]
    pending_resume_route: String,
    offset: i64,
    #[serde(default)]
    last_received_update_at: u64,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct WeixinConfig {
    enabled: bool,
    account_id: String,
    allowed_user_id: String,
    authorization: String,
    #[serde(default)]
    conversation_route: String,
    base_url: String,
    cursor: String,
    recent_ids: Vec<String>,
}

/// Frozen notification ownership; credentials never cross the Agent bridge.
#[derive(Clone, Debug)]
pub(crate) struct FrozenNotificationTarget {
    pub channel: String,
    pub authorization: String,
    pub recipient: String,
    pub route: String,
    pub generation: u64,
}

#[derive(Debug, PartialEq)]
pub(crate) enum NotificationDelivery {
    Delivered,
    NeedsContext,
    Revoked,
    Failed(String),
}

#[derive(Deserialize, Serialize)]
struct WeixinNotificationContext {
    token: String,
    received_at: u64,
}

impl Default for WeixinConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            account_id: String::new(),
            allowed_user_id: String::new(),
            authorization: String::new(),
            conversation_route: String::new(),
            base_url: WEIXIN_URL.into(),
            cursor: String::new(),
            recent_ids: Vec::new(),
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
struct ChannelConfig {
    telegram: TelegramConfig,
    weixin: WeixinConfig,
}

#[derive(Default)]
struct ChannelSession {
    generation: u64,
    cancel: Option<watch::Sender<bool>>,
    status: String,
    error: String,
    delivery_error: String,
}

struct Pairing {
    code: String,
    expires_at: u64,
    failures: usize,
}

#[derive(Clone)]
struct WeixinLogin {
    session_id: String,
    qrcode: String,
    base_url: String,
    started_at: u64,
}

struct RuntimeState {
    config: ChannelConfig,
    load_error: Option<String>,
    ready: bool,
    telegram: ChannelSession,
    weixin: ChannelSession,
    pairing: Option<Pairing>,
    login: Option<WeixinLogin>,
}

pub struct ChannelRuntime {
    state: Mutex<RuntimeState>,
    client: reqwest::Client,
}

impl Default for ChannelRuntime {
    fn default() -> Self {
        let loaded = load_config();
        let (config, load_error) = match loaded {
            Ok(config) => (config, None),
            Err(error) => (ChannelConfig::default(), Some(error)),
        };
        Self {
            state: Mutex::new(RuntimeState {
                config,
                load_error,
                ready: false,
                telegram: ChannelSession::default(),
                weixin: ChannelSession::default(),
                pairing: None,
                login: None,
            }),
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP client"),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramSettings {
    enabled: bool,
    bot_name: String,
    allowed_user_id: String,
    has_token: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeixinSettings {
    enabled: bool,
    account_id: String,
    allowed_user_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    telegram: String,
    weixin: String,
    telegram_error: String,
    weixin_error: String,
}

#[derive(Clone, Serialize)]
pub struct ChannelSettings {
    telegram: TelegramSettings,
    weixin: WeixinSettings,
    status: ChannelStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramConnected {
    bot_name: String,
    pairing_code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeixinLoginStarted {
    session_id: String,
    qr_code_url: String,
}

#[derive(Serialize)]
pub struct WeixinLoginStatus {
    status: String,
    connected: bool,
    message: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".coffee-cli").join("channels.json"))
        .ok_or_else(|| "Cannot find the user home directory".into())
}

fn load_config() -> Result<ChannelConfig, String> {
    let path = config_path()?;
    match std::fs::read(path) {
        Ok(data) => {
            serde_json::from_slice(&data).map_err(|_| "Channel settings are damaged".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ChannelConfig::default()),
        Err(error) => Err(format!("Cannot read channel settings: {error}")),
    }
}

fn save_config(config: &ChannelConfig) -> Result<(), String> {
    let path = config_path()?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let data = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, data).map_err(|e| format!("Cannot save channel settings: {e}"))?;
    std::fs::rename(temporary, path).map_err(|e| format!("Cannot replace channel settings: {e}"))
}

fn secret_entry(channel: &str, authorization: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("{channel}-{authorization}"))
        .map_err(|error| format!("OS credential store is unavailable: {error}"))
}

fn read_secret(channel: &str, authorization: &str) -> Result<String, String> {
    secret_entry(channel, authorization)?
        .get_password()
        .map_err(|error| {
            format!("Cannot read {channel} credential; reconnect the channel: {error}")
        })
}

fn forget_secret(channel: &str, authorization: &str) -> Result<(), String> {
    if authorization.is_empty() {
        return Ok(());
    }
    match secret_entry(channel, authorization)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Cannot remove {channel} credential: {error}")),
    }
}

fn install_secret(channel: &str, authorization: &str, token: &str) -> Result<(), String> {
    let entry = secret_entry(channel, authorization)?;
    entry
        .set_password(token)
        .map_err(|e| format!("Cannot save {channel} credential: {e}"))?;
    if entry
        .get_password()
        .map_err(|e| format!("Cannot verify credential storage: {e}"))?
        != token
    {
        return Err("OS credential storage did not retain the token".into());
    }
    Ok(())
}

fn context_account(authorization: &str, recipient: &str) -> String {
    // JSON avoids ambiguous separators in external user IDs.
    format!("weixin-context:{}", json!([authorization, recipient]))
}

fn context_entry(authorization: &str, recipient: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &context_account(authorization, recipient))
        .map_err(|_| "OS credential store is unavailable".into())
}

fn save_notification_context(authorization: &str, recipient: &str, token: &str) -> Result<(), String> {
    let value = serde_json::to_string(&WeixinNotificationContext {
        token: token.into(), received_at: now_ms(),
    }).map_err(|_| "Could not serialize Weixin notification context")?;
    context_entry(authorization, recipient)?.set_password(&value)
        .map_err(|_| "Could not save Weixin notification context".into())
}

fn read_notification_context(authorization: &str, recipient: &str) -> Result<Option<String>, String> {
    match context_entry(authorization, recipient)?.get_password() {
        Ok(raw) => {
            let value: WeixinNotificationContext = serde_json::from_str(&raw)
                .map_err(|_| "Weixin notification context is invalid")?;
            Ok((!value.token.is_empty()).then_some(value.token))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read Weixin notification context".into()),
    }
}

fn forget_notification_context(authorization: &str, recipient: &str) -> Result<(), String> {
    if authorization.is_empty() || recipient.is_empty() { return Ok(()); }
    match context_entry(authorization, recipient)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove Weixin notification context".into()),
    }
}

fn stop_session(session: &mut ChannelSession) {
    if let Some(cancel) = session.cancel.take() {
        let _ = cancel.send(true);
    }
    session.generation += 1;
}

fn session<'a>(state: &'a RuntimeState, channel: &str) -> &'a ChannelSession {
    if channel == "telegram" {
        &state.telegram
    } else {
        &state.weixin
    }
}

fn session_mut<'a>(state: &'a mut RuntimeState, channel: &str) -> &'a mut ChannelSession {
    if channel == "telegram" {
        &mut state.telegram
    } else {
        &mut state.weixin
    }
}

fn snapshot(state: &RuntimeState) -> ChannelSettings {
    ChannelSettings {
        telegram: TelegramSettings {
            enabled: state.config.telegram.enabled,
            bot_name: state.config.telegram.bot_name.clone(),
            allowed_user_id: state.config.telegram.allowed_user_id.clone(),
            has_token: !state.config.telegram.authorization.is_empty(),
        },
        weixin: WeixinSettings {
            enabled: state.config.weixin.enabled,
            account_id: state.config.weixin.account_id.clone(),
            allowed_user_id: state.config.weixin.allowed_user_id.clone(),
        },
        status: ChannelStatus {
            telegram: status_or_disconnected(&state.telegram),
            weixin: status_or_disconnected(&state.weixin),
            telegram_error: channel_error(&state.telegram),
            weixin_error: channel_error(&state.weixin),
        },
    }
}

fn status_or_disconnected(session: &ChannelSession) -> String {
    if !session.delivery_error.is_empty() {
        "error".into()
    } else if session.status.is_empty() {
        "disconnected".into()
    } else {
        session.status.clone()
    }
}

fn channel_error(session: &ChannelSession) -> String {
    [&session.error, &session.delivery_error]
        .into_iter()
        .filter(|error| !error.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn set_delivery_status(app: &AppHandle, channel: &str, generation: u64, error: &str) {
    let runtime = app.state::<ChannelRuntime>();
    if let Ok(mut state) = runtime.state.lock() {
        let current = session_mut(&mut state, channel);
        if current.generation != generation {
            return;
        }
        current.delivery_error = error.into();
    }
    emit_status(app);
}

fn emit_status(app: &AppHandle) {
    let runtime = app.state::<ChannelRuntime>();
    let settings = runtime.state.lock().ok().map(|state| snapshot(&state));
    if let Some(settings) = settings {
        let _ = app.emit("channel-status", settings);
    }
}

fn set_status(app: &AppHandle, channel: &str, generation: u64, status: &str, error: &str) {
    let runtime = app.state::<ChannelRuntime>();
    if let Ok(mut state) = runtime.state.lock() {
        let current = session_mut(&mut state, channel);
        if current.generation != generation {
            return;
        }
        if current.status == status && current.error == error {
            return;
        }
        current.status = status.into();
        current.error = error.into();
    }
    emit_status(app);
}

#[tauri::command]
pub fn channel_get_settings(app: AppHandle) -> Result<ChannelSettings, String> {
    let runtime = app.state::<ChannelRuntime>();
    let state = runtime
        .state
        .lock()
        .map_err(|_| "Channel runtime is unavailable")?;
    if let Some(error) = &state.load_error {
        return Err(error.clone());
    }
    Ok(snapshot(&state))
}

#[tauri::command]
pub async fn channel_connect_telegram(
    app: AppHandle,
    token: String,
) -> Result<TelegramConnected, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Enter a Telegram bot token".into());
    }
    let runtime = app.state::<ChannelRuntime>();
    let generation = {
        let state = runtime
            .state
            .lock()
            .map_err(|_| "Channel runtime is unavailable")?;
        if let Some(error) = &state.load_error {
            return Err(error.clone());
        }
        state.telegram.generation
    };
    let response = telegram_request(&runtime.client, token, "getMe", json!({})).await?;
    let bot_id = response
        .pointer("/result/id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or("Telegram did not return a bot ID")?
        .to_string();
    let bot_name = response
        .pointer("/result/username")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .ok_or("Telegram did not return a bot username")?
        .to_string();
    let webhook = telegram_request(&runtime.client, token, "getWebhookInfo", json!({})).await?;
    if webhook
        .pointer("/result/url")
        .and_then(Value::as_str)
        .is_some_and(|url| !url.is_empty())
    {
        return Err(
            "This bot has an active webhook. Use a dedicated bot or remove its webhook first."
                .into(),
        );
    }
    let authorization = uuid::Uuid::new_v4().simple().to_string();
    let pairing_code = uuid::Uuid::new_v4().simple().to_string()[..12].to_uppercase();
    let old_authorization;
    {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| "Channel runtime is unavailable")?;
        if let Some(error) = &state.load_error {
            return Err(error.clone());
        }
        if state.telegram.generation != generation {
            return Err("Telegram connection was cancelled or replaced".into());
        }
        install_secret("telegram", &authorization, token)?;
        let mut config = state.config.clone();
        old_authorization = config.telegram.authorization.clone();
        let same_legacy_token = config.telegram.bot_id.is_empty()
            && !old_authorization.is_empty()
            && read_secret("telegram", &old_authorization).is_ok_and(|old| old == token);
        config.telegram = telegram_reconnect_config(
            &config.telegram,
            bot_id,
            bot_name.clone(),
            authorization.clone(),
            same_legacy_token,
        );
        if let Err(error) = save_config(&config) {
            let _ = forget_secret("telegram", &authorization);
            return Err(error);
        }
        stop_session(&mut state.telegram);
        state.config = config;
        state.pairing = Some(Pairing {
            code: pairing_code.clone(),
            expires_at: now_ms() + PAIRING_TTL_MS,
            failures: 0,
        });
        state.telegram.status = "waiting_pairing".into();
        state.telegram.error.clear();
        state.telegram.delivery_error.clear();
    }
    if let Err(error) = forget_secret("telegram", &old_authorization) {
        log::warn!("{error}");
    }
    start_channel(app.clone(), "telegram");
    emit_status(&app);
    Ok(TelegramConnected {
        bot_name,
        pairing_code,
    })
}

#[tauri::command]
pub fn channel_disconnect(app: AppHandle, channel: String) -> Result<(), String> {
    if channel != "telegram" && channel != "weixin" {
        return Err("Unknown message channel".into());
    }
    let runtime = app.state::<ChannelRuntime>();
    let authorization;
    let recipient;
    {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| "Channel runtime is unavailable")?;
        let mut config = state.config.clone();
        if channel == "telegram" {
            authorization = config.telegram.authorization.clone();
            recipient = config.telegram.allowed_user_id.clone();
            config.telegram = TelegramConfig::default();
            state.pairing = None;
        } else {
            authorization = config.weixin.authorization.clone();
            recipient = config.weixin.allowed_user_id.clone();
            config.weixin = WeixinConfig::default();
            state.login = None;
        }
        // Revocation takes effect even if credential deletion subsequently fails.
        save_config(&config)?;
        state.config = config;
        let current = session_mut(&mut state, &channel);
        stop_session(current);
        current.status = "disconnected".into();
        current.error.clear();
        current.delivery_error.clear();
    }
    emit_status(&app);
    if channel == "weixin" {
        forget_notification_context(&authorization, &recipient)?;
    }
    forget_secret(&channel, &authorization)
}

fn client_version() -> u32 {
    let mut parts = env!("CARGO_PKG_VERSION")
        .split('.')
        .filter_map(|part| part.parse::<u32>().ok());
    ((parts.next().unwrap_or(0) & 255) << 16)
        | ((parts.next().unwrap_or(0) & 255) << 8)
        | (parts.next().unwrap_or(0) & 255)
}

fn weixin_headers(token: Option<&str>) -> Result<reqwest::header::HeaderMap, String> {
    use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
    let mut headers = HeaderMap::new();
    headers.insert("iLink-App-Id", HeaderValue::from_static("bot"));
    headers.insert(
        "iLink-App-ClientVersion",
        HeaderValue::from_str(&client_version().to_string()).unwrap(),
    );
    if let Some(token) = token {
        headers.insert(
            "AuthorizationType",
            HeaderValue::from_static("ilink_bot_token"),
        );
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| "Invalid Weixin token")?,
        );
    }
    Ok(headers)
}

fn base_info() -> Value {
    json!({"channel_version": env!("CARGO_PKG_VERSION"), "bot_agent": concat!("CoffeeCLI/", env!("CARGO_PKG_VERSION"))})
}

fn service_url(raw: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid Weixin service URL")?;
    let host = url.host_str().ok_or("Invalid Weixin service host")?;
    if url.scheme() != "https"
        || !(host == "weixin.qq.com" || host.ends_with(".weixin.qq.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || (url.path() != "/" && !url.path().is_empty())
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Weixin returned an unsafe service URL".into());
    }
    Ok(format!("https://{host}"))
}

fn weixin_login_tokens(entry: &keyring::Entry) -> Result<Vec<String>, String> {
    match entry.get_password() {
        Ok(token) => Ok(vec![token]),
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(error) => Err(format!("Cannot read weixin credential: {error}")),
    }
}

#[tauri::command]
pub async fn channel_weixin_start(app: AppHandle) -> Result<WeixinLoginStarted, String> {
    let runtime = app.state::<ChannelRuntime>();
    let (local_tokens, generation) = {
        let state = runtime
            .state
            .lock()
            .map_err(|_| "Channel runtime is unavailable")?;
        if let Some(error) = &state.load_error {
            return Err(error.clone());
        }
        let tokens = if state.config.weixin.authorization.is_empty() {
            Vec::new()
        } else {
            weixin_login_tokens(&secret_entry("weixin", &state.config.weixin.authorization)?)?
        };
        (tokens, state.weixin.generation)
    };
    let response = weixin_post(
        &runtime.client,
        WEIXIN_URL,
        "ilink/bot/get_bot_qrcode?bot_type=3",
        None,
        json!({"local_token_list": local_tokens}),
        20,
    )
    .await?;
    let qrcode = response
        .get("qrcode")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Weixin did not return a QR code")?
        .to_string();
    let qr_code_url = response
        .get("qrcode_img_content")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Weixin did not return a QR code URL")?
        .to_string();
    let session_id = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut state = runtime
            .state
            .lock()
            .map_err(|_| "Channel runtime is unavailable")?;
        if state.weixin.generation != generation {
            return Err("Weixin connection was cancelled or replaced".into());
        }
        if state.weixin.cancel.is_none() {
            state.weixin.status = "waiting_scan".into();
            state.weixin.error.clear();
        }
        state.login = Some(WeixinLogin {
            session_id: session_id.clone(),
            qrcode,
            base_url: WEIXIN_URL.into(),
            started_at: now_ms(),
        });
    }
    emit_status(&app);
    Ok(WeixinLoginStarted {
        session_id,
        qr_code_url,
    })
}

#[tauri::command]
pub async fn channel_weixin_poll(
    app: AppHandle,
    session_id: String,
    verify_code: Option<String>,
) -> Result<WeixinLoginStatus, String> {
    let runtime = app.state::<ChannelRuntime>();
    let login = runtime
        .state
        .lock()
        .map_err(|_| "Channel runtime is unavailable")?
        .login
        .clone()
        .filter(|login| login.session_id == session_id)
        .ok_or("Weixin login session expired; connect again")?;
    if now_ms().saturating_sub(login.started_at) > PAIRING_TTL_MS {
        return Ok(WeixinLoginStatus {
            status: "expired".into(),
            connected: false,
            message: "二维码已过期，请重新连接。".into(),
        });
    }
    let mut url = reqwest::Url::parse(&format!("{}/ilink/bot/get_qrcode_status", login.base_url))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("qrcode", &login.qrcode);
    if let Some(code) = verify_code
        .as_deref()
        .map(str::trim)
        .filter(|code| !code.is_empty())
    {
        url.query_pairs_mut().append_pair("verify_code", code);
    }
    let response = runtime
        .client
        .get(url)
        .headers(weixin_headers(None)?)
        .timeout(Duration::from_secs(40))
        .send()
        .await
        .map_err(|e| format!("Cannot check Weixin login: {}", e.without_url()))?;
    let response = decode_response(response).await?;
    let status = response
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("wait");
    let mut state = runtime
        .state
        .lock()
        .map_err(|_| "Channel runtime is unavailable")?;
    if state
        .login
        .as_ref()
        .is_none_or(|active| active.session_id != session_id)
    {
        return Err("Weixin login was cancelled or replaced".into());
    }
    if status == "scaned_but_redirect" {
        if let Some(host) = response.get("redirect_host").and_then(Value::as_str) {
            state.login.as_mut().unwrap().base_url = service_url(&format!("https://{host}"))?;
        }
    }
    if status == "confirmed" {
        let token = required_string(&response, "bot_token")?;
        let account_id = required_string(&response, "ilink_bot_id")?;
        let allowed_user_id = required_string(&response, "ilink_user_id")?;
        let base_url = service_url(
            response
                .get("baseurl")
                .and_then(Value::as_str)
                .unwrap_or(&login.base_url),
        )?;
        let authorization = uuid::Uuid::new_v4().simple().to_string();
        install_secret("weixin", &authorization, &token)?;
        let mut config = state.config.clone();
        let old_authorization = config.weixin.authorization.clone();
        let old_recipient = config.weixin.allowed_user_id.clone();
        config.weixin = weixin_reconnect_config(
            &config.weixin,
            account_id,
            allowed_user_id,
            authorization.clone(),
            base_url,
        );
        if let Err(error) = save_config(&config) {
            let _ = forget_secret("weixin", &authorization);
            return Err(error);
        }
        state.config = config;
        state.login = None;
        stop_session(&mut state.weixin);
        state.weixin.status = "connected".into();
        state.weixin.error.clear();
        state.weixin.delivery_error.clear();
        drop(state);
        if let Err(error) = forget_notification_context(&old_authorization, &old_recipient) {
            log::warn!("{error}");
        }
        if let Err(error) = forget_secret("weixin", &old_authorization) {
            log::warn!("{error}");
        }
        start_channel(app.clone(), "weixin");
        emit_status(&app);
        return Ok(WeixinLoginStatus {
            status: "connected".into(),
            connected: true,
            message: "微信已连接。".into(),
        });
    }
    let message = match status {
        "scaned" => "已扫码，请在手机微信确认。",
        "need_verifycode" => "请输入手机微信显示的验证码。",
        "verify_code_blocked" => "验证次数过多，请重新连接。",
        "expired" => "二维码已过期，请重新连接。",
        "binded_redirect" => "此微信已有连接，请断开后重新绑定。",
        _ => "等待微信扫码。",
    };
    if status == "expired" || status == "verify_code_blocked" {
        state.login = None;
    }
    drop(state);
    Ok(WeixinLoginStatus {
        status: status.into(),
        connected: false,
        message: message.into(),
    })
}

fn required_string(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Weixin login did not return {field}"))
}

struct ApiError {
    message: String,
    retry_after: Option<u64>,
    session_expired: bool,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<ApiError> for String {
    fn from(error: ApiError) -> Self {
        error.message
    }
}

async fn decode_response(response: reqwest::Response) -> Result<Value, ApiError> {
    let status = response.status();
    let header_retry = response
        .headers()
        .get("retry-after")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.parse().ok());
    let value: Value = match response.json().await {
        Ok(value) => value,
        Err(_) if !status.is_success() => Value::Null,
        Err(_) => {
            return Err(ApiError {
                message: "Channel returned an invalid response".into(),
                retry_after: None,
                session_expired: false,
            })
        }
    };
    let code = value
        .get("ret")
        .and_then(Value::as_i64)
        .filter(|code| *code != 0)
        .or_else(|| {
            value
                .get("errcode")
                .and_then(Value::as_i64)
                .filter(|code| *code != 0)
        });
    if !status.is_success()
        || value.get("ok").and_then(Value::as_bool) == Some(false)
        || code.is_some()
    {
        let retry_after = value
            .pointer("/parameters/retry_after")
            .and_then(Value::as_u64)
            .or(header_retry);
        return Err(ApiError {
            message: format!(
                "Channel request failed (HTTP {status}, code {}): {}",
                code.or_else(|| value.get("error_code").and_then(Value::as_i64))
                    .unwrap_or_default(),
                value
                    .get("description")
                    .or_else(|| value.get("errmsg"))
                    .and_then(Value::as_str)
                    .unwrap_or("Service rejected request")
            ),
            retry_after: if status.as_u16() == 429
                || value.get("error_code").and_then(Value::as_i64) == Some(429)
            {
                Some(retry_after.unwrap_or(5).clamp(1, 60))
            } else {
                None
            },
            session_expired: code == Some(-14),
        });
    }
    Ok(value)
}

async fn telegram_request(
    client: &reqwest::Client,
    token: &str,
    method: &str,
    body: Value,
) -> Result<Value, ApiError> {
    let response = client
        .post(format!("https://api.telegram.org/bot{token}/{method}"))
        .timeout(Duration::from_secs(40))
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError {
            message: format!("Telegram request failed: {}", e.without_url()),
            retry_after: None,
            session_expired: false,
        })?;
    decode_response(response).await
}

async fn weixin_post(
    client: &reqwest::Client,
    base: &str,
    endpoint: &str,
    token: Option<&str>,
    body: Value,
    timeout: u64,
) -> Result<Value, ApiError> {
    let base = service_url(base).map_err(|message| ApiError {
        message,
        retry_after: None,
        session_expired: false,
    })?;
    let mut headers = weixin_headers(token).map_err(|message| ApiError {
        message,
        retry_after: None,
        session_expired: false,
    })?;
    headers.insert(
        "AuthorizationType",
        reqwest::header::HeaderValue::from_static("ilink_bot_token"),
    );
    let uin = base64::engine::general_purpose::STANDARD
        .encode((uuid::Uuid::new_v4().as_u128() as u32).to_string());
    headers.insert(
        "X-WECHAT-UIN",
        reqwest::header::HeaderValue::from_str(&uin).unwrap(),
    );
    let response = client
        .post(format!("{base}/{endpoint}"))
        .headers(headers)
        .timeout(Duration::from_secs(timeout))
        .json(&body)
        .send()
        .await
        .map_err(|e| ApiError {
            message: format!("Weixin request failed: {}", e.without_url()),
            retry_after: None,
            session_expired: false,
        })?;
    decode_response(response).await
}

async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    while cancel.changed().await.is_ok() {
        if *cancel.borrow() {
            return;
        }
    }
}

pub fn start_saved(app: AppHandle) {
    let runtime = app.state::<ChannelRuntime>();
    if let Ok(mut state) = runtime.state.lock() {
        if state.ready {
            return;
        }
        state.ready = true;
        if let Some(error) = state.load_error.clone() {
            state.telegram.status = "error".into();
            state.telegram.error = error.clone();
            state.weixin.status = "error".into();
            state.weixin.error = error;
            drop(state);
            emit_status(&app);
            return;
        }
    }
    start_channel(app.clone(), "telegram");
    start_channel(app.clone(), "weixin");
    emit_status(&app);
}

fn start_channel(app: AppHandle, channel: &'static str) {
    let (config, token, generation, cancel) = {
        let runtime = app.state::<ChannelRuntime>();
        let Ok(mut state) = runtime.state.lock() else {
            return;
        };
        if !state.ready || session(&state, channel).cancel.is_some() {
            return;
        }
        let (enabled, authorization) = if channel == "telegram" {
            (
                state.config.telegram.enabled,
                state.config.telegram.authorization.clone(),
            )
        } else {
            (
                state.config.weixin.enabled,
                state.config.weixin.authorization.clone(),
            )
        };
        if !enabled {
            return;
        }
        let token = match read_secret(channel, &authorization) {
            Ok(token) => token,
            Err(error) => {
                let current = session_mut(&mut state, channel);
                current.status = "error".into();
                current.error = error;
                return;
            }
        };
        let config = state.config.clone();
        let current = session_mut(&mut state, channel);
        let (sender, cancel) = watch::channel(false);
        current.cancel = Some(sender);
        // A freshly confirmed Weixin login has already authenticated the token;
        // don't wait for the first idle long poll to report it as connected.
        if current.status != "connected" {
            current.status = "connecting".into();
        }
        current.error.clear();
        (config, token, current.generation, cancel)
    };
    tauri::async_runtime::spawn(async move {
        receive_loop(app, channel, config, token, generation, cancel).await;
    });
}

fn telegram_input(update: &Value) -> Option<(i64, String, String, String)> {
    let message = update.get("message")?;
    if message.pointer("/chat/type")?.as_str()? != "private" {
        return None;
    }
    let id = update.get("update_id")?.as_i64()?;
    let user = message.pointer("/from/id")?.as_i64()?.to_string();
    let chat = message.pointer("/chat/id")?.as_i64()?.to_string();
    let text = message.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some((id, user, chat, text.into()))
}

fn consume_pairing(pairing: &mut Option<Pairing>, text: &str, now: u64) -> bool {
    let Some(active) = pairing.as_mut() else {
        return false;
    };
    if !text.starts_with("/pair") || active.expires_at <= now || active.failures >= 20 {
        return false;
    }
    if text != format!("/pair {}", active.code) {
        active.failures += 1;
        return false;
    }
    *pairing = None;
    true
}

fn refresh_telegram_offset(config: &mut TelegramConfig, now: u64) -> bool {
    if config.last_received_update_at == 0 {
        config.last_received_update_at = now;
        return true;
    }
    if now.saturating_sub(config.last_received_update_at) >= TELEGRAM_IDLE_RESET_MS {
        // Telegram can choose a lower random ID after a week without updates.
        // Already consumed updates expire from its queue after 24 hours.
        config.offset = 0;
        config.last_received_update_at = now;
        return true;
    }
    false
}

fn acknowledge_telegram(config: &mut TelegramConfig, update_id: i64, received_at: u64) -> bool {
    config.last_received_update_at = received_at;
    if update_id < config.offset {
        return false;
    }
    config.offset = config.offset.max(update_id.saturating_add(1));
    true
}

fn remember_weixin(config: &mut WeixinConfig, id: String) -> bool {
    if config.recent_ids.contains(&id) {
        return false;
    }
    config.recent_ids.push(id);
    if config.recent_ids.len() > 256 {
        config.recent_ids.remove(0);
    }
    true
}

fn weixin_input(message: &Value, allowed_user: &str) -> Option<(String, String, String, String)> {
    if message.get("message_type")?.as_i64()? != 1
        || message.get("from_user_id")?.as_str()? != allowed_user
    {
        return None;
    }
    if message
        .get("group_id")
        .and_then(Value::as_str)
        .is_some_and(|group| !group.is_empty())
    {
        return None;
    }
    let id = message.get("message_id")?.to_string();
    let text = message
        .get("item_list")?
        .as_array()?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_i64) == Some(1))
        .filter_map(|item| item.pointer("/text_item/text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let context = message.get("context_token")?.as_str()?.to_string();
    if text.trim().is_empty() || context.is_empty() {
        return None;
    }
    Some((id, allowed_user.into(), text.trim().into(), context))
}

async fn receive_loop(
    app: AppHandle,
    channel: &'static str,
    mut config: ChannelConfig,
    token: String,
    generation: u64,
    mut cancel: watch::Receiver<bool>,
) {
    let mut backoff = 2u64;
    loop {
        let runtime = app.state::<ChannelRuntime>();
        if channel == "telegram" {
            let mut state = match runtime.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if state.telegram.generation != generation {
                return;
            }
            let mut next = state.config.clone();
            if refresh_telegram_offset(&mut next.telegram, now_ms()) {
                if let Err(error) = save_config(&next) {
                    drop(state);
                    set_status(&app, channel, generation, "error", &error);
                    return;
                }
                state.config = next.clone();
                config = next;
            }
        }
        let receive = async {
            if channel == "telegram" {
                telegram_request(&runtime.client, &token, "getUpdates", json!({"offset": config.telegram.offset, "timeout": 30, "allowed_updates": ["message"]})).await
            } else {
                weixin_post(
                    &runtime.client,
                    &config.weixin.base_url,
                    "ilink/bot/getupdates",
                    Some(&token),
                    json!({"get_updates_buf": config.weixin.cursor, "base_info": base_info()}),
                    40,
                )
                .await
            }
        };
        let response = tokio::select! { biased; _ = cancelled(&mut cancel) => return, response = receive => response };
        let response = match response {
            Ok(response) => {
                backoff = 2;
                response
            }
            Err(error) => {
                set_status(&app, channel, generation, "error", &error.message);
                if error.session_expired {
                    return;
                }
                let delay = error.retry_after.unwrap_or(backoff);
                backoff = (backoff * 2).min(60);
                tokio::select! { biased; _ = cancelled(&mut cancel) => return, _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
                continue;
            }
        };
        let mut accepted = Vec::new();
        let mut paired_reply = None;
        let mut notification_context_received = false;
        let mut notification_context_error = None;
        {
            let mut state = match runtime.state.lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            if session(&state, channel).generation != generation {
                return;
            }
            let mut next = state.config.clone();
            if channel == "telegram" {
                for update in response
                    .get("result")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(update_id) = update.get("update_id").and_then(Value::as_i64) else {
                        continue;
                    };
                    if !acknowledge_telegram(&mut next.telegram, update_id, now_ms()) {
                        continue;
                    }
                    let Some((_, user, chat, text)) = telegram_input(update) else {
                        continue;
                    };
                    if next.telegram.allowed_user_id.is_empty() {
                        if consume_pairing(&mut state.pairing, &text, now_ms()) {
                            bind_telegram_user(&mut next.telegram, user);
                            paired_reply = Some(chat);
                        }
                    } else if user == next.telegram.allowed_user_id {
                        accepted.push((chat, text, String::new()));
                    }
                }
            } else {
                if let Some(cursor) = response
                    .get("get_updates_buf")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    next.weixin.cursor = cursor.into();
                }
                for message in response
                    .get("msgs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some((id, user, text, context)) =
                        weixin_input(message, &next.weixin.allowed_user_id)
                    else {
                        continue;
                    };
                    if !remember_weixin(&mut next.weixin, id) {
                        continue;
                    }
                    match save_notification_context(&next.weixin.authorization, &user, &context) {
                        Ok(()) => notification_context_received = true,
                        Err(error) => notification_context_error = Some(error),
                    }
                    accepted.push((user, text, context));
                }
            }
            // Acknowledge before running tools: a crash may lose a request, but
            // must never silently rerun a destructive request on restart.
            if next != state.config {
                if let Err(error) = save_config(&next) {
                    drop(state);
                    set_status(&app, channel, generation, "error", &error);
                    return;
                }
            }
            state.config = next.clone();
            config = next;
        }
        let pairing_problem = if channel == "telegram" && config.telegram.allowed_user_id.is_empty()
        {
            let state = runtime.state.lock().unwrap();
            state
                .pairing
                .as_ref()
                .is_none_or(|pair| pair.expires_at <= now_ms() || pair.failures >= 20)
        } else {
            false
        };
        set_status(
            &app,
            channel,
            generation,
            if pairing_problem {
                "error"
            } else if channel == "telegram" && config.telegram.allowed_user_id.is_empty() {
                "waiting_pairing"
            } else {
                "connected"
            },
            if pairing_problem {
                "Pairing expired or unavailable. Reconnect Telegram to generate a new code."
            } else {
                ""
            },
        );
        if let Some(error) = notification_context_error {
            set_delivery_status(&app, channel, generation, &error);
        }
        if notification_context_received {
            crate::agent_sentinel::resume_pending(app.clone());
        }
        if let Some(chat) = paired_reply {
            let app = app.clone();
            let token = token.clone();
            let config = config.clone();
            let cancel = cancel.clone();
            tauri::async_runtime::spawn(async move {
                reply_message(
                    app,
                    channel,
                    config,
                    token,
                    chat,
                    String::new(),
                    "Coffee CLI 已连接。现在可以查询会话或向 Agent 发送任务。使用 /cancel 可取消当前 Agent 请求。".into(),
                    generation,
                    cancel,
                )
                .await;
            });
        }
        let last_cancel = accepted
            .iter()
            .rposition(|(_, text, _)| is_cancel_command(text));
        for (index, (recipient, text, context)) in accepted.into_iter().enumerate() {
            // A cancellation also drops not-yet-dispatched requests in this batch.
            if last_cancel.is_some_and(|position| index < position) {
                continue;
            }
            let cancellation = if is_cancel_command(&text) {
                let running = {
                    let state = match runtime.state.lock() {
                        Ok(state) => state,
                        Err(_) => return,
                    };
                    if session(&state, channel).generation != generation || *cancel.borrow() {
                        return;
                    }
                    // Keep revocation from racing a cancellation on the stable route.
                    crate::agent::cancel_route(&app, &conversation_id(channel, &config))
                };
                Some(if running || index > 0 {
                    "已取消当前 Agent 请求。已经提交的操作可能仍会完成；这不会关闭或中断 CLI 会话。"
                } else {
                    "当前没有正在执行的 Agent 请求。这不会关闭或中断 CLI 会话。"
                }.to_string())
            } else {
                None
            };
            let app = app.clone();
            let config = config.clone();
            let token = token.clone();
            let cancel = cancel.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(reply) = cancellation {
                    reply_message(
                        app, channel, config, token, recipient, context, reply, generation, cancel,
                    )
                    .await;
                } else {
                    process_message(
                        app, channel, config, token, recipient, text, context, generation, cancel,
                    )
                    .await;
                }
            });
        }
    }
}

fn is_cancel_command(text: &str) -> bool {
    matches!(text.trim(), "/cancel" | "取消当前请求")
}

fn conversation_id(channel: &str, config: &ChannelConfig) -> String {
    if channel == "telegram" {
        saved_route(
            channel,
            &config.telegram.authorization,
            &config.telegram.conversation_route,
        )
    } else {
        saved_route(
            channel,
            &config.weixin.authorization,
            &config.weixin.conversation_route,
        )
    }
}

fn saved_route(channel: &str, authorization: &str, route: &str) -> String {
    if route.is_empty() {
        format!("{channel}-{authorization}")
    } else {
        route.into()
    }
}

fn telegram_reconnect_config(
    previous: &TelegramConfig,
    bot_id: String,
    bot_name: String,
    authorization: String,
    same_legacy_token: bool,
) -> TelegramConfig {
    let same_bot = previous.bot_id == bot_id || (previous.bot_id.is_empty() && same_legacy_token);
    let (pending_resume_user_id, pending_resume_route) = if same_bot {
        if previous.allowed_user_id.is_empty() {
            (
                previous.pending_resume_user_id.clone(),
                previous.pending_resume_route.clone(),
            )
        } else {
            (
                previous.allowed_user_id.clone(),
                saved_route(
                    "telegram",
                    &previous.authorization,
                    &previous.conversation_route,
                ),
            )
        }
    } else {
        (String::new(), String::new())
    };
    TelegramConfig {
        enabled: true,
        bot_name,
        bot_id,
        authorization,
        conversation_route: format!("telegram-{}", uuid::Uuid::new_v4().simple()),
        pending_resume_user_id,
        pending_resume_route,
        offset: if same_bot { previous.offset } else { 0 },
        last_received_update_at: if same_bot {
            previous.last_received_update_at
        } else {
            0
        },
        ..TelegramConfig::default()
    }
}

fn bind_telegram_user(config: &mut TelegramConfig, user: String) {
    if user == config.pending_resume_user_id && !config.pending_resume_route.is_empty() {
        config.conversation_route = config.pending_resume_route.clone();
    }
    config.allowed_user_id = user;
    config.pending_resume_user_id.clear();
    config.pending_resume_route.clear();
}

fn weixin_reconnect_config(
    previous: &WeixinConfig,
    account_id: String,
    allowed_user_id: String,
    authorization: String,
    base_url: String,
) -> WeixinConfig {
    let same_identity =
        previous.account_id == account_id && previous.allowed_user_id == allowed_user_id;
    WeixinConfig {
        enabled: true,
        account_id,
        allowed_user_id,
        authorization,
        conversation_route: if same_identity {
            saved_route(
                "weixin",
                &previous.authorization,
                &previous.conversation_route,
            )
        } else {
            format!("weixin-{}", uuid::Uuid::new_v4().simple())
        },
        base_url,
        cursor: if same_identity {
            previous.cursor.clone()
        } else {
            String::new()
        },
        recent_ids: if same_identity {
            previous.recent_ids.clone()
        } else {
            Vec::new()
        },
    }
}

async fn process_message(
    app: AppHandle,
    channel: &'static str,
    config: ChannelConfig,
    token: String,
    recipient: String,
    text: String,
    context: String,
    generation: u64,
    mut cancel: watch::Receiver<bool>,
) {
    let conversation = conversation_id(channel, &config);
    let response = tokio::select! { biased;
        _ = cancelled(&mut cancel) => return,
        result = async {
            if crate::agent::is_new_conversation_command(&text) {
                crate::agent::agent_new_conversation(app.clone(), conversation).map(|_| "已开始新对话，长期记忆和旧对话仍保留；CLI 标签没有关闭。".into())
            } else { crate::agent::run_message(app.clone(), conversation, text).await }
        } => match result { Ok(text) => text, Err(error) if error == "Cancelled" => return, Err(error) => format!("Agent 未完成请求：{error}") },
    };
    reply_message(
        app, channel, config, token, recipient, context, response, generation, cancel,
    )
    .await;
}

async fn reply_message(
    app: AppHandle,
    channel: &'static str,
    config: ChannelConfig,
    token: String,
    recipient: String,
    context: String,
    response: String,
    generation: u64,
    cancel: watch::Receiver<bool>,
) {
    match send_text(
        &app, channel, &config, &token, &recipient, &context, &response, cancel,
    )
    .await
    {
        Ok(()) => set_delivery_status(&app, channel, generation, ""),
        Err(error) => set_delivery_status(
            &app,
            channel,
            generation,
            &format!(
                "Reply was not delivered: {error}. Send another message to query the conversation."
            ),
        ),
    }
}

fn split_text(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    for (index, character) in text.chars().enumerate() {
        if index > 0 && index % 3900 == 0 {
            parts.push(std::mem::take(&mut current));
        }
        current.push(character);
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

async fn send_text(
    app: &AppHandle,
    channel: &str,
    config: &ChannelConfig,
    token: &str,
    recipient: &str,
    context: &str,
    text: &str,
    mut cancel: watch::Receiver<bool>,
) -> Result<(), String> {
    let runtime = app.state::<ChannelRuntime>();
    for (part_index, part) in split_text(text).into_iter().enumerate() {
        if part_index > 0 {
            tokio::select! { biased; _ = cancelled(&mut cancel) => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
        }
        let client_id = format!("coffee:{}", uuid::Uuid::new_v4().simple());
        for attempt in 0..3 {
            let send = async {
                if channel == "telegram" {
                    telegram_request(&runtime.client, token, "sendMessage", json!({"chat_id": recipient, "text": part, "link_preview_options": {"is_disabled": true}})).await
                } else {
                    weixin_post(&runtime.client, &config.weixin.base_url, "ilink/bot/sendmessage", Some(token), json!({"msg": {"from_user_id": "", "to_user_id": recipient, "client_id": client_id, "message_type": 2, "message_state": 2, "context_token": context, "item_list": [{"type": 1, "text_item": {"text": part}}]}, "base_info": base_info()}), 20).await
                }
            };
            let result = tokio::select! { biased; _ = cancelled(&mut cancel) => return Ok(()), result = send => result };
            match result {
                Ok(_) => break,
                Err(error) => {
                    // Retrying an ambiguous timeout may duplicate a Telegram
                    // message. Only retry explicit service rate-limit replies.
                    let Some(delay) = error.retry_after.filter(|_| attempt < 2) else {
                        return Err(error.message);
                    };
                    tokio::select! { biased; _ = cancelled(&mut cancel) => return Ok(()), _ = tokio::time::sleep(Duration::from_secs(delay)) => {} }
                }
            }
        }
    }
    Ok(())
}

fn frozen_target_matches(config: &ChannelConfig, current: &ChannelSession, target: &FrozenNotificationTarget) -> bool {
    let (enabled, authorization, recipient, route) = match target.channel.as_str() {
        "telegram" => (config.telegram.enabled, &config.telegram.authorization, &config.telegram.allowed_user_id, conversation_id("telegram", config)),
        "weixin" => (config.weixin.enabled, &config.weixin.authorization, &config.weixin.allowed_user_id, conversation_id("weixin", config)),
        _ => return false,
    };
    enabled && !recipient.is_empty() && authorization == &target.authorization
        && recipient == &target.recipient && route == target.route
        && current.generation == target.generation && current.cancel.is_some()
}

pub(crate) fn notification_targets(app: &AppHandle) -> Result<Vec<FrozenNotificationTarget>, String> {
    let runtime = app.state::<ChannelRuntime>();
    let state = runtime.state.lock().map_err(|_| "Channel runtime is unavailable")?;
    let mut targets = Vec::new();
    for channel in ["telegram", "weixin"] {
        let (enabled, authorization, recipient) = if channel == "telegram" {
            (state.config.telegram.enabled, &state.config.telegram.authorization, &state.config.telegram.allowed_user_id)
        } else {
            (state.config.weixin.enabled, &state.config.weixin.authorization, &state.config.weixin.allowed_user_id)
        };
        let current = session(&state, channel);
        if enabled && !authorization.is_empty() && !recipient.is_empty() && current.cancel.is_some() {
            targets.push(FrozenNotificationTarget {
                channel: channel.into(), authorization: authorization.clone(), recipient: recipient.clone(),
                route: conversation_id(channel, &state.config), generation: current.generation,
            });
        }
    }
    Ok(targets)
}

pub(crate) fn notification_context_ready(app: &AppHandle, target: &FrozenNotificationTarget) -> bool {
    let runtime = app.state::<ChannelRuntime>();
    runtime.state.lock().ok().is_some_and(|state| {
        frozen_target_matches(&state.config, session(&state, &target.channel), target)
            && read_notification_context(&target.authorization, &target.recipient).ok().flatten().is_some()
    })
}

fn rejected_notification_context(error: &ApiError) -> bool {
    let message = error.message.to_ascii_lowercase();
    error.session_expired || (message.contains("code -2):")
        && (message.contains("prepare failed") || message.contains("unknown error")))
}

fn notification_retry_delay(error: &ApiError, attempt: usize) -> Option<u64> {
    error.retry_after.filter(|_| attempt < 2)
}

/// At most one accepted send; only explicit rate-limit refusals are retried.
pub(crate) async fn notify_frozen_target(
    app: &AppHandle, target: &FrozenNotificationTarget, text: &str, mode_epoch: u64,
) -> NotificationDelivery {
    if !crate::agent_sentinel::enabled_epoch(app, mode_epoch) { return NotificationDelivery::Revoked; }
    if text.is_empty() || text.chars().count() > 3900 {
        return NotificationDelivery::Failed("Notification text is too long or empty".into());
    }
    let runtime = app.state::<ChannelRuntime>();
    let loaded = {
        let state = match runtime.state.lock() {
            Ok(state) => state,
            Err(_) => return NotificationDelivery::Failed("Channel runtime is unavailable".into()),
        };
        if !frozen_target_matches(&state.config, session(&state, &target.channel), target) {
            return NotificationDelivery::Revoked;
        }
        let token = read_secret(&target.channel, &target.authorization);
        let context = if target.channel == "weixin" {
            read_notification_context(&target.authorization, &target.recipient)
        } else { Ok(Some(String::new())) };
        (state.config.clone(), token, context, session(&state, &target.channel).cancel.as_ref().unwrap().subscribe())
    };
    let (config, token, context, mut cancel) = loaded;
    let token = match token {
        Ok(token) => token,
        Err(error) => return NotificationDelivery::Failed(error),
    };
    let context = match context {
        Ok(Some(context)) => context,
        Ok(None) => {
            set_delivery_status(app, &target.channel, target.generation, "Weixin notification is waiting for a message from the paired user.");
            return NotificationDelivery::NeedsContext;
        }
        Err(error) => return NotificationDelivery::Failed(error),
    };
    let client_id = format!("coffee:{}", uuid::Uuid::new_v4().simple());
    let mut epoch_changes = crate::agent_sentinel::epoch_changes();
    for attempt in 0..3 {
        if !crate::agent_sentinel::enabled_epoch(app, mode_epoch) {
            return NotificationDelivery::Revoked;
        }
        {
            let state = match runtime.state.lock() {
                Ok(state) => state,
                Err(_) => return NotificationDelivery::Failed("Channel runtime is unavailable".into()),
            };
            if !frozen_target_matches(&state.config, session(&state, &target.channel), target) {
                return NotificationDelivery::Revoked;
            }
        }
        let send = async {
            if target.channel == "telegram" {
                telegram_request(&runtime.client, &token, "sendMessage", json!({"chat_id":target.recipient,"text":text,"link_preview_options":{"is_disabled":true}})).await
            } else {
                weixin_post(&runtime.client, &config.weixin.base_url, "ilink/bot/sendmessage", Some(&token), json!({"msg":{"from_user_id":"","to_user_id":target.recipient,"client_id":client_id,"message_type":2,"message_state":2,"context_token":context,"item_list":[{"type":1,"text_item":{"text":text}}]},"base_info":base_info()}), 20).await
            }
        };
        let result = tokio::select! { biased;
            _ = cancelled(&mut cancel) => return NotificationDelivery::Revoked,
            _ = crate::agent_sentinel::epoch_cancelled(&mut epoch_changes, mode_epoch) => return NotificationDelivery::Revoked,
            result = send => result,
        };
        match result {
            Ok(_) => {
                set_delivery_status(app, &target.channel, target.generation, "");
                return NotificationDelivery::Delivered;
            }
            Err(error) if target.channel == "weixin" && rejected_notification_context(&error) => {
                // Only clear the token used by this request; a new inbound token may already exist.
                if let Ok(state) = runtime.state.lock() {
                    if frozen_target_matches(&state.config, session(&state, &target.channel), target)
                        && read_notification_context(&target.authorization, &target.recipient).ok().flatten().as_deref() == Some(&context)
                    {
                        if let Err(error) = forget_notification_context(&target.authorization, &target.recipient) {
                            return NotificationDelivery::Failed(error);
                        }
                    }
                }
                set_delivery_status(app, &target.channel, target.generation, "Weixin rejected the notification context. Send another message or reconnect to restore notifications.");
                return NotificationDelivery::NeedsContext;
            }
            Err(error) => {
                let Some(delay) = notification_retry_delay(&error, attempt) else {
                    let message = "Sentinel notification was not delivered; delivery may be uncertain. It will not be sent again automatically.";
                    set_delivery_status(app, &target.channel, target.generation, message);
                    return NotificationDelivery::Failed(message.into());
                };
                tokio::select! { biased;
                    _ = cancelled(&mut cancel) => return NotificationDelivery::Revoked,
                    _ = crate::agent_sentinel::epoch_cancelled(&mut epoch_changes, mode_epoch) => return NotificationDelivery::Revoked,
                    _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                }
            }
        }
    }
    NotificationDelivery::Failed("Notification was not delivered".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notifications_stay_bound_to_the_paired_owner_and_connection_generation() {
        for channel in ["weixin", "telegram"] {
            let mut config = ChannelConfig::default();
            if channel == "weixin" {
                config.weixin.enabled = true;
                config.weixin.authorization = "auth".into();
                config.weixin.allowed_user_id = "owner".into();
            } else {
                config.telegram.enabled = true;
                config.telegram.authorization = "auth".into();
                config.telegram.allowed_user_id = "owner".into();
            }
            let (sender, _receiver) = watch::channel(false);
            let mut current = ChannelSession { generation: 7, cancel: Some(sender), ..ChannelSession::default() };
            let target = FrozenNotificationTarget { channel: channel.into(), authorization: "auth".into(), recipient: "owner".into(), route: conversation_id(channel, &config), generation: 7 };
            assert!(frozen_target_matches(&config, &current, &target));
            for mutation in 0..3 {
                let mut changed = target.clone();
                match mutation {
                    0 => changed.recipient = "other-user".into(),
                    1 => changed.authorization = "new-login".into(),
                    _ => changed.route = "desktop".into(),
                }
                assert!(!frozen_target_matches(&config, &current, &changed));
            }
            current.generation += 1;
            assert!(!frozen_target_matches(&config, &current, &target));
            current.generation = target.generation;
            current.cancel = None;
            assert!(!frozen_target_matches(&config, &current, &target));
        }
        assert_ne!(context_account("old", "owner"), context_account("new", "owner"));
        assert_ne!(context_account("auth", "owner"), context_account("auth", "other"));
        assert_ne!(context_account("a-b", "c"), context_account("a", "b-c"));
    }

    #[test]
    fn only_explicit_context_refusals_wait_for_a_new_message_and_timeouts_are_not_retried() {
        let timeout = ApiError { message: "request timed out".into(), retry_after: None, session_expired: false };
        assert!(!rejected_notification_context(&timeout));
        assert_eq!(notification_retry_delay(&timeout, 0), None);
        for message in ["Channel request failed (HTTP 200 OK, code -2): prepare failed", "Channel request failed (HTTP 200 OK, code -2): unknown error"] {
            let refusal = ApiError { message: message.into(), retry_after: None, session_expired: false };
            assert!(rejected_notification_context(&refusal));
        }
        let expired = ApiError { message: "session expired".into(), retry_after: None, session_expired: true };
        assert!(rejected_notification_context(&expired));
        let rate_limit = ApiError { message: "HTTP 429".into(), retry_after: Some(5), session_expired: false };
        assert!(!rejected_notification_context(&rate_limit));
        assert_eq!(notification_retry_delay(&rate_limit, 0), Some(5));
        assert_eq!(notification_retry_delay(&rate_limit, 2), None);
    }

    #[test]
    fn legacy_channel_settings_keep_their_original_conversation_routes() {
        let config: ChannelConfig = serde_json::from_value(json!({
            "telegram": {
                "enabled": true, "botName": "old_bot", "allowedUserId": "42",
                "authorization": "old-telegram", "offset": 100
            },
            "weixin": {
                "enabled": true, "accountId": "account", "allowedUserId": "owner",
                "authorization": "old-weixin", "baseUrl": WEIXIN_URL,
                "cursor": "cursor", "recentIds": ["seen"]
            }
        }))
        .unwrap();
        assert_eq!(
            conversation_id("telegram", &config),
            "telegram-old-telegram"
        );
        assert_eq!(conversation_id("weixin", &config), "weixin-old-weixin");
        let pending = telegram_reconnect_config(
            &config.telegram,
            "123".into(),
            "old_bot".into(),
            "new".into(),
            true,
        );
        assert_eq!(pending.pending_resume_route, "telegram-old-telegram");
        let unverified = telegram_reconnect_config(
            &config.telegram,
            "123".into(),
            "old_bot".into(),
            "new".into(),
            false,
        );
        assert!(unverified.pending_resume_route.is_empty());
        assert_eq!(unverified.offset, 0);
    }

    #[test]
    fn telegram_reconnect_resumes_only_after_the_same_bot_and_user_pair() {
        let previous = TelegramConfig {
            bot_id: "123".into(),
            allowed_user_id: "42".into(),
            authorization: "old".into(),
            conversation_route: "telegram-history".into(),
            offset: 100,
            ..TelegramConfig::default()
        };
        let pending = telegram_reconnect_config(
            &previous,
            "123".into(),
            "renamed_bot".into(),
            "new".into(),
            false,
        );
        assert!(pending.allowed_user_id.is_empty());
        assert_ne!(pending.conversation_route, previous.conversation_route);
        assert_eq!(pending.authorization, "new");
        assert_eq!(pending.offset, 100);
        let restored: TelegramConfig =
            serde_json::from_slice(&serde_json::to_vec(&pending).unwrap()).unwrap();
        let mut reconnected = telegram_reconnect_config(
            &restored,
            "123".into(),
            "renamed_bot".into(),
            "newer".into(),
            false,
        );
        bind_telegram_user(&mut reconnected, "42".into());
        assert_eq!(reconnected.conversation_route, previous.conversation_route);
        assert!(reconnected.pending_resume_user_id.is_empty());
        assert!(reconnected.pending_resume_route.is_empty());
        let mut new_user = pending;
        bind_telegram_user(&mut new_user, "43".into());
        assert_ne!(new_user.conversation_route, previous.conversation_route);
        let mut new_bot = telegram_reconnect_config(
            &previous,
            "456".into(),
            "old_bot".into(),
            "new".into(),
            false,
        );
        bind_telegram_user(&mut new_bot, "42".into());
        assert_ne!(new_bot.conversation_route, previous.conversation_route);
        assert_eq!(new_bot.offset, 0);
    }

    #[test]
    fn weixin_reconnect_keeps_history_and_acknowledgements_only_for_the_same_identity() {
        let previous = WeixinConfig {
            account_id: "account".into(),
            allowed_user_id: "owner".into(),
            authorization: "old".into(),
            cursor: "cursor".into(),
            recent_ids: vec!["seen".into()],
            ..WeixinConfig::default()
        };
        let same = weixin_reconnect_config(
            &previous,
            "account".into(),
            "owner".into(),
            "new".into(),
            WEIXIN_URL.into(),
        );
        assert_eq!(same.conversation_route, "weixin-old");
        assert_eq!(same.authorization, "new");
        assert_eq!(same.cursor, previous.cursor);
        assert_eq!(same.recent_ids, previous.recent_ids);
        for (account, user) in [("other", "owner"), ("account", "other")] {
            let changed = weixin_reconnect_config(
                &previous,
                account.into(),
                user.into(),
                "new".into(),
                WEIXIN_URL.into(),
            );
            assert_ne!(changed.conversation_route, same.conversation_route);
            assert!(changed.cursor.is_empty());
            assert!(changed.recent_ids.is_empty());
        }
    }

    #[test]
    fn reconnected_channels_retain_persisted_conversations_and_memory_without_sharing_owners() {
        let directory =
            std::env::temp_dir().join(format!("coffee-channel-memory-{}", uuid::Uuid::new_v4()));
        let mut store = crate::agent_memory::Store::open(&directory).unwrap();
        let old = ChannelConfig {
            telegram: TelegramConfig {
                bot_id: "123".into(),
                allowed_user_id: "42".into(),
                authorization: "old-telegram".into(),
                ..TelegramConfig::default()
            },
            weixin: WeixinConfig {
                account_id: "account".into(),
                allowed_user_id: "owner".into(),
                authorization: "old-weixin".into(),
                ..WeixinConfig::default()
            },
        };
        let mut next = ChannelConfig {
            telegram: telegram_reconnect_config(
                &old.telegram,
                "123".into(),
                "bot".into(),
                "new-telegram".into(),
                false,
            ),
            weixin: weixin_reconnect_config(
                &old.weixin,
                "account".into(),
                "owner".into(),
                "new-weixin".into(),
                WEIXIN_URL.into(),
            ),
        };
        bind_telegram_user(&mut next.telegram, "42".into());
        let next: ChannelConfig =
            serde_json::from_slice(&serde_json::to_vec(&next).unwrap()).unwrap();
        for channel in ["telegram", "weixin"] {
            let original_route = conversation_id(channel, &old);
            let id = store.resolve(&original_route).unwrap();
            store.append(&id, "user", "remember my work").unwrap();
            store
                .save_memory(&original_route, None, "report in Chinese")
                .unwrap();
            let reconnected_route = conversation_id(channel, &next);
            assert_eq!(store.resolve(&reconnected_route).unwrap(), id);
            assert_eq!(
                store.context(&id).unwrap().messages[0].text,
                "remember my work"
            );
            assert_eq!(store.memories(&reconnected_route).unwrap().len(), 1);
        }
        let mut changed = next.clone();
        changed.telegram = telegram_reconnect_config(
            &next.telegram,
            "123".into(),
            "bot".into(),
            "other".into(),
            false,
        );
        bind_telegram_user(&mut changed.telegram, "43".into());
        changed.weixin = weixin_reconnect_config(
            &next.weixin,
            "account".into(),
            "other".into(),
            "other".into(),
            WEIXIN_URL.into(),
        );
        drop(store);
        let mut reopened = crate::agent_memory::Store::open(&directory).unwrap();
        for channel in ["telegram", "weixin"] {
            assert_eq!(
                reopened
                    .memories(&conversation_id(channel, &next))
                    .unwrap()
                    .len(),
                1
            );
            let changed_route = conversation_id(channel, &changed);
            assert!(reopened.memories(&changed_route).unwrap().is_empty());
            let id = reopened.resolve(&changed_route).unwrap();
            assert!(reopened.context(&id).unwrap().messages.is_empty());
        }
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn weixin_reconnect_allows_missing_credentials_but_reports_storage_failures() {
        let entry =
            keyring::Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        assert!(weixin_login_tokens(&entry).unwrap().is_empty());
        entry.set_password("existing-token").unwrap();
        assert_eq!(weixin_login_tokens(&entry).unwrap(), vec!["existing-token"]);
        entry.delete_credential().unwrap();
        assert!(weixin_login_tokens(&entry).unwrap().is_empty());
        let mock = entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap();
        for error in [
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("locked"))),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("unavailable"))),
        ] {
            mock.set_error(error);
            assert!(weixin_login_tokens(&entry).is_err());
        }
    }

    #[test]
    fn pairing_code_is_exact_expiring_and_consumed_once() {
        let mut pairing = Some(Pairing {
            code: "ABC123".into(),
            expires_at: 100,
            failures: 0,
        });
        assert!(!consume_pairing(&mut pairing, "/pair wrong", 10));
        assert_eq!(pairing.as_ref().unwrap().failures, 1);
        assert!(!consume_pairing(&mut pairing, "/pair ABC123 extra", 10));
        assert!(!consume_pairing(&mut pairing, "/pair ABC123", 100));
        assert!(consume_pairing(&mut pairing, "/pair ABC123", 99));
        assert!(!consume_pairing(&mut pairing, "/pair ABC123", 99));
        pairing = Some(Pairing {
            code: "ABC123".into(),
            expires_at: 100,
            failures: 20,
        });
        assert!(!consume_pairing(&mut pairing, "/pair ABC123", 10));
    }

    #[test]
    fn persisted_acknowledgements_prevent_restart_replay() {
        let mut config = ChannelConfig::default();
        assert!(acknowledge_telegram(&mut config.telegram, 42, 100));
        assert!(remember_weixin(&mut config.weixin, "message-1".into()));
        let saved = serde_json::to_vec(&config).unwrap();
        let mut restarted: ChannelConfig = serde_json::from_slice(&saved).unwrap();
        assert!(!acknowledge_telegram(&mut restarted.telegram, 42, 101));
        assert!(!remember_weixin(&mut restarted.weixin, "message-1".into()));
        assert!(acknowledge_telegram(&mut restarted.telegram, 43, 102));
        for id in 0..300 {
            remember_weixin(&mut restarted.weixin, format!("new-{id}"));
        }
        assert_eq!(restarted.weixin.recent_ids.len(), 256);
        assert!(!remember_weixin(&mut restarted.weixin, "new-299".into()));
    }

    #[test]
    fn telegram_idle_reset_preserves_recent_offsets_and_accepts_a_new_lower_epoch() {
        let mut config = TelegramConfig {
            offset: 1000,
            last_received_update_at: 100,
            ..TelegramConfig::default()
        };
        assert!(!refresh_telegram_offset(&mut config, 99));
        assert_eq!(config.offset, 1000);
        let saved = serde_json::to_vec(&config).unwrap();
        let mut restarted: TelegramConfig = serde_json::from_slice(&saved).unwrap();
        assert!(!refresh_telegram_offset(
            &mut restarted,
            100 + TELEGRAM_IDLE_RESET_MS - 1
        ));
        assert_eq!(restarted.offset, 1000);
        assert!(!acknowledge_telegram(&mut restarted, 999, 101));
        assert!(refresh_telegram_offset(
            &mut restarted,
            101 + TELEGRAM_IDLE_RESET_MS
        ));
        assert_eq!(restarted.offset, 0);
        assert!(acknowledge_telegram(
            &mut restarted,
            42,
            102 + TELEGRAM_IDLE_RESET_MS
        ));
        let mut legacy = TelegramConfig {
            offset: 1000,
            ..TelegramConfig::default()
        };
        assert!(refresh_telegram_offset(&mut legacy, 500));
        assert_eq!(legacy.offset, 1000);
        assert_eq!(legacy.last_received_update_at, 500);
        assert!(!refresh_telegram_offset(&mut legacy, 501));
    }

    #[test]
    fn successful_poll_does_not_hide_failed_reply() {
        let session = ChannelSession {
            status: "connected".into(),
            error: String::new(),
            delivery_error: "Reply delivery failed".into(),
            ..ChannelSession::default()
        };
        assert_eq!(status_or_disconnected(&session), "error");
        assert_eq!(channel_error(&session), "Reply delivery failed");
    }

    #[test]
    fn cancellation_is_explicit_and_does_not_capture_cli_instructions() {
        assert!(is_cancel_command(" /cancel "));
        assert!(is_cancel_command("取消当前请求"));
        assert!(!is_cancel_command("关闭 C2"));
        assert!(!is_cancel_command("/cancel C2"));
        assert!(!is_cancel_command("Explain how /cancel works"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn revocation_cancels_old_channel_work_and_advances_generation() {
        let (sender, mut receiver) = watch::channel(false);
        let mut session = ChannelSession {
            generation: 7,
            cancel: Some(sender),
            ..ChannelSession::default()
        };
        stop_session(&mut session);
        cancelled(&mut receiver).await;
        assert_eq!(session.generation, 8);
        assert!(session.cancel.is_none());
    }

    #[test]
    fn telegram_accepts_only_private_text_with_numeric_identity() {
        let mut update = json!({"update_id": 12, "message": {"chat": {"id": 42, "type": "private"}, "from": {"id": 42}, "text": "  hello  "}});
        assert_eq!(
            telegram_input(&update),
            Some((12, "42".into(), "42".into(), "hello".into()))
        );
        update["message"]["chat"]["type"] = json!("group");
        assert!(telegram_input(&update).is_none());
        update["message"]["chat"]["type"] = json!("private");
        update["message"]["from"]["id"] = json!("42");
        assert!(telegram_input(&update).is_none());
    }

    #[test]
    fn weixin_rejects_other_users_groups_and_missing_context() {
        let mut message = json!({"message_id": 10, "message_type": 1, "from_user_id": "owner", "context_token": "context", "item_list": [{"type": 1, "text_item": {"text": "hello"}}]});
        assert!(weixin_input(&message, "owner").is_some());
        assert!(weixin_input(&message, "stranger").is_none());
        message["group_id"] = json!("group");
        assert!(weixin_input(&message, "owner").is_none());
        message["group_id"] = json!("");
        message["context_token"] = json!("");
        assert!(weixin_input(&message, "owner").is_none());
    }

    #[test]
    fn credentials_are_not_in_persisted_metadata() {
        let encoded = serde_json::to_string(&ChannelConfig::default()).unwrap();
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("pairing"));
    }

    #[test]
    fn weixin_service_cannot_redirect_credentials_to_another_host() {
        assert!(service_url(WEIXIN_URL).is_ok());
        assert!(service_url("https://ilinkai.weixin.qq.com.evil.test").is_err());
        assert!(service_url("http://ilinkai.weixin.qq.com").is_err());
        assert!(service_url("https://user@ilinkai.weixin.qq.com").is_err());
    }

    #[test]
    fn long_unicode_replies_are_split_without_losing_characters() {
        let text = "咖啡☕".repeat(3000);
        let parts = split_text(&text);
        assert_eq!(parts.concat(), text);
        assert!(parts.iter().all(|part| part.chars().count() <= 3900));
    }
}
