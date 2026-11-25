//! Read only the active Alibaba desktop login; never import EchoBird's account store.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn layout(provider: &str) -> Result<(&'static str, &'static str, i64), String> {
    match provider {
        "qoder" => Ok(("com.qoder.app.stable", "auth.v1.dat", 1)),
        "qodercn" => Ok(("com.qodercn.app.stable", "auth.v1.dat", 1)),
        "qwenwork" => Ok(("QwenWork", "auth-v2.dat", 2)),
        "qwenworkcn" => Ok(("QwenWorkCN", "auth-v2.dat", 2)),
        _ => Err("signed_out".into()),
    }
}

fn directory(
    provider: &str,
    platform: &str,
    home: &Path,
    config: &Path,
) -> Result<PathBuf, String> {
    let (name, _, _) = layout(provider)?;
    Ok(if platform == "macos" {
        home.join("Library/Application Support")
    } else {
        config.to_path_buf()
    }
    .join(name))
}

fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "signed_out".into())
}

fn expires_at(value: &Value) -> Option<i64> {
    let n = value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.timestamp())
        .or_else(|| value.as_i64().or_else(|| value.as_str()?.parse().ok()))?;
    let n = if n >= 1_000_000_000_000 { n / 1000 } else { n };
    (n > 0 && n < 253_402_214_400).then_some(n)
}

fn credentials(
    provider: &str,
    metadata: &Value,
    auth: &Value,
    machine: Option<&str>,
    now: i64,
) -> Result<(String, Value), String> {
    let (name, _, schema) = layout(provider)?;
    if auth["schemaVersion"] != schema || expires_at(&auth["expiresAt"]).is_none_or(|t| t <= now) {
        return Err("signed_out".into());
    }
    let token = text(auth, "token")?;
    let user = &auth["user"];
    let id = text(user, "id")?;
    if schema == 1 {
        let (product, app, protocol) = if provider == "qoder" {
            ("qoder", "com.qoder.app", "qoder")
        } else {
            ("qoder-cn", "com.qodercn.app", "qoder-cn")
        };
        // The IDE has a different login store; never pair its version with an App token.
        if metadata["dataDirectoryName"] != name
            || metadata["productId"] != product
            || metadata["appId"] != app
            || metadata["protocolScheme"] != protocol
        {
            return Err("signed_out".into());
        }
        let machine = machine.map(str::trim).ok_or("signed_out")?;
        uuid::Uuid::parse_str(machine).map_err(|_| "signed_out")?;
        let version = text(metadata, "version").or_else(|_| text(metadata, "appVersion"))?;
        Ok((
            id.into(),
            json!({"edition":provider,"deviceToken":token,"userId":id,
            "machineId":machine,"name":user["name"],"email":user["email"],"appVersion":version}),
        ))
    } else {
        let package = if provider == "qwenwork" {
            "qwen-work"
        } else {
            "qwen-work-cn"
        };
        if metadata["name"] != package
            || auth["authRealm"]
                .as_str()
                .is_some_and(|realm| realm != "standard")
        {
            return Err("signed_out".into());
        }
        let version =
            text(metadata, "qoderworkUpgradeVersion").or_else(|_| text(metadata, "version"))?;
        let version = version.split('-').next().ok_or("signed_out")?;
        if version.is_empty() {
            return Err("signed_out".into());
        }
        Ok((
            id.into(),
            json!({"edition":provider,"accessToken":token,"userId":id,
            "name":user["name"],"email":user["email"],"version":version}),
        ))
    }
}

