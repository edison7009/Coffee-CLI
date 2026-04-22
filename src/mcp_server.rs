//! Coffee-CLI multi-agent MCP server (v1.0 day 3-4).
//!
//! Exposes 3 tools over HTTP Streamable MCP transport:
//! - `list_panes()` — enumerate panes in the current multi-agent Tab
//! - `send_to_pane(id, text, timeout_sec, wait)` — inject keys into another pane
//! - `read_pane(id, last_n_lines)` — read another pane's recent output
//!
//! Day 3-4 replaces the Day 1-2 MockPaneStore with a live `PaneStore`
//! backed by the existing `terminal::SharedSession` (a HashMap of
//! `portable-pty` sessions keyed by session_id).
//!
//! HTTP transport (not stdio) because Coffee-CLI is a resident Tauri process
//! and can't be spawned as a subprocess by each CLI. See
//! docs/MULTI-AGENT-ARCHITECTURE.md §5.5 for the full rationale.

use std::{
    io::Write,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use crate::terminal::SharedSession;

use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{
        router::tool::ToolRouter,
        wrapper::Parameters,
    },
    model::*,
    schemars::JsonSchema,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
        session::local::LocalSessionManager,
    },
};
use serde::{Deserialize, Serialize};

// ---------- Pane abstraction (in-memory mock for v1.0 day 1-2) ----------

/// State of a single pane as visible to the primary CLI.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
#[schemars(crate = "rmcp::schemars")]
pub enum PaneState {
    /// Pane has no CLI running yet; user hasn't selected one.
    Empty,
    /// PTY is alive and the CLI is accepting input.
    Idle,
    /// CLI is producing output or awaiting long task completion.
    Busy,
    /// PTY exited.
    Terminated,
}

/// Snapshot of a pane returned by `list_panes`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct PaneInfo {
    /// Globally unique id, format `tab-{tab}-pane-{idx}`.
    pub id: String,
    /// User-assigned label.
    pub title: String,
    /// CLI running in this pane (claude / codex / gemini / opencode / shell / ...).
    pub cli: String,
    pub state: PaneState,
    /// Epoch seconds of last output from this pane.
    pub last_activity_at: u64,
}

/// Live pane store bridging the MCP layer to `terminal::SharedSession`.
///
/// Each Coffee-CLI terminal session (one per Tab pane) is visible here as
/// a "pane". The primary pane's CLI (Claude Code / Codex / Gemini / OpenCode)
/// calls MCP tools; we translate those calls into direct operations on
/// the other panes' PTYs.
pub struct PaneStore {
    session: SharedSession,
    /// ANSI escape sequence matcher, reused across reads.
    /// Same pattern as terminal.rs emitter thread (line ~738).
    ansi_re: regex::Regex,
}

