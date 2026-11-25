//! Starting each tool in a terminal tab: its command and arguments, resume, launch permissions, the
//! environment it needs, its native session id, and the per-tool launch settings. Moved out of server.rs;
//! the terminal engine (src/terminal.rs) knows nothing about tools.
#![allow(clippy::too_many_arguments)]
use crate::server::*;
use crate::terminal;
use crate::agent_presets as presets;
use crate::history::*;
use tauri::{Emitter, State};

#[tauri::command]
pub(crate) async fn maintain_tool_integration(tool: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::hook_installer::maintain_for_tool(&tool)).await.map_err(|e| e.to_string())
}

/// Drain the external launch request that arrived before the frontend was
/// listening, if any. Exactly-once semantics — the first caller gets the
/// request, every later caller gets `None`, and every later request arrives
/// as a `launch-request` event instead. Call it after subscribing.

#[tauri::command]
pub(crate) async fn check_tools_installed() -> Result<std::collections::HashMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut result = std::collections::HashMap::new();
        for tool in crate::tools::TOOLS {
            result.insert(tool.id.to_string(), binary_on_path(tool.binary_name));
        }
        // DeepSeek Harness is "installed" exactly when its tab can start: `where dsh` also
        // matches scripts it cannot run, and misses the Desktop runtime, which stays off PATH.
        result.insert("dsh".to_string(), crate::dsh_session::executable().is_some());
        // An ACP tool counts as installed where its desktop tab can start (its custom command, or ~/.local/bin).
        for tool in crate::tools::TOOLS { if crate::acp_session::executable(tool.id).is_some() { result.insert(tool.id.to_string(), true); } }
        // `terminal` (system shell) and `remote` (SSH) have no binary to
        // probe — always available, not registered.
        result.insert("terminal".to_string(), true);
        result
    }).await.map_err(|e| e.to_string())
}

/// Launch flags for the permission a start-page card chose, from the tab's tool data `{"permission": …}`. Only the
/// values the card offers are accepted; anything else starts the tool with its own default.
/// The binary a terminal tab runs. An ACP tool counts as installed where its desktop tab finds it, which includes
/// ~/.local/bin off PATH (src/acp_session.rs): its terminal tab runs that same file rather than fail to find it.
fn terminal_binary(tool: &str, cmd: String) -> String {
    let registered = crate::tools::find(tool).is_some_and(|descriptor| descriptor.binary_name == cmd);
    if !registered || binary_on_path(&cmd) { return cmd; }
    crate::acp_session::executable(tool).map(|(path, _)| path).unwrap_or(cmd)
}

/// A history tab's resume command line. A tab started with the card's permission keeps it when it comes back
/// with its session.
fn resume_args(preset: &presets::AgentPreset, tool: &str, token: &str, tool_data: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = preset.resume_args_before.iter().map(|s| s.to_string()).collect();
    args.push(token.to_string());
    args.extend(preset.resume_args_after.iter().map(|s| s.to_string()));
    args.extend(launch_permission_args(tool, tool_data));
    args
}

fn launch_permission_args(tool: &str, tool_data: Option<&str>) -> Vec<String> {
    let permission = tool_data.and_then(|data| serde_json::from_str::<serde_json::Value>(data).ok())
        .and_then(|data| data.get("permission").and_then(|p| p.as_str()).map(str::to_owned));
    let Some(permission) = permission else { return vec![] };
    let flags: &[&str] = match (tool, permission.as_str()) {
        ("claude", mode @ ("default" | "plan" | "acceptEdits" | "bypassPermissions")) => return vec!["--permission-mode".into(), mode.into()],
        ("codex", "readOnly") => &["--sandbox", "read-only", "--ask-for-approval", "on-request"],
        ("codex", "workspaceWrite") => &["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
        ("codex", "dangerFullAccess") => &["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
        _ => &[],
    };
    flags.iter().map(|flag| flag.to_string()).collect()
}


// ─── Tier Terminal API ────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn tier_terminal_start(
    session_id: String,
    tool: Option<String>,
    tool_data: Option<String>,
    cols: u16,
    rows: u16,
    theme_mode: Option<String>,
    locale: Option<String>,
    cwd: Option<String>,
    resume_token: Option<String>,
    shell: Option<String>,
    strict_cwd: Option<bool>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Offload the whole spawn sequence to a blocking thread so the Tauri
    // command dispatcher returns immediately. Without this, Windows was
    // paying ~cmd.exe boot + Defender AV scan + Node startup on the command
    // thread, stalling every other IPC call (resize, theme, terminal I/O)
    // until the spawn returned. Running in the terminal directly avoids
    // this because no IPC layer is involved — the shell forks directly.
    let terminal_session = state.terminal_session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tier_terminal_start_blocking(
            session_id, tool, tool_data, cols, rows,
            theme_mode, locale, cwd, resume_token, shell, strict_cwd.unwrap_or(false), app, terminal_session,
        )
    })
    .await
    .map_err(|e| format!("Spawn task join failed: {e}"))?
}

