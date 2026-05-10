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

export interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

// ─── Typed Commands ──────────────────────────────────────────────────────────

export const commands = {
  pickFolder: () => invoke<string>('pick_folder'),

  // Window decorators
  windowMinimize: () => invoke<void>('window_minimize'),
  windowMaximize: () => invoke<void>('window_maximize'),
  windowClose: () => invoke<void>('window_close'),

  // Tier Terminal API
  tierTerminalStart: (sessionId: string, tool: string | null, cols: number, rows: number, themeMode: string, locale?: string, toolData?: string, cwd?: string, sentinelEnabled?: boolean) =>
    invoke<void>('tier_terminal_start', { sessionId, tool, toolData: toolData ?? null, cols, rows, themeMode, locale: locale ?? null, cwd: cwd ?? null, sentinelEnabled: sentinelEnabled ?? false }),
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

  /** Notify the Rust backend that the window's visibility changed.
   *  When hidden=true, every per-session worker thread (ticker, emitter)
   *  widens its sleep / coalesce window so a backgrounded Coffee CLI
   *  drops to near-zero CPU instead of running its full foreground
   *  cadence. Apple Silicon laptops in particular need this to keep
   *  the chassis cool when users leave the app open all day. */
  setBackgroundMode: (hidden: boolean) =>
    invoke<void>('set_background_mode', { hidden }),

  // Session Resume
  getNativeHistory: () => invoke<SavedSession[]>('get_native_history'),
  /** Per-session activity for the contribution heatmap.
   *  One entry per session file: { ts: epoch seconds, count: msg lines }.
   *  Frontend buckets ts into local-day boxes for the grid. */
  getMessageHeatmap: () =>
    invoke<{ ts: number; count: number }[]>('get_message_heatmap'),
  readNativeSession: (filePath: string) => invoke<string>('read_native_session', { filePath }),
  readOpencodeSession: (sessionId: string) =>
    invoke<string>('read_opencode_session', { sessionId }),
  tierTerminalResume: (sessionId: string, savedSessionId: string, tool: string, sessionToken: string, cols: number, rows: number, cwd: string) =>
    invoke<void>('tier_terminal_resume', { sessionId, savedSessionId, tool, sessionToken, cols, rows, cwd }),
  checkNetworkPort: (host: string, port: number) => invoke<boolean>('check_network_port', { host, port }),

  // Tool availability detection
  checkToolsInstalled: () =>
    invoke<Record<string, boolean>>('check_tools_installed'),

  /** Static list of tools registered in the Rust src/tools/ registry —
   *  one entry per supported AI CLI with the canonical display name.
   *  Loaded once at app boot and cached; see `lib/tool-info.ts`. */
  listTools: () => invoke<{ id: string; displayName: string }[]>('list_tools'),

  /** Install hook scripts + upstream config patches for one tool.
   *  Call when the focus-rescan detects a CLI flipped to installed —
   *  picks up tab status indicators without forcing a Coffee CLI
   *  restart. No-op for tools the hook installer doesn't manage. */
  installHookForTool: (tool: string) =>
    invoke<void>('install_hook_for_tool', { tool }),

  /** Gambit — save a clipboard-pasted image to a temp file and return its path.
   *  The returned absolute path is inserted into the textarea so the AI CLI agent
   *  (Claude Code, etc.) can read the image via the local filesystem. */
  saveClipboardImage: (dataBase64: string, extension: string) =>
    invoke<string>('save_clipboard_image', { dataBase64, extension }),

  listDirectory: (path: string) => invoke<DirEntryInfo[]>('list_directory', { path }),

  // Workspace file diff — global per-file baseline keyed by absolute
  // path, shared across every tab and project the user opens during
  // this Coffee CLI process. First-seen wins: re-running
  // startFolderSnapshot for an already-baselined file is a no-op so
  // the original audit-log baseline is preserved across tab close /
  // reopen. Process exit clears everything. No git, no .git/, works
  // in any folder.
  startFolderSnapshot: (path: string) =>
    invoke<void>('start_folder_snapshot', { path }),
  // Diff panel inputs: baseline = the file's bytes when Coffee CLI
  // first observed it during this process lifetime; current = the
  // file's bytes now. Both lossy-UTF8 decoded so GBK / latin-1 source
  // files still render. `null` = file missing / binary / never seen.
  getBaselineContent: (path: string) =>
    invoke<string | null>('get_baseline_content', { path }),
  readTextFile: (path: string) =>
    invoke<string | null>('read_text_file', { path }),

  // File system operations
  fsDelete: (path: string) => invoke<void>('fs_delete', { path }),
  fsRename: (path: string, newName: string) => invoke<void>('fs_rename', { path, newName }),
  fsPaste: (action: string, srcPath: string, targetDir: string) =>
    invoke<void>('fs_paste', { action, srcPath, targetDir }),
  showInFolder: (path: string) => invoke<void>('show_in_folder', { path }),

  // ── Skills (Coffee CLI skill store, junctioned into ~/.claude/skills + ~/.codex/skills) ──
  // Frontend does HTTP fetch (no Rust HTTP dep), pipes bytes here.
  skillsEnsureDirs: () => invoke<void>('skills_ensure_dirs'),
  skillsWriteFile: (name: string, relPath: string, bytes: number[] | Uint8Array) =>
    invoke<void>('skills_write_file', { name, relPath, bytes: Array.from(bytes) }),
  skillsList: () => invoke<{ name: string; enabled: boolean; skillMd: string | null; iconDataUrl: string | null }[]>('skills_list'),
  skillsToggle: (name: string, enable: boolean) =>
    invoke<void>('skills_toggle', { name, enable }),
  skillsDelete: (name: string) => invoke<void>('skills_delete', { name }),

  // Task Board persistence (~/.coffee-cli/tasks.json)
  loadTasks: () => invoke<string>('load_tasks'),
  saveTasks: (data: string) => invoke<void>('save_tasks', { data }),

  // Credential store — passwords live in OS keychain, never in localStorage
  savePassword: (host: string, username: string, password: string) =>
    invoke<void>('save_password', { host, username, password }),
  loadPassword: (host: string, username: string) =>
    invoke<string | null>('load_password', { host, username }),
  deletePassword: (host: string, username: string) =>
    invoke<void>('delete_password', { host, username }),
  openUrl: (url: string) =>
    invoke<void>('open_url', { url }),

  // Live fs watcher — subscribes to OS-native events under `path` and
  // emits `fs-refresh` Tauri events that Explorer already listens for.
  // Calling start with a new path implicitly replaces the previous watcher.
  startFsWatcher: (path: string) =>
    invoke<void>('start_fs_watcher', { path }),
  stopFsWatcher: () =>
    invoke<void>('stop_fs_watcher'),

  // Multi-agent mode — post-v1.5 this is a thin handshake. The backend
  // creates per-pane MCP servers + per-pane CLI artifacts (Claude
  // mcp.json / Codex instructions.md / Gemini extension stub) lazily
  // when each pane spawns its CLI inside `tier_terminal_start`. No
  // workspace files are written and no global ~/.codex / ~/.gemini
  // entries are injected, so there's nothing to "install" or
  // "uninstall" at this layer. The call is kept as the structured
  // place for the backend to surface preflight warnings and for future
  // cross-cutting validation.
  enableMultiAgentMode: (workspace: string, tools: string[]) =>
    invoke<{ ok: boolean; warnings: string[] }>(
      'enable_multi_agent_mode',
      { workspace, tools },
    ),
  disableMultiAgentMode: (workspace: string) =>
    invoke<{ ok: boolean; warnings: string[] }>(
      'disable_multi_agent_mode',
      { workspace },
    ),

  // ─── Hyper-Agent (cross-tab admin MCP for OpenClaw / Hermes Agent) ──
  startHyperAgentServer: () =>
    invoke<HyperAgentStatus>('start_hyper_agent_server'),
  getHyperAgentEndpoint: () =>
    invoke<McpEndpoint | null>('get_hyper_agent_endpoint'),

  // ─── Per-tool launch overrides (~/.coffee-cli/tools.json) ───────────
  getToolConfig: (tool: string) =>
    invoke<ToolConfigEntry>('get_tool_config', { tool }),
  getAllToolConfigs: () =>
    invoke<Record<string, ToolConfigEntry>>('get_all_tool_configs'),
  setToolConfig: (tool: string, entry: ToolConfigEntry) =>
    invoke<void>('set_tool_config', { tool, entry }),
};

export interface McpEndpoint {
  url: string;
  port: number;
  pid: number;
  started_at: number;
}

interface HyperAgentStatus {
  endpoint: McpEndpoint;
}

/**
 * One entry in `~/.coffee-cli/tools.json`. All fields are optional —
 * empty strings / empty arrays fall through to Coffee CLI's built-in
 * defaults for that tool. Lets users say things like "my hermes is at
 * `wsl ~/.local/bin/hermes`" or "always launch claude with
 * --dangerously-skip-permissions" without us having to auto-detect
 * every conceivable install path.
 */
export interface ToolConfigEntry {
  /** Full launch command. Whitespace-split — first token is the binary,
   *  the rest are prepended to args. Empty falls through to default. */
  command: string;
  /** Args appended AFTER the built-in args (so tool-managed flags like
   *  --mcp-config / --append-system-prompt still come first). */
  extra_args: string[];
  /** Pre-fills the cwd selector when starting a new tab. Empty falls
   *  through to the launchpad's last-used cwd. */
  default_cwd: string;
  /** Custom directory to scan for this tool's session history files.
   *  Empty falls through to the built-in scan path. */
  history_path: string;
}
