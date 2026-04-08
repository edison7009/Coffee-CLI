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

export interface ModelConfig {
  name: string;
  model_id: string;
  base_url: string;
  /** true when an API key is present in models.json */
  configured: boolean;
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

  loadModel: () => invoke<ModelConfig>('get_model'),

  // Window decorators
  windowMinimize: () => invoke<void>('window_minimize'),
  windowMaximize: () => invoke<void>('window_maximize'),
  windowClose: () => invoke<void>('window_close'),

  // Git Status
  getGitStatus: () =>
    invoke<GitStatusResponse | null>('get_git_status'),

  // Tier Terminal API
  tierTerminalStart: (sessionId: string, tool: string | null, cols: number, rows: number, themeMode: string, locale?: string, toolData?: string) => 
    invoke<void>('tier_terminal_start', { sessionId, tool, toolData: toolData ?? null, cols, rows, themeMode, locale: locale ?? null }),
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
  getResumableSessions: () => invoke<SavedSession[]>('get_resumable_sessions'),
  tierTerminalResume: (sessionId: string, savedSessionId: string, tool: string, sessionToken: string, cols: number, rows: number) =>
    invoke<void>('tier_terminal_resume', { sessionId, savedSessionId, tool, sessionToken, cols, rows }),

  // Translation
  setTranslationLang: (lang: string) => invoke<void>('set_translation_lang', { lang }),
  getTranslationEntries: (tool: string, lang: string) =>
    invoke<[string, string][]>('get_translation_entries', { tool, lang }),

  // Tool availability detection
  checkToolsInstalled: () => invoke<Record<string, boolean>>('check_tools_installed'),

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

  // Task Board persistence (~/.coffee-cli/tasks.json)
  loadTasks: () => invoke<string>('load_tasks'),
  saveTasks: (data: string) => invoke<void>('save_tasks', { data }),

  // Multi-window: detach tab into new window
  createDetachedWindow: (sessionId: string, tool: string, toolData?: string) =>
    invoke<void>('create_detached_window', { sessionId, tool, toolData }),

  // Multi-window: replay terminal history for detached window
  getTerminalBuffer: (sessionId: string) =>
    invoke<string[]>('get_terminal_buffer', { sessionId }),
};
