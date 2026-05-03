//! Per-pane MCP wiring for multi-agent mode.
//!
//! Each multi-agent pane gets:
//!   - a private temp dir at `<temp>/coffee-cli/panes/<sanitized-pane-id>/`
//!     holding the per-pane CLI artifacts (Claude mcp.json / Codex
//!     instructions.md / Gemini extension manifest+GEMINI.md)
//!   - a per-pane MCP HTTP server (with `self_pane_id` baked in at spawn
//!     time), independently of CLI kind. So `whoami()`, `list_panes()`'s
//!     `is_self`, and `[From <id>]` auto-prefixing in `send_to_pane()` are
//!     deterministic across all CLIs — no LLM guessing of pane identity
//!     even when 4 panes run the same CLI type.
//!
//! Per-CLI handoff (consumed by `server::tier_terminal_start_blocking`):
//!
//! | CLI      | Coffee CLI passes via …                                    | Pane reads from …                                         |
//! |----------|------------------------------------------------------------|-----------------------------------------------------------|
//! | Claude   | `--mcp-config <pane-temp>/claude-mcp.json`                 | that JSON file                                            |
//! | Codex    | `-c mcp_servers.coffee-cli.url='<url>'`                    | command-line override (no file)                           |
//! |          | `-c experimental_instructions_file='<pane-temp>/inst.md'`  | per-pane temp file (no workspace touch)                   |
//! | Gemini   | `--extensions coffee-pane-<sanitized>`                     | `~/.gemini/extensions/coffee-pane-<sanitized>/` stub      |
//! |          |                                                            | which holds a link → `<pane-temp>/gemini-extension.json`  |
//! |          |                                                            | + `<pane-temp>/GEMINI.md`                                 |
//! | OpenCode | `OPENCODE_CONFIG=<pane-temp>/opencode.json` env var        | that JSON file (merged onto user's global config; carries |
//! |          |                                                            | `permission: "allow"` since OpenCode TUI has no CLI flag) |
//!
//! Workspace pollution: zero. No `.md`, no `settings.json`, no
//! `mcp_servers` block ever lands in the user's project directory.
//!
//! Global pollution: zero for Claude and Codex (purely command-line +
//! OS temp). One narrow exception for Gemini — Gemini CLI's extension
//! loader ONLY scans `~/.gemini/extensions/<name>/` (no absolute-path
//! flag exists), so each active pane drops a tiny stub directory there
//! containing only a `.gemini-extension-install.json` link metadata
//! file pointing at the real manifest in OS temp. Stubs are pruned at
//! `start_ui` boot, on app shutdown, and on every tab close, so they
//! never accumulate even across crashes (boot-time prune is the
//! belt-and-suspenders catch-all).
//!
//! Auth safety: we never set `CODEX_HOME` / `GEMINI_CLI_HOME`, so
//! Codex's `~/.codex/auth.json` and Gemini's `~/.gemini/oauth_creds.json`
//! always remain reachable. Codex `-c` overrides merge onto the user's
//! `~/.codex/config.toml` rather than replacing it; Gemini extension
//! `mcpServers` merge into the user's existing MCP set. User customisation
//! and credentials are preserved.
//!
//! Lifecycle: `prune_pane_artifacts()` is called once at app start so
//! the previous run's leftover dirs go away, again at shutdown for
//! belt-and-suspenders, and (for the per-tab subset) when a multi-agent
//! tab unmounts. New artifacts are created lazily in
//! `prepare_pane_config_dir()` on every PTY spawn — content is rewritten
//! idempotently each time, safe to call repeatedly for the same pane id.

use std::{fs, path::PathBuf};

use crate::mcp_server::McpEndpoint;

/// Key used for the Coffee CLI entry in every per-pane CLI config.
pub const MCP_KEY: &str = "coffee-cli";

/// Stub-dir prefix in `~/.gemini/extensions/`. Each active multi-agent
/// pane running Gemini gets one stub dir under this prefix. The prefix
/// lets `prune_pane_artifacts()` find and delete stale stubs from
/// previous Coffee CLI runs without touching user-installed extensions.
pub const GEMINI_STUB_PREFIX: &str = "coffee-pane-";

