//! Commands the desktop UI may run when it is loaded on a phone (`?remote`).
//!
//! The phone runs the same front-end; every Tauri `invoke` it makes arrives
//! here. Only what a conversation needs is allowed, and nothing may start,
//! restart or close a desktop session: `*_session_start` attaches to the
//! running one, `*_session_close` is ignored. Anything else is refused.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub type Refusal = (&'static str, String);

/// Desktop events the remote UI listens to, forwarded as they are emitted.
pub const FORWARDED_EVENTS: [&str; 3] = ["claude-session-event", "tier-terminal-status", "agent-work-modes"];

fn arg(args: &Value, key: &str) -> Result<String, Refusal> {
    args[key].as_str().map(str::to_owned).ok_or(("invalid_params", format!("{key} required")))
}

fn failed(error: String) -> Refusal { ("internal", error) }

pub fn allowed(cmd: &str) -> bool {
    matches!(cmd, "claude_session_start" | "claude_session_close" | "claude_session_send" | "claude_session_control"
        | "claude_session_respond" | "claude_session_history" | "claude_session_preview" | "computer_name" | "get_tool_control" | "list_tools")
}

pub async fn invoke(app: &AppHandle, cmd: &str, args: &Value) -> Result<Value, Refusal> {
    use crate::claude_session as claude;
    if !allowed(cmd) { return Err(("unsupported", format!("{cmd} is not available on a phone"))); }
    let sessions = || app.state::<claude::ClaudeSessions>();
    match cmd {
        "claude_session_start" => claude::attach(app, &arg(args, "id")?).map_err(|e| ("not_found", e)),
        // The tab and its process belong to the desktop.
        "claude_session_close" => Ok(Value::Null),
        "claude_session_send" => claude::claude_session_send(app.clone(), sessions(), arg(args, "id")?, arg(args, "generation")?, arg(args, "text")?, None)
            .await.map(|_| Value::Null).map_err(failed),
        "claude_session_control" => claude::claude_session_control(sessions(), arg(args, "id")?, arg(args, "generation")?, args["request"].clone()).await.map_err(failed),
        "claude_session_respond" => claude::claude_session_respond(sessions(), arg(args, "id")?, arg(args, "generation")?, arg(args, "requestId")?, args["response"].clone())
            .await.map(|_| Value::Null).map_err(failed),
        "claude_session_history" => claude::claude_session_history(sessions(), arg(args, "id")?, arg(args, "generation")?, args["before"].as_u64().unwrap_or(0)).await.map_err(failed),
        "claude_session_preview" => claude::claude_session_preview(args["cwd"].as_str().map(str::to_owned), arg(args, "resumeToken")?).await.map_err(failed),
        "computer_name" => Ok(json!(crate::server::computer_name_value())),
        "list_tools" => Ok(serde_json::to_value(crate::tools::list_tools()).unwrap_or(Value::Null)),
        "get_tool_control" => crate::tool_control::get_tool_control(arg(args, "kind")?).await.map(|status| serde_json::to_value(status).unwrap_or(Value::Null)).map_err(failed),
        _ => unreachable!("checked by allowed()"),
    }
}