pub(super) fn read(provider: &str, home: &Path, config: &Path) -> Result<(String, Value), String> {
    let (_, filename, schema) = layout(provider)?;
    let dir = directory(provider, std::env::consts::OS, home, config)?;
    // Missing state must not access a keychain, create a directory or fall back to an old account.
    let bytes = std::fs::read(dir.join(filename)).map_err(|_| "signed_out")?;
    let metadata = super::accounts::app_metadata(provider).ok_or("signed_out")?;
    let storage_name = if schema == 1 {
        text(&metadata, "electronApplicationName")?
    } else {
        layout(provider)?.0
    };
    #[cfg(target_os = "linux")]
    let cipher = if bytes.starts_with(b"v10") {
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1, &mut key);
        super::vault::Cipher::Cbc {
            key,
            prefix: *b"v10",
            linux: true,
        }
    } else {
        super::vault::cipher_with_name(&dir, storage_name)?
    };
    #[cfg(not(target_os = "linux"))]
    let cipher = super::vault::cipher_with_name(&dir, storage_name)?;
    let plain = super::vault::decrypt_bytes(&cipher, &bytes)?;
    let auth: Value = serde_json::from_slice(&plain).map_err(|_| "signed_out")?;
    let machine = if schema == 1 {
        Some(std::fs::read_to_string(dir.join("auth.machine-id")).map_err(|_| "signed_out")?)
    } else {
        None
    };
    credentials(
        provider,
        &metadata,
        &auth,
        machine.as_deref(),
        chrono::Utc::now().timestamp(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(provider: &str) -> (Value, Value) {
        let cn = provider.ends_with("cn");
        let metadata = if provider.starts_with("qoder") {
            json!({"productId":if cn {"qoder-cn"}else{"qoder"},
                "appId":if cn {"com.qodercn.app"}else{"com.qoder.app"},
                "dataDirectoryName":layout(provider).unwrap().0,
                "protocolScheme":if cn {"qoder-cn"}else{"qoder"},"version":"0.4.9"})
        } else {
            json!({"name":if cn {"qwen-work-cn"}else{"qwen-work"},"qoderworkUpgradeVersion":"1.3.2-26091802"})
        };
        let auth = json!({"schemaVersion":layout(provider).unwrap().2,"token":"fixture-token",
            "expiresAt":"2099-01-01T00:00:00Z","user":{"id":"fixture-id","name":"Fixture","email":"fixture@example.invalid"}});
        (metadata, auth)
    }

    #[test]
    fn current_login_keeps_region_and_correct_token_family() {
        for provider in ["qoder", "qodercn", "qwenwork", "qwenworkcn"] {
            let (metadata, auth) = fixture(provider);
            let (id, data) = credentials(
                provider,
                &metadata,
                &auth,
                Some("00000000-0000-4000-8000-000000000001"),
                1_800_000_000,
            )
            .unwrap();
            assert_eq!(id, "fixture-id");
            assert_eq!(data["edition"], provider);
            if provider.starts_with("qoder") {
                assert_eq!(data["deviceToken"], "fixture-token");
                assert!(data.get("accessToken").is_none());
            } else {
                assert_eq!(data["accessToken"], "fixture-token");
                assert_eq!(data["version"], "1.3.2");
            }
            assert!(data.get("refreshToken").is_none());
            let other = match provider {
                "qoder" => "qodercn",
                "qodercn" => "qoder",
                "qwenwork" => "qwenworkcn",
                _ => "qwenwork",
            };
            assert!(credentials(
                other,
                &metadata,
                &auth,
                Some("00000000-0000-4000-8000-000000000001"),
                1_800_000_000
            )
            .is_err());
        }
    }

    #[test]
    fn expired_signed_out_wrong_realm_and_missing_machine_are_rejected() {
        let machine = Some("00000000-0000-4000-8000-000000000001");
        for provider in ["qoder", "qodercn", "qwenwork", "qwenworkcn"] {
            let (metadata, auth) = fixture(provider);
            for key in ["token", "user", "expiresAt", "schemaVersion"] {
                let mut missing = auth.clone();
                missing.as_object_mut().unwrap().remove(key);
                assert!(
                    credentials(provider, &metadata, &missing, machine, 1_800_000_000).is_err()
                );
            }
            let mut expired = auth.clone();
            expired["expiresAt"] = json!(1_700_000_000_000i64);
            assert!(credentials(provider, &metadata, &expired, machine, 1_800_000_000).is_err());
            if provider.starts_with("qoder") {
                assert!(credentials(provider, &metadata, &auth, None, 1_800_000_000).is_err());
            } else {
                let mut foreign = auth.clone();
                foreign["authRealm"] = json!("other");
                assert!(credentials(provider, &metadata, &foreign, None, 1_800_000_000).is_err());
            }
        }
    }

    #[test]
    fn missing_client_state_creates_nothing_and_platform_paths_stay_isolated() {
        let root = tempfile::tempdir().unwrap();
        for provider in ["qoder", "qodercn", "qwenwork", "qwenworkcn"] {
            let name = layout(provider).unwrap().0;
            let home = root.path().join("home");
            let config = root.path().join("config");
            assert_eq!(
                directory(provider, "macos", &home, &config).unwrap(),
                home.join("Library/Application Support").join(name)
            );
            assert_eq!(
                directory(provider, "linux", &home, &config).unwrap(),
                config.join(name)
            );
            assert!(read(provider, &home, &config).is_err());
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
