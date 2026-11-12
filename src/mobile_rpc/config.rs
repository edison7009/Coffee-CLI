//! `~/.coffee-cli/mobile/config.json`: enabled flag, port and pairing token.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_PORT: u16 = 47391;

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub token: String,
}

fn default_port() -> u16 { DEFAULT_PORT }

fn path() -> Option<PathBuf> { dirs::home_dir().map(|home| home.join(".coffee-cli").join("mobile").join("config.json")) }

pub fn new_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn parse(text: Option<&str>) -> (Settings, bool) {
    let mut settings = text.and_then(|t| serde_json::from_str::<Settings>(t).ok())
        .unwrap_or(Settings { enabled: false, port: DEFAULT_PORT, token: String::new() });
    let fresh = settings.token.len() < 32;
    if fresh { settings.token = new_token(); }
    (settings, fresh)
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
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Constant-time comparison so response timing does not leak the token.
pub fn token_matches(given: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let (a, b) = (Sha256::digest(given.as_bytes()), Sha256::digest(expected.as_bytes()));
    !expected.is_empty() && a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
