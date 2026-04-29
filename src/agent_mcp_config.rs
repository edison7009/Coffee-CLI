//! Auto-register Coffee-CLI's Hyper-Agent MCP server into the local
//! CLI agents that act as "admin orchestrators" — OpenClaw and Hermes
//! Agent.
//!
//! Architecture context (Hyper-Agent, 2026-04-30 → ):
//!
//!   User → IM (WeChat/Telegram/...) → OpenClaw / Hermes Agent on user's machine
//!                                          ↓ MCP @ 127.0.0.1:<stable-port>
//!                                       Coffee-CLI (running with several panes)
//!                                          ↓ existing send_to_pane → PTY stdin
//!                                  Claude Code / Codex CLI / Gemini CLI / ... panes
//!                                  (don't know if input came from human or MCP —
//!                                   it's just stdin, zero target-side adaptation)
//!
//! For OpenClaw / Hermes Agent to discover Coffee-CLI's MCP server,
//! their config files need a `coffee-cli` server entry. This module
//! writes that entry — idempotently, atomically, preserving all other
//! user-configured fields. Called when the user opens the Hyper-Agent
//! tab; runs once on a fresh machine, no-op on subsequent launches as
//! long as Coffee-CLI's port is stable.
//!
//! NB: this module deliberately does NOT touch Codex Desktop's
//! `~/.codex/config.toml` or Claude Desktop's `claude_desktop_config.json`.
//! Hyper-Agent doesn't drive Desktop GUI apps — that was the previous
//! Hyper-Desktop experiment which was killed for not having a real
//! product wedge (see reference_hyper_desktop_postmortem.md). Here we
//! only configure the two CLI agents that act as IM bridges.

use std::path::PathBuf;

use serde::Serialize;

const MCP_NAME: &str = "coffee-cli";

#[derive(Debug, Clone, Serialize)]
pub struct RegistrationReport {
    pub agent: String,        // "openclaw" / "hermes"
    pub ok: bool,
    pub path: Option<String>,
    /// Human-readable outcome / error. Messages prefixed with
    /// `UNCHANGED_PREFIX` mean "the file already had our exact entry,
    /// no write performed" — the caller suppresses any UI signal in
    /// that case so the panel stays quiet on subsequent launches.
    pub message: String,
}

pub const UNCHANGED_PREFIX: &str = "[unchanged] ";

pub async fn register_all(url: &str) -> Vec<RegistrationReport> {
    vec![
        register_with_openclaw(url),
        register_with_hermes(url).await,
    ]
}

// ─── OpenClaw ───────────────────────────────────────────────────────
//
// File: `~/.openclaw/openclaw.json` (or `OPENCLAW_CONFIG_PATH` if set).
// Format: JSON.
// Required entries:
//   - `commands.mcp = true` — OpenClaw's MCP client subsystem is gated
//     behind this flag. Discovered live during Hyper-Desktop dev: without
//     it, `mcp.servers` is silently ignored. See reference_openclaw_mcp_gate.md.
//   - `mcp.servers.coffee-cli = { url, transport: "streamable-http" }`
//     — note the nested `mcp.servers`, NOT camelCase `mcpServers`.

fn openclaw_config_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("OPENCLAW_CONFIG_PATH") {
        return Some(PathBuf::from(p));
    }
    Some(dirs::home_dir()?.join(".openclaw").join("openclaw.json"))
}

pub fn register_with_openclaw(url: &str) -> RegistrationReport {
    let path = match openclaw_config_path() {
        Some(p) => p,
        None => {
            return RegistrationReport {
                agent: "openclaw".into(),
                ok: false,
                path: None,
                message: "no home directory; cannot resolve ~/.openclaw/openclaw.json".into(),
            };
        }
    };
    register_with_openclaw_at(&path, url)
}