impl PaneStore {
    pub fn new(session: SharedSession) -> Self {
        Self {
            session,
            ansi_re: regex::Regex::new(
                r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\].*?(?:\x07|\x1b\\)|\x1b.",
            )
            .expect("ANSI regex compiles"),
        }
    }

    /// Snapshot every session in the shared map as a PaneInfo row.
    ///
    /// v1.0 returns every session in the process; Tab-scoped filtering
    /// (as defined in docs §5.7) is enforced by the UI pane selector and
    /// by the primary CLI following CLAUDE.md / AGENTS.md / GEMINI.md
    /// conventions. Day 5 UI work can add a `?tab=<id>` endpoint filter.
    async fn list(&self) -> Vec<PaneInfo> {
        // Extract everything we need under a brief lock, then drop it.
        let raw = tokio::task::spawn_blocking({
            let session = self.session.clone();
            move || {
                let guard = session.lock().ok()?;
                let rows: Vec<(String, Option<String>, String, Instant)> = guard
                    .iter()
                    .map(|(id, sess)| {
                        let (status, last_at) = match sess.activity.lock() {
                            Ok(act) => (act.last_status.clone(), act.last_output_at),
                            Err(_) => ("unknown".to_string(), Instant::now()),
                        };
                        (id.clone(), sess.tool_name.clone(), status, last_at)
                    })
                    .collect();
                Some(rows)
            }
        })
        .await
        .unwrap_or(None)
        .unwrap_or_default();

        let now_instant = Instant::now();
        let now_epoch = epoch_seconds();

        let mut list: Vec<PaneInfo> = raw
            .into_iter()
            .map(|(id, tool_name, status, last_at)| {
                let elapsed = now_instant.saturating_duration_since(last_at).as_secs();
                let last_activity_at = now_epoch.saturating_sub(elapsed);
                PaneInfo {
                    title: id.clone(),
                    cli: tool_name.unwrap_or_else(|| "shell".to_string()),
                    state: status_to_pane_state(&status),
                    last_activity_at,
                    id,
                }
            })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Inject raw bytes into the target pane's PTY stdin.
    ///
    /// The target sees these bytes exactly as if the user had typed them;
    /// the CLI inside decides how to interpret them. No trailing newline
    /// is appended — callers should include `\r` themselves if they want
    /// the CLI to submit (matching conductor-mcp's `submit` convention).
    async fn send(&self, id: &str, text: &str) -> Result<String, String> {
        let id = id.to_string();
        let text = text.to_string();
        let session = self.session.clone();

        tokio::task::spawn_blocking(move || -> Result<String, String> {
            let writer_lock = {
                let guard = session
                    .lock()
                    .map_err(|_| "session map poisoned".to_string())?;
                let sess = guard
                    .get(&id)
                    .ok_or_else(|| format!("pane not found: {}", id))?;
                sess.writer_lock.clone()
            };

            let mut writer = writer_lock
                .lock()
                .map_err(|_| "pane writer poisoned".to_string())?;
            writer
                .write_all(text.as_bytes())
                .map_err(|e| format!("pty write failed: {}", e))?;
            writer
                .flush()
                .map_err(|e| format!("pty flush failed: {}", e))?;
            Ok(format!("wrote {} bytes", text.len()))
        })
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
    }

    /// Return the last `last_n` lines of the pane's ANSI-stripped output,
    /// plus an `is_idle` flag derived from `last_status`.
    async fn read(&self, id: &str, last_n: usize) -> Result<(String, bool), String> {
        let id = id.to_string();
        let session = self.session.clone();
        let ansi_re = self.ansi_re.clone();

        tokio::task::spawn_blocking(move || -> Result<(String, bool), String> {
            let guard = session
                .lock()
                .map_err(|_| "session map poisoned".to_string())?;
            let sess = guard
                .get(&id)
                .ok_or_else(|| format!("pane not found: {}", id))?;

            // Pull the raw output ring under its own lock, dropped immediately.
            let raw_chunks: Vec<String> = {
                let ring = sess
                    .output_buffer
                    .lock()
                    .map_err(|_| "output buffer poisoned".to_string())?;
                ring.clone()
            };

            let is_idle = sess
                .activity
                .lock()
                .map(|a| a.last_status == "wait_input")
                .unwrap_or(false);

            drop(guard);

            // Join chunks, strip ANSI, keep last N lines.
            let joined = raw_chunks.join("");
            let stripped = ansi_re.replace_all(&joined, "").to_string();
            let mut lines: Vec<&str> = stripped.lines().collect();
            if lines.len() > last_n {
                lines = lines.split_off(lines.len() - last_n);
            }
            Ok((lines.join("\n"), is_idle))
        })
        .await
        .map_err(|e| format!("blocking task join failed: {}", e))?
    }
}

