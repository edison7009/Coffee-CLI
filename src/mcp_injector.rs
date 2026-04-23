//! Inject the Coffee-CLI MCP server endpoint into each supported primary
//! CLI's config file, and back it out cleanly on disable.
//!
//! Supported CLIs (v1.0):
//!   - Claude Code    → ~/.claude.json            (JSON, key: `mcpServers.coffee-cli`)
//!   - Codex CLI      → ~/.codex/config.toml      (TOML, key: `[mcp_servers.coffee-cli]`)
//!   - Gemini CLI     → ~/.gemini/settings.json   (JSON, key: `mcpServers.coffee-cli`)
//!
//! OpenCode was evaluated and dropped for v1.0 — its workspace-local
//! `opencode.json` and `mcp` (not `mcpServers`) shape are enough unlike
//! the other three that it deserves its own pass. Tracked for v1.1.
//!
//! Safety:
//!   - Before touching any config we back it up to
//!     ~/.coffee-cli/backup/<tool>-<timestamp>.bak so the user can roll
//!     back by hand. The newest 10 backups per tool are retained.
//!   - We MERGE our key into existing config rather than overwriting —
//!     any user-managed MCP servers, env vars, or other settings are
//!     preserved verbatim.
//!   - On disable we remove ONLY the `coffee-cli` key, not the whole
//!     `mcpServers` / `[mcp_servers]` / `mcp` section.
//!
//! This module does NOT write the protocol `.md` files — that is
//! `multi_agent_protocol`'s job. Typical flow:
//!
//!   let endpoint = crate::mcp_server::spawn(store).await?;
//!   crate::multi_agent_protocol::install(workspace)?;
//!   crate::mcp_injector::install_all(&endpoint)?;
//!
//! On disable, invoke both modules' `uninstall` in reverse order.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value as JsonValue;

use crate::mcp_server::McpEndpoint;

/// Key used for the Coffee-CLI entry in every primary CLI's MCP map.
/// Changing this after ship breaks uninstallation on existing users.
pub const MCP_KEY: &str = "coffee-cli";

// ---------- Public entry points ----------

/// Inject the endpoint into every supported primary CLI's config we can
/// find on disk. Missing-config scenarios are logged and skipped (they
/// just mean that CLI isn't installed); only hard failures return Err.
///
/// The `_workspace` parameter is retained for forward compatibility with
/// v1.1 when OpenCode (workspace-local config) may come back online.
///
/// Returns the list of paths we touched so the UI can surface them.
pub fn install_all(endpoint: &McpEndpoint, _workspace: Option<&Path>) -> anyhow::Result<Vec<PathBuf>> {
    let mut touched = Vec::new();

    // Claude Code — ~/.claude.json
    if let Some(p) = claude_config_path() {
        if let Err(e) = install_claude(&p, endpoint) {
            log::warn!("[mcp-inject] claude skipped: {}", e);
        } else {
            touched.push(p);
        }
    }

    // Codex CLI — ~/.codex/config.toml
    if let Some(p) = codex_config_path() {
        if let Err(e) = install_codex(&p, endpoint) {
            log::warn!("[mcp-inject] codex skipped: {}", e);
        } else {
            touched.push(p);
        }
    }

    // Gemini CLI — ~/.gemini/settings.json
    if let Some(p) = gemini_config_path() {
        if let Err(e) = install_gemini(&p, endpoint) {
            log::warn!("[mcp-inject] gemini skipped: {}", e);
        } else {
            touched.push(p);
        }
    }

    Ok(touched)
}

