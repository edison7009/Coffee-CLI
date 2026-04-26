//! Coffee-CLI multi-agent MCP server.
//!
//! Exposes 3 tools over HTTP Streamable MCP transport:
//! - `list_panes()` — enumerate panes in the current multi-agent Tab with
//!   their CLI type, state (empty / idle / busy / terminated), and titles.
//! - `send_to_pane(id, text, timeout_sec, wait)` — inject keys into another
//!   pane's PTY; synchronously waits for that pane to return to idle if
//!   `wait=true`, otherwise fires-and-forgets.
//! - `read_pane(id, last_n_lines)` — read recent output from another pane
//!   (ANSI-stripped), useful for checking on a fire-and-forget dispatch.
//!
//! HTTP transport (not stdio) because Coffee-CLI is a resident Tauri
//! process and can't be spawned as a subprocess by each CLI. The Rust
//! backend binds `127.0.0.1:<random>` at startup, and each primary CLI's
//! config file (see `mcp_injector.rs`) is patched with a `mcpServers.coffee-cli`
//! entry pointing at that ephemeral URL — which means a shutdown hook
//! MUST clean those entries out on Coffee-CLI exit, otherwise opening a
//! standalone Claude window later hits a dead-port connection error.
//!
//! This is the FORWARD-DISPATCH layer (agent A → agent B). The Sentinel
//! Protocol sitting on top of MCP adds a BACKWARD receipt: when the
//! dispatched agent finishes, it emits `[COFFEE-DONE:paneN->paneM]` into
//! its own PTY output, and the frontend injects a "task complete"
//! notification into the dispatcher's PTY input so the dispatcher's
//! turn-loop can wake up without polling. See TierTerminal.tsx.
//!
//! History: MCP was retired in 2026-04-24 in a misread of the user's
//! product intent ("sentinel is on-top-of MCP, not replacement-for") and
//! restored 2026-04-25. See docs/MULTI-AGENT-ARCHITECTURE.md §九 decision
//! log for the embarrassing details.