fn tier_terminal_start_blocking(
    session_id: String,
    tool: Option<String>,
    tool_data: Option<String>,
    cols: u16,
    rows: u16,
    theme_mode: Option<String>,
    locale: Option<String>,
    cwd: Option<String>,
    resume_token: Option<String>,
    shell: Option<String>,
    strict_cwd: bool,
    app: tauri::AppHandle,
    terminal_session: terminal::SharedSession,
) -> Result<(), String> {
    // CWD resolution order (first non-empty wins):
    //   1. cwd passed from the frontend (launchpad's folder picker / per-tab cwd)
    //   2. tool_config.default_cwd from ~/.coffee-cli/tools.json (WSL-type users
    //      who want a fixed launch dir regardless of launchpad selection)
    //   3. empty → spawn process inherits Coffee CLI's own cwd
    //
    // The launchpad picker dominates because it's the per-launch user choice;
    // tool_config.default_cwd is the always-on fallback for users who don't
    // want to pick each time (or whose launchpad-side path can't address the
    // tool's actual workspace, e.g. WSL).
    let frontend_cwd = cwd.clone().unwrap_or_default();
    let dir = if !frontend_cwd.is_empty() {
        std::path::PathBuf::from(frontend_cwd)
    } else if let Some(name) = tool.as_deref() {
        let cfg_cwd = crate::tool_config::get(name).default_cwd;
        if cfg_cwd.is_empty() {
            std::path::PathBuf::default()
        } else {
            std::path::PathBuf::from(cfg_cwd)
        }
    } else {
        std::path::PathBuf::default()
    };

    // Resolve the binary + default args from the tool registry. `remote`
    // and the fallback shell are not in the registry — `remote` parses
    // tool_data at runtime, the shell is platform-derived.
    let registry_descriptor = tool.as_deref().and_then(crate::tools::find);
    let (cmd, args): (String, Vec<String>) = match (tool.as_deref(), registry_descriptor) {
        (Some(id), Some(descriptor)) => {
            let mut a: Vec<String> = descriptor
                .default_args
                .iter()
                .map(|s| s.to_string())
                .collect();
            // The start page's card can pick the permission a fresh tab starts with (src-ui/src/lib/launch-permission.ts).
            a.extend(launch_permission_args(id, tool_data.as_deref()));
            (descriptor.binary_name.to_string(), a)
        }
        (Some("remote"), _) => {
            // Parse connection info from toolData JSON
            let data = tool_data.as_deref().unwrap_or("{}");
            let conn: serde_json::Value = serde_json::from_str(data)
                .map_err(|e| format!("Invalid remote connection data: {}", e))?;

            let protocol = conn["protocol"].as_str().unwrap_or("ssh");
            let host = conn["host"].as_str().unwrap_or("localhost");
            let port = conn["port"].as_u64().unwrap_or(if protocol == "ssh" { 22 } else { 7681 });
            let username = conn["username"].as_str().unwrap_or("root");
            let _password = conn["password"].as_str().unwrap_or("");

            if protocol == "ssh" {
                // Build SSH command — user will type password interactively in PTY
                let mut ssh_args = vec![
                    "-o".to_string(),
                    "StrictHostKeyChecking=no".to_string(),
                    "-p".to_string(),
                    port.to_string(),
                    format!("{}@{}", username, host),
                ];

                // If password is provided, try to use sshpass for auto-login
                // Otherwise user types password in terminal
                if !_password.is_empty() {
                    // Check if sshpass is available
                    let has_sshpass = if cfg!(target_os = "windows") {
                        false // sshpass not typically available on Windows
                    } else {
                        std::process::Command::new("which")
                            .arg("sshpass")
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()
                            .map(|s| s.success())
                            .unwrap_or(false)
                    };

                    if has_sshpass {
                        let mut full_args = vec![
                            "-p".to_string(),
                            _password.to_string(),
                            "ssh".to_string(),
                        ];
                        full_args.append(&mut ssh_args);
                        ("sshpass".to_string(), full_args)
                    } else {
                        ("ssh".to_string(), ssh_args)
                    }
                } else {
                    ("ssh".to_string(), ssh_args)
                }
            } else {
                // WebSocket protocol — not handled by PTY backend
                // Frontend will handle this via xterm.js AttachAddon directly
                return Err("ws".to_string());
            }
        },

        _ => if cfg!(target_os = "windows") {
            // User's chosen default shell (settings → Terminal), resolved to a
            // concrete (program, args). `Auto` keeps the historical pwsh→
            // powershell fallback. Resolving to an ABSOLUTE path here also
            // defeats the Microsoft-Store App Execution Alias trap: a 0-byte
            // `pwsh.exe` reparse point probes as "installed" via `where` but
            // fails to spawn with ERROR_ACCESS_DENIED. shell_probe treats
            // aliases as not-installed, so the picker never offers a dead
            // shell. Power users can still override via `terminal` in
            // ~/.coffee-cli/tools.json (applied just below, as final word).
            let id = crate::shell_probe::ShellId::from_opt(&shell);
            let caps = crate::shell_probe::detect_capabilities();
            crate::shell_probe::resolve_shell(id, &caps)
        } else {
            // Unix: `Auto` reads $SHELL (with an existence guard) and falls
            // back to bash; an explicit choice spawns that shell directly.
            // fish gets its OSC 7 cwd-reporting hook via -C (bash gets it via
            // PROMPT_COMMAND in terminal.rs; zsh has no clean flag hook).
            let id = crate::shell_probe::ShellId::from_opt(&shell);
            let caps = crate::shell_probe::ShellCapabilities::default();
            crate::shell_probe::resolve_shell(id, &caps)
        }
    };

    // ── Resume override ─────────────────────────────────────────────────────
    // When resume_token is present, this tab was opened from a history
    // "Continue this session" action. Override the fresh-launch cmd/args
    // built above with the tool's resume flags (e.g. `claude --resume <uuid>`,
    // `codex resume <id>`). The match above still ran (harmless — tool is
    // always set in the resume path, so it hit the registry branch and
    // produced a throwaway `(binary_name, [])`); we discard that and rebuild
    // from the agent preset. Validation mirrors the deleted tier_terminal_resume:
    // cwd existence (don't silently resume into the wrong project) + token-
    // format anti-injection.
    let (cmd, args): (String, Vec<String>) = if let Some(token) = resume_token.as_deref().filter(|t| !t.is_empty()) {
        let tool_name = tool.as_deref()
            .ok_or_else(|| "Resume requires a tool, but none was set".to_string())?;
        let preset = presets::find_preset(tool_name)
            .ok_or_else(|| format!("Unknown tool for resume: {}", tool_name))?;
        let resume_program = preset.resume_program
            .ok_or_else(|| format!("Tool '{}' does not support resume", tool_name))?;

        let resume_dir = cwd.as_deref().unwrap_or("").trim();
        if !std::path::Path::new(resume_dir).is_dir() {
            return Err(if resume_dir.is_empty() {
                "Could not determine this session's project folder — refusing to resume into the wrong directory".to_string()
            } else {
                format!("This session's project folder no longer exists ({resume_dir}) — refusing to resume into the wrong directory")
            });
        }
        if let Some(fmt) = preset.token_format {
            let re = regex::Regex::new(fmt)
                .map_err(|e| format!("Invalid token format pattern: {e}"))?;
            if !re.is_match(token) {
                return Err(format!("Invalid session token format for tool '{}'", tool_name));
            }
        }

        // Token is a separate vec element — never string-interpolated into a
        // command line that gets whitespace-split.
        (resume_program.to_string(), resume_args(preset, tool_name, token, tool_data.as_deref()))
    } else {
        (cmd, args)
    };

    // ── User-configurable launch overrides ─────────────────────────────────
    // ~/.coffee-cli/tools.json lets users say e.g. "always launch claude with
    // --dangerously-skip-permissions" or "run codex through `docker exec mybox`".
    // `remote` is excluded by design: its argv is protocol-derived from
    // runtime tool_data, not configurable.
    let launch_config = match tool.as_deref() {
        Some(name) if name == "terminal" || crate::tools::find(name).is_some() => crate::tool_config::get(name),
        _ => Default::default(),
    };
    let (cmd, args) = match tool.as_deref() {
        Some(name) if name == "terminal" || crate::tools::find(name).is_some() => {
            let entry = &launch_config;
            let (cmd, mut args) = (cmd, args);
            let (cmd, args) = if let (Some(bin), prefix_args) =
                crate::tool_config::parse_command(&entry.command)
            {
                // User overrode the binary. Prepend any prefix args
                // (e.g. for `wsl claude`, prefix_args = ["claude"]) so
                // the original built-in args (--mcp-config / --append-
                // system-prompt / etc) follow them.
                let mut new_args = prefix_args;
                new_args.append(&mut args);
                (crate::tool_config::command_binary(name, &bin).to_owned(), new_args)
            } else {
                (terminal_binary(name, cmd), args)
            };
            // Append user's extra_args after the built-in flags so
            // they take precedence (e.g. user can override --approval-
            // mode by adding their own at the end).
            let mut args = args;
            args.extend(entry.extra_args.iter().cloned());
            (cmd, args)
        }
        // Synthetic / pane-internal tools (remote / multi-agent)
        // intentionally bypass user override.
        _ => (cmd, args),
    };

    let mut args = args;
    let native_token = if tool.as_deref() == Some("claude") {
        presets::claude_launch_token(&mut args, launch_config.command.trim().is_empty())
    } else {
        None
    };
    // Pi writes the session only after the first message (and Pi before 0.76
    // ignores `--session-id`), so its id is reported once the file exists.
    let pi_token = if tool.as_deref() == Some("pi") {
        presets::pi_launch_token(&mut args, launch_config.command.trim().is_empty())
    } else {
        None
    };

    // If a session with the same ID already exists (e.g. restart-in-place),
    // forcefully kill and remove it before spawning a fresh one.
    {
        let mut lock = terminal_session.lock().unwrap();
        if let Some(old_session) = lock.remove(&session_id) {
            eprintln!("[Tier Terminal] Killing existing session {} for restart", session_id);
            let _ = old_session.kill_tx.send(());
            // Brief pause to let the OS reclaim PTY resources
            drop(lock);
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    // Determine the CWD to pass to the Agent:
    // 1. If workspace has an explicit dir (from open-folder or resume) → use it
    // 2. Otherwise default to user's home dir (matches most agents' default)
    if strict_cwd && (dir.as_os_str().is_empty() || !dir.is_dir()) {
        return Err("Agent working directory no longer exists; terminal was not started".into());
    }
    let spawn_cwd = if dir.as_os_str().is_empty() || !dir.is_dir() {
        dirs::home_dir().map(|p| p.to_string_lossy().to_string())
    } else {
        Some(dir.to_string_lossy().to_string())
    };
    let spawn_cwd = spawn_cwd.map(|cwd| {
        terminal::shell_working_directory(std::path::Path::new(&cwd))
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|e| e.to_string())
    }).transpose()?;

    let tool_name = tool.clone();
    let actual_cwd = spawn_cwd.clone().unwrap_or_default();

    eprintln!("[Tier Terminal] Starting tool={:?}, cmd={}, args={:?}, cwd={:?}", tool, cmd, args, spawn_cwd);

    // Per-pane env overrides (reserved). Independent-split and
    // single-terminal panes spawn with no extra env today.
    let mut extra_env: Vec<(String, String)> = Vec::new();

    if tool.as_deref() == Some("claude") {
        let parent = match &native_token {
            Some(native_id) => crate::orchestration::parent_launch(&app, &session_id, native_id, std::path::Path::new(&actual_cwd), false)?,
            None => None,
        };
        if let Some(mcp) = crate::window_control::add_to(&app, &session_id, parent.as_ref().map(|parent| parent.mcp.clone())) {
            args.extend(["--mcp-config".into(), mcp]);
        }
        if let Some(parent) = parent {
            args.extend(["--append-system-prompt".into(), parent.prompt]);
            args.extend(parent.args);
        }
    }
    // The window tools for the other tools that take them (src/window_control.rs).
    if tool.as_deref() == Some("codex") { args.extend(crate::window_control::codex_args(&app, &session_id)); }
    if tool.as_deref() == Some("opencode") { extra_env.extend(crate::window_control::opencode_env(&app, &session_id)); }

    let launched_at = std::time::SystemTime::now();
    // AI CLIs get their environment first; the launch's own variables win, then OpenCode's status layer.
    let mut spawn_env = presets::ai_cli_env(tool_name.as_deref(), &cmd);
    let island = presets::opencode_island_env(tool_name.as_deref(), &cmd, &extra_env);
    spawn_env.extend(extra_env);
    spawn_env.extend(island);
    terminal::spawn(
        app.clone(),
        session_id.clone(),
        terminal_session.clone(),
        cmd,
        args,
        spawn_cwd,
        locale.clone().unwrap_or_else(|| "en".to_string()),
        cols,
        rows,
        tool_name.clone(),
        tool_name.as_deref().and_then(presets::find_preset).and_then(|preset| preset.session_id_pattern),
        theme_mode,
        locale,
        spawn_env,
    ).map_err(|e| format!("Failed to spawn PTY: {}", e))?;

    if let Some(token) = native_token {
        if let Some(session) = terminal_session.lock().unwrap().get(&session_id) {
            *session.session_token.lock().unwrap() = Some(token.clone());
        }
        let _ = app.emit("tier-terminal-token", terminal::SessionTokenPayload { id: session_id.clone(), token });
    }

    if let Some(token) = pi_token {
        let root = crate::tools::find("pi").and_then(|t| Some(history_root(t, t.history_shape.as_ref()?, &dirs::home_dir()?)));
        if let Some(root) = root {
            let suffix = format!("_{token}.jsonl");
            watch_session_token(app.clone(), terminal_session.clone(), session_id.clone(), false, move || {
                pi_session_written(&root, &suffix).then(|| token.clone())
            });
        }
    }
    #[cfg(unix)]
    if tool.as_deref() == Some("omp") {
        let tty = terminal_session.lock().ok()
            .and_then(|map| map.get(&session_id).map(|s| s._master.clone()))
            .and_then(|master| master.lock().ok().and_then(|m| m.as_ref().and_then(|m| m.tty_name())));
        if let Some(tty) = tty {
            watch_session_token(app.clone(), terminal_session.clone(), session_id.clone(), true, move || {
                presets::omp_terminal_token(&tty, launched_at)
            });
        }
    }

    // Emit the initial CWD to the frontend so the left panel can map immediately.
    // On Windows, cmd.exe does not emit OSC 7, and full-screen agents enter alt-screen
    // before any shell prompt appears. This one-time emit bridges the gap.
    if !actual_cwd.is_empty() {
        #[derive(serde::Serialize, Clone)]
        struct CwdPayload { id: String, cwd: String }
        let _ = app.emit("tier-terminal-cwd", CwdPayload {
            id: session_id,
            cwd: actual_cwd,
        });
    }

    Ok(())
}



// ─── Session Resume API ──────────────────────────────────────────────────────


/// Poll `probe` once a second for this PTY's native id and report it. With
/// `follow`, keep watching for the PTY's whole life (omp's in-app `/new`
/// switches sessions); otherwise stop at the first id.
fn watch_session_token(
    app: tauri::AppHandle,
    sessions: terminal::SharedSession,
    session_id: String,
    follow: bool,
    probe: impl Fn() -> Option<String> + Send + 'static,
) {
    let Some(master) = sessions.lock().ok().and_then(|map| map.get(&session_id).map(|s| s._master.clone())) else { return };
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let token = probe();
        let Ok(map) = sessions.lock() else { return };
        // Stop once this PTY is gone or the id was reused by a restart.
        let Some(session) = map.get(&session_id).filter(|s| std::sync::Arc::ptr_eq(&s._master, &master)) else { return };
        let Some(token) = token else { continue };
        let Ok(mut current) = session.session_token.lock() else { return };
        if current.as_deref() != Some(token.as_str()) {
            *current = Some(token.clone());
            drop(current);
            drop(map);
            let _ = app.emit("tier-terminal-token", terminal::SessionTokenPayload { id: session_id.clone(), token });
        }
        if !follow { return; }
    });
}

