//! Coffee-CLI multi-agent MCP server (v1.0 skeleton).
//!
//! Exposes 3 tools over HTTP Streamable MCP transport:
//! - `list_panes()` — enumerate panes in the current multi-agent Tab
//! - `send_to_pane(id, text, timeout_sec, wait)` — inject keys into another pane
//! - `read_pane(id, last_n_lines)` — read another pane's recent output
//!
//! v1.0 day 1-2 uses an in-memory `MockPaneStore`. Day 3-4 replaces it with
//! a real `PaneManager` backed by portable-pty (see src/terminal.rs).
//!
//! HTTP transport (not stdio) because Coffee-CLI is a resident Tauri process
//! and can't be spawned as a subprocess by each CLI. See
//! docs/MULTI-AGENT-ARCHITECTURE.md §5.5 for the full rationale.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

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
use tokio::sync::RwLock;

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

/// In-memory pane store for v1.0 smoke testing.
/// Replaced by `PaneManager` in day 3-4.
#[derive(Default)]
pub struct MockPaneStore {
    panes: RwLock<HashMap<String, MockPane>>,
}

struct MockPane {
    info: PaneInfo,
    /// Rolling output buffer (ANSI already stripped). Newest lines at the end.
    output: Vec<String>,
}

impl MockPaneStore {
    pub async fn seed_demo(&self) {
        let mut panes = self.panes.write().await;
        let now = now_epoch();
        for (idx, (cli, state)) in [
            ("claude", PaneState::Idle),
            ("codex", PaneState::Idle),
            ("gemini", PaneState::Empty),
            ("opencode", PaneState::Empty),
        ]
        .iter()
        .enumerate()
        {
            let id = format!("tab-0-pane-{}", idx);
            panes.insert(
                id.clone(),
                MockPane {
                    info: PaneInfo {
                        id: id.clone(),
                        title: format!("{} pane", cli),
                        cli: cli.to_string(),
                        state: state.clone(),
                        last_activity_at: now,
                    },
                    output: vec![
                        format!("[mock] {} ready", cli),
                        format!("[mock] {} last_activity={}", cli, now),
                    ],
                },
            );
        }
    }

    async fn list(&self) -> Vec<PaneInfo> {
        let panes = self.panes.read().await;
        let mut list: Vec<PaneInfo> = panes.values().map(|p| p.info.clone()).collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    async fn send(&self, id: &str, text: &str) -> Result<String, String> {
        let mut panes = self.panes.write().await;
        let pane = panes
            .get_mut(id)
            .ok_or_else(|| format!("pane not found: {}", id))?;

        match pane.info.state {
            PaneState::Empty => {
                return Err("pane is empty, ask user to start a CLI first".into());
            }
            PaneState::Terminated => {
                return Err("target pane terminated".into());
            }
            _ => {}
        }

        // MOCK: just echo the text into the output buffer.
        // Day 3-4 will replace this with `pty.write(text.as_bytes())`.
        let stamp = now_epoch();
        pane.output.push(format!("[mock-in] {}", text));
        pane.output
            .push(format!("[mock-out] {} replied at {}", pane.info.cli, stamp));
        pane.info.last_activity_at = stamp;

        Ok(format!(
            "[mock] {} received {} bytes",
            pane.info.cli,
            text.len()
        ))
    }

    async fn read(&self, id: &str, last_n: usize) -> Result<(String, bool), String> {
        let panes = self.panes.read().await;
        let pane = panes
            .get(id)
            .ok_or_else(|| format!("pane not found: {}", id))?;

        let start = pane.output.len().saturating_sub(last_n);
        let text = pane.output[start..].join("\n");
        let is_idle = matches!(pane.info.state, PaneState::Idle | PaneState::Empty);
        Ok((text, is_idle))
    }
}

fn now_epoch() -> u64 {
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
    panes: Arc<MockPaneStore>,
}

#[tool_router]
impl CoffeeMcp {
    pub fn new(panes: Arc<MockPaneStore>) -> Self {
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
#[derive(Debug, Serialize)]
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
pub async fn spawn(panes: Arc<MockPaneStore>) -> anyhow::Result<McpEndpoint> {
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
        started_at: now_epoch(),
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