use std::{
    io::Write,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    /// `true` only for the row representing the caller's own pane.
    /// Set by the MCP server based on its baked-in `self_pane_id`,
    /// so a CLI receiving this list knows unambiguously which entry
    /// is itself — even when 4 panes run the same CLI type.
    /// Omitted (None / not serialized) if the server doesn't know
    /// the caller's identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_self: Option<bool>,
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
                    is_self: None, // filled in by CoffeeMcp::list_panes if known
                }
            })
            .collect();
        list.sort_by(|a, b| a.id.cmp(&b.id));
        list
    }

    /// Inject text into the target pane's PTY stdin and, when `wait=true`,
    /// block until the pane's CLI returns to its prompt (or `timeout_sec`
    /// elapses), then return the ANSI-stripped output that arrived since
    /// the write.
    ///
    /// `submit=true` (default) auto-appends `\r` if the text isn't already
    /// newline-terminated, so the target CLI actually executes the command
    /// instead of leaving it in the input box. The carriage return also
    /// mirrors [`crate::server::tier_terminal_write`]'s bookkeeping: we
    /// set `activity.user_submitted_at` so the status ticker flips to
    /// `"working"` and we can later detect the transition back to
    /// `"wait_input"` as the signal that the CLI finished.
    ///
    /// Output capture works by diffing `output_buffer` snapshots taken
    /// before the write vs. after idle detection. The ring can drain
    /// (capped at 2000 chunks in `terminal.rs`); in that rare case we
    /// fall back to returning the current tail rather than failing.
    async fn dispatch(
        &self,
        id: &str,
        text: &str,
        submit: bool,
        wait: bool,
        timeout_sec: u64,
    ) -> Result<DispatchResult, String> {
        // Strip any caller-provided trailing newline; we always append our
        // own in a SECOND write so Ink/React-based REPLs (Gemini, Claude
        // Code) treat the body and the Enter as two separate stdin events
        // — not one pasted chunk where the final \r gets swallowed as
        // part of the text. Observed live: a combined "body\r" write
        // shows up in Gemini's input box but never submits; splitting
        // body + short sleep + "\r" reliably submits.
        let body = text.trim_end_matches(['\r', '\n']).to_string();
        let should_submit = submit;
        let bytes_written = body.len() + if should_submit { 1 } else { 0 };

        // Phase 1a: snapshot buffer + write BODY (no Enter yet).
        let buf_before = {
            let id2 = id.to_string();
            let body2 = body.clone();
            let session = self.session.clone();
            tokio::task::spawn_blocking(move || -> Result<String, String> {
                let (writer_arc, buffer_arc) = {
                    let guard = session
                        .lock()
                        .map_err(|_| "session map poisoned".to_string())?;
                    let sess = guard
                        .get(&id2)
                        .ok_or_else(|| format!("pane not found: {}", id2))?;
                    (sess.writer_lock.clone(), sess.output_buffer.clone())
                };

                let before = {
                    let ring = buffer_arc
                        .lock()
                        .map_err(|_| "output buffer poisoned".to_string())?;
                    ring.join("")
                };

                {
                    let mut writer = writer_arc
                        .lock()
                        .map_err(|_| "pane writer poisoned".to_string())?;
                    if !body2.is_empty() {
                        writer
                            .write_all(body2.as_bytes())
                            .map_err(|e| format!("pty write failed: {}", e))?;
                        writer
                            .flush()
                            .map_err(|e| format!("pty flush failed: {}", e))?;
                    }
                }

                Ok(before)
            })
            .await
            .map_err(|e| format!("blocking task join failed: {}", e))??
        };

        // Phase 1b: pause so the target REPL processes the body
        // characters into its input field, THEN send the Enter as a
        // separate keystroke. Observed live on 2026-04-23: a flat
        // 120ms was enough for short < 100-char prompts but failed for
        // a 300-char multi-line Claude→Gemini dispatch — Gemini's Ink
        // reconciler was still painting the last lines when `\r`
        // arrived, so the CR got absorbed into the text instead of
        // submitting. Body-size proportional delay fixes the whole
        // range: 250ms base (covers the fixed render cost) + 1ms per
        // body character (scales with paint work), clamped to 1.5s
        // so we never sit on a huge paste for ages. Still fires
        // mirror of server::tier_terminal_write's user_submitted_at
        // so the status ticker flips to "working".
        if should_submit {
            let body_len = body.chars().count() as u64;
            let delay_ms = (250 + body_len).clamp(250, 1500);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let id3 = id.to_string();
            let session = self.session.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let (writer_arc, activity_arc) = {
                    let guard = session
                        .lock()
                        .map_err(|_| "session map poisoned".to_string())?;
                    let sess = guard
                        .get(&id3)
                        .ok_or_else(|| format!("pane not found: {}", id3))?;
                    (sess.writer_lock.clone(), sess.activity.clone())
                };
                {
                    let mut writer = writer_arc
                        .lock()
                        .map_err(|_| "pane writer poisoned".to_string())?;
                    writer
                        .write_all(b"\r")
                        .map_err(|e| format!("pty write failed: {}", e))?;
                    writer
                        .flush()
                        .map_err(|e| format!("pty flush failed: {}", e))?;
                }
                if let Ok(mut act) = activity_arc.lock() {
                    if act.last_status == "wait_input" {
                        act.user_submitted_at = Some(Instant::now());
                    }
                }
                Ok(())
            })
            .await
            .map_err(|e| format!("blocking task join failed: {}", e))??;

            // Phase 1d: verify the CR actually submitted. This is the
            // single most critical correctness gate of the dispatch flow:
            // if the body delivered but the CR was absorbed (Ink/React
            // reconciler still painting when \r arrived, bracketed-paste
            // mode swallowing the trailing newline, etc.), the target
            // pane sits silently with the message stuck in its input
            // box and the entire orchestration hangs — exact symptom
            // user reported as "成语接龙 pane 2 不动".
            //
            // Detection: after a 1.5s grace, if no PTY output has
            // arrived since we wrote the CR AND the activity ticker
            // still thinks the pane is at its input prompt, the CR
            // almost certainly never reached the REPL's reducer.
            // (Real LLM CLIs paint *something* — Thinking…/spinner/
            // input-box clear — within 1.5s of a successful submit.)
            //
            // Recovery: send a single retry CR. Cost of a false positive
            // (CR did land but the LLM was unusually slow) is one empty
            // Enter at the prompt, which all three target CLIs (Claude
            // Code / Codex / Gemini) treat as a no-op. We deliberately
            // do not retry more than once: two retries means the agent
            // is genuinely stuck (network, OOM, model crash) and adding
            // more CRs won't help — let the wait loop time out and
            // surface that to the caller.
            let cr_send_time = Instant::now();
            tokio::time::sleep(Duration::from_millis(1500)).await;

            let cr_lost = {
                let id_check = id.to_string();
                let session_check = self.session.clone();
                tokio::task::spawn_blocking(move || -> bool {
                    let Ok(guard) = session_check.lock() else { return false; };
                    let Some(sess) = guard.get(&id_check) else { return false; };
                    let Ok(act) = sess.activity.lock() else { return false; };
                    act.last_output_at < cr_send_time && act.last_status == "wait_input"
                })
                .await
                .unwrap_or(false)
            };

            if cr_lost {
                log::warn!(
                    "coffee-cli mcp dispatch: CR appears absorbed by {}, retrying once",
                    id
                );
                let id_retry = id.to_string();
                let session_retry = self.session.clone();
                let _ = tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let writer_arc = {
                        let guard = session_retry
                            .lock()
                            .map_err(|_| "session map poisoned".to_string())?;
                        let sess = guard
                            .get(&id_retry)
                            .ok_or_else(|| format!("pane not found: {}", id_retry))?;
                        sess.writer_lock.clone()
                    };
                    let mut writer = writer_arc
                        .lock()
                        .map_err(|_| "pane writer poisoned".to_string())?;
                    writer
                        .write_all(b"\r")
                        .map_err(|e| format!("pty write failed: {}", e))?;
                    writer
                        .flush()
                        .map_err(|e| format!("pty flush failed: {}", e))?;
                    Ok(())
                })
                .await;
            }
        }

        if !wait {
            return Ok(DispatchResult {
                bytes_written,
                waited: false,
                timed_out: false,
                captured_output: None,
            });
        }

        // Phase 2: poll for idle. Two independent paths — either one means
        // the pane is done.
        //
        //   A) marker-based: ticker flipped status back to "wait_input"
        //      (shell prompt marker seen) AND output either arrived since
        //      send or has been quiet 2s+. Primary path when terminal.rs's
        //      prompt_markers match the target CLI's actual prompt.
        //
        //   B) settle-based: we saw output come in after send time AND then
        //      it has been quiet for 2.5s+. Independent of prompt markers.
        //      Load-bearing when a CLI's prompt isn't in the marker list
        //      (observed live: Gemini CLI's "* " input prompt doesn't
        //      match its preset `✦`, so path A never fires and the
        //      controller pane would hang forever waiting on a response
        //      that already arrived).
        //
        // The settle_silence threshold is slightly longer than long_silence
        // so we don't declare idle in the gap BETWEEN our write hitting
        // the PTY and Gemini starting to render its answer.
        let send_time = Instant::now();
        let deadline = send_time + Duration::from_secs(timeout_sec);

        // Initial grace so the ticker thread (1s cadence in terminal.rs)
        // has a chance to observe output and flip status to "working".
        tokio::time::sleep(Duration::from_millis(400)).await;

        let mut timed_out = true;
        loop {
            if Instant::now() > deadline {
                break;
            }

            let idle = {
                let id2 = id.to_string();
                let session = self.session.clone();
                tokio::task::spawn_blocking(move || -> Result<bool, String> {
                    let guard = session
                        .lock()
                        .map_err(|_| "session map poisoned".to_string())?;
                    let sess = guard
                        .get(&id2)
                        .ok_or_else(|| format!("pane not found: {}", id2))?;
                    let act = sess
                        .activity
                        .lock()
                        .map_err(|_| "activity poisoned".to_string())?;
                    let at_prompt = act.last_status == "wait_input";
                    let now = Instant::now();
                    let produced_since_send = act.last_output_at >= send_time;
                    let silence = now.duration_since(act.last_output_at);
                    // Observed 2026-04-23: LLM-driven CLIs (Claude/Codex/
                    // Gemini) pause 3-8s between planning phases while
                    // the model thinks; the old 2s/2.5s thresholds
                    // treated these as "task done" and returned Claude a
                    // half-finished result. Bump to 8s/15s — Gemini's
                    // longest observed mid-task think gap was ~10s, so
                    // 15s for settle_silence is conservative without
                    // stretching too long. Real idle after a genuinely
                    // completed task (Gemini renders ✨ summary, prompt
                    // returns) hits marker_path in <2s and early-returns
                    // regardless, so this doesn't slow the happy path.
                    let long_silence = silence > Duration::from_millis(8000);
                    let settle_silence = silence > Duration::from_millis(15000);

                    let marker_path = at_prompt && (produced_since_send || long_silence);
                    let settle_path = produced_since_send && settle_silence;

                    Ok(marker_path || settle_path)
                })
                .await
                .map_err(|e| format!("blocking task join failed: {}", e))??
            };

            if idle {
                timed_out = false;
                break;
            }

            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        // Phase 3: snapshot buffer after idle and extract the new suffix.
        let buf_after = {
            let id2 = id.to_string();
            let session = self.session.clone();
            tokio::task::spawn_blocking(move || -> Result<String, String> {
                let guard = session
                    .lock()
                    .map_err(|_| "session map poisoned".to_string())?;
                let sess = guard
                    .get(&id2)
                    .ok_or_else(|| format!("pane not found: {}", id2))?;
                let ring = sess
                    .output_buffer
                    .lock()
                    .map_err(|_| "output buffer poisoned".to_string())?;
                Ok(ring.join(""))
            })
            .await
            .map_err(|e| format!("blocking task join failed: {}", e))??
        };

        let raw_diff = if buf_after.starts_with(&buf_before) {
            buf_after[buf_before.len()..].to_string()
        } else {
            // Ring was drained between snapshots — best effort, return all.
            buf_after
        };

        let stripped = self.ansi_re.replace_all(&raw_diff, "").to_string();

        // Cap at last 200 lines; the MCP caller can re-read via read_pane
        // if it needs more. Keeps tool-result payload bounded.
        let trimmed = {
            let mut lines: Vec<&str> = stripped.lines().collect();
            if lines.len() > 200 {
                lines = lines.split_off(lines.len() - 200);
            }
            lines.join("\n")
        };

        Ok(DispatchResult {
            bytes_written,
            waited: true,
            timed_out,
            captured_output: Some(trimmed),
        })
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

/// Outcome of `PaneStore::dispatch` — conveyed back to the MCP caller so
/// it can distinguish "CLI finished and here's its reply" from "timeout,
/// reply may still be coming, use read_pane to poll" from fire-and-forget.
#[derive(Debug)]
pub struct DispatchResult {
    pub bytes_written: usize,
    /// Whether the caller requested wait=true (vs fire-and-forget).
    pub waited: bool,
    /// True only when waited=true AND the deadline hit without the pane
    /// flipping back to wait_input. `captured_output` still holds whatever
    /// arrived in that window.
    pub timed_out: bool,
    /// ANSI-stripped output that arrived between the write and idle.
    /// Some(..) iff waited=true; None iff fire-and-forget.
    pub captured_output: Option<String>,
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
    /// Target pane id (e.g. "<tab_id>::pane-2"; pane numbers are 1..4
    /// matching the UI badge). Must not be the caller's own pane.
    pub id: String,
    /// Text to inject into the target pane's stdin.
    pub text: String,
    /// Seconds to wait for idle if wait=true. Default 600, max 3600.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_sec: Option<u64>,
    /// If true, block until pane is idle or timeout (default). If false,
    /// return immediately with job_id; caller polls via read_pane later.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<bool>,
    /// If true (default), auto-append `\r` unless `text` already ends with
    /// a newline. Set false when you need to type without submitting (e.g.
    /// inserting template text for the user to finish editing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submit: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[schemars(crate = "rmcp::schemars")]
pub struct ReadPaneArgs {
    pub id: String,
    /// Max recent lines to return. Default 200, max 2000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_n_lines: Option<usize>,
}

/// Extract the tab id portion of a pane id (`${tab_id}::pane-${idx}`).
/// Used to scope `list_panes` and `send_to_pane` to the caller's own
/// multi-agent Tab so simultaneous tabs don't see / dispatch to each
/// other. If the input doesn't match the expected format, returns the
/// whole string — that's a safe fallback (single-tab in legacy mode).
fn tab_prefix(pane_id: &str) -> &str {
    match pane_id.find("::pane-") {
        Some(idx) => &pane_id[..idx],
        None => pane_id,
    }
}

#[cfg(test)]
mod tests {
    use super::tab_prefix;

    #[test]
    fn tab_prefix_extracts_tab_portion() {
        assert_eq!(tab_prefix("tab-abc::pane-1"), "tab-abc");
        assert_eq!(tab_prefix("tab-abc::pane-4"), "tab-abc");
        assert_eq!(
            tab_prefix("tab-uuid-with-dashes::pane-2"),
            "tab-uuid-with-dashes"
        );
    }

    #[test]
    fn tab_prefix_falls_back_for_unmatched_format() {
        // Legacy / split-pane / shell sessions don't use the
        // ::pane- format. Returning the whole id is the safe
        // default — these never collide cross-Tab anyway.
        assert_eq!(tab_prefix("legacy-session-id"), "legacy-session-id");
        assert_eq!(tab_prefix("tab-X::split-1"), "tab-X::split-1");
    }

    #[test]
    fn tab_prefix_distinguishes_concurrent_tabs() {
        // The whole point of tab_prefix: panes in tab-A and tab-B
        // must produce DIFFERENT prefixes so list_panes can filter
        // them apart even when both Tabs run 4 Claude panes.
        let a1 = tab_prefix("tab-A::pane-1");
        let b1 = tab_prefix("tab-B::pane-1");
        assert_ne!(a1, b1, "concurrent multi-agent tabs must be isolatable");
    }
}

// ---------- MCP server handler ----------

#[derive(Clone)]
pub struct CoffeeMcp {
    tool_router: ToolRouter<CoffeeMcp>,
    panes: Arc<PaneStore>,
    /// The pane this MCP server instance is dedicated to — i.e. "the
    /// caller's identity, baked in at spawn time". Each multi-agent
    /// pane spawns its own MCP server bound to its own port, with
    /// its own `self_pane_id` set. `None` means the server is
    /// anonymous (legacy / non-multi-agent mode); in that case
    /// `whoami` returns an error and `list_panes` doesn't mark
    /// `is_self`.
    self_pane_id: Option<String>,
}

#[tool_router]
impl CoffeeMcp {
    pub fn new(panes: Arc<PaneStore>, self_pane_id: Option<String>) -> Self {
        Self {
            tool_router: Self::tool_router(),
            panes,
            self_pane_id,
        }
    }

    #[tool(
        description = "Return the caller's own pane id. Use this once at \
session start to know which pane you're running in — Coffee-CLI bakes \
the id into this MCP server instance at spawn time, so no inference is \
needed. The returned id is what you should pass as the `from` field of \
[COFFEE-DONE] markers and what you'll see as `is_self: true` in \
list_panes()."
    )]
    async fn whoami(&self) -> Result<CallToolResult, McpError> {
        match &self.self_pane_id {
            Some(id) => {
                let payload = serde_json::json!({ "pane_id": id });
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
                )]))
            }
            None => Ok(CallToolResult::success(vec![Content::text(
                serde_json::json!({
                    "error": "this MCP server is not bound to a specific pane",
                })
                .to_string(),
            )])),
        }
    }

    #[tool(
        description = "List all panes in the caller's own multi-agent Tab. \
Cross-Tab panes (from other multi-agent windows the user has open) are \
filtered out — you only see your own peers. The caller's own row is \
marked `is_self: true` so you always know which entry is yourself, even \
when multiple panes run the same CLI type. Returns each pane's id, title, \
cli name, and state (empty / idle / busy / terminated). Use this to \
discover what peers are running before calling send_to_pane."
    )]
    async fn list_panes(&self) -> Result<CallToolResult, McpError> {
        let mut panes = self.panes.list().await;
        if let Some(self_id) = &self.self_pane_id {
            // Tab-scope filter: a pane id is `${tab_id}::pane-${idx}`.
            // Only show panes whose tab prefix matches the caller's.
            // This is what makes simultaneous multi-agent tabs safe —
            // pane in Tab A can't accidentally dispatch to a pane in
            // Tab B because it never sees Tab B's panes in the first
            // place.
            let self_tab = tab_prefix(self_id);
            panes.retain(|p| tab_prefix(&p.id) == self_tab);
            for p in &mut panes {
                if &p.id == self_id {
                    p.is_self = Some(true);
                }
            }
        }
        let payload = serde_json::to_string_pretty(&panes).unwrap_or_default();
        Ok(CallToolResult::success(vec![Content::text(payload)]))
    }

    #[tool(
        description = "Send a text command to another pane and (by default) \
wait for that pane's CLI to respond. A carriage return is auto-appended so \
the target CLI actually executes the command (set submit=false to disable). \
If wait=true (default), blocks until the pane is idle or timeout (default 60s) \
and returns the new output that arrived — this is how you see the other CLI's \
reply. If wait=false, returns immediately; caller polls read_pane later for \
long-running tasks (> 2 min). Do NOT send to your own pane id."
    )]
    async fn send_to_pane(
        &self,
        Parameters(args): Parameters<SendToPaneArgs>,
    ) -> Result<CallToolResult, McpError> {
        // Reject self-dispatch up front — this MCP instance knows
        // exactly which pane it represents.
        if let Some(self_id) = &self.self_pane_id {
            if self_id == &args.id {
                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::json!({
                        "status": "failed",
                        "error": "cannot send_to_pane to self",
                        "self_pane_id": self_id,
                    })
                    .to_string(),
                )]));
            }
            // Cross-Tab guard: refuse to dispatch into a pane that
            // belongs to a different multi-agent Tab. Without this,
            // a 4-pane Tab A could accidentally pipe work into a
            // 4-pane Tab B because both tabs share the same global
            // SharedSession map. Mirrors the filtering done in
            // `list_panes`.
            let self_tab = tab_prefix(self_id);
            let target_tab = tab_prefix(&args.id);
            if self_tab != target_tab {
                return Ok(CallToolResult::success(vec![Content::text(
                    serde_json::json!({
                        "status": "failed",
                        "error": "target pane belongs to a different Tab; cross-Tab dispatch is not supported",
                        "self_tab": self_tab,
                        "target_tab": target_tab,
                    })
                    .to_string(),
                )]));
            }
        }
        let wait = args.wait.unwrap_or(true);
        let submit = args.submit.unwrap_or(true);
        // Default 600s (10 min) — a real orchestration task (refactor,
        // multi-step code edit, doc generation) commonly runs 3-8 min
        // in the target CLI. A 180s default still forced the user into
        // the manual "check pane X" ping flow for anything non-trivial,
        // defeating "hands-free orchestration". 10 min covers the 99th
        // percentile while still having a firm ceiling so a crashed or
        // stuck pane doesn't wedge the caller indefinitely. Early-exit
        // on actual idle detection means short tasks still return fast.
        let timeout_sec = args.timeout_sec.unwrap_or(600).min(3600);

        // Prefix the dispatched text with `[From <self_pane_id>]` so the
        // receiving CLI's LLM sees who sent the work — without this the
        // target gets a bare command and has to guess the source.
        let dispatch_text = match &self.self_pane_id {
            Some(self_id) => format!("[From {}] {}", self_id, args.text),
            None => args.text.clone(),
        };

        match self
            .panes
            .dispatch(&args.id, &dispatch_text, submit, wait, timeout_sec)
            .await
        {
            Ok(result) => {
                let status = if !result.waited {
                    "submitted"
                } else if result.timed_out {
                    "timeout"
                } else {
                    "completed"
                };
                let mut payload = serde_json::json!({
                    "status": status,
                    "pane_id": args.id,
                    "bytes_written": result.bytes_written,
                });
                if !result.waited {
                    payload["job_id"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
                }
                if let Some(output) = result.captured_output {
                    payload["output"] = serde_json::json!(output);
                }
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string_pretty(&payload).unwrap_or_default(),
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

/// Axum middleware that (a) logs every incoming request for debugging
/// and (b) works around rmcp 0.8.5's strict Accept-header check.
///
/// rmcp 0.8.5 StreamableHttpService returns **HTTP 406 Not Acceptable**
/// unless the request's `Accept` header contains BOTH `application/json`
/// AND `text/event-stream`. Some MCP clients (observed with Claude Code
/// v2.1.114) only send one of the two and get rejected before they can
/// call any tool.
///
/// We rewrite the Accept header to the canonical combination so rmcp
/// always proceeds. rmcp then decides response shape (JSON vs SSE) based
/// on the request; both shapes are MCP-spec compliant.
async fn mcp_request_middleware(
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::{header, HeaderValue};
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let accept_in = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_default();

    // Always present both media types to rmcp; that's the only combo it accepts.
    req.headers_mut().insert(
        header::ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );

    log::info!(
        "[mcp] {} {} accept-in=\"{}\" → \"application/json, text/event-stream\"",
        method,
        path,
        accept_in
    );

    next.run(req).await
}

/// Spawn the MCP server bound to `127.0.0.1:0` (OS-assigned port).
/// Returns the full endpoint info once bound. Server runs in a detached
/// tokio task; caller can drop the returned value (server keeps running
/// for the lifetime of the tokio runtime).
///
/// `self_pane_id` bakes a specific pane identity into THIS server
/// instance: every tool call to it is treated as coming from that pane.
/// Pass `None` for an "anonymous" server (legacy / non-multi-agent),
/// or `Some(pane_id)` to make `whoami()`, `is_self` in `list_panes`,
/// and `[From <id>]` prefixing in `send_to_pane` all work without the
/// LLM needing to guess.
pub async fn spawn(
    panes: Arc<PaneStore>,
    self_pane_id: Option<String>,
) -> anyhow::Result<McpEndpoint> {
    let service = StreamableHttpService::new(
        {
            let panes = panes.clone();
            let pane_id = self_pane_id.clone();
            move || Ok(CoffeeMcp::new(panes.clone(), pane_id.clone()))
        },
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );

    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(mcp_request_middleware));
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

/// Full snapshot of every running MCP server in this Coffee CLI
/// process. Persisted to `~/.coffee-cli/mcp-state.json` on every
/// spawn so the `coffee-cli mcp-status` subcommand can introspect
/// the live state from outside the GUI process — invaluable for
/// support tickets.
#[derive(Clone, Debug, Serialize)]
pub struct McpStateManifest {
    pub pid: u32,
    pub written_at: u64,
    /// Anonymous (no `self_pane_id`) MCP server, only spawned when
    /// non-Claude CLIs need global-config injection. May be absent
    /// in a pure-Claude workspace.
    pub anonymous: Option<McpEndpoint>,
    /// Per-pane MCP servers, one entry per multi-agent Claude pane.
    pub panes: Vec<PaneEndpointEntry>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PaneEndpointEntry {
    pub pane_id: String,
    pub url: String,
    pub port: u16,
    pub started_at: u64,
}

/// Path of the manifest file. Returned even when the home dir lookup
/// fails so callers can show a useful "tried path" diagnostic.
pub fn state_manifest_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".coffee-cli")
        .join("mcp-state.json")
}

/// Atomically write the current MCP topology to disk. Caller passes
/// the anonymous endpoint (if any) and the per-pane endpoint map
/// extracted from `AppState`. Best-effort — errors are logged but
/// don't propagate, since a missing manifest just means the
/// `mcp-status` subcommand won't see this run (not a runtime fault).
pub fn write_state_manifest(
    anonymous: Option<&McpEndpoint>,
    panes: &std::collections::HashMap<String, McpEndpoint>,
) {
    let manifest = McpStateManifest {
        pid: std::process::id(),
        written_at: epoch_seconds(),
        anonymous: anonymous.cloned(),
        panes: panes
            .iter()
            .map(|(pane_id, ep)| PaneEndpointEntry {
                pane_id: pane_id.clone(),
                url: ep.url.clone(),
                port: ep.port,
                started_at: ep.started_at,
            })
            .collect(),
    };
    let path = state_manifest_path();
    let body = match serde_json::to_string_pretty(&manifest) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[mcp] manifest serialize failed: {}", e);
            return;
        }
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::write(&path, body) {
        log::warn!("[mcp] manifest write to {} failed: {}", path.display(), e);
    }
}
