#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod scanner;
mod terminal;
mod server;

use anyhow::Result;
use std::path::PathBuf;

fn bootstrap_user_config() {
    let Some(home) = dirs::home_dir() else { return };
    let hc_dir = home.join(".coffee-cli");

    if let Err(e) = std::fs::create_dir_all(&hc_dir) {
        eprintln!("[CC] Could not create ~/.coffee-cli: {}", e);
        return;
    }

    let models_path = hc_dir.join("models.json");
    if models_path.exists() { return; }

    let template = r#"[
  {
    "name": "Coffee CLI Default",
    "modelId": "default",
    "baseUrl": "http://localhost:11434/v1"
  }
]
"#;
    if let Err(e) = std::fs::write(&models_path, template) {
        eprintln!("[CC] Could not write template models.json: {}", e);
    }
}

fn get_initial_dir() -> PathBuf {
    PathBuf::new()
}

fn main() -> Result<()> {
    bootstrap_user_config();
    let dir_path = get_initial_dir();
    server::start_ui(dir_path)
}
