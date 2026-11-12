//! `~/.coffee-cli/mobile/config.json`: enabled flag, port, the desktop's
//! static Noise key pair and the paired phones' public keys.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 47391;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub public_key: String,
    pub name: String,
    pub paired_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub devices: Vec<Device>,
}

fn default_port() -> u16 { DEFAULT_PORT }

static PATH_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Tests point the config at a temporary directory instead of the real home.
#[cfg(test)]
pub fn use_path(path: PathBuf) { let _ = PATH_OVERRIDE.set(path); }

fn path() -> Option<PathBuf> {
    PATH_OVERRIDE.get().cloned().or_else(|| dirs::home_dir().map(|home| home.join(".coffee-cli").join("mobile").join("config.json")))
}

impl Settings {
    pub fn private_bytes(&self) -> Vec<u8> { hex::decode(&self.private_key).unwrap_or_default() }
    pub fn knows(&self, public: &[u8]) -> bool { self.devices.iter().any(|d| d.public_key == hex::encode(public)) }
}

/// Parses saved settings; a missing or malformed key pair is regenerated,
/// which also unpairs every phone (their pinned desktop key no longer matches).
pub fn parse(text: Option<&str>) -> (Settings, bool) {
    let mut settings = text.and_then(|t| serde_json::from_str::<Settings>(t).ok()).unwrap_or(Settings {
        enabled: false, port: DEFAULT_PORT, private_key: String::new(), public_key: String::new(), devices: Vec::new(),
    });
    let valid = hex::decode(&settings.private_key).is_ok_and(|k| k.len() == 32) && hex::decode(&settings.public_key).is_ok_and(|k| k.len() == 32);
    if !valid {
        let (private, public) = super::secure::generate_keypair();
        settings.private_key = hex::encode(private);
        settings.public_key = hex::encode(public);
        settings.devices.clear();
    }
    (settings, !valid)
}

pub fn load() -> Settings {
    let text = path().and_then(|p| std::fs::read_to_string(p).ok());
    let (settings, fresh) = parse(text.as_deref());
    if fresh { let _ = save(&settings); }
    settings
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let path = path().ok_or("home directory unavailable")?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Write then rename so a crash never leaves a half-written key file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 128-bit one-time pairing code, shown only in the desktop QR code.
pub fn new_pairing_code() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
