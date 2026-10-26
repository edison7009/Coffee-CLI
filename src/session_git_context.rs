use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq)]
pub struct SessionGitContext {
    pub branch: Option<String>,
    #[serde(default)]
    pub pull_requests: Vec<String>,
}

#[derive(Default)]
pub struct SessionGitObserver {
    context: SessionGitContext,
    pending: HashSet<String>,
    pending_attachments: HashSet<String>,
}

pub fn pull_request_identity(url: &str) -> Option<(String, String, u64)> {
    let url = reqwest::Url::parse(url).ok()?;
    if url.scheme() != "https" || url.host_str()? != "github.com" || url.port().is_some()
        || !url.username().is_empty() || url.password().is_some() { return None; }
    let parts: Vec<_> = url.path_segments()?.collect();
    if parts.len() != 4 || parts[2] != "pull" { return None; }
    if !parts[..2].iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))) { return None; }
    let number = parts[3].parse::<u64>().ok().filter(|number| *number > 0)?;
    Some((parts[0].into(), parts[1].into(), number))
}

fn pr_urls(text: &str) -> impl Iterator<Item = String> + '_ {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*\b").unwrap())
        .find_iter(text).map(|found| found.as_str().to_string())
}

fn creates_or_updates_pr(command: &str) -> bool {
    command.split(['\n', ';', '&', '|']).any(|part| {
        let mut words = part.split_whitespace();
        words.next() == Some("gh") && words.next() == Some("pr")
            && matches!(words.next(), Some("create" | "merge" | "close" | "reopen" | "ready" | "edit" | "comment" | "checkout"))
    })
}

impl SessionGitObserver {
    fn bind(&mut self, url: String) {
        self.context.pull_requests.retain(|existing| existing != &url);
        self.context.pull_requests.push(url);
        if self.context.pull_requests.len() > 16 { self.context.pull_requests.remove(0); }
    }

    fn prompt(&mut self, text: &str) {
        if crate::server::is_system_injected(text) { return; }
        for url in pr_urls(crate::server::strip_codex_desktop_file_preamble(text)) { self.bind(url); }
    }

    fn attachment(&mut self, value: &Value, depth: u8) {
        if depth == 0 || value["isError"] == true { return; }
        if value["artifact_type"] == "pull_request" {
            if let Some(url) = value["url"].as_str().filter(|url| pull_request_identity(url).is_some()) { self.bind(url.into()); }
        }
        match value {
            Value::Array(items) => { for item in items { self.attachment(item, depth - 1); } }
            Value::Object(object) => {
                for key in ["structuredContent", "content", "text", "output", "value", "result"] {
                    if let Some(child) = object.get(key) { self.attachment(child, depth - 1); }
                }
            }
            Value::String(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(text) { self.attachment(&value, depth - 1); }
            }
            _ => {}
        }
    }