/// Output of [`prepare_pane_config_dir`]. The caller picks the right
/// field based on CLI kind. Default-empty when `cli_kind` doesn't
/// match a multi-agent CLI.
#[derive(Debug, Clone, Default)]
pub struct PaneConfigPaths {
    /// `cli_kind == "claude"` only. Pass via `--mcp-config <path>`.
    pub claude_mcp_config_path: Option<PathBuf>,
    /// `cli_kind == "codex"` only. Caller appends these straight onto
    /// the codex argv (already in `-c key=value` pairs, ready to spawn).
    pub codex_extra_args: Vec<String>,
    /// `cli_kind == "gemini"` only. Pass via `--extensions <name>`. The
    /// stub dir at `~/.gemini/extensions/<name>/` has been created with
    /// link metadata pointing at the real manifest in OS temp.
    pub gemini_extension_name: Option<String>,
    /// `cli_kind == "opencode"` only. Pass via `OPENCODE_CONFIG=<path>`
    /// env var (NOT a CLI flag — OpenCode 1.14 reads only env var or
    /// project-local `opencode.json`; we use the env var so the user's
    /// workspace stays untouched). Merged on top of the user's global
    /// `~/.config/opencode/opencode.json`, so user MCP servers / themes /
    /// auth all stay live; only `mcp.coffee-cli` is added.
    pub opencode_config_path: Option<PathBuf>,
}