/// Remove the `coffee-cli` entry from every config we can find. Does NOT
/// restore from backup — the point is to leave the user's OWN entries
/// alone and just drop ours. Backups are for manual rollback when a
/// merge goes wrong; in the normal disable path we use surgical removal.
pub fn uninstall_all(_workspace: Option<&Path>) -> anyhow::Result<Vec<PathBuf>> {
    let mut touched = Vec::new();

    if let Some(p) = claude_config_path() {
        if matches!(uninstall_json(&p, &["mcpServers", MCP_KEY]), Ok(true)) {
            touched.push(p);
        }
    }
    if let Some(p) = codex_config_path() {
        if matches!(uninstall_codex(&p), Ok(true)) {
            touched.push(p);
        }
    }
    if let Some(p) = gemini_config_path() {
        if matches!(uninstall_json(&p, &["mcpServers", MCP_KEY]), Ok(true)) {
            touched.push(p);
        }
    }

    Ok(touched)
}

// ---------- Path resolvers ----------

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn claude_config_path() -> Option<PathBuf> {
    home().map(|h| h.join(".claude.json"))
}

fn codex_config_path() -> Option<PathBuf> {
    home().map(|h| h.join(".codex").join("config.toml"))
}

fn gemini_config_path() -> Option<PathBuf> {
    home().map(|h| h.join(".gemini").join("settings.json"))
}

// ---------- Per-CLI install (JSON) ----------

fn install_claude(path: &Path, endpoint: &McpEndpoint) -> anyhow::Result<()> {
    install_json(path, &["mcpServers"], mcp_entry_json(endpoint), "claude")?;
    // Pre-accept the `--dangerously-skip-permissions` first-run warning
    // dialog so multi-agent panes boot straight into a working REPL.
    // Without this, the very first Claude pane shows a red "Bypass
    // Permissions mode" screen waiting for the user to pick "Yes, I
    // accept" — which defeats the entire hands-free orchestration the
    // flag exists to enable. Field name discovered via strings-mining
    // claude.exe; it is the exact bit Claude Code flips when the user
    // clicks accept, so pre-setting it is semantically identical.
    set_json_field_true(path, "bypassPermissionsModeAccepted", "claude")?;
    Ok(())
}

fn install_gemini(path: &Path, endpoint: &McpEndpoint) -> anyhow::Result<()> {
    install_json(path, &["mcpServers"], mcp_entry_json(endpoint), "gemini")
}

// OpenCode install path removed for v1.0 — see module header. The
// `install_json` helper is generic; v1.1 can reintroduce:
//   fn install_opencode(path: &Path, endpoint: &McpEndpoint) -> anyhow::Result<()> {
//       install_json(path, &["mcp"], mcp_entry_json(endpoint), "opencode")
//   }
// without further plumbing changes.

/// Shared JSON injection path. `parent_keys` describes where in the JSON
/// tree our MCP_KEY entry should live, e.g. `["mcpServers"]` means we
/// land at `root["mcpServers"]["coffee-cli"] = entry`.
fn install_json(
    path: &Path,
    parent_keys: &[&str],
    entry: JsonValue,
    tool_label: &str,
) -> anyhow::Result<()> {
    let existing = read_json_or_empty_object(path)?;
    backup_if_exists(path, tool_label)?;

    let mut root = existing;
    ensure_parent_chain(&mut root, parent_keys);

    // Walk down to the parent (safe — we just ensured it exists and is an object).
    let mut cursor = &mut root;
    for k in parent_keys {
        cursor = cursor
            .as_object_mut()
            .and_then(|m| m.get_mut(*k))
            .expect("parent chain was ensured");
    }
    let parent_obj = cursor
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("{} is not an object in {}", parent_keys.last().copied().unwrap_or(""), path.display()))?;
    parent_obj.insert(MCP_KEY.to_string(), entry);

    write_json_pretty(path, &root)?;
    log::info!("[mcp-inject] {} config updated: {}", tool_label, path.display());
    Ok(())
}

// ---------- Codex (TOML) install/uninstall ----------

