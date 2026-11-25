//! Adapted from EchoBird account_proxy; only speech transport is included.
use super::compat::{
    body::Bytes,
    http::{header, HeaderMap, HeaderValue, StatusCode},
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::time::Duration;

use super::ProxyError;

const ASR_URL: &str =
    "https://dumate-svc.baidu.com/gateway/rest/2.0/speech/publiccloudspeech/v1/asr/topspeed";

pub(crate) fn validate_audio(audio: &[u8], mime: &str) -> Result<(), ProxyError> {
    if !mime.eq_ignore_ascii_case("audio/wav") && !mime.eq_ignore_ascii_case("audio/x-wav") {
        return Err(ProxyError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "DuMate speech requires WAV audio",
        ));
    }
    let pcm = super::audio_format::pcm(audio).map_err(|_| {
        ProxyError::new(
            StatusCode::BAD_REQUEST,
            "DuMate speech requires 16 kHz mono PCM16 WAV audio",
        )
    })?;
    if pcm.len() > 60 * 32_000 {
        return Err(ProxyError::new(
            StatusCode::BAD_REQUEST,
            "DuMate speech audio exceeds 60 seconds",
        ));
    }
    Ok(())
}

pub(crate) async fn transcribe(
    client: &reqwest::Client,
    credentials: &Value,
    audio: &Bytes,
    _filename: &str,
    mime: &str,
) -> Result<String, ProxyError> {
    validate_audio(audio, mime)?;
    let token = credentials["accessToken"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(login_required)?;
    let bearer = if token
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("Bearer "))
    {
        token.to_owned()
    } else {
        format!("Bearer {token}")
    };
    let bearer = HeaderValue::from_str(&bearer).map_err(|_| login_required())?;
    let account = credentials["bceAccountId"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(HeaderValue::from_str)
        .transpose()
        .map_err(|_| login_required())?;
    let upload = prepare_upload(credentials, audio.len())?;
    let endpoint = ASR_URL;
    #[cfg(test)]
    let endpoint = credentials["_voice_test_endpoint"]
        .as_str()
        .unwrap_or(endpoint);

    tokio::time::timeout(Duration::from_secs(60), async {
        send(
            client
                .put(upload.url)
                .headers(upload.headers)
                .timeout(Duration::from_secs(30))
                .body(audio.clone()),
            "upload",
        )
        .await?;
        // The native client also permits a UUID when device/storage lookup fails.
        let mut request = client
            .post(endpoint)
            .header(header::AUTHORIZATION, bearer)
            .header("X-Dumate-Account-Id", "global")
            .timeout(Duration::from_secs(45))
            .json(&json!({
                "speech_url":upload.speech_url,
                "rate":16000,
                "dev_pid":200001,
                "cuid":uuid::Uuid::new_v4().to_string(),
            }));
        if let Some(account) = account {
            request = request.header("X-Appbuilder-Dumate-Account-Id", account);
        }
        let value: Value = send(request, "recognition")
            .await?
            .json()
            .await
            .map_err(request_error)?;
        if value
            .get("error_code")
            .is_some_and(|code| !code.is_null() && code.as_i64() != Some(0))
        {
            return Err(failed());
        }
        match &value["result"] {
            Value::String(text) => Ok(text.clone()),
            Value::Array(parts) => parts
                .iter()
                .map(|part| part.as_str().ok_or_else(failed))
                .collect::<Result<Vec<_>, _>>()
                .map(|parts| parts.concat()),
            _ => Err(failed()),
        }
    })
    .await
    .map_err(|_| timed_out())?
}

struct Upload {
    url: url::Url,
    headers: HeaderMap,
    speech_url: String,
}

fn prepare_upload(credentials: &Value, audio_len: usize) -> Result<Upload, ProxyError> {
    let session = &credentials["bosSession"];
    let field = |name: &str| {
        session[name]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(failed)
    };
    let ak = field("accessKeyId")?;
    let sk = field("secretAccessKey")?;
    let token = field("sessionToken")?;
    let endpoint = field("endpoint")?;
    let bucket = field("bucket")?;
    let prefix = field("sessionUniqId")?;
    // This is the native public BOS virtual-host branch, not an arbitrary URL.
    if endpoint.split('.').count() != 3
        || !endpoint.ends_with(".bcebos.com")
        || !dns_label(endpoint.split('.').next().unwrap_or_default())
        || !dns_label(bucket)
        || prefix
            .split('/')
            .any(|part| matches!(part, "" | "." | ".."))
        || prefix.contains('\\')
    {
        return Err(failed());
    }
    let key = encode(
        &format!("{prefix}/voice-{}.wav", uuid::Uuid::new_v4()),
        true,
    );
    let host = format!("{bucket}.{endpoint}");
    let url = url::Url::parse(&format!("https://{host}/{key}")).map_err(|_| failed())?;
    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    #[cfg(test)]
    let timestamp = credentials["_voice_test_timestamp"]
        .as_str()
        .unwrap_or(&timestamp)
        .to_owned();
    let length = audio_len.to_string();
    let pairs = [
        ("host", host.as_str()),
        ("content-length", length.as_str()),
        ("content-type", "audio/wav"),
        ("x-bce-date", timestamp.as_str()),
        ("x-bce-security-token", token),
    ];
    let signature = authorization((ak, sk), "PUT", url.path(), &[], &pairs, (&timestamp, 1800));
    let mut headers = HeaderMap::new();
    for (name, value) in pairs
        .into_iter()
        .chain([("authorization", signature.as_str())])
    {
        headers.insert(
            http::HeaderName::from_static(name),
            HeaderValue::from_str(value).map_err(|_| failed())?,
        );
    }
    // The shipped SDK intentionally has different PUT and presigned GET paths.
    let mut speech_url = url.clone();
    speech_url.set_path(&format!("/v1/{key}"));
    let signature = authorization(
        (ak, sk),
        "GET",
        speech_url.path(),
        &[("x-bce-security-token", token)],
        &[("host", host.as_str())],
        (&timestamp, -1),
    );
    speech_url.set_query(Some(&format!(
        "x-bce-security-token={}&authorization={}",
        encode(token, false),
        encode(&signature, false)
    )));
    #[cfg(test)]
    let url = if let Some(endpoint) = credentials["_voice_test_bos_endpoint"].as_str() {
        url::Url::parse(&format!(
            "{}{path}",
            endpoint.trim_end_matches('/'),
            path = url.path()
        ))
        .map_err(|_| failed())?
    } else {
        url
    };
    Ok(Upload {
        url,
        headers,
        speech_url: speech_url.to_string(),
    })
}

fn dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

fn encode(value: &str, preserve_slash: bool) -> String {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || b"-_.~".contains(&byte)
            || (preserve_slash && byte == b'/')
        {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 15) as usize] as char);
        }
    }
    out
}

