#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod git_intel;
mod scanner;
mod terminal;
mod translation;
mod watcher;
mod server;

use anyhow::Result;
use std::path::PathBuf;

fn bootstrap_user_config() {
    let Some(home) = dirs::home_dir() else { return };
    let hc_dir = home.join(".CoffeeMode");

    if let Err(e) = std::fs::create_dir_all(&hc_dir) {
        eprintln!("[CC] Could not create ~/.CoffeeMode: {}", e);
        return;
    }

    let models_path = hc_dir.join("models.json");
    if models_path.exists() { return; }

    let template = r#"[
  {
    "name": "Coffee Mode Default",
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
    let home = dirs::home_dir();
    if let Some(h) = &home {
        let last_dir_file = h.join(".CoffeeMode").join("last_dir.txt");
        if let Ok(content) = std::fs::read_to_string(&last_dir_file) {
            let path = PathBuf::from(content.trim());
            if path.is_dir() {
                return path;
            }
        }
    }
    
    // Fallback to desktop
    if let Some(desktop) = dirs::desktop_dir() {
        if desktop.is_dir() {
            return desktop;
        }
    }
    
    // Fallback to home
    if let Some(home_dir) = home {
        if home_dir.is_dir() {
            return home_dir;
        }
    }
    
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn main() -> Result<()> {
    bootstrap_user_config();
    translation::bootstrap_dictionaries();
    let dir_path = get_initial_dir();
    server::start_ui(dir_path)
}