fn install_codex(path: &Path, endpoint: &McpEndpoint) -> anyhow::Result<()> {
    backup_if_exists(path, "codex")?;

    // The rmcp HTTP transport plus API-key header is not the default shape
    // Codex `[mcp_servers.*]` was originally designed for (those are stdio
    // sub-process commands). Codex 0.x accepts a `url = "…"` field for
    // remote MCPs; we keep the block minimal and documented.
    let block = format!(
        "\n# Added by Coffee-CLI on {stamp}. See docs/MULTI-AGENT-ARCHITECTURE.md.\n\
         # Remove this section (and keep [mcp_servers] intact if it has other entries)\n\
         # to disable Coffee-CLI multi-agent integration.\n\
         [mcp_servers.{key}]\n\
         url = \"{url}\"\n\
         headers = {{ \"X-Coffee-CLI-Port\" = \"{port}\" }}\n",
        stamp = endpoint.started_at,
        key = MCP_KEY,
        url = endpoint.url,
        port = endpoint.port,
    );

    let existing = fs::read_to_string(path).unwrap_or_default();

    // Surgical update: if our section already exists, replace it; else append.
    let header = format!("[mcp_servers.{}]", MCP_KEY);
    let new_content = if let Some(start) = existing.find(&header) {
        // Find next `[` at column 0 (a fresh TOML section) OR end-of-file.
        let after_header = start + header.len();
        let tail = &existing[after_header..];
        let next_section_rel = tail
            .match_indices("\n[")
            .find(|(_, _)| true)
            .map(|(i, _)| after_header + i);

        let mut s = String::with_capacity(existing.len() + block.len());
        s.push_str(&existing[..start]);
        // Drop any leading blank line we would otherwise duplicate.
        s.push_str(block.trim_start_matches('\n'));
        if let Some(next) = next_section_rel {
            s.push_str(&existing[next..]);
        }
        s
    } else if existing.is_empty() {
        block.trim_start_matches('\n').to_string()
    } else if existing.ends_with('\n') {
        format!("{}{}", existing, block)
    } else {
        format!("{}\n{}", existing, block)
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, new_content)?;
    log::info!("[mcp-inject] codex config updated: {}", path.display());
    Ok(())
}

fn uninstall_codex(path: &Path) -> anyhow::Result<bool> {
    let Ok(existing) = fs::read_to_string(path) else {
        return Ok(false);
    };
    let header = format!("[mcp_servers.{}]", MCP_KEY);
    let Some(start) = existing.find(&header) else {
        return Ok(false);
    };

    // Strip any leading "# Added by Coffee-CLI" comment immediately above.
    let mut block_start = start;
    let head_slice = &existing[..start];
    if let Some(comment_idx) = head_slice.rfind("# Added by Coffee-CLI") {
        // Rewind further to the beginning of that line.
        if let Some(line_start) = existing[..comment_idx].rfind('\n') {
            block_start = line_start + 1;
        } else {
            block_start = 0;
        }
    }

    let after_header = start + header.len();
    let tail = &existing[after_header..];
    let end_rel = tail
        .match_indices("\n[")
        .next()
        .map(|(i, _)| after_header + i + 1) // keep leading \n off the next section
        .unwrap_or(existing.len());

    let mut s = String::with_capacity(existing.len());
    s.push_str(existing[..block_start].trim_end_matches(|c: char| c == '\n' || c == '\r'));
    if end_rel < existing.len() {
        s.push('\n');
        s.push_str(&existing[end_rel..]);
    } else {
        s.push('\n');
    }

    fs::write(path, s)?;
    log::info!("[mcp-inject] codex config cleaned: {}", path.display());
    Ok(true)
}

// ---------- JSON helpers ----------

fn uninstall_json(path: &Path, key_path: &[&str]) -> anyhow::Result<bool> {
    let Some(mut root) = read_json_if_exists(path)? else {
        return Ok(false);
    };

    if key_path.len() < 2 {
        return Ok(false);
    }
    let (leaf, parent_keys) = key_path.split_last().expect("len >= 2 checked");
    let mut cursor = &mut root;
    for k in parent_keys {
        match cursor.as_object_mut().and_then(|m| m.get_mut(*k)) {
            Some(next) => cursor = next,
            None => return Ok(false),
        }
    }
    let parent_obj = match cursor.as_object_mut() {
        Some(obj) => obj,
        None => return Ok(false),
    };
    if parent_obj.remove(*leaf).is_none() {
        return Ok(false);
    }

    // If the parent object is now empty AND we added it, we COULD delete
    // it to keep the file tidy — but that risks surprising the user if
    // they intentionally kept an empty `"mcpServers": {}`. Leave it.

    write_json_pretty(path, &root)?;
    log::info!("[mcp-inject] cleaned {} from {}", leaf, path.display());
    Ok(true)
}