/// Build per-pane CLI artifacts for `pane_id` running `cli_kind`,
/// pointed at `endpoint`. `protocol_text` is written into the CLI's
/// instructions file (Codex `instructions.md`, Gemini `GEMINI.md`).
/// Claude takes its protocol text via `--append-system-prompt` and
/// doesn't read a file here — caller passes the same `protocol_text`
/// through that flag separately.
///
/// Idempotent: re-invoking with the same args overwrites in place.
/// Unknown `cli_kind` returns the default empty `PaneConfigPaths`.
pub fn prepare_pane_config_dir(
    pane_id: &str,
    cli_kind: &str,
    endpoint: &McpEndpoint,
    protocol_text: &str,
) -> std::io::Result<PaneConfigPaths> {
    let dir = panes_root().join(sanitize_pane_id(pane_id));
    fs::create_dir_all(&dir)?;

    let mut out = PaneConfigPaths::default();
    match cli_kind {
        "claude" => {
            let p = dir.join("claude-mcp.json");
            fs::write(&p, claude_mcp_json(endpoint))?;
            out.claude_mcp_config_path = Some(p);
        }
        "codex" => {
            // Per-pane protocol text. Referenced by `-c
            // model_instructions_file=<path>` so Codex bakes it into
            // the model's session context. No workspace touch.
            //
            // Note on the key name: Codex 0.x exposed this as
            // `experimental_instructions_file`, but starting with the
            // 2026-04 release the `experimental_` prefix is deprecated
            // and silently ignored — Codex prints
            //   `experimental_instructions_file is deprecated and ignored.
            //    Use model_instructions_file instead.`
            // and our protocol injection becomes a no-op (the multi-agent
            // CLI then has no idea how to call send_to_pane). Use the
            // new key. Older Codex versions just don't recognise it and
            // emit a soft warning, which is the strictly better failure
            // mode (warning + still-runnable shell vs silent no-op).
            let inst = dir.join("instructions.md");
            fs::write(&inst, protocol_text)?;
            // Codex `-c key=value` parses `value` as a TOML scalar. Use
            // TOML literal-strings ('...') so Windows backslashes in
            // the temp path don't accidentally trigger TOML escape
            // sequences (e.g. `\U` would otherwise look like a unicode
            // escape leadin in a basic-string).
            out.codex_extra_args = vec![
                "-c".to_string(),
                format!("mcp_servers.{key}.url='{url}'", key = MCP_KEY, url = endpoint.url),
                "-c".to_string(),
                format!(
                    "model_instructions_file='{path}'",
                    path = inst.display()
                ),
            ];
        }
        "gemini" => {
            let sanitized = sanitize_pane_id(pane_id);
            let extension_name = format!("{}{}", GEMINI_STUB_PREFIX, sanitized);

            // Real manifest + GEMINI.md in OS temp.
            fs::write(
                dir.join("gemini-extension.json"),
                gemini_extension_json(endpoint, &extension_name),
            )?;
            fs::write(dir.join("GEMINI.md"), protocol_text)?;

            // Stub in ~/.gemini/extensions/<name>/ — link metadata
            // pointing at the real manifest in OS temp. This is the
            // `effectiveExtensionPath` escape hatch in Gemini CLI's
            // loader (chunk-RNWNACRD.js:61763): when the stub contains
            // a `.gemini-extension-install.json` with `type=link`, the
            // loader reads the manifest from `source` instead of the
            // stub itself. Lets us keep the real config in OS temp
            // while still satisfying Gemini's "extensions live in
            // ~/.gemini/extensions/" hard-coded path.
            if let Some(stub_dir) = gemini_extensions_dir().map(|d| d.join(&extension_name)) {
                fs::create_dir_all(&stub_dir)?;
                let link_meta = serde_json::json!({
                    "type": "link",
                    "source": dir.display().to_string(),
                });
                fs::write(
                    stub_dir.join(".gemini-extension-install.json"),
                    serde_json::to_string_pretty(&link_meta).unwrap_or_default(),
                )?;
            }
            out.gemini_extension_name = Some(extension_name);
        }
        "opencode" => {
            // OpenCode 1.14 config-resolution chain (per opencode.ai/docs/config):
            //   1. ~/.config/opencode/opencode.json   (global user config)
            //   2. $OPENCODE_CONFIG                   ← we set this
            //   3. <project>/opencode.json            (project-local)
            //   4. $OPENCODE_CONFIG_CONTENT           (inline override)
            // Settings MERGE (not replace), so injecting just `mcp.coffee-cli`
            // here leaves the user's themes, auth, agents, model, and any
            // other MCP servers untouched. Picked the env var path over
            // OPENCODE_CONFIG_CONTENT because (a) Windows env-var JSON
            // escaping is fragile across shell layers, (b) the file is
            // visible on disk for debugging, and (c) `prune_pane_artifacts`
            // already cleans it up via the per-pane temp dir.
            //
            // OpenCode does NOT read project-local config from CWD as long
            // as OPENCODE_CONFIG points elsewhere — wait, actually it
            // ALWAYS reads project-local if present, layered on top. That's
            // fine: user's own `opencode.json` (if any) is their choice and
            // takes precedence over our injected `mcp.coffee-cli` (unless
            // they happen to also key something under that exact name,
            // which would be a deliberate override).
            let p = dir.join("opencode.json");
            fs::write(&p, opencode_config_json(endpoint))?;
            out.opencode_config_path = Some(p);
        }
        _ => {}
    }
    Ok(out)
}

/// Wipe per-pane artifacts from any previous Coffee CLI run:
///   - `<temp>/coffee-cli/panes/`
///   - `~/.gemini/extensions/coffee-pane-*` stub directories
///
/// Called once at app start (recover from crash residue), once at app
/// shutdown (tidy exit). Best-effort — missing dirs and permission
/// glitches are logged but never returned as errors. New artifacts get
/// recreated lazily by `prepare_pane_config_dir()` as panes spawn.
pub fn prune_pane_artifacts() {
    let root = panes_root();
    if root.exists() {
        if let Err(e) = fs::remove_dir_all(&root) {
            log::warn!(
                "[mcp-inject] prune {} failed: {} (will recreate per-pane dirs lazily)",
                root.display(),
                e
            );
        }
    }
    if let Some(ext_dir) = gemini_extensions_dir() {
        if let Ok(entries) = fs::read_dir(&ext_dir) {
            for ent in entries.flatten() {
                let name = ent.file_name();
                if name.to_string_lossy().starts_with(GEMINI_STUB_PREFIX) {
                    let p = ent.path();
                    if let Err(e) = fs::remove_dir_all(&p) {
                        log::warn!("[mcp-inject] prune stub {} failed: {}", p.display(), e);
                    }
                }
            }
        }
    }
}

