// Tauri v2 typed invoke wrapper

// Extend Window with Tauri globals to avoid TS2339
declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    __TAURI__?: {
      invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
      core?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    };
  }
}

// isTauri: evaluated once at module load.
// Tauri injects __TAURI_INTERNALS__ synchronously before any scripts run.
export const isTauri =
  typeof window !== 'undefined' &&
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__);

// Resolve the invoke function across Tauri v1 / v2
function resolveInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const w = window as unknown as Record<string, unknown>;
  const internals = w.__TAURI_INTERNALS__ as Record<string, unknown> | undefined;
  if (internals && typeof internals.invoke === 'function') return internals.invoke as never;
  const tauri = w.__TAURI__ as Record<string, unknown> | undefined;
  if (tauri) {
    const core = tauri.core as Record<string, unknown> | undefined;
    if (core && typeof core.invoke === 'function') return core.invoke as never;
    if (typeof tauri.invoke === 'function') return tauri.invoke as never;
  }
  return null;
}

let _invoke = isTauri ? resolveInvoke() : null;

export function retryInvoke() {
  if (isTauri && !_invoke) _invoke = resolveInvoke();
  return _invoke;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) throw new Error('Tauri IPC not available');
  return _invoke(cmd, args) as Promise<T>;
}

// ─── Type Definitions ────────────────────────────────────────────────────────

export interface FileEntry {
  relative_path: string;
  size: number;
  extension: string;
  symbols: { name: string; kind: string; line: number }[];
  line_count: number;
}

export interface ScanResult {
  root: string;
  files: FileEntry[];
  total_scanned: number;
  skipped: string[];
}

export interface GitStatusResponse {
  files_changed: number;
  insertions: number;
  deletions: number;
}

export interface SavedSession {
  id: string;
  name: string;
  tool: string;
  cwd: string;
  session_token: string | null;
  saved_at: string;
  file_path?: string;
  turn_count?: number;
}