fn read_json_or_empty_object(path: &Path) -> anyhow::Result<JsonValue> {
    match read_json_if_exists(path)? {
        Some(v) => Ok(v),
        None => Ok(JsonValue::Object(Default::default())),
    }
}

fn read_json_if_exists(path: &Path) -> anyhow::Result<Option<JsonValue>> {
    match fs::read_to_string(path) {
        Ok(s) if s.trim().is_empty() => Ok(Some(JsonValue::Object(Default::default()))),
        Ok(s) => Ok(Some(serde_json::from_str(&s).map_err(|e| {
            anyhow::anyhow!("parse {} failed: {}", path.display(), e)
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Set a single top-level boolean field to `true` on a JSON config,
/// preserving every other field. Used to pre-flip Claude Code's
/// `bypassPermissionsModeAccepted` bit so `--dangerously-skip-permissions`
/// boots silently in multi-agent panes. Idempotent.
fn set_json_field_true(path: &Path, field: &str, tool_label: &str) -> anyhow::Result<()> {
    let mut root = read_json_or_empty_object(path)?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("{} root is not a JSON object", path.display()))?;
    let already = obj.get(field).and_then(|v| v.as_bool()).unwrap_or(false);
    if already {
        return Ok(());
    }
    obj.insert(field.to_string(), JsonValue::Bool(true));
    write_json_pretty(path, &root)?;
    log::info!("[mcp-inject] {} config: set {}=true", tool_label, field);
    Ok(())
}

fn write_json_pretty(path: &Path, v: &JsonValue) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let s = serde_json::to_string_pretty(v)?;
    fs::write(path, s)?;
    Ok(())
}

fn ensure_parent_chain(root: &mut JsonValue, parent_keys: &[&str]) {
    let mut cursor = root;
    for k in parent_keys {
        if !cursor.is_object() {
            *cursor = JsonValue::Object(Default::default());
        }
        let obj = cursor.as_object_mut().expect("just ensured object");
        if !obj.contains_key(*k) {
            obj.insert((*k).to_string(), JsonValue::Object(Default::default()));
        }
        cursor = obj.get_mut(*k).expect("just inserted");
    }
}

fn mcp_entry_json(endpoint: &McpEndpoint) -> JsonValue {
    serde_json::json!({
        "type": "http",
        "url": endpoint.url,
        "headers": {
            "X-Coffee-CLI-Port": endpoint.port.to_string(),
        },
    })
}

// ---------- Backups ----------

fn backup_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".coffee-cli").join("backup"))
}

/// If `path` exists, copy it to `~/.coffee-cli/backup/<tool>-<ts>.bak`.
/// Best-effort: any error is logged but not propagated (missing backup
/// isn't worth blocking the install).
fn backup_if_exists(path: &Path, tool_label: &str) -> anyhow::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let Some(dir) = backup_dir() else {
        return Ok(());
    };
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("[mcp-inject] backup dir create failed: {}", e);
        return Ok(());
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("bak");
    let backup_name = format!("{}-{}.{}.bak", tool_label, ts, ext);
    let dest = dir.join(&backup_name);

    if let Err(e) = fs::copy(path, &dest) {
        log::warn!("[mcp-inject] backup copy failed: {}", e);
        return Ok(());
    }
    log::debug!("[mcp-inject] backed up {} → {}", path.display(), dest.display());

    prune_backups(&dir, tool_label, 10);
    Ok(())
}

