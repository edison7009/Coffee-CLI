//! Auto-register Coffee-CLI's Hyper-Agent MCP server into OpenClaw's
//! config file.
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
//! their config needs a `coffee-cli` server entry. We auto-write that
//! entry for OpenClaw — its config is plain JSON and has no interactive
//! gate, so we can patch it atomically while preserving user fields.
//!
//! Hermes Agent is **not** auto-registered: its only official add path
//! is the interactive `hermes mcp add ...` command (3 stdin prompts —
//! overwrite-confirm, auth-confirm, tool-selection), which deadlocks on
//! a TTY-less subprocess. Per the project rule
//! `feedback_defer_to_upstream_config.md`, we instead surface the exact
//! one-liner inside the SETUP_INSTRUCTION block the user copy-pastes
//! into Hermes Agent — the receiving LLM has shell tools and runs it
//! itself. OpenClaw users see the same line as a no-op (their `coffee-cli`
//! tools are already mounted, so they ignore the bootstrap hint).
//!
//! NB: this module deliberately does NOT touch Codex Desktop's
//! `~/.codex/config.toml` or Claude Desktop's `claude_desktop_config.json`.
//! Hyper-Agent doesn't drive Desktop GUI apps — that was the previous
//! Hyper-Desktop experiment which was killed for not having a real
//! product wedge (see reference_hyper_desktop_postmortem.md).

use std::path::PathBuf;

use serde::Serialize;

const MCP_NAME: &str = "coffee-cli";

#[derive(Debug, Clone, Serialize)]
pub struct RegistrationReport {
    pub agent: String,        // currently always "openclaw"
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
    vec![register_with_openclaw(url)]
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

// Hermes Agent registration is intentionally NOT performed here.
// `hermes mcp add` is interactive (3 stdin prompts) and deadlocks when
// spawned from a TTY-less subprocess; rather than maintain a brittle
// expect-script or write YAML directly (and bypass Hermes' tool
// discovery), the SETUP_INSTRUCTION block in the Hyper-Agent UI
// embeds the exact `hermes mcp add coffee-cli --url <URL>` one-liner
// — the user copies it into Hermes Agent's chat, and the receiving
// LLM uses its shell tool to register Coffee-CLI itself.

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