fn register_with_openclaw_at(path: &PathBuf, url: &str) -> RegistrationReport {
    // Idempotent: already configured? skip write entirely so OpenClaw's
    // file watcher doesn't trigger a gateway restart on every launch.
    if let Ok(existing_str) = std::fs::read_to_string(path) {
        if let Ok(existing) = serde_json::from_str::<serde_json::Value>(&existing_str) {
            let already_set = existing
                .get("commands")
                .and_then(|c| c.get("mcp"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                && existing
                    .get("mcp")
                    .and_then(|m| m.get("servers"))
                    .and_then(|s| s.get(MCP_NAME))
                    .and_then(|e| e.get("url"))
                    .and_then(|u| u.as_str())
                    == Some(url);
            if already_set {
                return RegistrationReport {
                    agent: "openclaw".into(),
                    ok: true,
                    path: Some(path.display().to_string()),
                    message: format!("{}OpenClaw config already current", UNCHANGED_PREFIX),
                };
            }
        }
    }

    let mut root: serde_json::Value = match std::fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => v,
            Err(e) => {
                return RegistrationReport {
                    agent: "openclaw".into(),
                    ok: false,
                    path: Some(path.display().to_string()),
                    message: format!("existing config is not valid JSON: {e}"),
                };
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => {
            return RegistrationReport {
                agent: "openclaw".into(),
                ok: false,
                path: Some(path.display().to_string()),
                message: format!("read failed: {e}"),
            };
        }
    };
    if !root.is_object() {
        return RegistrationReport {
            agent: "openclaw".into(),
            ok: false,
            path: Some(path.display().to_string()),
            message: "config root is not a JSON object; refusing to clobber".into(),
        };
    }

    // 1) commands.mcp = true (the hidden feature gate).
    let commands = root
        .as_object_mut()
        .unwrap()
        .entry("commands")
        .or_insert(serde_json::json!({}));
    if !commands.is_object() {
        return RegistrationReport {
            agent: "openclaw".into(),
            ok: false,
            path: Some(path.display().to_string()),
            message: "config.commands exists but is not an object; refusing to clobber".into(),
        };
    }
    commands
        .as_object_mut()
        .unwrap()
        .insert("mcp".to_string(), serde_json::Value::Bool(true));

    // 2) mcp.servers.coffee-cli = { url, transport: streamable-http }.
    let mcp = root
        .as_object_mut()
        .unwrap()
        .entry("mcp")
        .or_insert(serde_json::json!({}));
    if !mcp.is_object() {
        return RegistrationReport {
            agent: "openclaw".into(),
            ok: false,
            path: Some(path.display().to_string()),
            message: "config.mcp exists but is not an object; refusing to clobber".into(),
        };
    }
    let servers = mcp
        .as_object_mut()
        .unwrap()
        .entry("servers")
        .or_insert(serde_json::json!({}));
    if !servers.is_object() {
        return RegistrationReport {
            agent: "openclaw".into(),
            ok: false,
            path: Some(path.display().to_string()),
            message: "config.mcp.servers exists but is not an object; refusing to clobber".into(),
        };
    }
    servers.as_object_mut().unwrap().insert(
        MCP_NAME.to_string(),
        serde_json::json!({ "url": url, "transport": "streamable-http" }),
    );

    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return RegistrationReport {
                agent: "openclaw".into(),
                ok: false,
                path: Some(path.display().to_string()),
                message: format!("could not create parent dir: {e}"),
            };
        }
    }
    let tmp = path.with_extension("json.coffee-tmp");
    let body = match serde_json::to_string_pretty(&root) {
        Ok(s) => s,
        Err(e) => {
            return RegistrationReport {
                agent: "openclaw".into(),
                ok: false,
                path: Some(path.display().to_string()),
                message: format!("serialize failed: {e}"),
            };
        }
    };
    if let Err(e) = std::fs::write(&tmp, body) {
        return RegistrationReport {
            agent: "openclaw".into(),
            ok: false,
            path: Some(path.display().to_string()),
            message: format!("write tmp failed: {e}"),
        };
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return RegistrationReport {
            agent: "openclaw".into(),
            ok: false,
            path: Some(path.display().to_string()),
            message: format!("rename failed: {e}"),
        };
    }

    RegistrationReport {
        agent: "openclaw".into(),
        ok: true,
        path: Some(path.display().to_string()),
        message: "registered (restart OpenClaw to load)".into(),
    }
}

// ─── Hermes Agent ───────────────────────────────────────────────────
//
// File: `~/.hermes/config.yaml`. Format: YAML.
// Cleanest path: shell out to `hermes mcp add coffee-cli --url <URL>`
// — Hermes' own command-line writer that handles the YAML edit AND
// auto-discovers tools at registration time. No YAML parsing on our
// side, no risk of clobbering user comments.

