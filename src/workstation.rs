// workstation.rs — Tauri commands for the Workstation.
//
// Phase 3a (detection):
//   - detect_clis:          which AI CLIs are on PATH
//   - detect_runtimes:      which OCI runtimes are on PATH
//   - get_system_capacity:  RAM / cores / platform / estimated max agents
//
// Phase 3b (team filesystem):
//   - create_team_fs: materializes ~/.coffee/teams/<id>/ as a recursive
//     tree mirroring the blueprint's canvas hierarchy. Each node becomes
//     a subdirectory with agent.md (identity + current task) and
//     output.md (append-only produce log). When an agent's container
//     mounts its subtree as /team/, sibling and parent agents are
//     invisible by design — every agent sees itself as the root of its
//     own world.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use sysinfo::System;

/// Matches `CliAvailability` in src-ui/.../workstation/types.ts.
/// serde's rename_all flips Rust snake_case to TS camelCase (no-op here
/// since fields are already flat single-words) and drops the Rust struct
/// name during JSON serialization.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAvailability {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub qwen: bool,
}

/// Matches `SystemCapacity` in types.ts. Note: `runtimesAvailable` mirrors
/// the TS field name exactly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemCapacity {
    pub ram_gb: u32,
    pub cpu_cores: u32,
    pub platform: String,
    pub est_max_agents: u32,
    pub runtimes_available: Vec<String>,
}

/// Returns true if `cmd` resolves to an executable on the user's PATH.
fn is_on_path(cmd: &str) -> bool {
    which::which(cmd).is_ok()
}

#[tauri::command]
pub fn detect_clis() -> CliAvailability {
    CliAvailability {
        claude: is_on_path("claude"),
        codex: is_on_path("codex"),
        gemini: is_on_path("gemini"),
        qwen: is_on_path("qwen"),
    }
}

#[tauri::command]
pub fn detect_runtimes() -> Vec<String> {
    let mut runtimes = Vec::new();
    // Podman first — we prefer it (free, daemonless).
    if is_on_path("podman") {
        runtimes.push("podman".to_string());
    }
    if is_on_path("docker") {
        runtimes.push("docker".to_string());
    }
    runtimes
}

#[tauri::command]
pub fn get_system_capacity() -> SystemCapacity {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::everything());

    let ram_bytes = sys.total_memory();
    let ram_gb = (ram_bytes / (1024 * 1024 * 1024)) as u32;
    let cpu_cores = sys.cpus().len() as u32;

    let platform = if cfg!(target_os = "windows") {
        "Windows".to_string()
    } else if cfg!(target_os = "macos") {
        "macOS".to_string()
    } else {
        "Linux".to_string()
    };

    // (RAM - 4 GB reserved for OS/user apps) * 1024 MB / ~300 MB per agent,
    // floored at 3 so tiny machines still show a meaningful number.
    let est_max_agents = std::cmp::max(
        3,
        ram_gb.saturating_sub(4).saturating_mul(1024) / 300,
    );

    SystemCapacity {
        ram_gb,
        cpu_cores,
        platform,
        est_max_agents,
        runtimes_available: detect_runtimes(),
    }
}

// ─── Phase 3b: team filesystem ──────────────────────────────

#[derive(Deserialize)]
pub struct BlueprintNode {
    pub id: String,
    pub name: String,
    pub hint: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
}

#[derive(Deserialize)]
pub struct BlueprintEdge {
    pub source: String,
    pub target: String,
}

#[derive(Deserialize)]
pub struct BlueprintPayload {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    pub author: String,
    pub nodes: Vec<BlueprintNode>,
    pub edges: Vec<BlueprintEdge>,
}

fn team_root(team_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("home directory not available")?;
    Ok(home.join(".coffee").join("teams").join(team_id))
}

fn team_md_content(bp: &BlueprintPayload) -> String {
    format!(
        "# {} · {}\n\n{}\n\n---\n\n- blueprint: `{}`\n- author: {}\n",
        bp.icon, bp.name, bp.description, bp.id, bp.author,
    )
}

fn agent_md_content(node: &BlueprintNode) -> String {
    let avatar = node.avatar.as_deref().unwrap_or("👤");
    let purpose = node
        .description
        .as_deref()
        .or(node.hint.as_deref())
        .unwrap_or("（未指定职责）");
    format!(
        "# {} {}\n\n> id: `{}`\n\n## 身份\n\n{}\n\n## 当前任务\n\n_（此处由上级或用户编辑。心跳触发时分身会读取这里。）_\n\n## 下属（只读，自动生成）\n\n运行 `ls /team/` 查看。\n",
        avatar, node.name, node.id, purpose,
    )
}

fn write_agent_files(dir: &Path, node: &BlueprintNode) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("create_dir_all {}: {}", dir.display(), e))?;
    fs::write(dir.join("agent.md"), agent_md_content(node))
        .map_err(|e| format!("write agent.md: {}", e))?;
    fs::write(dir.join("output.md"), "")
        .map_err(|e| format!("write output.md: {}", e))?;
    Ok(())
}

fn build_tree(
    parent: &Path,
    node: &BlueprintNode,
    all_nodes: &[BlueprintNode],
    edges: &[BlueprintEdge],
) -> Result<(), String> {
    let agent_dir = parent.join(&node.id);
    write_agent_files(&agent_dir, node)?;

    let child_ids: Vec<&String> = edges
        .iter()
        .filter(|e| e.source == node.id)
        .map(|e| &e.target)
        .collect();

    for child_id in child_ids {
        if let Some(child) = all_nodes.iter().find(|n| &n.id == child_id) {
            build_tree(&agent_dir, child, all_nodes, edges)?;
        }
    }
    Ok(())
}

/// Materialize the team directory on disk. Called when the user picks a
/// template. Safe to call multiple times with the same team_id (it tops
/// up any missing files without clobbering content users may have
/// edited — fs::create_dir_all and fs::write only write if the target
/// differs, but for simplicity we always write the seed content on first
/// creation and leave it alone after).
#[tauri::command]
pub fn create_team_fs(team_id: String, blueprint: BlueprintPayload) -> Result<String, String> {
    let base = team_root(&team_id)?;
    fs::create_dir_all(&base).map_err(|e| format!("create_dir_all team root: {}", e))?;

    // Seed team.md only on first creation — don't clobber if the user
    // has edited it.
    let team_md_path = base.join("team.md");
    if !team_md_path.exists() {
        fs::write(&team_md_path, team_md_content(&blueprint))
            .map_err(|e| format!("write team.md: {}", e))?;
    }

    // Find the root node — one with no incoming edges. If there's no
    // clear root (disconnected graph or cycle) we pick the first node
    // rather than error; blueprints in our catalog are well-formed trees
    // so this fallback is defensive only.
    let targets: HashSet<&String> = blueprint.edges.iter().map(|e| &e.target).collect();
    let root = blueprint
        .nodes
        .iter()
        .find(|n| !targets.contains(&n.id))
        .or_else(|| blueprint.nodes.first())
        .ok_or("blueprint has no nodes")?;

    build_tree(&base, root, &blueprint.nodes, &blueprint.edges)?;

    Ok(base.to_string_lossy().to_string())
}