/// Pi keeps `<root>/--<encoded-cwd>--/<ts>_<id>.jsonl`; true once that file exists.
fn pi_session_written(root: &std::path::Path, suffix: &str) -> bool {
    std::fs::read_dir(root).into_iter().flatten().flatten().any(|bucket| {
        std::fs::read_dir(bucket.path()).into_iter().flatten().flatten()
            .any(|file| file.file_name().to_string_lossy().ends_with(suffix))
    })
}

#[tauri::command]
pub(crate) fn get_terminal_session_token(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let map = state.terminal_session.lock().map_err(|e| e.to_string())?;
    let Some(session) = map.get(&session_id) else {
        return Ok(None);
    };
    let token = session.session_token.lock()
        .map(|token| token.clone())
        .map_err(|e| e.to_string())?;
    Ok(token)
}


// ─── Hyper-Agent: global anonymous MCP server for external orchestrators ──
//
// Started lazily when the user opens the Hyper-Agent tab. `self_pane_id=None`,
// so list_panes / send_to_pane bypass tab-scope filtering — exactly the
// "super admin can see and dispatch to every pane" semantics the product
// needs. Uses a port persisted across launches so OpenClaw / Hermes Agent
// configs stay stable (no config-file thrash → no gateway restart loops).
//
// Tauri commands here are all the frontend needs to know about.

// ─── Per-tool launch overrides (~/.coffee-cli/tools.json) ────────────────
//
// Lets users tell Coffee CLI things like "my claude is at
// `/opt/coffee/bin/claude`, not on PATH" or "always launch claude with
// --dangerously-skip-permissions". Replaces what the abandoned in-app
// installer was supposed to handle by auto-detection — defer to the
// user, who knows their machine better than we do.

#[tauri::command]
pub fn get_tool_config(tool: String) -> crate::tool_config::ToolConfigEntry {
    crate::tool_config::get(&tool)
}

#[tauri::command]
pub fn get_all_tool_configs() -> crate::tool_config::ToolConfig {
    crate::tool_config::load()
}

#[tauri::command]
pub fn set_tool_config(
    tool: String,
    entry: crate::tool_config::ToolConfigEntry,
) -> Result<(), String> {
    crate::tool_config::set(&tool, entry).map_err(|e| e.to_string())
}

#[cfg(test)]
mod resume_cwd_tests {
    use super::{coffee_worktree_cwd, load_claude_project_map, project_root_from_cwd};
    use std::io::Write;

    // The exact path that was landing wrong in the wild: a Claude session run
    // inside a worktree recorded the worktree as its cwd, so resume cd'd into
    // the ephemeral worktree instead of the project root.
    #[test]
    fn strips_windows_worktree_cwd_to_project_root() {
        assert_eq!(
            project_root_from_cwd(r"D:\Coffee-CLI\.claude\worktrees\intelligent-heyrovsky-b3d421"),
            r"D:\Coffee-CLI"
        );
    }

    #[test]
    fn strips_unix_worktree_cwd_to_project_root() {
        assert_eq!(
            project_root_from_cwd("/home/eben/coffee-cli/.claude/worktrees/foo"),
            "/home/eben/coffee-cli"
        );
    }

    #[test]
    fn leaves_a_plain_project_dir_unchanged() {
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI"), r"D:\Coffee-CLI");
        assert_eq!(project_root_from_cwd("/home/eben/coffee-cli"), "/home/eben/coffee-cli");
    }

    #[test]
    fn leaves_a_real_subdir_unchanged() {
        // A genuine working subdir must NOT be collapsed — only worktrees.
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI\src\ui"), r"D:\Coffee-CLI\src\ui");
    }