fn panes_root() -> PathBuf {
    std::env::temp_dir().join("coffee-cli").join("panes")
}

fn gemini_extensions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".gemini").join("extensions"))
}

/// Pane ids contain `::` and `/` which are unfriendly for filenames
/// on Windows. Replace anything outside `[A-Za-z0-9_-]` with `_`.
fn sanitize_pane_id(pane_id: &str) -> String {
    pane_id
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => c,
            _ => '_',
        })
        .collect()
}

fn claude_mcp_json(endpoint: &McpEndpoint) -> String {
    let body = serde_json::json!({
        "mcpServers": {
            MCP_KEY: {
                "type": "http",
                "url": endpoint.url,
            }
        }
    });
    serde_json::to_string_pretty(&body).unwrap_or_default()
}

fn opencode_config_json(endpoint: &McpEndpoint) -> String {
    // Two things this per-pane config must do:
    //
    // 1. MCP server: `type: "remote"` for HTTP endpoints, `url` is the
    //    base URL. Matches Claude's `type: "http"` semantically but uses
    //    OpenCode's own naming (see opencode.ai/docs/mcp-servers).
    //
    // 2. `permission: "allow"`: OpenCode's TUI has no
    //    `--dangerously-skip-permissions` CLI flag (only `opencode run`
    //    does); the only hands-free path is the config field. The single-
    //    string form blanket-approves every permission category — read,
    //    edit, bash, webfetch, external_directory, etc. — which is the
    //    correct level of trust for multi-agent mode where another
    //    pane's LLM is dispatching work and there's no human at the
    //    keyboard to click "Allow". Per-pane config means the user's
    //    own standalone-OpenCode runs (in other terminals, with a
    //    human watching) keep their normal interactive permissions.
    let body = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "permission": "allow",
        "mcp": {
            MCP_KEY: {
                "type": "remote",
                "url": endpoint.url,
            }
        }
    });
    serde_json::to_string_pretty(&body).unwrap_or_default()
}

