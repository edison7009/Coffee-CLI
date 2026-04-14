#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod scanner;
mod terminal;
mod server;

use anyhow::Result;
use std::path::PathBuf;

fn main() -> Result<()> {
    // No initial directory — each tab picks its own CWD at launch time.
    server::start_ui(PathBuf::new())
}