/// Keep only the `keep` newest backups per tool; delete older ones.
fn prune_backups(dir: &Path, tool_label: &str, keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let prefix = format!("{}-", tool_label);
    let mut backups: Vec<(PathBuf, SystemTime)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_string();
            if !name.starts_with(&prefix) {
                return None;
            }
            let meta = e.metadata().ok()?;
            let mtime = meta.modified().ok()?;
            Some((p, mtime))
        })
        .collect();
    if backups.len() <= keep {
        return;
    }
    backups.sort_by(|a, b| b.1.cmp(&a.1)); // newest first
    for (old, _) in backups.into_iter().skip(keep) {
        let _ = fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_json_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "coffee-cli-inject-test-{}-{}.json",
            std::process::id(),
            name
        ));
        p
    }

    fn sample_endpoint() -> McpEndpoint {
        McpEndpoint {
            url: "http://127.0.0.1:50000/mcp".to_string(),
            port: 50000,
            pid: std::process::id(),
            started_at: 1700000000,
        }
    }

    #[test]
    fn json_install_preserves_unrelated_keys() {
        let p = tmp_json_path("preserve");
        let _ = fs::remove_file(&p);
        fs::write(
            &p,
            r#"{
  "theme": "dark",
  "mcpServers": { "user-tool": { "command": "foo" } }
}"#,
        )
        .unwrap();

        install_json(&p, &["mcpServers"], mcp_entry_json(&sample_endpoint()), "test").unwrap();

        let parsed: JsonValue = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(parsed["theme"], JsonValue::String("dark".to_string()));
        assert!(parsed["mcpServers"]["user-tool"].is_object(), "user tool kept");
        assert_eq!(parsed["mcpServers"][MCP_KEY]["url"], "http://127.0.0.1:50000/mcp");

        let _ = fs::remove_file(&p);
    }

    #[test]
    fn json_uninstall_removes_only_our_key() {
        let p = tmp_json_path("uninstall");
        let _ = fs::remove_file(&p);
        fs::write(
            &p,
            format!(
                r#"{{
  "mcpServers": {{
    "user-tool": {{ "command": "foo" }},
    "{k}": {{ "url": "http://x/mcp" }}
  }}
}}"#,
                k = MCP_KEY
            ),
        )
        .unwrap();

        assert!(uninstall_json(&p, &["mcpServers", MCP_KEY]).unwrap());
        let parsed: JsonValue = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert!(parsed["mcpServers"]["user-tool"].is_object());
        assert!(parsed["mcpServers"].get(MCP_KEY).is_none());

        let _ = fs::remove_file(&p);
    }

    #[test]
    fn json_install_creates_missing_file_with_empty_object() {
        let p = tmp_json_path("creates");
        let _ = fs::remove_file(&p);
        install_json(&p, &["mcpServers"], mcp_entry_json(&sample_endpoint()), "test").unwrap();
        assert!(p.exists());
        let parsed: JsonValue = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"][MCP_KEY]["port"], JsonValue::Null); // port isn't in entry, url is
        assert_eq!(parsed["mcpServers"][MCP_KEY]["url"], "http://127.0.0.1:50000/mcp");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn codex_install_then_uninstall_roundtrip() {
        let p = tmp_json_path("codex.toml");
        let _ = fs::remove_file(&p);
        fs::write(
            &p,
            "[other_setting]\nvalue = 42\n\n[mcp_servers.user]\ncommand = \"foo\"\n",
        )
        .unwrap();

        install_codex(&p, &sample_endpoint()).unwrap();
        let with_us = fs::read_to_string(&p).unwrap();
        assert!(with_us.contains("[mcp_servers.coffee-cli]"));
        assert!(with_us.contains("[other_setting]"));
        assert!(with_us.contains("[mcp_servers.user]"));

        assert!(uninstall_codex(&p).unwrap());
        let cleaned = fs::read_to_string(&p).unwrap();
        assert!(!cleaned.contains("coffee-cli"), "our section removed");
        assert!(cleaned.contains("[other_setting]"), "other settings kept");
        assert!(cleaned.contains("[mcp_servers.user]"), "user mcp entries kept");
        let _ = fs::remove_file(&p);
    }
}