export interface DriveInfo {
  path: string;
  label: string;
  kind: string;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

// ─── Typed Commands ──────────────────────────────────────────────────────────

export const commands = {
  pickFolder: () => invoke<string>('pick_folder'),

  scanFolder: (path: string | null) =>
    invoke<ScanResult>('scan_project', { path }),

  // Window decorators
  windowMinimize: () => invoke<void>('window_minimize'),
  windowMaximize: () => invoke<void>('window_maximize'),
  windowClose: () => invoke<void>('window_close'),

  // Git Status
  getGitStatus: () =>
    invoke<GitStatusResponse | null>('get_git_status'),

  // Tier Terminal API
  tierTerminalStart: (sessionId: string, tool: string | null, cols: number, rows: number, themeMode: string, locale?: string, toolData?: string, cwd?: string) => 
    invoke<void>('tier_terminal_start', { sessionId, tool, toolData: toolData ?? null, cols, rows, themeMode, locale: locale ?? null, cwd: cwd ?? null }),
  tierTerminalInput: (sessionId: string, data: string) => 
    invoke<void>('tier_terminal_input', { sessionId, data }),
  /** Raw write to PTY — does NOT trigger agent-status detection.
   *  Used for system-generated input (auto-skip prompts, etc.). */
  tierTerminalRawWrite: (sessionId: string, data: string) =>
    invoke<void>('tier_terminal_raw_write', { sessionId, data }),
  tierTerminalKill: (sessionId: string) => 
    invoke<void>('tier_terminal_kill', { sessionId }),
  tierTerminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>('tier_terminal_resize', { sessionId, cols, rows }),

  // Session Resume
  getNativeHistory: () => invoke<SavedSession[]>('get_native_history'),
  readNativeSession: (filePath: string) => invoke<string>('read_native_session', { filePath }),
  tierTerminalResume: (sessionId: string, savedSessionId: string, tool: string, sessionToken: string, cols: number, rows: number, cwd: string) =>
    invoke<void>('tier_terminal_resume', { sessionId, savedSessionId, tool, sessionToken, cols, rows, cwd }),
  checkNetworkPort: (host: string, port: number) => invoke<boolean>('check_network_port', { host, port }),

  // Installer — write script to a temp file and return its path
  writeTempScript: (content: string, extension: string) =>
    invoke<string>('write_temp_script', { content, extension }),

  // Tool availability detection
  checkToolsInstalled: (extras?: string[]) =>
    invoke<Record<string, boolean>>('check_tools_installed', extras ? { extras } : {}),

  /** Gambit — save a clipboard-pasted image to a temp file and return its path.
   *  The returned absolute path is inserted into the textarea so the AI CLI agent
   *  (Claude Code, etc.) can read the image via the local filesystem. */
  saveClipboardImage: (dataBase64: string, extension: string) =>
    invoke<string>('save_clipboard_image', { dataBase64, extension }),

  // File system browsing (My Computer tab)
  listDrives: () => invoke<DriveInfo[]>('list_drives'),
  listDirectory: (path: string) => invoke<DirEntryInfo[]>('list_directory', { path }),

  // File system operations
  fsDelete: (path: string) => invoke<void>('fs_delete', { path }),
  fsRename: (path: string, newName: string) => invoke<void>('fs_rename', { path, newName }),
  fsPaste: (action: string, srcPath: string, targetDir: string) =>
    invoke<void>('fs_paste', { action, srcPath, targetDir }),
  showInFolder: (path: string) => invoke<void>('show_in_folder', { path }),

  // Arcade (Coffee Play)
  listJsdosBundles: () => invoke<{ name: string; path: string; size: number }[]>('list_jsdos_bundles'),
  readJsdosBundle: (path: string) => invoke<number[]>('read_jsdos_bundle', { path }),
  saveJsdosBundle: (name: string, data: number[] | Uint8Array) => invoke<void>('save_jsdos_bundle', { name, data: Array.from(data) }),

  // Task Board persistence (~/.coffee-cli/tasks.json)
  loadTasks: () => invoke<string>('load_tasks'),
  saveTasks: (data: string) => invoke<void>('save_tasks', { data }),

  // Multi-window: detach tab into new window
  createDetachedWindow: (sessionId: string, tool: string, toolData?: string) =>
    invoke<void>('create_detached_window', { sessionId, tool, toolData }),

  // Multi-window: replay terminal history for detached window
  getTerminalBuffer: (sessionId: string) =>
    invoke<string[]>('get_terminal_buffer', { sessionId }),

  // Credential store — passwords live in OS keychain, never in localStorage
  savePassword: (host: string, username: string, password: string) =>
    invoke<void>('save_password', { host, username, password }),
  loadPassword: (host: string, username: string) =>
    invoke<string | null>('load_password', { host, username }),
  deletePassword: (host: string, username: string) =>
    invoke<void>('delete_password', { host, username }),
  openUrl: (url: string) =>
    invoke<void>('open_url', { url }),

  // Skill auto-install: check whether ~/.claude/skills/<name>/SKILL.md exists,
  // and write individual files into ~/.claude/skills/vibeid/<relPath>.
  // Used by the VibeID launcher to hydrate the skill on first launch by
  // fetching the remote skill package and piping each file through.
  checkSkillInstalled: (name: string) =>
    invoke<boolean>('check_skill_installed', { name }),
  writeSkillFile: (relPath: string, bytes: number[]) =>
    invoke<void>('write_skill_file', { relPath, bytes }),

  // Check whether `~/.claude/usage-data/report.html` exists. Used by the
  // VibeID launcher to gate between running /insights first or going
  // straight to /vibeid.
  checkVibeidReportExists: () =>
    invoke<boolean>('check_vibeid_report_exists'),

  // Return the Unix-epoch-seconds mtime of the /insights report file.
  // 0 if the file doesn't exist. The VibeID launcher records the click
  // timestamp, starts a pre-run tab that runs /insights, and polls this
  // until mtime > clickTs (meaning the report was freshly regenerated).
  checkVibeidReportMtime: () =>
    invoke<number>('check_vibeid_report_mtime'),

  // Live fs watcher — subscribes to OS-native events under `path` and
  // emits `fs-refresh` Tauri events that Explorer already listens for.
  // Calling start with a new path implicitly replaces the previous watcher.
  startFsWatcher: (path: string) =>
    invoke<void>('start_fs_watcher', { path }),
  stopFsWatcher: () =>
    invoke<void>('stop_fs_watcher'),

  // Multi-agent mode — writes CLAUDE.md / AGENTS.md / GEMINI.md to the
  // workspace root and merges the coffee-cli MCP endpoint into each
  // detected primary CLI config. Idempotent; safe to call repeatedly.
  enableMultiAgentMode: (workspace: string) =>
    invoke<{
      ok: boolean;
      mcp_url: string | null;
      touched_config_files: string[];
      touched_md_files: string[];
      warnings: string[];
    }>('enable_multi_agent_mode', { workspace }),
  disableMultiAgentMode: (workspace: string) =>
    invoke<{
      ok: boolean;
      mcp_url: string | null;
      touched_config_files: string[];
      touched_md_files: string[];
      warnings: string[];
    }>('disable_multi_agent_mode', { workspace }),
};