    #[test]
    fn strips_only_dot_claude_worktrees_not_other_dot_dir_worktrees() {
        // `.claude/worktrees` is the harness's real worktree layout, so it
        // strips. `.git/worktrees` is git's INTERNAL metadata (never a working
        // cwd), so anchoring on `.claude` specifically leaves it — and any
        // other `.<dir>/worktrees` — untouched, avoiding a bogus over-collapse.
        assert_eq!(project_root_from_cwd(r"D:\proj\.git\worktrees\x"), r"D:\proj\.git\worktrees\x");
        assert_eq!(project_root_from_cwd("/home/e/proj/.jj/worktrees/y"), "/home/e/proj/.jj/worktrees/y");
    }

    #[test]
    fn does_not_touch_an_ordinary_hidden_dir_without_worktrees() {
        // The Linux/macOS safety case: editing dotfiles with an agent runs the
        // session INSIDE a hidden dir; that cwd must survive intact.
        assert_eq!(project_root_from_cwd("/home/eben/.config/nvim"), "/home/eben/.config/nvim");
        assert_eq!(project_root_from_cwd("/home/eben/.dotfiles"), "/home/eben/.dotfiles");
        assert_eq!(project_root_from_cwd(r"D:\proj\.vscode"), r"D:\proj\.vscode");
        // `.claude` itself, without a worktrees child, is a real (if unusual) dir.
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI\.claude"), r"D:\Coffee-CLI\.claude");
        assert_eq!(project_root_from_cwd(r"D:\Coffee-CLI\.claude\settings"), r"D:\Coffee-CLI\.claude\settings");
    }

    #[test]
    fn only_coffee_worktrees_resume_in_place() {
        assert!(coffee_worktree_cwd(r"D:\Proj\.claude\worktrees\coffee-fix-a1b2c3\src"));
        assert!(coffee_worktree_cwd("/home/e/proj/.claude/worktrees/coffee-x-1"));
        assert!(!coffee_worktree_cwd(r"D:\Proj\.claude\worktrees\intelligent-heyrovsky-b3d421"));
        assert!(!coffee_worktree_cwd(r"D:\Proj\coffee-x"));
    }

    #[test]
    fn requires_worktrees_to_be_a_whole_next_component() {
        // A plain, non-hidden `worktrees/` folder is a legitimate project subdir.
        assert_eq!(project_root_from_cwd(r"D:\proj\worktrees\x"), r"D:\proj\worktrees\x");
        // `worktrees` must be a WHOLE next component, not a prefix.
        assert_eq!(
            project_root_from_cwd(r"D:\proj\.claude\worktrees-archive\x"),
            r"D:\proj\.claude\worktrees-archive\x"
        );
    }

    #[test]
    fn handles_mixed_separators_and_non_ascii() {
        // Windows sometimes emits mixed separators; a Chinese project name must
        // not panic the byte-slice (all slice indices land on ASCII separators).
        assert_eq!(project_root_from_cwd(r"D:/Coffee-CLI\.claude/worktrees\x"), r"D:/Coffee-CLI");
        assert_eq!(project_root_from_cwd(r"D:\项目名\.claude\worktrees\x"), r"D:\项目名");
    }

    #[test]
    fn does_not_split_on_a_dot_inside_a_component() {
        // The dot must open a `.claude` component; a dot mid-name never matches.
        assert_eq!(project_root_from_cwd(r"D:\proj\my.claude\worktrees\x"), r"D:\proj\my.claude\worktrees\x");
        assert_eq!(project_root_from_cwd(r"D:\tools\v1.2\bin"), r"D:\tools\v1.2\bin");
    }

