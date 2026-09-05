//! External launch requests — `coffee-cli launch --tool <id> [--cwd <dir>]`.
//!
//! Lets launchers, context menus, and scripts open Coffee CLI directly
//! into a fresh agent tab at a chosen folder, instead of landing on the
//! launchpad and making the user pick the tool + folder by hand.
//!
//! Two delivery paths, one payload:
//!
//! - **Cold start** — `main.rs` parses argv and hands the request to
//!   `server::start_ui`, which stores it in `AppState::pending_launch`.
//!   The frontend drains it once via the `take_pending_launch` command
//!   on mount.
//! - **Warm start** — the app is already running; the second process's
//!   argv is forwarded by the single-instance plugin, whose callback
//!   re-parses it here and emits `launch-request` to the frontend (the
//!   first process keeps running, so nothing is restarted).
//!
//! Examples:
//!   macOS:   open -a "Coffee CLI" --args launch --tool kimicode --cwd /work/proj
//!   Windows: coffee-cli.exe launch --tool claude --cwd "C:\work\proj"
//!   Linux:   coffee-cli launch --tool codex --cwd ~/work/proj
//!
//! `--tool` must be a registered tool id (`claude`, `codex`, `kimicode`,
//! `hermes`, …). Unknown tools and non-existent `--cwd` values are
//! rejected here so a bad invocation degrades to the plain launchpad
//! instead of erroring out in front of the user.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Parse a `launch` subcommand from a raw argv (with or without argv[0]).
/// Returns `None` when argv is not a launch request, the tool id is not
/// registered, or `--cwd` points at a directory that doesn't exist.
pub fn parse_launch_args(args: &[String]) -> Option<LaunchRequest> {
    // `launch` must be the first real argument. argv[0] presence varies
    // (bare exe name, full path, or single-instance forwarded argv), so
    // accept it at index 0 or 1 instead of guessing argv[0]'s shape.
    let start = match args.first().map(|s| s.as_str()) {
        Some("launch") => 1,
        _ if args.get(1).map(|s| s.as_str()) == Some("launch") => 2,
        _ => return None,
    };
    let rest = &args[start..];

    let mut tool: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut i = 0;
    while i < rest.len() {
        let arg = rest[i].as_str();
        // Support both `--flag value` and `--flag=value`.
        let (flag, inline_val) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg, None),
        };
        let next_val = |i: &mut usize| -> Option<String> {
            if let Some(v) = inline_val.clone() {
                return Some(v);
            }
            *i += 1;
            rest.get(*i).cloned()
        };
        match flag {
            "--tool" => tool = next_val(&mut i),
            "--cwd" => cwd = next_val(&mut i),
            _ => {}
        }
        i += 1;
    }

    let tool = tool?;
    // Unknown tool ids degrade to the plain launchpad.
    crate::tools::find(&tool)?;

    if let Some(dir) = &cwd {
        if !std::path::Path::new(dir).is_dir() {
            return None;
        }
    }
    Some(LaunchRequest { tool, cwd })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn first_tool_id() -> &'static str {
        crate::tools::TOOLS[0].id
    }

    #[test]
    fn ignores_non_launch_argv() {
        assert!(parse_launch_args(&argv(&["coffee-cli"])).is_none());
        assert!(parse_launch_args(&argv(&["coffee-cli", "--help"])).is_none());
        assert!(parse_launch_args(&argv(&["launch"])).is_none()); // missing --tool
    }

    #[test]
    fn parses_tool_with_and_without_argv0() {
        let id = first_tool_id();
        let with0 = parse_launch_args(&argv(&["/usr/bin/coffee-cli", "launch", "--tool", id]));
        let without0 = parse_launch_args(&argv(&["launch", "--tool", id]));
        assert_eq!(with0.as_ref().map(|r| r.tool.as_str()), Some(id));
        assert_eq!(without0.as_ref().map(|r| r.tool.as_str()), Some(id));
        assert!(with0.unwrap().cwd.is_none());
    }

    #[test]
    fn parses_equals_form_and_validates_cwd() {
        let id = first_tool_id();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let ok = parse_launch_args(&argv(&[
            "coffee-cli",
            "launch",
            &format!("--tool={}", id),
            &format!("--cwd={cwd}"),
        ]));
        assert_eq!(ok.as_ref().and_then(|r| r.cwd.as_deref()), Some(cwd.as_str()));

        let bad = parse_launch_args(&argv(&[
            "coffee-cli",
            "launch",
            "--tool",
            id,
            "--cwd",
            "/definitely/not/a/real/dir-9f2b7",
        ]));
        assert!(bad.is_none());
    }

    #[test]
    fn rejects_unknown_tool() {
        assert!(parse_launch_args(&argv(&[
            "coffee-cli",
            "launch",
            "--tool",
            "not-a-real-tool"
        ]))
        .is_none());
    }
}