fn gemini_extension_json(endpoint: &McpEndpoint, extension_name: &str) -> String {
    let body = serde_json::json!({
        "name": extension_name,
        "version": "1.0.0",
        "description": "Coffee CLI multi-agent pane bridge",
        "contextFileName": "GEMINI.md",
        "mcpServers": {
            MCP_KEY: {
                "httpUrl": endpoint.url,
            }
        }
    });
    serde_json::to_string_pretty(&body).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep() -> McpEndpoint {
        McpEndpoint {
            url: "http://127.0.0.1:50000/mcp".into(),
            port: 50000,
            pid: std::process::id(),
            started_at: 1_700_000_000,
        }
    }

    fn unique_pane(label: &str) -> String {
        format!("test::pane-{}-{}", label, std::process::id())
    }

    #[test]
    fn claude_writes_mcp_json_with_url() {
        let pid = unique_pane("claude");
        let out = prepare_pane_config_dir(&pid, "claude", &ep(), "PROMPT").unwrap();
        let p = out.claude_mcp_config_path.expect("claude returns path");
        let body = fs::read_to_string(&p).unwrap();
        assert!(body.contains("coffee-cli"));
        assert!(body.contains("http://127.0.0.1:50000/mcp"));
        let _ = fs::remove_dir_all(panes_root().join(sanitize_pane_id(&pid)));
    }

    #[test]
    fn codex_returns_minus_c_args_only() {
        let pid = unique_pane("codex");
        let out = prepare_pane_config_dir(&pid, "codex", &ep(), "PROTOCOL BODY").unwrap();
        assert!(out.claude_mcp_config_path.is_none());
        assert!(out.gemini_extension_name.is_none());
        assert_eq!(out.codex_extra_args.len(), 4);
        assert_eq!(out.codex_extra_args[0], "-c");
        assert!(out.codex_extra_args[1].contains("mcp_servers.coffee-cli.url"));
        assert!(out.codex_extra_args[1].contains("http://127.0.0.1:50000/mcp"));
        assert_eq!(out.codex_extra_args[2], "-c");
        assert!(out.codex_extra_args[3].contains("model_instructions_file"));
        // Protocol text actually got written.
        let inst_path = panes_root()
            .join(sanitize_pane_id(&pid))
            .join("instructions.md");
        let body = fs::read_to_string(&inst_path).unwrap();
        assert_eq!(body, "PROTOCOL BODY");
        let _ = fs::remove_dir_all(panes_root().join(sanitize_pane_id(&pid)));
    }

    #[test]
    fn gemini_writes_real_manifest_and_stub() {
        let pid = unique_pane("gemini");
        let out = prepare_pane_config_dir(&pid, "gemini", &ep(), "GEMINI BODY").unwrap();
        let name = out
            .gemini_extension_name
            .clone()
            .expect("gemini returns name");
        assert!(name.starts_with(GEMINI_STUB_PREFIX));
        // Real manifest in OS temp.
        let temp_dir = panes_root().join(sanitize_pane_id(&pid));
        let manifest = fs::read_to_string(temp_dir.join("gemini-extension.json")).unwrap();
        assert!(manifest.contains("coffee-cli"));
        assert!(manifest.contains("httpUrl"));
        assert!(manifest.contains("http://127.0.0.1:50000/mcp"));
        let gemini_md = fs::read_to_string(temp_dir.join("GEMINI.md")).unwrap();
        assert_eq!(gemini_md, "GEMINI BODY");
        // Stub in ~/.gemini/extensions/.
        if let Some(stub_dir) = gemini_extensions_dir().map(|d| d.join(&name)) {
            let link = fs::read_to_string(stub_dir.join(".gemini-extension-install.json"))
                .unwrap();
            assert!(link.contains("\"type\""));
            assert!(link.contains("\"link\""));
            // serde_json escapes backslashes so the literal source path
            // doesn't byte-match temp_dir.display(). Confirm the source
            // field exists and contains the unique sanitized pane id —
            // that's enough to prove this stub points at THIS pane's
            // dir and not some shared one.
            assert!(link.contains("\"source\""));
            assert!(link.contains(&sanitize_pane_id(&pid)));
            let _ = fs::remove_dir_all(&stub_dir);
        }
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn opencode_writes_config_file_with_url_and_allow_permission() {
        let pid = unique_pane("opencode");
        let out = prepare_pane_config_dir(&pid, "opencode", &ep(), "IGNORED").unwrap();
        let p = out.opencode_config_path.expect("opencode returns path");
        assert!(out.claude_mcp_config_path.is_none());
        assert!(out.codex_extra_args.is_empty());
        assert!(out.gemini_extension_name.is_none());
        let body = fs::read_to_string(&p).unwrap();
        assert!(body.contains("coffee-cli"));
        assert!(body.contains("\"type\": \"remote\""));
        assert!(body.contains("http://127.0.0.1:50000/mcp"));
        // permission: "allow" is the only hands-free path for OpenCode TUI
        // (no --dangerously-skip-permissions equivalent). Without it,
        // multi-agent dispatch into an OpenCode pane wedges on the first
        // permission prompt with no human present to approve.
        assert!(body.contains("\"permission\": \"allow\""));
        let _ = fs::remove_dir_all(panes_root().join(sanitize_pane_id(&pid)));
    }

    #[test]
    fn unknown_cli_kind_is_a_noop() {
        let pid = unique_pane("unknown");
        let out = prepare_pane_config_dir(&pid, "qwen", &ep(), "ignored").unwrap();
        assert!(out.claude_mcp_config_path.is_none());
        assert!(out.codex_extra_args.is_empty());
        assert!(out.gemini_extension_name.is_none());
        assert!(out.opencode_config_path.is_none());
        let _ = fs::remove_dir_all(panes_root().join(sanitize_pane_id(&pid)));
    }
}