fn authorization(
    credentials: (&str, &str),
    method: &str,
    path: &str,
    query: &[(&str, &str)],
    headers: &[(&str, &str)],
    time: (&str, i64),
) -> String {
    let mut query = query
        .iter()
        .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
        .map(|(name, value)| format!("{}={}", encode(name, false), encode(value, false)))
        .collect::<Vec<_>>();
    query.sort();
    let mut headers = headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.to_ascii_lowercase();
            let value = value.trim();
            (!value.is_empty()
                && (name.starts_with("x-bce-")
                    || matches!(
                        name.as_str(),
                        "host" | "content-length" | "content-type" | "content-md5"
                    )))
            .then(|| {
                (
                    name.clone(),
                    format!("{}:{}", encode(&name, false), encode(value, false)),
                )
            })
        })
        .collect::<Vec<_>>();
    headers.sort();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = headers
        .into_iter()
        .map(|(_, header)| header)
        .collect::<Vec<_>>()
        .join("\n");
    let prefix = format!("bce-auth-v1/{}/{}/{}", credentials.0, time.0, time.1);
    let hmac = |key: &[u8], text: &str| {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
        mac.update(text.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    };
    let key = hmac(credentials.1.as_bytes(), &prefix);
    let signature = hmac(
        key.as_bytes(),
        &format!("{method}\n{path}\n{}\n{canonical_headers}", query.join("&")),
    );
    format!("{prefix}/{signed_headers}/{signature}")
}

async fn send(
    request: reqwest::RequestBuilder,
    stage: &str,
) -> Result<reqwest::Response, ProxyError> {
    let response = request.send().await.map_err(request_error)?;
    if !response.status().is_success() {
        let mut error = ProxyError::new(response.status(), format!("DuMate speech {stage} failed"));
        error.retry_after = response.headers().get(header::RETRY_AFTER).cloned();
        return Err(error);
    }
    Ok(response)
}

fn login_required() -> ProxyError {
    ProxyError::new(StatusCode::UNAUTHORIZED, "DuMate speech login required")
}

fn failed() -> ProxyError {
    ProxyError::new(
        StatusCode::BAD_GATEWAY,
        "DuMate speech response was invalid",
    )
}

fn timed_out() -> ProxyError {
    ProxyError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "DuMate speech request timed out",
    )
}

fn request_error(error: reqwest::Error) -> ProxyError {
    if error.is_timeout() {
        timed_out()
    } else {
        failed()
    }
}

#[cfg(test)]
mod tests;