    pub fn observe(&mut self, row: &Value) {
        if row["isSidechain"] == true { return; }
        if let Some(branch) = row["gitBranch"].as_str().filter(|branch| !branch.trim().is_empty()) {
            self.context.branch = Some(branch.into());
        }
        if row["type"] == "pr-link" {
            if let Some(url) = row["prUrl"].as_str().filter(|url| pull_request_identity(url).is_some()) {
                self.bind(url.into());
            }
        }
        let payload = &row["payload"];
        let message = if row["type"] == "user_message" || row["type"] == "response_item" && payload["type"] == "message" { payload } else { &row["message"] };
        if message["role"] == "user" {
            if let Some(blocks) = message["content"].as_array() {
                for block in blocks {
                    if matches!(block["type"].as_str(), Some("text" | "input_text")) {
                        self.prompt(block["text"].as_str().unwrap_or(""));
                    }
                }
            } else if let Some(text) = message["content"].as_str() {
                self.prompt(text);
            }
        }
        if let Some(blocks) = message["content"].as_array() {
            for block in blocks {
                if message["role"] == "assistant" && block["type"] == "text" {
                    for tagged in block["text"].as_str().unwrap_or("").split("<pr-created>").skip(1) {
                        if let Some((url, _)) = tagged.split_once("</pr-created>") {
                            if let Some(url) = pr_urls(url).next() { self.bind(url); }
                        }
                    }
                }
                if block["type"] == "tool_use" && block["name"] == "Bash"
                    && block["input"]["command"].as_str().is_some_and(creates_or_updates_pr) {
                    if let Some(id) = block["id"].as_str() { self.pending.insert(id.into()); }
                }
                if block["type"] == "tool_result" {
                    if let Some(id) = block["tool_use_id"].as_str() {
                        if self.pending.remove(id) && block["is_error"] != true {
                            let text = block["content"].as_str().map(str::to_string).unwrap_or_else(|| block["content"].to_string());
                            if let Some(url) = pr_urls(&text).last() { self.bind(url); }
                        }
                    }
                }
            }
        }
        if row["type"] == "session_meta" {
            if let Some(branch) = payload["git"]["branch"].as_str().filter(|branch| !branch.trim().is_empty()) {
                self.context.branch = Some(branch.into());
            }
        }
        if row["type"] == "response_item" {
            if matches!(payload["type"].as_str(), Some("function_call" | "custom_tool_call")) {
                let raw = payload["arguments"].as_str().or_else(|| payload["input"].as_str()).unwrap_or("");
                if payload["name"].as_str().is_some_and(|name| name.ends_with("attach_artifact"))
                    || raw.contains("mcp__codex_app__attach_artifact") || raw.contains("mcp__codex_app.attach_artifact") {
                    if let Some(id) = payload["call_id"].as_str() { self.pending_attachments.insert(id.into()); }
                }
                let arguments = payload["arguments"].as_str().and_then(|value| serde_json::from_str::<Value>(value).ok());
                if let Some(command) = arguments.as_ref().and_then(|args| args["cmd"].as_str().or_else(|| args["command"].as_str())) {
                    if creates_or_updates_pr(command) {
                        if let Some(id) = payload["call_id"].as_str() { self.pending.insert(id.into()); }
                    }
                }
            } else if matches!(payload["type"].as_str(), Some("function_call_output" | "custom_tool_call_output")) {
                if let Some(id) = payload["call_id"].as_str() {
                    if self.pending_attachments.remove(id) { self.attachment(&payload["output"], 12); }
                    if self.pending.remove(id) {
                        let output = payload["output"].as_str().unwrap_or("");
                        let structured = serde_json::from_str::<Value>(output).ok();
                        let success = structured.as_ref().is_some_and(|value| value["exit_code"] == 0 || value["metadata"]["exit_code"] == 0)
                            || output.contains("Process exited with code 0") || output.contains("Exit code: 0");
                        if success {
                            let text = structured.as_ref().and_then(|value| value["output"].as_str()).unwrap_or(output);
                            if let Some(url) = pr_urls(text).last() { self.bind(url); }
                        }
                    }
                }
            }
        }
    }