    // Isolated per-test home dir under the OS temp dir — avoids clobbering
    // the real ~/.claude.json and avoids tests racing each other on a
    // shared path (each test gets a name-derived subfolder).
    fn temp_home(test_name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("coffee-cli-test-{}", test_name));
        let _ = std::fs::remove_dir_all(&dir); // clean slate if a prior run left it behind
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_claude_json(home: &std::path::Path, project_paths: &[&str]) {
        let projects_obj = project_paths
            .iter()
            .map(|p| format!("{:?}: {{}}", p)) // {:?} on &str gives a valid escaped JSON string
            .collect::<Vec<_>>()
            .join(",");
        let json = format!(r#"{{"projects": {{{}}}}}"#, projects_obj);
        let mut f = std::fs::File::create(home.join(".claude.json")).unwrap();
        f.write_all(json.as_bytes()).unwrap();
    }

    // Real folder name observed on disk, verified by hand against the known
    // real path — the exact case that motivated the fix (a project name
    // containing a hyphen, "Coffee-CLI", made the old split("--") fallback
    // reconstruct a nonexistent path). load_claude_project_map forward-encodes
    // the real key so the mangled folder name maps back exactly.
    #[test]
    fn map_resolves_real_world_hyphenated_project_path() {
        let home = temp_home("hyphenated-project");
        let real_path = r"D:\Coffee-CLI\.claude\worktrees\exciting-swanson-f7e8be";
        write_claude_json(&home, &[real_path]);

        let map = load_claude_project_map(&home);

        assert_eq!(
            map.get("D--Coffee-CLI--claude-worktrees-exciting-swanson-f7e8be").map(String::as_str),
            Some(real_path)
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_resolves_second_real_world_project_path() {
        let home = temp_home("echobird-project");
        let real_path = r"E:\EchoBird";
        write_claude_json(&home, &[real_path]);

        let map = load_claude_project_map(&home);

        assert_eq!(map.get("E--EchoBird").map(String::as_str), Some(real_path));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_has_no_entry_for_an_unregistered_folder() {
        let home = temp_home("no-match");
        write_claude_json(&home, &[r"D:\some\other\project"]);

        let map = load_claude_project_map(&home);

        assert_eq!(map.get("D--Coffee-CLI--claude-worktrees-foo"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_is_empty_when_claude_json_is_missing() {
        let home = temp_home("missing-config");
        // Deliberately don't write .claude.json.
        assert!(load_claude_project_map(&home).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn map_is_empty_and_does_not_panic_on_malformed_json() {
        // A truncated/corrupt ~/.claude.json (a real post-crashed-write state)
        // must degrade to an empty map (and an eprintln breadcrumb), never panic
        // or reconstruct the old broken split("--") guess.
        let home = temp_home("malformed-config");
        let mut f = std::fs::File::create(home.join(".claude.json")).unwrap();
        f.write_all(br#"{"projects": {"D:\Coffee-CLI": {"#).unwrap(); // truncated
        drop(f);

        let map = load_claude_project_map(&home);

        assert!(map.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
}


#[cfg(test)]
mod antigravity_history_tests {
    #[test]
    fn antigravity_history_reads_root_conversations_from_its_index() {
        use super::*;
        let dir = std::env::temp_dir().join(format!("coffee-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("conversation_summaries.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        // Columns as created by agy 1.4.12.
        conn.execute_batch(r#"CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`));"#).unwrap();
        let row = |id: &str, title: &str, preview: &str, steps: i64, time: &str, uris: &str, parent: &str| {
            conn.execute("INSERT INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?5)",
                rusqlite::params![id, title, preview, steps, time, uris, parent]).unwrap();
        };
        row("f99ca1a5-1184-4740-8c60-5c28d2252186", "Chinese Greeting", "你好", 10, "2026-11-03 22:19:37.954952+00:00", r#"["file:///Users/eben"]"#, "");
        row("0a1b2c3d-0000-4000-8000-000000000001", "", "修复构建\n第二行", 4, "2026-11-04 08:00:00.5+00:00", r#"["file:///Volumes/%E6%89%A9%E5%B1%95%E5%AD%98%E5%82%A8/coffee-cli"]"#, "");
        row("0a1b2c3d-0000-4000-8000-000000000002", "Worker", "", 6, "2026-11-04 09:00:00+00:00", r#"["file:///Users/eben"]"#, "f99ca1a5-1184-4740-8c60-5c28d2252186");
        row("0a1b2c3d-0000-4000-8000-000000000003", "", "", 0, "2026-11-04 10:00:00+00:00", "[]", "");
        row("not a conversation --flag", "Bad id", "", 3, "2026-11-04 11:00:00+00:00", "[]", "");
        drop(conn);

        let mut sessions = Vec::new();
        find_antigravity_sessions(&db, &mut sessions);
        let summary: Vec<_> = sessions.iter().map(|s| (s.name.as_str(), s.cwd.as_str(), s.session_token.as_deref(), s.saved_at.as_str(), s.tool.as_str())).collect();
        assert_eq!(summary, vec![
            ("修复构建", if cfg!(windows) { "" } else { "/Volumes/扩展存储/coffee-cli" }, Some("0a1b2c3d-0000-4000-8000-000000000001"), "1793779200500", "antigravity"),
            ("Chinese Greeting", if cfg!(windows) { "" } else { "/Users/eben" }, Some("f99ca1a5-1184-4740-8c60-5c28d2252186"), "1793744377954", "antigravity"),
        ], "root conversations only, newest first; sub-agent and empty conversations are skipped");
        assert!(crate::agent_presets::find_preset("antigravity").is_some_and(|preset| preset.resume_program == Some("agy") && preset.resume_args_before == ["--conversation"]));

        let mut heatmap = Vec::new();
        collect_antigravity_heatmap_entries(&db, 1793744377, &mut heatmap);
        let mut counts: Vec<_> = heatmap.iter().map(|entry| (entry.ts, entry.count)).collect();
        counts.sort();
        assert_eq!(counts, vec![(1793744377, 10), (1793779200, 4)]);
        // Workspaces decode per platform, including percent-encoded non-ASCII folders.
        #[cfg(windows)]
        assert_eq!(antigravity_workspace(r#"["file:///C:/Users/eben/%E6%89%A9%E5%B1%95%E5%AD%98%E5%82%A8"]"#), r"C:\Users\eben\扩展存储");
        #[cfg(not(windows))]
        assert_eq!(antigravity_workspace(r#"["file:///home/eben/%E6%89%A9%E5%B1%95%E5%AD%98%E5%82%A8"]"#), "/home/eben/扩展存储");
        assert_eq!(antigravity_workspace("[]"), "");
        // Older index rows may carry no offset; they are UTC.
        assert_eq!(antigravity_time_ms("2026-11-03 22:19:37.954952"), Some(1793744377954));
        assert_eq!(antigravity_time_ms("2026-11-03T22:19:37Z"), Some(1793744377000));
        assert_eq!(antigravity_time_ms("yesterday"), None);
        let mut recent = Vec::new();
        collect_antigravity_heatmap_entries(&db, 1793744378, &mut recent);
        assert_eq!(recent.len(), 1, "the cutoff applies");

        // An index without the filter columns still lists its conversations, ordered by parsed time.
        let legacy = dir.join("legacy.db");
        let conn = rusqlite::Connection::open(&legacy).unwrap();
        conn.execute_batch("CREATE TABLE conversation_summaries(conversation_id TEXT,title TEXT,workspace_uris TEXT,preview TEXT,last_modified_time TEXT);").unwrap();
        for (id, time) in [("0a1b2c3d-0000-4000-8000-00000000000a", "2026-11-04 09:00:00"), ("0a1b2c3d-0000-4000-8000-00000000000b", "2026-11-04T10:00:00Z")] {
            conn.execute("INSERT INTO conversation_summaries VALUES (?1, 'Legacy', '[]', '', ?2)", rusqlite::params![id, time]).unwrap();
        }
        drop(conn);
        let mut legacy_sessions = Vec::new();
        find_antigravity_sessions(&legacy, &mut legacy_sessions);
        assert_eq!(legacy_sessions.iter().map(|s| s.session_token.as_deref().unwrap()).collect::<Vec<_>>(),
            ["0a1b2c3d-0000-4000-8000-00000000000b", "0a1b2c3d-0000-4000-8000-00000000000a"], "newest by time, not by text");
        let mut legacy_heatmap = Vec::new();
        collect_antigravity_heatmap_entries(&legacy, 0, &mut legacy_heatmap);
        assert_eq!(legacy_heatmap.iter().map(|entry| entry.count).collect::<Vec<_>>(), [1, 1]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_lines_keep_only_candidate_rows_and_exact_cursor() {
        let assistant = "{\"message\":{\"role\":\"assistant\",\"content\":\"done\"}}\n";
        let user = "{\"id\":\"u-1\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n";
        let data = format!("{assistant}{user}");
        let mut rows = Vec::new();

        push_navigation_lines(&mut rows, &data, 41, true);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].data, user);
        assert_eq!(rows[0].cursor, 41 + assistant.len() as u64);
    }

    #[test]
    fn jsonl_history_windows_reassemble_without_gap_or_overlap() {
        let data = (0..250)
            .map(|index| format!("{{\"message\":{{\"role\":\"user\",\"content\":\"第 {index} 条\"}}}}\n"))
            .collect::<String>();
        let (tail, tail_start) = slice_jsonl_window(&data, data.len() as u64);
        let (older, older_start) = slice_jsonl_window(&data, tail_start);

        assert_eq!(older_start, 0);
        assert_eq!(format!("{older}{tail}"), data);
        assert_eq!(tail.lines().count(), CHAT_WINDOW_ROWS);
    }

    #[test]
    fn jsonl_window_drops_only_the_leading_partial_row() {
        let bytes = b"partial row\nsecond\nthird\n";
        let (relative, absolute) = jsonl_window_bounds(bytes, 100);
        assert_eq!(&bytes[relative..], b"second\nthird\n");
        assert_eq!(absolute, 112);
    }

    #[test]
    fn jsonl_window_skips_one_oversized_row_without_stalling_history() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "coffee-cli-chat-window-{}.jsonl",
            std::process::id(),
        ));
        let mut file = std::fs::File::create(&path).expect("create window fixture");
        file.write_all(b"first\nsecond\n").expect("write ordinary rows");
        file.write_all(&vec![b'x'; CHAT_WINDOW_BYTES as usize + 32])
            .expect("write oversized row");
        file.write_all(b"\n").expect("finish oversized row");
        drop(file);

        let len = std::fs::metadata(&path).expect("fixture metadata").len();
        let (data, history_cursor, valid_end, skipped) =
            read_jsonl_file_window(&path, len).expect("read tail window");
        let _ = std::fs::remove_file(&path);

        assert!(skipped);
        assert_eq!(data, "first\nsecond\n");
        assert_eq!(history_cursor, 0);
        assert_eq!(valid_end, 13);
    }

    /// Build a temp Drizzle-schema SQLite db (the `session` + `message` shape
    /// `find_drizzle_sessions_sqlite` reads), seeded with one parent session,
    /// two sub-agent children (parent_id set), and one archived session. Only
    /// the columns the scanner touches are created.
    fn seed_drizzle_db(test_name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "coffee-cli-drizzle-test-{}-{}.db",
            std::process::id(),
            test_name,
        ));
        let _ = std::fs::remove_file(&path);
        let conn = rusqlite::Connection::open(&path).expect("open temp db");
        conn.execute_batch(
             r#"CREATE TABLE session (
                id            TEXT PRIMARY KEY,
                title         TEXT,
                directory     TEXT,
                time_created  INTEGER,
                time_updated  INTEGER,
                time_archived INTEGER,
                parent_id     TEXT
             );
             CREATE TABLE message (
                id           TEXT PRIMARY KEY,
                session_id   TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                data         TEXT
             );
             CREATE TABLE part (
                id           TEXT PRIMARY KEY,
                message_id   TEXT,
                session_id   TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                data         TEXT
             );
             INSERT INTO session (id, title, directory, time_created, time_updated, time_archived, parent_id) VALUES
                ('ses_parent',   'Main task',                      '/proj', 2000, 3000, NULL, NULL),
                ('ses_child_a',  'Find files (@explore subagent)', '/proj', 2010, 3010, NULL, 'ses_parent'),
                ('ses_child_b',  'Refactor (@general subagent)',   '/proj', 2020, 3020, NULL, 'ses_parent'),
                ('ses_archived', 'Old session',                    '/proj',  900, 1000, 999,  NULL);
             INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
                ('m1', 'ses_parent',   2001, 2001, '{"role":"user"}'),
                ('m2', 'ses_parent',   2002, 2002, '{"role":"assistant"}'),
                ('m3', 'ses_child_a',  2011, 2011, '{"role":"user"}'),
                ('m4', 'ses_archived',  901,  901, '{"role":"user"}');
             INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
                ('p1', 'm1', 'ses_parent', 2001, 2001, '{"type":"text","text":"hello"}');"#,
        )
        .expect("seed db");
        drop(conn);
        path
    }

    /// Sub-agent sessions carry a non-null `parent_id` (OpenCode writes one
    /// row per spawned sub-agent). The scanner must surface only root
    /// sessions — matching OpenCode's own desktop, whose root list query is
    /// `WHERE parent_id IS NULL`. Without this filter every sub-agent
    /// clutters the Sessions board as a top-level card.
    #[test]
    fn drizzle_scanner_excludes_subagent_and_archived_sessions() {
        let db = seed_drizzle_db("scanner");
        let mut result: Vec<SavedSession> = Vec::new();
        find_drizzle_sessions_sqlite(&db, "opencode", "OpenCode Session", &mut result);
        let _ = std::fs::remove_file(&db);

        let ids: Vec<&str> = result
            .iter()
            .map(|s| s.session_token.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(
            result.len(),
            1,
            "expected only the root parent session, got {ids:?}"
        );
        assert_eq!(result[0].session_token.as_deref(), Some("ses_parent"));
        assert_eq!(result[0].created_at.as_deref(), Some("2000"));
    }

    #[test]
    fn drizzle_revision_changes_without_reading_message_bodies() {
        let db = seed_drizzle_db("revision");
        let before = drizzle_session_revision(&db, "ses_parent").expect("initial revision");
        let conn = rusqlite::Connection::open(&db).expect("reopen temp db");
        conn.execute(
            "UPDATE part SET data = ?1, time_updated = 2100 WHERE id = 'p1'",
            [r#"{"type":"text","text":"hello again"}"#],
        )
        .expect("update part");
        drop(conn);
        let after = drizzle_session_revision(&db, "ses_parent").expect("updated revision");
        let _ = std::fs::remove_file(&db);
        assert_ne!(before, after);
    }

    #[test]
    fn drizzle_chat_page_queries_only_the_requested_message_window() {
        let db = seed_drizzle_db("chat-page");
        let mut conn = rusqlite::Connection::open(&db).expect("reopen temp db");
        let transaction = conn.transaction().expect("start seed transaction");
        for index in 0..205 {
            let message_id = format!("page-message-{index:03}");
            transaction.execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) \
                 VALUES (?1, 'ses_parent', ?2, ?2, '{\"role\":\"assistant\"}')",
                rusqlite::params![message_id, 10_000 + index],
            ).expect("insert paged message");
            transaction.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) \
                 VALUES (?1, ?2, 'ses_parent', ?3, ?3, ?4)",
                rusqlite::params![
                    format!("page-part-{index:03}"),
                    message_id,
                    10_000 + index,
                    format!(r#"{{"type":"text","text":"message {index}"}}"#),
                ],
            ).expect("insert paged part");
        }
        transaction.commit().expect("commit seed transaction");
        drop(conn);

        let tail = read_opencode_sqlite_session_page(&db, "ses_parent", None)
            .expect("read tail page");
        let older = read_opencode_sqlite_session_page(
            &db,
            "ses_parent",
            Some(tail.history_cursor),
        ).expect("read older page");
        let _ = std::fs::remove_file(&db);

        assert!(tail.has_older);
        assert_eq!(tail.data.lines().count(), CHAT_WINDOW_ROWS);
        assert!(!older.has_older);
        assert!(older.data.contains("hello"));
        assert!(!older.data.contains("message 204"));
    }

    #[test]
    fn hermes_revision_changes_when_a_message_is_appended() {
        let db = std::env::temp_dir().join(format!(
            "coffee-cli-hermes-revision-test-{}.db",
            std::process::id(),
        ));
        let _ = std::fs::remove_file(&db);
        let conn = rusqlite::Connection::open(&db).expect("open Hermes test db");
        conn.execute_batch(
            "CREATE TABLE messages (
                id INTEGER PRIMARY KEY,
                session_id TEXT,
                timestamp REAL,
                content TEXT
             );
             INSERT INTO messages (id, session_id, timestamp, content)
             VALUES (1, 'session-a', 1.0, 'hello');",
        )
        .expect("seed Hermes test db");
        let before = hermes_session_revision(&db, "session-a").expect("initial revision");
        conn.execute(
            "INSERT INTO messages (id, session_id, timestamp, content) VALUES (2, ?1, 2.0, 'world')",
            ["session-a"],
        )
        .expect("append Hermes message");
        drop(conn);
        let after = hermes_session_revision(&db, "session-a").expect("updated revision");
        let _ = std::fs::remove_file(&db);
        assert_ne!(before, after);
    }

    /// Write a Codex-style rollout JSONL with the given `session_meta` payload
    /// fields and one user message, returning the temp file path. Mirrors the
    /// real `~/.codex/sessions/.../rollout-*.jsonl` shape. `case` is a unique
    /// discriminator so parallel tests don't race on the same temp filename.
    /// `source` is passed as a `Value` so callers can exercise both the string
    /// form ("vscode"/"cli" - user sessions) and the object form
    /// (`{"subagent": ...}` - sub-agents) that real Codex rollouts use.
    fn write_codex_rollout(
        case: &str,
        source: serde_json::Value,
        thread_source: Option<&str>,
        forked_from_id: Option<&str>,
    ) -> std::path::PathBuf {
        write_codex_rollout_with_user_messages(
            case,
            source,
            thread_source,
            forked_from_id,
            &["refactor the auth module"],
        )
    }

    fn write_codex_rollout_with_user_messages(
        case: &str,
        source: serde_json::Value,
        thread_source: Option<&str>,
        forked_from_id: Option<&str>,
        user_messages: &[&str],
    ) -> std::path::PathBuf {
        use std::io::Write;
        let mut payload = serde_json::json!({
            "timestamp": "2026-07-12T10:48:37.000Z",
            "type": "session_meta",
            "payload": {
                "id": "019f55f1-7c10-75f2-b536-84009ee1d4dc",
                "timestamp": "2026-07-12T10:48:37.000Z",
                "cwd": "E:\\test",
                "originator": "Codex Desktop",
                "cli_version": "0.144.1",
                "source": source,
                "model_provider": "OpenAI",
            },
        });
        let inner = payload.get_mut("payload").unwrap().as_object_mut().unwrap();
        if let Some(ts) = thread_source {
            inner.insert("thread_source".to_string(), serde_json::Value::String(ts.to_string()));
        }
        if let Some(fid) = forked_from_id {
            inner.insert("forked_from_id".to_string(), serde_json::Value::String(fid.to_string()));
        }
        let path = std::env::temp_dir().join(format!(
            "coffee-cli-codex-test-{}-{}.jsonl",
            std::process::id(),
            case
        ));
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{}", payload).unwrap();
        for text in user_messages {
            let msg = serde_json::json!({
                "timestamp": "2026-07-12T10:48:38.000Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                },
            });
            writeln!(f, "{}", msg).unwrap();
        }
        path
    }

    /// A normal user-created main session stays visible.
    #[test]
    fn codex_parser_keeps_user_main_session() {
        let path = write_codex_rollout("user-main", serde_json::json!("vscode"), Some("user"), None);
        let session = parse_codex_session_jsonl(&path).expect("user session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.tool, "codex");
        assert_eq!(session.name, "refactor the auth module");
        assert_eq!(session.created_at.as_deref(), Some("2026-07-12T10:48:37.000Z"));
    }

    /// Codex Desktop writes plugin/AGENTS/environment bootstrap context as
    /// synthetic user messages before the first thing the user actually typed.
    /// The sidebar title must scan past all of them.
    #[test]
    fn codex_parser_skips_desktop_bootstrap_messages_for_title() {
        let path = write_codex_rollout_with_user_messages(
            "desktop-bootstrap-title",
            serde_json::json!("vscode"),
            Some("user"),
            None,
            &[
                "<recommended_plugins> Here is a list of plugins that are available but not installed.",
                "# AGENTS.md instructions for D:\\Coffee-CLI\n<INSTRUCTIONS>...</INSTRUCTIONS>",
                "<environment_context><cwd>D:\\Coffee-CLI</cwd></environment_context>",
                "修复真正的用户标题",
            ],
        );
        let session = parse_codex_session_jsonl(&path).expect("desktop session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.name, "修复真正的用户标题");
    }

    /// `thread_source == "subagent"` rollouts are dropped entirely.
    #[test]
    fn codex_parser_drops_subagent_thread_source() {
        let path = write_codex_rollout("subagent-ts", serde_json::json!("vscode"), Some("subagent"), None);
        let session = parse_codex_session_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        assert!(session.is_none(), "subagent rollout must be hidden");
    }

    /// A sub-agent rollout identified by `source: {"subagent": ...}` is
    /// dropped even with no `thread_source` (older rollouts). Uses the real
    /// Codex Desktop shape, where `parent_thread_id` is nested under
    /// `source.subagent.thread_spawn` - not a top-level field.
    #[test]
    fn codex_parser_drops_subagent_source_object() {
        let source = serde_json::json!({
            "subagent": {"thread_spawn": {"parent_thread_id": "019e6d80-aaaa-bbbb-cccc-dddddddddddd", "depth": 1, "agent_role": "explorer"}}
        });
        let path = write_codex_rollout("subagent-src", source, None, None);
        let session = parse_codex_session_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        assert!(session.is_none(), "subagent source-object rollout must be hidden");
    }

    /// A sub-agent whose `SubAgentSource` is a unit variant (e.g. "review")
    /// still serializes `source` with a `subagent` key - caught by the
    /// `contains_key` check regardless of the nested variant shape.
    #[test]
    fn codex_parser_drops_subagent_source_unit_variant() {
        let path = write_codex_rollout("subagent-review", serde_json::json!({"subagent": "review"}), None, None);
        let session = parse_codex_session_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        assert!(session.is_none(), "review subagent rollout must be hidden");
    }

    /// `forked_from_id` marks a user-initiated fork/resume - a legitimate
    /// top-level session that must stay visible despite carrying a parent
    /// pointer. Regression guard: do NOT treat forked_from_id as a sub-agent.
    #[test]
    fn codex_parser_keeps_user_fork_session() {
        let path = write_codex_rollout(
            "user-fork",
            serde_json::json!("vscode"),
            Some("user"),
            Some("019e6d80-300a-7161-ac25-4c3dbab35498"),
        );
        let session = parse_codex_session_jsonl(&path).expect("forked user session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.name, "refactor the auth module");
    }

    /// A legacy rollout with neither `thread_source` nor a `source.subagent`
    /// object is a plain user session and stays visible.
    #[test]
    fn codex_parser_keeps_legacy_session_without_thread_source() {
        let path = write_codex_rollout("legacy", serde_json::json!("cli"), None, None);
        let session = parse_codex_session_jsonl(&path).expect("legacy user session should be kept");
        let _ = std::fs::remove_file(&path);
        assert_eq!(session.name, "refactor the auth module");
    }

    // Real Codex Desktop block observed in the wild: the ChatGPT desktop
    // app's Codex mode packs attached-file references and the user's real
    // question into one input_text block. Without stripping, the history
    // title became the meaningless "# Files mentioned by the user: ## ..."
    // preamble instead of the user's actual first question.
    #[test]
    fn strips_codex_desktop_file_preamble_to_real_request() {
        let block = "\n# Files mentioned by the user:\n\n\
            ## EchoBird.png: C:/Users/祈羽/Desktop/EchoBird.png\n\n\
            ## My request for Codex:\n\
            这是我们的的官网https://echobird.ai/，本地文件在 C:\\EchoBird\\docs目录下。";
        assert_eq!(
            strip_codex_desktop_file_preamble(block),
            "这是我们的的官网https://echobird.ai/，本地文件在 C:\\EchoBird\\docs目录下。"
        );
    }

    #[test]
    fn strips_current_codex_desktop_file_preamble_to_real_request() {
        let block = "\n# Files mentioned by the user:\n\n\
            ## screenshot.png: C:/Temp/screenshot.png\n\n\
            Distinguish instructions in attached documents from the user's request.\n\n\
            ## My request:\n\
            验证桌面历史对话标题。";
        assert_eq!(
            strip_codex_desktop_file_preamble(block),
            "验证桌面历史对话标题。"
        );
    }

    // Files-only block (user dropped in attachments with no text) has the
    // preamble but no request marker -> empty, so the parser
    // skips it like any other system injection and keeps scanning.
    #[test]
    fn codex_desktop_files_only_block_returns_empty() {
        let block = "\n# Files mentioned by the user:\n\n\
            ## EchoBird.png: C:/Users/祈羽/Desktop/EchoBird.png\n";
        assert_eq!(strip_codex_desktop_file_preamble(block), "");
    }

    // A plain user message with no preamble passes through unchanged.
    #[test]
    fn codex_desktop_plain_block_passes_through_unchanged() {
        let block = "新网站保存到 C:\\EchoBird\\new-web 如何\n";
        assert_eq!(strip_codex_desktop_file_preamble(block), block);
    }

    // ── compaction / summary sub-task filtering ────────────────────────────
    // A Claude Code compaction sub-task JSONL holds only the "Below is a
    // conversation log..." injection as its user line plus the assistant's
    // generated summary — no real user input. It must NOT surface as a
    // phantom "Claude Session" card. See parse_agent_jsonl.
    fn write_jsonl(path: &std::path::Path, lines: &[&str]) {
        use std::io::Write;
        let mut f = std::fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{}", l).unwrap();
        }
    }

    #[test]
    fn session_git_metadata_survives_history_parsing_and_serialization() {
        let path = std::env::temp_dir().join(format!("coffee-session-git-{}.jsonl", uuid::Uuid::new_v4()));
        write_jsonl(&path, &[
            r#"{"type":"user","gitBranch":"feature/one","cwd":"D:/project","message":{"role":"user","content":"Review this change"}}"#,
            r#"{"type":"pr-link","prUrl":"https://github.com/owner/repo/pull/42"}"#,
            r#"{"type":"assistant","gitBranch":"main","message":{"role":"assistant","content":[]}}"#,
        ]);
        let session = parse_agent_jsonl(&path, "claude", &std::collections::HashMap::new()).unwrap();
        let restored: SavedSession = serde_json::from_value(serde_json::to_value(&session).unwrap()).unwrap();
        let context = restored.git_context.unwrap();
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert_eq!(context.pull_requests, ["https://github.com/owner/repo/pull/42"]);
        write_jsonl(&path, &[
            r#"{"type":"session_meta","payload":{"id":"one","cwd":"D:/project","git":{"branch":"main"}}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Review https://github.com/owner/repo/pull/43"}]}}"#,
        ]);
        let context = parse_codex_session_jsonl(&path).unwrap().git_context.unwrap();
        assert_eq!(context.branch.as_deref(), Some("main"));
        assert_eq!(context.pull_requests, ["https://github.com/owner/repo/pull/43"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn drops_pure_compaction_subtask_session() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-compact-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("30d442fb-fake-compaction.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Below is a conversation log from a Claude Code coding session.\\nCreate a summary to help the next session quickly understand the context.\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"# Session Summary\\n...\"}]}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"### Tasks\\n- did stuff\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new());
        assert!(got.is_none(), "pure compaction sub-task must not be listed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_real_session_with_real_user_message() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-real-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("dadf2990-fake-real.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"修复一下历史记录的 bug\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"好的，我来看看\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("real session kept");
        assert_eq!(got.name, "修复一下历史记录的 bug");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_title_skips_rows_the_cli_marks_as_not_typed() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-wrapper-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("5b1c0f3e-fake-wrappers.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Caveat: the messages below were generated by the user while running local commands.\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<some-new-wrapper>hook output</some-new-wrapper>\"}]}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"[Request interrupted by user]\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"tool output\"}]}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<ide_opened_file>a.rs</ide_opened_file>\"},{\"type\":\"text\",\"text\":\"把工作中动画对齐竖线\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "把工作中动画对齐竖线");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_title_falls_back_to_slash_command_and_reads_shell_lines() {
        let mut fallback = String::new();
        assert_eq!(claude_prompt_title("<command-name>/model</command-name>\n<command-message>model</command-message>", &mut fallback), None);
        assert_eq!(fallback, "/model");
        assert_eq!(claude_prompt_title("<bash-input>git status</bash-input>", &mut fallback).as_deref(), Some("! git status"));
        assert_eq!(claude_prompt_title("Use <b>bold</b> here", &mut fallback).as_deref(), Some("Use <b>bold</b> here"));
        // Older CLIs put the message tag first; a prompt that only mentions the tags is still a prompt.
        let mut older = String::new();
        assert_eq!(claude_prompt_title("<command-message>usage</command-message>\n<command-name>/usage</command-name>", &mut older), None);
        assert_eq!(older, "/usage");
        let mut untouched = String::new();
        assert_eq!(claude_prompt_title("why is <command-name>/init</command-name> in the log?", &mut untouched).as_deref(), Some("why is <command-name>/init</command-name> in the log?"));
        assert_eq!(claude_prompt_title("run <bash-input>ls</bash-input> for me", &mut untouched).as_deref(), Some("run <bash-input>ls</bash-input> for me"));
        assert!(untouched.is_empty());
        let dir = std::env::temp_dir().join(format!("coffee-cli-command-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("7a2e9c1d-fake-command.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/init</command-name>\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"real prompt after the command\"}}",
        ]);
        assert_eq!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("kept").name, "real prompt after the command");
        // A session the user only ran a slash command in is theirs, named by the command.
        write_jsonl(&f, &["{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<command-name>/usage</command-name>\"}}"]);
        assert_eq!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("kept").name, "/usage");
        // Hook output and interrupt markers alone are not a conversation the user had.
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"<some-hook-output>ran</some-hook-output>\"}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"[Request interrupted by user]\"}}",
            "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"Caveat: generated while running local commands.\"}}",
        ]);
        assert!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Row shapes below are copied from real Claude Code transcripts.
    #[test]
    fn claude_native_title_beats_first_prompt() {
        let dir = std::env::temp_dir().join(format!("coffee-cli-title-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let user = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"帮我看看历史记录为什么少了几条\"}}";

        let f = dir.join("ai-title.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"ai-title\",\"aiTitle\":\"排查历史记录\",\"sessionId\":\"ai-title\"}",
            user,
            "{\"type\":\"ai-title\",\"aiTitle\":\"历史记录缺失排查\",\"sessionId\":\"ai-title\"}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "历史记录缺失排查", "the last generated title wins");
        assert_eq!(got.turn_count, Some(1), "title rows are not messages");

        let f = dir.join("custom-title.jsonl");
        write_jsonl(&f, &[
            user,
            "{\"type\":\"custom-title\",\"customTitle\":\"历史记录｜扫描稳定性\",\"sessionId\":\"custom-title\"}",
            "{\"type\":\"ai-title\",\"aiTitle\":\"历史记录缺失排查\",\"sessionId\":\"custom-title\"}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "历史记录｜扫描稳定性", "a user rename beats a generated title");

        let f = dir.join("blank-title.jsonl");
        write_jsonl(&f, &[user, "{\"type\":\"ai-title\",\"aiTitle\":\"  \",\"sessionId\":\"blank-title\"}"]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("session kept");
        assert_eq!(got.name, "帮我看看历史记录为什么少了几条", "a blank title falls back to the first prompt");

        // A title row is not a conversation: still a phantom without a real user line.
        let f = dir.join("title-only.jsonl");
        write_jsonl(&f, &["{\"type\":\"ai-title\",\"aiTitle\":\"Orphan\",\"sessionId\":\"title-only\"}"]);
        assert!(parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_thread_names_overlay_first_prompt_titles() {
        let names = parse_codex_thread_names(concat!(
            "{\"id\":\"t1\",\"thread_name\":\"修正 Codex 本地代理配置\",\"updated_at\":\"2026-09-19T10:31:30Z\"}\n",
            "not json\n",
            "{\"id\":\"t2\",\"thread_name\":\"  \"}\n",
            "{\"id\":\"t1\",\"thread_name\":\"Codex代理｜核对本地地址绕过配置\",\"updated_at\":\"2026-09-19T10:33:37Z\"}\n",
        ));
        assert_eq!(names.len(), 1, "blank names and malformed rows are skipped");
        assert_eq!(names["t1"], "Codex代理｜核对本地地址绕过配置", "a later row renames the thread");

        let home = std::env::temp_dir().join(format!("coffee-cli-codex-index-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(
            home.join(".codex").join("session_index.jsonl"),
            "{\"id\":\"t1\",\"thread_name\":\"Codex代理｜核对本地地址绕过配置\"}\n",
        ).unwrap();
        let row = |tool: &str, token: &str| SavedSession {
            id: format!("{}_native_{}", tool, token),
            name: "first prompt".to_string(),
            tool: tool.to_string(),
            cwd: String::new(),
            session_token: Some(token.to_string()),
            saved_at: String::new(),
            created_at: None,
            file_path: None,
            turn_count: None,
            git_context: None,
            worktree_cwd: None,
        };
        let mut sessions = vec![row("codex", "t1"), row("codex", "unnamed"), row("claude", "t1")];
        apply_codex_thread_names(&home.join(".codex/sessions"), &mut sessions);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(sessions[0].name, "Codex代理｜核对本地地址绕过配置");
        assert_eq!(sessions[1].name, "first prompt", "threads absent from the index keep their title");
        assert_eq!(sessions[2].name, "first prompt", "other tools are never touched");
    }

    #[test]
    fn keeps_session_that_continued_after_compaction() {
        // The live-session case: compaction injected as the FIRST user line,
        // but the user kept chatting in the same session file. Must survive —
        // filtering on "first user line is injected" would wrongly drop this.
        let dir = std::env::temp_dir().join(format!("coffee-cli-cont-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("43b57955-fake-continued.jsonl");
        write_jsonl(&f, &[
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Below is a conversation log from a Claude Code coding session.\\nCreate a summary...\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"summary\"}]}}",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"继续帮我测一下 OSC 52\"}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"好\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("continued session kept");
        // Title is the FIRST real user line, not the compaction injection.
        assert_eq!(got.name, "继续帮我测一下 OSC 52");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn counts_array_content_user_message_with_mixed_blocks() {
        // A user message whose content is an ARRAY can mix an injected block
        // (e.g. an ide_opened_file tool_result) with a real text block. The
        // counter must count this as ONE real user message (.any() semantics)
        // — not zero (which would drop a live session) and not >1. Covers the
        // array branch of the counter that the string-content tests don't.
        let dir = std::env::temp_dir().join(format!("coffee-cli-arr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a3f2c910-fake-array.jsonl");
        write_jsonl(&f, &[
            // First user msg: array with an injected tool_result block AND a
            // real text block — must count as 1 real user message.
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"x\",\"content\":\"<ide_opened_file>\"},{\"type\":\"text\",\"text\":\"帮我把这个文件重构一下\"}]}}",
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"好的\"}]}}",
        ]);
        let got = parse_agent_jsonl(&f, "claude", &std::collections::HashMap::new()).expect("mixed-array session kept");
        // Title comes from the real text block, not the injected tool_result.
        assert_eq!(got.name, "帮我把这个文件重构一下");
        let _ = std::fs::remove_dir_all(&dir);
    }

}

#[cfg(test)]
mod pi_session_written_tests {
    #[test]
    fn pi_token_waits_for_the_session_file() {
        let root = std::env::temp_dir().join(format!("coffee-pi-root-{}", uuid::Uuid::new_v4()));
        let bucket = root.join("--Users-me-proj--");
        std::fs::create_dir_all(&bucket).unwrap();
        let id = "0f0f0f0f-1111-2222-3333-444444444444";
        let suffix = format!("_{id}.jsonl");
        assert!(!super::pi_session_written(&root, &suffix));
        std::fs::write(bucket.join(format!("2026-11-03T01-02-03-000Z{suffix}")), "{}").unwrap();
        assert!(super::pi_session_written(&root, &suffix));
        std::fs::remove_dir_all(root).unwrap();
    }
}


#[cfg(test)]
mod launch_permission_tests {
    use super::launch_permission_args;
    #[test]
    fn a_cards_permission_becomes_the_tools_own_launch_flags_and_nothing_else_passes() {
        assert_eq!(launch_permission_args("claude", Some(r#"{"permission":"plan"}"#)), ["--permission-mode", "plan"]);
        assert_eq!(launch_permission_args("codex", Some(r#"{"permission":"dangerFullAccess"}"#)), ["--sandbox", "danger-full-access", "--ask-for-approval", "never"]);
        assert_eq!(launch_permission_args("codex", Some(r#"{"permission":"readOnly"}"#)), ["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
        assert!(launch_permission_args("claude", Some(r#"{"permission":"--dangerously; rm"}"#)).is_empty(), "only the card's own values");
        assert!(launch_permission_args("claude", Some(r#"{"permission":"readOnly"}"#)).is_empty(), "another tool's value");
        assert!(launch_permission_args("opencode", Some(r#"{"permission":"plan"}"#)).is_empty());
        assert!(launch_permission_args("claude", None).is_empty());
        let claude = crate::agent_presets::find_preset("claude").unwrap();
        assert_eq!(super::resume_args(claude, "claude", "abc", Some(r#"{"permission":"plan"}"#)), ["--resume", "abc", "--permission-mode", "plan"], "a resumed tab keeps the card's permission");
        assert!(launch_permission_args("claude", Some("not json")).is_empty());
    }
}