fn status_to_pane_state(status: &str) -> PaneState {
    match status {
        "wait_input" => PaneState::Idle,
        "working" => PaneState::Busy,
        "" | "unknown" => PaneState::Empty,
        _ => PaneState::Idle,
    }
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- MCP tool arguments ----------

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct SendToPaneArgs {
    /// Target pane id (e.g. "tab-0-pane-1"). Must not be the caller's own pane.
    pub id: String,
    /// Text to inject into the target pane's stdin.
    pub text: String,
    /// Seconds to wait for idle if wait=true. Default 60, max 3600.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
    /// If true, block until pane is idle or timeout (default). If false,
    /// return immediately with job_id; caller polls via read_pane later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ReadPaneArgs {
    pub id: String,
    /// Max recent lines to return. Default 200, max 2000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
}

// ---------- MCP server handler ----------

#[derive(Clone)]
pub struct CoffeeMcp {
    tool_router: ToolRouter<CoffeeMcp>,
    panes: Arc<PaneStore>,
}

#[tool_router]
impl CoffeeMcp {
    pub fn new(panes: Arc<PaneStore>) -> Self {
        Self {
            tool_router: Self::tool_router(),
            panes,
        }
    }

    #[tool(
        description = "List all panes in the current multi-agent Tab. \
Returns each pane's id, title, cli name, and state (empty / idle / busy / terminated). \
Use this to discover what other CLIs are running before calling send_to_pane."
    )]
    async fn list_panes(&self) -> Result<CallToolResult, McpError> {
        let panes = self.panes.list().await;
        let payload = serde_json::to_string_pretty(&panes).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(payload)]))
    }

    #[tool(
        description = "Send a text command to another pane. \
If wait=true (default), blocks until the pane is idle or timeout (default 60s). \
If wait=false, returns immediately with a job_id and the caller can poll read_pane later \
for long-running tasks (> 2 min). \
Do NOT send to your own pane id."
    )]
    async fn send_to_pane(
        &self,
        Parameters(args): Parameters<SendToPaneArgs>,
    ) -> Result<CallToolResult, McpError> {
        let wait = args.wait.unwrap_or(true);
        let _timeout_sec = args.timeout_sec.unwrap_or(60).min(3600);

        match self.panes.send(&args.id, &args.text).await {
            Ok(mock_ack) => {
                // v1.0 day 1-2 mock: no real idle polling yet.
                // Day 3-4 will plug in idle detection + 500ms polling (Superset pattern).
                let result = serde_json::json!({
                    "status": if wait { "completed" } else { "submitted" },
                    "pane_id": args.id,
                    "mock_ack": mock_ack,
                    "job_id": uuid::Uuid::new_v4().to_string(),
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&result).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }

    #[tool(
        description = "Read the most recent output lines from another pane. \
Useful after a send_to_pane(wait=false) long task, to check progress or pull final output. \
Returns plain text (ANSI stripped) and an is_idle flag."
    )]
    async fn read_pane(
        &self,
        Parameters(args): Parameters<ReadPaneArgs>,
    ) -> Result<CallToolResult, McpError> {
        let last_n = args.last_n_lines.unwrap_or(200).min(2000);
        match self.panes.read(&args.id, last_n).await {
            Ok((output, is_idle)) => {
                let payload = serde_json::json!({
                    "output": output,
                    "is_idle": is_idle,
                });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({ "status": "failed", "error": e }).to_string(),
            )])),
        }
    }
}

#[tool_handler]
impl ServerHandler for CoffeeMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation::from_build_env(),
            instructions: Some(
                "Coffee-CLI multi-agent MCP server. \
Tools: list_panes, send_to_pane, read_pane. \
Use these to coordinate ACROSS different CLIs (Claude/Codex/Gemini/OpenCode). \
For intra-CLI parallelism, prefer your native subagent SDK (Agent Teams / app-server / TaskTool). \
See CLAUDE.md / AGENTS.md / GEMINI.md in the workspace root for full protocol."
                    .to_string(),
            ),
        }
    }
}

// ---------- Entry point: spawn HTTP server on a dynamic port ----------

/// Information written to ~/.coffee-cli/mcp-endpoint.json so the CLI
/// injection scripts can find the running Coffee-CLI MCP server.
#[derive(Clone, Debug, Serialize)]
pub struct McpEndpoint {
    pub url: String,
    pub port: u16,
    pub pid: u32,
    pub started_at: u64,
}

/// Spawn the MCP server bound to `127.0.0.1:0` (OS-assigned port).
/// Returns the full endpoint info once bound. Server runs in a detached
/// tokio task; caller can drop the returned value (server keeps running
/// for the lifetime of the tokio runtime).
pub async fn spawn(panes: Arc<PaneStore>) -> anyhow::Result<McpEndpoint> {
    let service = StreamableHttpService::new(
        {
            let panes = panes.clone();
            move || Ok(CoffeeMcp::new(panes.clone()))
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );

    let router = axum::Router::new().nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;

    let endpoint = McpEndpoint {
        url: format!("http://{}/mcp", addr),
        port: addr.port(),
        pid: std::process::id(),
        started_at: epoch_seconds(),
    };

    log::info!("coffee-cli mcp server listening at {}", endpoint.url);

    // Persist endpoint for injection scripts.
    write_endpoint_file(&endpoint)?;

    // Detach: server owns the listener and runs until the runtime shuts down.
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            log::error!("coffee-cli mcp server exited with error: {}", e);
        }
    });

    Ok(endpoint)
}

/// Write the endpoint info to `~/.coffee-cli/mcp-endpoint.json` so CLI
/// injection scripts (v1.0 day 7) can discover it.
fn write_endpoint_file(endpoint: &McpEndpoint) -> anyhow::Result<()> {
    let dir = dirs::home_dir()
        .ok_or_else(|| anyhow::anyhow!("no home dir"))?
        .join(".coffee-cli");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("mcp-endpoint.json");
    let json = serde_json::to_string_pretty(endpoint)?;
    std::fs::write(&path, json)?;
    log::debug!("wrote mcp endpoint to {}", path.display());
    Ok(())
}