pub async fn register_with_hermes(url: &str) -> RegistrationReport {
    let result = tokio::task::spawn_blocking({
        let url = url.to_string();
        move || {
            #[cfg(target_os = "windows")]
            let mut cmd = {
                use std::os::windows::process::CommandExt;
                let mut c = std::process::Command::new("hermes");
                c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                c
            };
            #[cfg(not(target_os = "windows"))]
            let mut cmd = std::process::Command::new("hermes");

            cmd.args(["mcp", "add", MCP_NAME, "--url", &url]).output()
        }
    })
    .await;

    let path_hint = dirs::home_dir().map(|h| {
        h.join(".hermes").join("config.yaml").display().to_string()
    });

    match result {
        Ok(Ok(output)) => {
            if output.status.success() {
                RegistrationReport {
                    agent: "hermes".into(),
                    ok: true,
                    path: path_hint,
                    message: "registered via `hermes mcp add` (restart Hermes Agent to load)".into(),
                }
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let combined = if !stderr.is_empty() { stderr } else { stdout };
                // Detect the "already exists" common case and treat it
                // as unchanged rather than an error — Hermes' CLI tends
                // to refuse re-add of an existing server entry.
                let combined_lc = combined.to_lowercase();
                if combined_lc.contains("already") || combined_lc.contains("exists") {
                    return RegistrationReport {
                        agent: "hermes".into(),
                        ok: true,
                        path: path_hint,
                        message: format!("{}Hermes already has coffee-cli", UNCHANGED_PREFIX),
                    };
                }
                RegistrationReport {
                    agent: "hermes".into(),
                    ok: false,
                    path: path_hint,
                    message: format!(
                        "`hermes mcp add` exited {}: {}",
                        output.status,
                        if combined.is_empty() { "(no output)".into() } else { combined },
                    ),
                }
            }
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => RegistrationReport {
            agent: "hermes".into(),
            ok: false,
            path: path_hint,
            message: "`hermes` binary not on PATH (Hermes Agent not installed?)".into(),
        },
        Ok(Err(e)) => RegistrationReport {
            agent: "hermes".into(),
            ok: false,
            path: path_hint,
            message: format!("spawn failed: {e}"),
        },
        Err(e) => RegistrationReport {
            agent: "hermes".into(),
            ok: false,
            path: path_hint,
            message: format!("blocking task join failed: {e}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_tmp_path() -> PathBuf {
        let tmp = std::env::temp_dir().join(format!("coffee-cli-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        tmp.join("openclaw.json")
    }

    #[test]
    fn openclaw_register_creates_nested_path_and_gate() {
        let cfg = fresh_tmp_path();
        let r = register_with_openclaw_at(&cfg, "http://127.0.0.1:55555/mcp");
        assert!(r.ok, "registration failed: {}", r.message);
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(v["commands"]["mcp"], true);
        assert_eq!(
            v["mcp"]["servers"]["coffee-cli"]["url"],
            "http://127.0.0.1:55555/mcp"
        );
        assert_eq!(
            v["mcp"]["servers"]["coffee-cli"]["transport"],
            "streamable-http"
        );
        let _ = std::fs::remove_dir_all(cfg.parent().unwrap());
    }

    #[test]
    fn openclaw_register_preserves_user_keys() {
        let cfg = fresh_tmp_path();
        std::fs::write(
            &cfg,
            r#"{
  "userPreference": "matters",
  "commands": { "shell": false },
  "mcp": {
    "servers": {
      "user-thing": { "url": "http://example/", "transport": "streamable-http" }
    }
  }
}"#,
        )
        .unwrap();
        let r = register_with_openclaw_at(&cfg, "http://127.0.0.1:55555/mcp");
        assert!(r.ok);
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(v["userPreference"], "matters");
        assert_eq!(v["commands"]["shell"], false);
        assert_eq!(v["commands"]["mcp"], true); // we added this
        assert_eq!(v["mcp"]["servers"]["user-thing"]["url"], "http://example/");
        assert_eq!(
            v["mcp"]["servers"]["coffee-cli"]["url"],
            "http://127.0.0.1:55555/mcp"
        );
        let _ = std::fs::remove_dir_all(cfg.parent().unwrap());
    }

    #[test]
    fn openclaw_register_idempotent_skips_write() {
        let cfg = fresh_tmp_path();
        let r1 = register_with_openclaw_at(&cfg, "http://127.0.0.1:11111/mcp");
        assert!(r1.ok);
        assert!(!r1.message.starts_with(UNCHANGED_PREFIX));
        let r2 = register_with_openclaw_at(&cfg, "http://127.0.0.1:11111/mcp");
        assert!(r2.ok);
        assert!(r2.message.starts_with(UNCHANGED_PREFIX));
        let _ = std::fs::remove_dir_all(cfg.parent().unwrap());
    }
}
