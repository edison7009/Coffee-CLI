// workstation.rs — Tauri commands for the Workstation (Phase 3a).
//
// Phase 3a: detection only. No container spawning yet.
//   - detect_clis:          which AI CLIs are on PATH
//   - detect_runtimes:      which OCI runtimes are on PATH
//   - get_system_capacity:  RAM / cores / platform / estimated max agents
//
// All three are called once on workstation open (Phase 1 used placeholders).
// Phase 3b+ will add team-fs setup and container spawning in this module.

use serde::Serialize;
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
