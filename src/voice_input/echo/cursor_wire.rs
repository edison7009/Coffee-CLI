use super::{
    compat::http::{header, HeaderMap, HeaderValue, StatusCode},
    ProxyError,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
pub(super) const MAX_MESSAGE: usize = 4 * 1024 * 1024;
pub(super) fn endpoint(_credentials: &Value) -> &str {
    #[cfg(test)]
    if let Some(endpoint) = _credentials["_voice_test_endpoint"].as_str() {
        return endpoint;
    }
    "https://api2.cursor.sh"
}

pub(super) fn headers(credentials: &Value, bot: bool) -> Result<HeaderMap, ProxyError> {
    let token = credentials["accessToken"]
        .as_str()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(login_required)?;
    let mut result = HeaderMap::new();
    result.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| login_required())?,
    );
    // Protocol compatibility versions from the inspected official artifacts; not
    // a claim about a locally installed app, and no installation is required.
    let version = if bot { "0.75.8" } else { "3.27.12" };
    result.insert("connect-protocol-version", HeaderValue::from_static("1"));
    result.insert("x-cursor-client-version", HeaderValue::from_static(version));
    result.insert(
        "x-cursor-client-type",
        HeaderValue::from_static(if bot { "sand" } else { "ide" }),
    );
    result.insert("x-ghost-mode", HeaderValue::from_static("true"));
    if !bot {
        result.insert("x-cursor-streaming", HeaderValue::from_static("true"));
    }
    let os = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    result.insert(
        "x-cursor-client-os",
        HeaderValue::from_str(os).map_err(|_| failed())?,
    );
    result.insert(
        "x-request-id",
        HeaderValue::from_str(&uuid::Uuid::new_v4().to_string()).map_err(|_| failed())?,
    );
    if let Some(team) = credentials["teamId"]
        .as_u64()
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
    {
        result.insert(
            "x-cursor-team-id",
            HeaderValue::from_str(&team.to_string()).map_err(|_| login_required())?,
        );
    }
    if let Some(machine) = credentials["machineId"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        let checksum = checksum(
            machine,
            (chrono::Utc::now().timestamp_millis() / 1_000_000) as u32,
        );
        result.insert(
            "x-cursor-checksum",
            HeaderValue::from_str(&checksum).map_err(|_| login_required())?,
        );
    }
    if bot {
        result.insert("x-sand-box-namespace", HeaderValue::from_static("prod"));
        result.insert(
            "x-cursor-client-source",
            HeaderValue::from_static("sand-desktop"),
        );
        let platform = match os {
            "darwin" => "(Macintosh; Intel Mac OS X 10_15_7)".to_string(),
            "win32" => "(Windows NT 10.0; Win64; x64)".to_string(),
            "linux" => "(X11; Linux x86_64)".to_string(),
            other => format!("(compatible; {other})"),
        };
        let agent = format!("Mozilla/5.0 {platform} AppleWebKit/537.36 (KHTML, like Gecko) Sand/{version} Safari/537.36");
        result.insert(
            header::USER_AGENT,
            HeaderValue::from_str(&agent).map_err(|_| failed())?,
        );
    }
    Ok(result)
}

fn checksum(machine: &str, time: u32) -> String {
    // JavaScript bit shifts wrap modulo 32: >>40 is >>8, >>32 is >>0.
    let mut bytes = [
        (time >> 8) as u8,
        time as u8,
        (time >> 24) as u8,
        (time >> 16) as u8,
        (time >> 8) as u8,
        time as u8,
    ];
    let mut previous = 165;
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = (*byte ^ previous).wrapping_add(index as u8);
        previous = *byte;
    }
    format!("{}{machine}", URL_SAFE_NO_PAD.encode(bytes))
}

pub(super) fn content_type(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
        })
}

pub(super) fn field(number: u32, data: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(data.len() + 10);
    for mut value in [u64::from(number) << 3 | 2, data.len() as u64] {
        while value >= 128 {
            bytes.push(value as u8 | 128);
            value >>= 7;
        }
        bytes.push(value as u8);
    }
    bytes.extend_from_slice(data);
    bytes
}

pub(super) enum WireValue<'a> {
    Bytes(&'a [u8]),
    Other,
}

pub(super) fn fields(mut bytes: &[u8]) -> Result<Vec<(u32, WireValue<'_>)>, ProxyError> {
    fn varint(bytes: &mut &[u8]) -> Result<u64, ProxyError> {
        let mut value = 0;
        for shift in (0..=63).step_by(7) {
            let (&byte, rest) = bytes.split_first().ok_or_else(failed)?;
            *bytes = rest;
            if shift == 63 && byte > 1 {
                return Err(failed());
            }
            value |= u64::from(byte & 127) << shift;
            if byte < 128 {
                return Ok(value);
            }
        }
        Err(failed())
    }
    let mut result = Vec::new();
    while !bytes.is_empty() {
        let tag = varint(&mut bytes)?;
        let number = u32::try_from(tag >> 3).map_err(|_| failed())?;
        if number == 0 || number > 0x1fff_ffff {
            return Err(failed());
        }
        let length = match tag & 7 {
            0 => {
                varint(&mut bytes)?;
                continue;
            }
            1 => 8,
            2 => usize::try_from(varint(&mut bytes)?).map_err(|_| failed())?,
            5 => 4,
            _ => return Err(failed()),
        };
        let data = bytes.get(..length).ok_or_else(failed)?;
        result.push((
            number,
            if tag & 7 == 2 {
                WireValue::Bytes(data)
            } else {
                WireValue::Other
            },
        ));
        bytes = &bytes[length..];
    }
    Ok(result)
}

pub(super) fn http_error(status: StatusCode, headers: &HeaderMap) -> ProxyError {
    let mut error = ProxyError::new(status, "Cursor-family speech request failed");
    error.retry_after = headers.get(header::RETRY_AFTER).cloned();
    error
}

pub(super) fn nonempty(text: &str) -> Result<String, ProxyError> {
    let text = text.trim();
    if text.is_empty() {
        Err(failed())
    } else {
        Ok(text.into())
    }
}

fn login_required() -> ProxyError {
    ProxyError::new(
        StatusCode::UNAUTHORIZED,
        "Cursor-family speech login required",
    )
}
pub(super) fn failed() -> ProxyError {
    ProxyError::new(
        StatusCode::BAD_GATEWAY,
        "Cursor-family speech recognition failed",
    )
}
pub(super) fn timed_out() -> ProxyError {
    ProxyError::new(
        StatusCode::GATEWAY_TIMEOUT,
        "Cursor-family speech recognition timed out",
    )
}
pub(super) fn request_error(error: reqwest::Error) -> ProxyError {
    if error.is_timeout() {
        timed_out()
    } else {
        failed()
    }
}