    pub fn finish(self) -> Option<SessionGitContext> {
        (self.context.branch.is_some() || !self.context.pull_requests.is_empty()).then_some(self.context)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_links_survive_switching_back_to_main_and_ignore_sidechains() {
        let mut observer = SessionGitObserver::default();
        observer.observe(&json!({"gitBranch":"feature/one"}));
        observer.observe(&json!({"type":"pr-link","prUrl":"https://github.com/owner/repo/pull/42"}));
        observer.observe(&json!({"gitBranch":"main"}));
        observer.observe(&json!({"isSidechain":true,"gitBranch":"unrelated"}));
        let context = observer.finish().unwrap();
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert_eq!(context.pull_requests.last().map(String::as_str), Some("https://github.com/owner/repo/pull/42"));
    }

    #[test]
    fn command_output_binds_only_a_successful_pr_operation() {
        let mut observer = SessionGitObserver::default();
        observer.observe(&json!({"type":"session_meta","payload":{"git":{"branch":"feature/one"}}}));
        let call = |id, command| json!({"type":"response_item","payload":{"type":"function_call","call_id":id,"arguments":json!({"cmd":command}).to_string()}});
        let output = |id, code| json!({"type":"response_item","payload":{"type":"function_call_output","call_id":id,"output":json!({"exit_code":code,"output":"https://github.com/owner/repo/pull/42"}).to_string()}});
        observer.observe(&call("read", "echo https://github.com/owner/repo/pull/42"));
        observer.observe(&output("read", 0));
        observer.observe(&call("failed", "gh pr create --fill"));
        observer.observe(&output("failed", 1));
        assert!(observer.context.pull_requests.is_empty());
        observer.observe(&call("created", "cd repo && gh pr create --fill"));
        observer.observe(&output("created", 0));
        assert_eq!(observer.finish().unwrap().pull_requests.last().map(String::as_str), Some("https://github.com/owner/repo/pull/42"));
    }

    #[test]
    fn assistant_reference_links_are_not_pr_attachments() {
        let mut observer = SessionGitObserver::default();
        observer.observe(&json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"Compare https://github.com/owner/repo/pull/42"}]}}));
        assert!(observer.finish().is_none());
        for url in ["https://github.com.evil.test/owner/repo/pull/42", "https://github.com/owner/repo/issues/42", "http://github.com/owner/repo/pull/42", "https://github.com/owner/repo/pull/0"] {
            assert!(pull_request_identity(url).is_none());
        }
    }

    #[test]
    fn user_pr_links_are_kept_per_session_and_native_bash_results_are_correlated() {
        let mut observer = SessionGitObserver::default();
        observer.observe(&json!({"message":{"role":"user","content":[{"type":"text","text":"Review [this PR](https://github.com/owner/repo/pull/42)"}]}}));
        observer.observe(&json!({"message":{"role":"assistant","content":[{"type":"tool_use","id":"create","name":"Bash","input":{"command":"gh pr create --fill"}}]}}));
        observer.observe(&json!({"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"other","content":"https://github.com/owner/repo/pull/100"}]}}));
        observer.observe(&json!({"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"create","content":"https://github.com/owner/repo/pull/43"}]}}));
        assert_eq!(observer.finish().unwrap().pull_requests, ["https://github.com/owner/repo/pull/42", "https://github.com/owner/repo/pull/43"]);
        assert!(SessionGitObserver::default().finish().is_none());
    }

    #[test]
    fn explicit_artifacts_and_creation_tags_bind_but_injected_context_does_not() {
        let mut observer = SessionGitObserver::default();
        observer.observe(&json!({"message":{"role":"user","content":"<system-reminder> reference https://github.com/owner/repo/pull/99"}}));
        assert!(observer.context.pull_requests.is_empty());
        observer.observe(&json!({"type":"response_item","payload":{"type":"function_call","name":"mcp__codex_app__attach_artifact","call_id":"attach"}}));
        observer.observe(&json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"attach","output":json!({"content":[{"type":"text","text":json!({"artifact_type":"pull_request","url":"https://github.com/owner/repo/pull/42"}).to_string()}],"isError":false}).to_string()}}));
        observer.observe(&json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"functions.exec","call_id":"wrapped","input":"await tools.mcp__codex_app__attach_artifact(...)"}}));
        observer.observe(&json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"wrapped","output":[{"type":"input_text","text":json!({"status":"fulfilled","value":{"content":[{"type":"text","text":json!({"artifact_type":"pull_request","url":"https://github.com/owner/repo/pull/42"}).to_string()}],"isError":false}}).to_string()}]}}));
        observer.observe(&json!({"message":{"role":"assistant","content":[{"type":"text","text":"<pr-created>https://github.com/owner/repo/pull/43</pr-created>"}]}}));
        assert_eq!(observer.finish().unwrap().pull_requests, ["https://github.com/owner/repo/pull/42", "https://github.com/owner/repo/pull/43"]);
    }
}
