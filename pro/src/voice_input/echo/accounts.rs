//! Discover only each vendor client's active sign-in. EchoBird's account databases are never opened.
use super::{ali_native, other_native, system_native, Credentials, VoiceSource};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
#[cfg(unix)]
use std::{ffi::OsStr, process::Command};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub(super) const CHANNELS: &[(&str, &str)] = &[
    ("minimax:cn", "MiniMax"),
    ("minimax:global", "MiniMax (Global)"),
    ("kilo", "Kilo"),
    ("antigravity", "Antigravity"),
    ("grokbot", "Grok Bot"),
    ("dumate", "DuMate"),
    ("devin", "Devin"),
    ("codearts", "CodeArts"),
    ("qoder", "Qoder"),
    ("qodercn", "Qoder CN"),
    ("qwenwork", "QwenWork"),
    ("qwenworkcn", "QwenWork CN"),
    ("trae", "TRAE"),
    ("traecn", "TRAE CN"),
];
pub(super) fn supports(source: &str) -> bool {
    CHANNELS.iter().any(|(id, _)| *id == source) || source == "workbuddyai"
}
pub(super) fn sources() -> Vec<VoiceSource> {
    CHANNELS
        .iter()
        .filter_map(|(id, name)| {
            let c = account(id).ok()?;
            Some(VoiceSource {
                id: (*id).into(),
                name: (*name).into(),
                account_id: (!c.account_id.is_empty()).then_some(c.account_id),
                issue: None,
                transcription_mode: Some("batch"),
            })
        })
        .collect()
}
pub(super) fn account(source: &str) -> Result<Credentials, String> {
    if !CHANNELS.iter().any(|(id, _)| *id == source) {
        return Err("signed_out".into());
    }
    let home = dirs::home_dir().ok_or("signed_out")?;
    let config = dirs::config_dir().ok_or("signed_out")?;
    let (id, data) = match source {
        "qoder" | "qodercn" | "qwenwork" | "qwenworkcn" => ali_native::read(source, &home, &config),
        "minimax:cn" | "minimax:global" | "kilo" | "dumate" => {
            other_native::read(source, &home, &config)
        }
        _ => system_native::read(source, &home, &config),
    }?;
    Ok(Credentials {
        provider: source.split(':').next().unwrap_or(source).into(),
        account_id: id,
        data,
    })
}
pub(super) async fn dumate_credentials(
    client: &reqwest::Client,
    c: &Value,
) -> Result<Value, String> {
    other_native::dumate_credentials(client, c).await
}
pub(super) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    serde_json::from_slice(&std::fs::read(path).map_err(|_| "signed_out")?)
        .map_err(|_| "signed_out".into())
}
#[cfg(unix)]
pub(super) fn command(exe: impl AsRef<OsStr>) -> Command {
    Command::new(exe)
}

