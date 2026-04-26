//! Coffee CLI command-line subcommands.
//!
//! Coffee CLI is primarily a Tauri GUI app, but it ships a small
//! collection of opt-in subcommands for advanced users and support
//! diagnostics. Subcommands are detected in `main.rs` from argv and
//! short-circuit the GUI launch.
//!
//! Currently:
//!   - `coffee-cli mcp-status` — print the live MCP server topology
//!     (anonymous + per-pane endpoints) by reading the manifest file
//!     `~/.coffee-cli/mcp-state.json` that the running Coffee CLI
//!     process keeps fresh on every spawn.

use anyhow::Result;
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
struct ManifestRead {
    pid: u32,
    written_at: u64,
    anonymous: Option<EndpointRead>,
    panes: Vec<PaneEntryRead>,
}

#[derive(Debug, Deserialize)]
struct EndpointRead {
    url: String,
    port: u16,
    started_at: u64,
}

#[derive(Debug, Deserialize)]
struct PaneEntryRead {
    pane_id: String,
    url: String,
    port: u16,
    started_at: u64,
}

/// Print the current MCP server topology to stdout, plus optional
/// liveness pings of each endpoint. Reads the manifest written by
/// `crate::mcp_server::write_state_manifest`. Returns Ok even if the
/// manifest is missing — the subcommand should always exit cleanly
/// so users can pipe its output.
pub fn mcp_status() -> Result<()> {
    let path = crate::mcp_server::state_manifest_path();
    println!("Coffee CLI — MCP server status");
    println!("Manifest: {}", path.display());

    if !path.exists() {
        println!();
        println!("(no manifest found)");
        println!();
        println!("This means either:");
        println!("  - Coffee CLI isn't currently running, OR");
        println!("  - It's running but hasn't spawned any MCP server yet");
        println!("    (no multi-agent tab has been opened in this session).");
        return Ok(());
    }

    let body = std::fs::read_to_string(&path)?;
    let manifest: ManifestRead = match serde_json::from_str(&body) {
        Ok(m) => m,
        Err(e) => {
            println!();
            println!("ERROR: manifest is corrupt or schema-mismatched: {}", e);
            println!("Raw contents:");
            println!("{}", body);
            return Ok(());
        }
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(manifest.written_at);
    let manifest_age = now.saturating_sub(manifest.written_at);
    let pid_alive = is_process_alive(manifest.pid);

    println!();
    println!(
        "  PID            {}  ({})",
        manifest.pid,
        if pid_alive { "alive" } else { "DEAD — manifest is stale" }
    );
    println!(
        "  Manifest age   {}s  ({})",
        manifest_age,
        format_age(manifest_age)
    );
    println!();

    if let Some(a) = manifest.anonymous.as_ref() {
        let age = now.saturating_sub(a.started_at);
        println!("Anonymous server (used by codex/gemini global injection):");
        println!("  URL          {}", a.url);
        println!("  Port         {}", a.port);
        println!("  Up for       {}s  ({})", age, format_age(age));
        println!();
    } else {
        println!("Anonymous server: (not spawned — pure-Claude session)");
        println!();
    }

    if manifest.panes.is_empty() {
        println!("Per-pane servers: (none)");
    } else {
        println!("Per-pane servers ({}):", manifest.panes.len());
        let mut sorted = manifest.panes;
        sorted.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));
        for p in &sorted {
            let age = now.saturating_sub(p.started_at);
            println!();
            println!("  pane_id      {}", p.pane_id);
            println!("  URL          {}", p.url);
            println!("  Port         {}", p.port);
            println!("  Up for       {}s  ({})", age, format_age(age));
        }
    }
    println!();

    if !pid_alive {
        println!(
            "Note: Coffee CLI process {} is not running. The endpoints above \n\
             are stale — restart Coffee CLI and reopen your multi-agent tabs.",
            manifest.pid
        );
    }

    Ok(())
}

fn format_age(seconds: u64) -> String {
    if seconds < 60 {
        format!("{}s", seconds)
    } else if seconds < 3600 {
        format!("{}m{}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h{}m", seconds / 3600, (seconds % 3600) / 60)
    }
}

#[cfg(target_family = "unix")]
fn is_process_alive(pid: u32) -> bool {
    // signal 0 doesn't deliver, just probes existence.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(target_family = "windows")]
fn is_process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, FALSE};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) {
            Ok(h) if !h.is_invalid() => {
                let _ = CloseHandle(h);
                true
            }
            _ => false,
        }
    }
}