/// Read a packaged application's metadata without executing its code or probing account stores.
pub(super) fn app_metadata(tool: &str) -> Option<Value> {
    let names: &[&str] = match tool {
        "qoder" => &["Qoder"],
        "qodercn" => &["Qoder CN", "QoderCN"],
        "qwenwork" => &["QwenWork"],
        "qwenworkcn" => &["QwenWorkCN", "QwenWork CN"],
        "antigravity" | "antigravitydesktop" => &["antigravity", "Antigravity"],
        "trae" => &["Trae", "TRAE"],
        "traecn" => &["Trae CN", "TRAE CN"],
        "grokbot" => &["Grok Bot"],
        "devin" => &["Devin"],
        "codearts" => &["CodeArts", "codearts", "CodeArts Doer"],
        "dumate" => &["DuMate"],
        "minimax" | "minimaxdesktop" => &["MiniMax", "MiniMax Agent", "MiniMax Code"],
        "workbuddyai" => &["WorkBuddyAI", "WorkBuddy AI"],
        _ => return None,
    };
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        for base in [
            std::env::var_os("LOCALAPPDATA").map(|v| PathBuf::from(v).join("Programs")),
            std::env::var_os("ProgramFiles").map(PathBuf::from),
            std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
        ]
        .into_iter()
        .flatten()
        {
            roots.extend(names.iter().map(|name| base.join(name)));
        }
    }
    #[cfg(target_os = "macos")]
    {
        for base in [
            Some(PathBuf::from("/Applications")),
            dirs::home_dir().map(|p| p.join("Applications")),
        ]
        .into_iter()
        .flatten()
        {
            roots.extend(
                names
                    .iter()
                    .map(|name| base.join(format!("{name}.app/Contents"))),
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        for base in [
            PathBuf::from("/opt"),
            PathBuf::from("/usr/share"),
            dirs::home_dir()?.join(".local/share"),
        ] {
            for name in names {
                roots.push(base.join(name));
                roots.push(base.join(name.to_ascii_lowercase()));
            }
        }
    }
    for root in roots {
        let mut candidates = vec![root.join(".qoder-update/current"), root.clone()];
        for sub in [root.join(".qoder-update"), root.clone()] {
            if let Ok(entries) = std::fs::read_dir(sub) {
                let mut dirs: Vec<_> = entries
                    .flatten()
                    .filter(|e| {
                        e.file_type().is_ok_and(|t| t.is_dir())
                            && e.file_name()
                                .to_string_lossy()
                                .starts_with(|c: char| c.is_ascii_digit())
                    })
                    .map(|e| e.path())
                    .collect();
                dirs.sort();
                dirs.reverse();
                candidates.extend(dirs.into_iter().take(16));
            }
        }
        for candidate in candidates {
            for resources in [candidate.join("resources"), candidate.join("Resources")] {
                if let Some(value) = metadata_at(&resources) {
                    return Some(value);
                }
            }
        }
    }
    None
}
fn metadata_at(resources: &Path) -> Option<Value> {
    let mut package: Value = read_json(&resources.join("app/package.json"))
        .ok()
        .or_else(|| asar_package(&resources.join("app.asar")))?;
    if !package.is_object() {
        return None;
    }
    for path in [
        resources.join("product.json"),
        resources.join("app/product.json"),
    ] {
        if let Ok(Value::Object(product)) = read_json(&path) {
            package.as_object_mut()?.extend(product);
        }
    }
    if package["appVersion"].as_str().is_none() {
        package["appVersion"] = package["version"].clone();
    }
    package["resourcesPath"] = json!(resources.to_string_lossy());
    Some(package)
}
fn asar_package(path: &Path) -> Option<Value> {
    let mut file = File::open(path).ok()?;
    let mut prefix = [0u8; 16];
    file.read_exact(&mut prefix).ok()?;
    let header = u32::from_le_bytes(prefix[4..8].try_into().ok()?) as usize;
    let length = u32::from_le_bytes(prefix[12..16].try_into().ok()?) as usize;
    if header < 8 || length > header - 8 || header > 32 * 1024 * 1024 {
        return None;
    }
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes).ok()?;
    let index: Value = serde_json::from_slice(&bytes).ok()?;
    let entry = &index["files"]["package.json"];
    let size = usize::try_from(entry["size"].as_u64()?).ok()?;
    if size > 1024 * 1024 || entry["unpacked"] == true {
        return None;
    }
    let offset = entry["offset"].as_str()?.parse::<u64>().ok()?;
    file.seek(SeekFrom::Start((8 + header as u64).checked_add(offset)?))
        .ok()?;
    let mut bytes = vec![0; size];
    file.read_exact(&mut bytes).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_reads_packaged_headers_and_rejects_oversized_or_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(asar_package(&dir.path().join("missing.asar")).is_none());
        let package = br#"{"name":"fixture","version":"1.2.3"}"#;
        let index =
            json!({"files":{"package.json":{"size":package.len(),"offset":"0"}}}).to_string();
        let mut bytes = 4u32.to_le_bytes().to_vec();
        bytes.extend((8 + index.len() as u32).to_le_bytes());
        bytes.extend((4 + index.len() as u32).to_le_bytes());
        bytes.extend((index.len() as u32).to_le_bytes());
        bytes.extend(index.as_bytes());
        bytes.extend(package);
        let path = dir.path().join("app.asar");
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(asar_package(&path).unwrap()["version"], "1.2.3");
        bytes[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert!(asar_package(&path).is_none());
    }
}
