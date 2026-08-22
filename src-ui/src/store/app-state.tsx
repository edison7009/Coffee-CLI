// Coffee CLI — Global App State (React Context)

import { createContext, useContext, useReducer } from 'react';
import type { ReactNode } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolType = 'claude' | 'qwen' | 'installer' | 'hermes' | 'opencode' | 'mimocode' | 'kilo' | 'openclaw' | 'codex' | 'grok' | 'antigravity' | 'pi' | 'crush' | 'aider' | 'kimicode' | 'goose' | 'copilot' | 'cursor' | 'cline' | 'omp' | 'terminal' | 'remote' | 'two-split' | 'three-split' | 'four-split' | null;

/**
 * Tab status shown as an animated 9-dot glyph. Three states only —
 * Native OSC titles and the rendered-screen semantic parser can drive this
 * state. The screen parser covers tools that do not expose a title protocol.
 *
 *   idle       — ready for input (green Wave-Double)
 *   working    — LLM generating / tool call in flight (orange Snake-CCW)
 *   wait_input — permission prompt blocking, user must confirm (blue Ripple)
 *
 * CSS classes are `status-idle / -working / -waiting`
 * (the `wait_input → waiting` rename happens at render time).
 */
export type AgentStatus = 'idle' | 'working' | 'wait_input';

/** True only when the upstream CLI exposes authoritative state via OSC title. */
export function supportsNativeAgentStatus(tool: ToolType): boolean {
  return tool === 'claude' || tool === 'codex' || tool === 'grok';
}

/** Tools whose live TUI screen has a source-verified status/interaction
 * grammar. Native-title tools stay in this set because screen interactions
 * (especially permission prompts) are more precise than their coarse title. */
export function supportsAgentStatus(tool: ToolType): boolean {
  return supportsNativeAgentStatus(tool)
    || tool === 'opencode'
    || tool === 'mimocode'
    || tool === 'kilo'
    || tool === 'pi'
    || tool === 'omp'
    || tool === 'kimicode';
}

// Theme: color palette (orthogonal to shape)
export type ThemeColor =
  | 'dark' | 'light' | 'cappuccino' | 'sakura' | 'lavender' | 'mint'
  | 'obsidian' | 'cobalt' | 'moss'
  // Vibrant batch — saturated accents on tinted-dark bases (crimson is the
  // Spider-Man hero, intended to pair with the carbon shape).
  | 'crimson' | 'sunset' | 'amber' | 'emerald' | 'teal' | 'indigo' | 'fuchsia';
// Theme: shape form (orthogonal to color)
// Frost reuses the full glass chrome; only the frosted backdrop layer differs
// (see isFrostShape + [data-frost] CSS). App.tsx normalizes it to
// data-shape="glass" so every [data-shape="glass"] rule applies unchanged.
export type ThemeShape =
  | 'soft' | 'slab' | 'sharp' | 'glass'
  | 'frost'
  | 'panel' | 'carbon' | 'monogram';
// Icon theme: visual style for file/folder icons in the explorer.
// 8 themes, each with genuinely distinct folder silhouette + file icon style.
// Fetched upstream (6): material, vscode-icons, catppuccin-mocha, devicon, fluent, symbols
// Self-authored (2): outline (line-frame), coffee (Coffee CLI brand)
export type IconTheme =
  | 'outline' | 'material' | 'vscode-icons' | 'catppuccin-mocha'
  | 'devicon' | 'fluent' | 'symbols' | 'coffee';

// Unified one-hand hotkey SCHEME for the three chrome toggles — left panel,
// Gambit (妙手), right panel — on three adjacent keys. The user picks one of
// four presets in Settings → 妙手; default Alt+QWE. Each scheme is a single
// modifier + three keys mapped left/gambit/right, so a whole hand rests on the
// row. We match on `e.code` (physical key) because Alt on macOS rewrites
// `e.key` into the typed glyph (œ/∑/´) — only the code is stable — and every
// handler preventDefaults to cancel that glyph AND stop the combo reaching a
// focused terminal. Ctrl+QWE is offered but collides with core terminal editing
// (Ctrl+W/E/Q); it's opt-in, same "you chose it" contract as the old alt-*.
// Literal `Ctrl`/`Alt` (not ⌃/⌥) for the mass-market audience.
export const HOTKEY_SCHEMES = [
  { code: 'alt-qwe',  mod: 'Alt',  modifier: 'alt',
    keys: { left: { key: 'Q', eventCode: 'KeyQ' }, gambit: { key: 'W', eventCode: 'KeyW' }, right: { key: 'E', eventCode: 'KeyE' } } },
  { code: 'ctrl-qwe', mod: 'Ctrl', modifier: 'ctrl',
    keys: { left: { key: 'Q', eventCode: 'KeyQ' }, gambit: { key: 'W', eventCode: 'KeyW' }, right: { key: 'E', eventCode: 'KeyE' } } },
  { code: 'alt-123',  mod: 'Alt',  modifier: 'alt',
    keys: { left: { key: '1', eventCode: 'Digit1' }, gambit: { key: '2', eventCode: 'Digit2' }, right: { key: '3', eventCode: 'Digit3' } } },
  { code: 'ctrl-123', mod: 'Ctrl', modifier: 'ctrl',
    keys: { left: { key: '1', eventCode: 'Digit1' }, gambit: { key: '2', eventCode: 'Digit2' }, right: { key: '3', eventCode: 'Digit3' } } },
] as const;

export type HotkeyScheme = typeof HOTKEY_SCHEMES[number]['code'];
export type HotkeyAction = 'left' | 'gambit' | 'right';

// How the titlebar's three panel toggles (left / Gambit / right) render:
// 'icon-hotkey' = icon + shortcut hint (default); 'icon' = icon only;
// 'hidden' = hide the toggles entirely (keyboard-only — Alt+Q/W/E still work).
export type TitlebarToggleDisplay = 'icon-hotkey' | 'icon' | 'hidden';

// Which chrome toggle a keydown maps to under the active scheme, or null. The
// caller MUST then preventDefault (cancels the macOS Alt-glyph + the control
// byte) AND stopPropagation (keeps the combo out of xterm's own keydown).
// metaKey is always rejected (macOS Cmd stays a system key); the modifier must
// match EXACTLY (an Alt-scheme ignores Ctrl-held combos and vice-versa) so the
// other modifier's shortcuts pass through untouched.
export function matchHotkeyScheme(e: KeyboardEvent, scheme: HotkeyScheme): HotkeyAction | null {
  const s = HOTKEY_SCHEMES.find(h => h.code === scheme) ?? HOTKEY_SCHEMES[0];
  if (e.metaKey) return null;
  const modOk = s.modifier === 'ctrl' ? (e.ctrlKey && !e.altKey) : (e.altKey && !e.ctrlKey);
  if (!modOk) return null;
  if (e.code === s.keys.left.eventCode) return 'left';
  if (e.code === s.keys.gambit.eventCode) return 'gambit';
  if (e.code === s.keys.right.eventCode) return 'right';
  return null;
}

// The three display combos for a scheme, e.g. { left: 'Alt + Q', gambit: 'Alt + W', right: 'Alt + E' }.
export function schemeLabels(scheme: HotkeyScheme): Record<HotkeyAction, string> {
  const s = HOTKEY_SCHEMES.find(h => h.code === scheme) ?? HOTKEY_SCHEMES[0];
  return {
    left: `${s.mod} + ${s.keys.left.key}`,
    gambit: `${s.mod} + ${s.keys.gambit.key}`,
    right: `${s.mod} + ${s.keys.right.key}`,
  };
}

/// One pane inside a multi-agent Tab. `paneIdx` is 1-indexed (1..4)
/// matching the user-visible badge and the MCP session id suffix —
/// sessionId = `${tabId}::pane-${paneIdx}`. The Rust MCP server's
/// list_panes returns the same ids, so when the user says "pane 2"
/// a CLI's MCP call can target it verbatim.
export interface MultiAgentPane {
  paneIdx: number;
  tool: ToolType;
  toolData?: string;
  agentStatus?: AgentStatus;
  // Per-pane working directory. Only used by the four-split (independent quad) tab
  // where each pane can run in its own project. Multi-agent panes ignore this
  // and use the tab-level folderPath (all 4 panes share one workspace because
  // they coordinate via MCP against that workspace's config).
  folderPath?: string | null;
  // Sentinel Protocol (opt-in per pane). When true, TierTerminal scans the
  // PTY output stream of this pane for the marker `[COFFEE-DONE:pane<N>]`
  // that the user instructs their agent to emit on task completion. On a
  // match, completionTs is set to Date.now() — the pane number badge
  // renders a small green dot while the timestamp is fresh.
  sentinelEnabled?: boolean;
  completionTs?: number;
}

/// State attached to a Tab with `tool === 'multi-agent'`. All four panes
/// are peers — there is no primary/worker distinction — so this type is
/// deliberately minimal. Each pane's CLI and toolData live on
/// `MultiAgentPane`; focus tracking happens inside `<MultiAgentGrid/>`.
interface MultiAgentState {
  panes: MultiAgentPane[];
  // Independent split (`*-split`) only: which pane the user last focused.
  // Drives left Explorer + right Changes target — without it the file panels
  // can't tell which pane's project they should reflect. Multi-agent tabs
  // (`*-agent`, shared folder) ignore this field.
  focusedPaneIdx?: number | null;
}

export interface TerminalSession {
  id: string;
  tool: ToolType;
  toolData?: string;  // Extra context for the tool (e.g. SSH connection JSON for remote)
  folderPath: string | null;
  /// Live terminal title set by the tool via OSC 0/2 (e.g. Claude Code's
  /// conversation summary). When set, the tab shows this instead of the cwd
  /// basename — matching how other terminals display the tool's own title.
  toolTitle?: string;
  restartKey?: number;
  /// When set, this tab was opened from a history "Continue this session"
  /// action. TierTerminal's mount effect passes it to tierTerminalStart,
  /// which spawns the tool with its `--resume <token>` flag instead of a
  /// fresh launch. Cleared on any subsequent SET_TERMINAL_TOOL.
  resumeToken?: string;
  isHidden?: boolean;
  agentStatus?: AgentStatus;
  gambitDraft?: string;    // Unsent textarea content, preserved across tab switches
  /** Per-tab center surface. The PTY stays mounted while chat is visible so
   *  switching views never interrupts the running CLI or loses output. */
  viewMode?: 'terminal' | 'chat';
  /** Optimistic prompt shown before the CLI has flushed it to native history. */
  chatPending?: { text: string; sentAt: number };
  /** Local launch timestamp used to reject older history files when binding
   *  a live conversation to this terminal tab. */
  startedAt?: number;
  /// When present, this Tab renders as a 2×2+ pane grid instead of a
  /// single terminal. See docs/MULTI-AGENT-ARCHITECTURE.md §5.7 and §7.
  multiAgent?: MultiAgentState;
}

// ─── State Shape ─────────────────────────────────────────────────────────────

export interface AppState {
  // UI
  currentTheme: ThemeColor;
  currentShape: ThemeShape;
  currentLang: string;
  iconTheme: IconTheme;

  // Background wallpaper
  bgPath: string;
  bgType: 'image' | 'video' | 'none';
  // Wallpaper image opacity, 0-100 (percent). 100 = fully visible, 0 =
  // fully transparent (image not visible). Default 70 — leaves the
  // theme's base color partially visible underneath so foreground text
  // stays legible on busy wallpapers without a black overlay (the
  // overlay was the previous design and clashed with themed colors).
  wallpaperOpacity: number;

  // Terminal foreground color override ('' = use theme default)
  termColorScheme: string;
  // Terminal font family override ('' = bundled CascadiaMono + fallbacks)
  termFont: string;
  // Default shell id for new terminal tabs ('' = Auto / platform fallback).
  // Resolved to a concrete program at spawn time on the Rust side. See
  // src/shell_probe.rs and SettingsModal's shell picker.
  defaultShell: string;

  // Terminals
  terminals: TerminalSession[];
  activeTerminalId: string | null;

  // Gambit (global floating compose window). Visibility is app-wide so the
  // panel doesn't appear/disappear when switching tabs; only the draft is
  // per-tab (stored on TerminalSession.gambitDraft).
  gambitOpen: boolean;

  // Personalization settings modal (opened by the titlebar gear). App-level
  // so the titlebar gear and the App-mounted modal share one flag.
  settingsOpen: boolean;

  // Gambit compose-box send key. true → Enter sends (Shift/Ctrl/Cmd+Enter =
  // newline); false → Ctrl/Cmd+Enter sends (Enter = newline). Chosen in the
  // settings modal because the muscle-memory split is per-user / per-OS.
  gambitEnterToSend: boolean;

  // Unified hotkey scheme (settings → 妙手): one of HOTKEY_SCHEMES, driving the
  // three chrome toggles — left panel / Gambit / right panel — via a global
  // capture-phase listener in ActiveGambit.
  hotkeyScheme: HotkeyScheme;
  // How the titlebar's three panel toggles render (icon+hotkey / icon / hidden).
  titlebarToggleDisplay: TitlebarToggleDisplay;

  // IDE-style layout toggles driven from titlebar controls.
  // Default both panels visible — matches first-time user expectation.
  leftPanelHidden: boolean;
  rightPanelHidden: boolean;

  // Multi-agent pane arrangement. 'grid' = 2×2 quadrant (default),
  // 'columns' = 1×4 vertical strip. Only takes effect inside a tab
  // whose tool is 'multi-agent'; other tabs ignore it.
  multiAgentLayout: 'grid' | 'columns';

  // Right-panel task board form. 'list' = compact to-do checklist (default),
  // 'note' = big sticky-note cards (traffic-light status + timestamp + roomy
  // text area). Same task data either way — purely a presentation choice made
  // in the settings modal. Default 'list' so existing users see no change.
  taskViewMode: 'list' | 'note' | 'prompt';

  // ── Diff view (修改记录 → click a file) ─────────────────────────────────
  // The right-side Changes tab shows a half-height bottom overlay (DiffPanel)
  // when a file is selected. The user can "expand" that diff — historically a
  // full-screen portal modal that blocked the agent terminal behind it. That
  // is replaced by a center **diff tab** (peer of the Claude/Codex terminal
  // tabs): `diffMode` selects which surface the open diff renders on.
  //   'overlay' = right-bottom half-height (default; existing behavior)
  //   'tab'     = center tab, full panel area
  // `diffSelection` carries the snapshot needed to render the diff on either
  // surface. It is snapshotted from the active terminal tab's folderPath +
  // the clicked file row at selection time, because a diff tab is not a
  // terminal and has no own folderPath to dynamically resolveDiffContext.
  // Persisted preference in `cc-diff-mode`; the selection itself is NOT
  // persisted (it depends on files open at the time).
  diffSelection: DiffSelection | null;
  diffMode: 'overlay' | 'tab';
  /// True while the center diff tab is the active surface (clicked in the tab
  /// strip). Clicking any terminal tab clears it (folded into SET_ACTIVE_TERMINAL).
  /// Lets the diff tab coexist in the strip with terminal tabs the user can
  /// switch back to, without diffMode flipping (mode = which surface the diff
  /// renders on; this = which tab is focused right now).
  diffTabActive: boolean;
}

/// Snapshot of the file the user clicked in ChangesBoard, plus the folderPath
/// of the terminal tab that was active when they clicked — enough for DiffPanel
/// to render on either surface without re-resolving against a live terminal.
export interface DiffSelection {
  repoRoot: string;
  folderPath: string;   // active terminal tab's cwd at snapshot time (tab title only)
  path: string;         // absolute on-disk path
  rel: string;          // repo-relative path for git specs
  kind: 'uncommitted' | 'untracked' | 'committed';
  commitHash?: string;
  added?: number;
  deleted?: number;
}

// ─── Tab tool predicates ────────────────────────────────────────────────────

const SPLIT_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['two-split', 'three-split', 'four-split']);
export const isSplitTool = (t: ToolType): boolean => SPLIT_TOOLS.has(t);

// `kind` is a backend protocol contract: `::pane-N` triggers hands-free flag
// injection (yolo / skip-permissions) for coordinated multi-agent; `::split-N`
// leaves them off so each pane prompts as a normal interactive PTY.
export const paneSessionId = (tabId: string, paneIdx: number, kind: 'split' | 'pane'): string =>
  `${tabId}::${kind}-${paneIdx}`;

// ─── Diff context resolver ──────────────────────────────────────────────────
// Split tabs route file-stats to the focused pane's own session+folder.
// Multi-agent and regular tabs use the tab itself. `null` = no diff target.
interface DiffContext {
  sessionId: string;
  folderPath: string;
  tool: ToolType;
}

export function resolveDiffContext(session: TerminalSession | null | undefined): DiffContext | null {
  if (!session) return null;
  if (isSplitTool(session.tool)) {
    const focusedIdx = session.multiAgent?.focusedPaneIdx ?? null;
    if (focusedIdx == null) return null;
    const pane = session.multiAgent?.panes.find(p => p.paneIdx === focusedIdx);
    if (!pane?.tool || !pane.folderPath) return null;
    return {
      sessionId: paneSessionId(session.id, pane.paneIdx, 'split'),
      folderPath: pane.folderPath,
      tool: pane.tool,
    };
  }
  if (!session.folderPath) return null;
  return { sessionId: session.id, folderPath: session.folderPath, tool: session.tool };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type Action =
  | { type: 'SET_FOLDER'; path: string }
  | { type: 'CLEAR_FOLDER' }
  | { type: 'SET_THEME'; theme: ThemeColor }
  | { type: 'SET_SHAPE'; shape: ThemeShape }
  | { type: 'SET_ICON_THEME'; theme: IconTheme }
  | { type: 'SET_LANG'; lang: string }
  | { type: 'ADD_TERMINAL'; session: TerminalSession }
  | { type: 'REMOVE_TERMINAL'; id: string }
  | { type: 'REORDER_TERMINAL'; sessionId: string; beforeId: string | null }
  | { type: 'SET_ACTIVE_TERMINAL'; id: string | null }
  | { type: 'SET_TERMINAL_TOOL'; id: string; tool: ToolType; toolData?: string; resumeToken?: string }
  | { type: 'SET_TERMINAL_HIDDEN'; id: string; isHidden: boolean }
  | { type: 'RESTART_TERMINAL'; id: string; newId: string }
  | { type: 'OPEN_HYPER_AGENT_TAB' }
  | { type: 'SET_AGENT_STATUS'; id: string; status: AgentStatus }
  | { type: 'SET_BG'; path: string; bgType: 'image' | 'video' }
  | { type: 'CLEAR_BG' }
  | { type: 'SET_WALLPAPER_OPACITY'; opacity: number }
  | { type: 'SET_TERM_SCHEME'; scheme: string }
  | { type: 'SET_TERM_FONT'; font: string }
  | { type: 'SET_DEFAULT_SHELL'; shell: string }
  | { type: 'TOGGLE_GAMBIT' }
  | { type: 'TOGGLE_SETTINGS' }
  | { type: 'SET_SETTINGS_OPEN'; open: boolean }
  | { type: 'SET_GAMBIT_ENTER_TO_SEND'; value: boolean }
  | { type: 'SET_HOTKEY_SCHEME'; value: HotkeyScheme }
  | { type: 'SET_TITLEBAR_TOGGLE_DISPLAY'; value: TitlebarToggleDisplay }
  | { type: 'SET_GAMBIT_DRAFT'; id: string; draft: string }
  | { type: 'APPEND_GAMBIT_DRAFT'; id: string; text: string }
  | { type: 'SET_SESSION_VIEW'; id: string; viewMode: 'terminal' | 'chat' }
  | { type: 'SET_CHAT_PENDING'; id: string; pending?: { text: string; sentAt: number } }
  | { type: 'SET_PANE_TOOL'; tabId: string; paneIdx: number; tool: ToolType; toolData?: string; folderPath?: string | null }
  | { type: 'SET_PANE_SENTINEL'; tabId: string; paneIdx: number; enabled: boolean }
  | { type: 'SET_PANE_COMPLETION'; tabId: string; paneIdx: number; ts: number }
  | { type: 'SET_FOCUSED_PANE'; tabId: string; paneIdx: number | null }
  | { type: 'TOGGLE_LEFT_PANEL' }
  | { type: 'TOGGLE_RIGHT_PANEL' }
  | { type: 'SET_MULTI_AGENT_LAYOUT'; layout: 'grid' | 'columns' }
  | { type: 'SET_TASK_VIEW_MODE'; mode: 'list' | 'note' | 'prompt' }
  | { type: 'SET_TAB_TITLE'; id: string; title: string }
  | { type: 'SET_DIFF_SELECTION'; selection: DiffSelection }
  | { type: 'CLEAR_DIFF' }
  | { type: 'SET_DIFF_MODE'; mode: 'overlay' | 'tab' }
  | { type: 'SET_DIFF_TAB_ACTIVE'; active: boolean };

// ─── Reducer ─────────────────────────────────────────────────────────────────

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_FOLDER':
      // Persist as the "last folder" so a fresh launch lands here instead
      // of the C-drive default. Read back in getInitialState().
      try { localStorage.setItem('cc-folder', action.path); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === state.activeTerminalId ? { ...t, folderPath: action.path } : t)
      };
    case 'CLEAR_FOLDER':
      try { localStorage.removeItem('cc-folder'); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === state.activeTerminalId ? { ...t, folderPath: null } : t)
      };
    case 'SET_TAB_TITLE':
      // OSC 0/2 title from the tool (xterm onTitleChange). Skip if the session
      // is gone (late dispatch after dispose) or unchanged (onTitleChange can
      // fire frequently) — both avoid a redundant CenterPanel re-render.
      if (!state.terminals.some(t => t.id === action.id)) return state;
      if (state.terminals.some(t => t.id === action.id && t.toolTitle === action.title)) return state;
      return { ...state, terminals: state.terminals.map(t => t.id === action.id ? { ...t, toolTitle: action.title } : t) };
    case 'SET_THEME':
      return { ...state, currentTheme: action.theme };
    case 'SET_SHAPE':
      return { ...state, currentShape: action.shape };
    case 'SET_ICON_THEME':
      return { ...state, iconTheme: action.theme };
    case 'SET_LANG':
      return { ...state, currentLang: action.lang };
    case 'ADD_TERMINAL': {
      const session = action.session.tool && !action.session.startedAt
        ? { ...action.session, startedAt: Date.now() }
        : action.session;
      return { 
        ...state, 
        terminals: [...state.terminals, session],
        activeTerminalId: session.id
      };
    }
    case 'REMOVE_TERMINAL': {
      let newTerminals = state.terminals.filter(t => t.id !== action.id);
      let newActiveId = state.activeTerminalId;
      
      if (newTerminals.length === 0) {
        const defaultId = crypto.randomUUID();
        const folderPath = state.terminals.length > 0 ? state.terminals[0].folderPath : null;
        newTerminals = [{ id: defaultId, tool: null, folderPath }];
        newActiveId = defaultId;
      } else if (state.activeTerminalId === action.id) {
         newActiveId = newTerminals[newTerminals.length - 1].id;
      }
      return { ...state, terminals: newTerminals, activeTerminalId: newActiveId };
    }
    case 'REORDER_TERMINAL': {
      // Move `sessionId`'s tab so that it sits immediately before
      // `beforeId` in the array. `beforeId === null` means "drop at end".
      // Used by browser-style tab reordering: pointer-down a tab, drag
      // horizontally, drop wherever you want it. CenterPanel does the
      // pixel-math; the reducer just handles the array surgery.
      const t = state.terminals;
      const fromIdx = t.findIndex(x => x.id === action.sessionId);
      if (fromIdx < 0) return state;
      const without = t.filter(x => x.id !== action.sessionId);
      const insertIdx = action.beforeId
        ? without.findIndex(x => x.id === action.beforeId)
        : without.length;
      if (insertIdx < 0) return state;
      const moved = t[fromIdx];
      const next = [...without.slice(0, insertIdx), moved, ...without.slice(insertIdx)];
      // No-op detection: skip dispatch round-trip when the order didn't
      // actually change (e.g., user dragged 1px and dropped, or dropped
      // back into the same gap).
      if (next.every((x, i) => x.id === t[i].id)) return state;
      return { ...state, terminals: next };
    }
    case 'SET_ACTIVE_TERMINAL':
      // Activating a terminal tab blurs the diff tab (they're peer tabs in
      // the strip; only one is focused at a time). diffMode is untouched —
      // the diff still renders in its chosen surface, just not focused.
      return { ...state, activeTerminalId: action.id, diffTabActive: false };
    case 'SET_TERMINAL_TOOL':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, tool: action.tool, toolData: action.toolData, resumeToken: action.resumeToken, toolTitle: undefined, agentStatus: undefined, viewMode: 'terminal', chatPending: undefined, startedAt: Date.now() } : t)
      };
    case 'SET_TERMINAL_HIDDEN':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, isHidden: action.isHidden } : t)
      };
    case 'RESTART_TERMINAL':
      return {
        ...state,
        terminals: state.terminals.map(t =>
          t.id === action.id ? { ...t, id: action.newId, toolTitle: undefined, agentStatus: undefined, chatPending: undefined, startedAt: Date.now() } : t
        ),
        activeTerminalId: state.activeTerminalId === action.id ? action.newId : state.activeTerminalId
      };
    case 'SET_AGENT_STATUS':
      // Native titles and rendered-screen spinners can both emit frequent
      // activity frames. Equal states must not re-render the app.
      if (!state.terminals.some(t => t.id === action.id && supportsAgentStatus(t.tool))) return state;
      if (state.terminals.some(t => t.id === action.id && t.agentStatus === action.status)) return state;
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, agentStatus: action.status } : t)
      };
    case 'SET_BG':
      return { ...state, bgPath: action.path, bgType: action.bgType };
    case 'CLEAR_BG':
      return { ...state, bgPath: '', bgType: 'none' };
    case 'SET_WALLPAPER_OPACITY':
      return { ...state, wallpaperOpacity: Math.max(0, Math.min(100, action.opacity)) };
    case 'SET_TERM_SCHEME':
      return { ...state, termColorScheme: action.scheme };
    case 'SET_TERM_FONT':
      return { ...state, termFont: action.font };
    case 'SET_DEFAULT_SHELL':
      return { ...state, defaultShell: action.shell };
    case 'TOGGLE_GAMBIT':
      return { ...state, gambitOpen: !state.gambitOpen };
    case 'TOGGLE_SETTINGS':
      return { ...state, settingsOpen: !state.settingsOpen };
    case 'SET_SETTINGS_OPEN':
      return { ...state, settingsOpen: action.open };
    case 'SET_GAMBIT_ENTER_TO_SEND':
      return { ...state, gambitEnterToSend: action.value };
    case 'SET_HOTKEY_SCHEME':
      return { ...state, hotkeyScheme: action.value };
    case 'SET_TITLEBAR_TOGGLE_DISPLAY':
      return { ...state, titlebarToggleDisplay: action.value };
    case 'SET_GAMBIT_DRAFT':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, gambitDraft: action.draft } : t)
      };
    case 'APPEND_GAMBIT_DRAFT':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id
          ? { ...t, gambitDraft: `${t.gambitDraft ?? ''}${action.text}` }
          : t),
      };
    case 'SET_SESSION_VIEW':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, viewMode: action.viewMode } : t),
      };
    case 'SET_CHAT_PENDING':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, chatPending: action.pending } : t),
      };
    case 'SET_PANE_TOOL': {
      // Seed a MultiAgentState lazily on the first pane selection so
      // quadrant tabs don't need a separate enable-step — point of entry
      // is the user clicking a CLI button in any empty pane slot.
      return {
        ...state,
        terminals: state.terminals.map(t => {
          if (t.id !== action.tabId) return t;
          const existing = t.multiAgent?.panes
            ?? ([1, 2, 3, 4].map(i => ({ paneIdx: i, tool: null as ToolType })) as MultiAgentPane[]);
          const panes = existing.map(p =>
            p.paneIdx === action.paneIdx
              ? {
                  ...p,
                  tool: action.tool,
                  toolData: action.toolData,
                  // Only overwrite folderPath when the action explicitly
                  // carries one. Clearing a pane (tool=null without folderPath)
                  // wipes the pane back to empty state, so we also null out
                  // the stored folder to avoid ghost state.
                  folderPath: action.folderPath !== undefined
                    ? action.folderPath
                    : (action.tool === null ? null : p.folderPath),
                }
              : p
          );
          return { ...t, multiAgent: { ...t.multiAgent, panes } };
        }),
      };
    }
    case 'SET_PANE_SENTINEL': {
      return {
        ...state,
        terminals: state.terminals.map(t => {
          if (t.id !== action.tabId) return t;
          const existing = t.multiAgent?.panes
            ?? ([1, 2, 3, 4].map(i => ({ paneIdx: i, tool: null as ToolType })) as MultiAgentPane[]);
          const panes = existing.map(p =>
            p.paneIdx === action.paneIdx ? { ...p, sentinelEnabled: action.enabled } : p
          );
          return { ...t, multiAgent: { ...t.multiAgent, panes } };
        }),
      };
    }
    case 'SET_PANE_COMPLETION': {
      return {
        ...state,
        terminals: state.terminals.map(t => {
          if (t.id !== action.tabId) return t;
          if (!t.multiAgent) return t;
          const panes = t.multiAgent.panes.map(p =>
            p.paneIdx === action.paneIdx ? { ...p, completionTs: action.ts } : p
          );
          return { ...t, multiAgent: { ...t.multiAgent, panes } };
        }),
      };
    }
    case 'SET_FOCUSED_PANE': {
      const tab = state.terminals.find(t => t.id === action.tabId);
      if (!tab) return state;
      if ((tab.multiAgent?.focusedPaneIdx ?? null) === action.paneIdx) return state;
      return {
        ...state,
        terminals: state.terminals.map(t => {
          if (t.id !== action.tabId) return t;
          const ma = t.multiAgent
            ?? { panes: [1, 2, 3, 4].map(i => ({ paneIdx: i, tool: null as ToolType })) as MultiAgentPane[] };
          return { ...t, multiAgent: { ...ma, focusedPaneIdx: action.paneIdx } };
        }),
      };
    }
    case 'TOGGLE_LEFT_PANEL': {
      const next = !state.leftPanelHidden;
      try { localStorage.setItem('cc-left-hidden', next ? '1' : '0'); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return { ...state, leftPanelHidden: next };
    }
    case 'TOGGLE_RIGHT_PANEL': {
      const next = !state.rightPanelHidden;
      try { localStorage.setItem('cc-right-hidden', next ? '1' : '0'); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return { ...state, rightPanelHidden: next };
    }
    case 'SET_MULTI_AGENT_LAYOUT': {
      try { localStorage.setItem('cc-ma-layout', action.layout); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return { ...state, multiAgentLayout: action.layout };
    }
    case 'SET_TASK_VIEW_MODE': {
      try { localStorage.setItem('cc-task-view', action.mode); } catch { /* Best-effort operation; failure is non-fatal. */ }
      return { ...state, taskViewMode: action.mode };
    }
    case 'SET_DIFF_SELECTION':
      // In tab mode, selecting a file focuses the diff tab immediately (the
      // user's pref is the center surface, so a click should show it there,
      // not just park an unfocused tab in the strip). Overlay mode leaves
      // diffTabActive alone — the overlay renders regardless of focus.
      return {
        ...state,
        diffSelection: action.selection,
        diffTabActive: state.diffMode === 'tab' ? true : state.diffTabActive,
      };
    case 'CLEAR_DIFF':
      // Dropping the selection also folds the diff tab: a tab only renders
      // while diffMode==='tab' && diffSelection. Clearing here covers both
      // the tab's close button and the overlay's close button.
      return { ...state, diffSelection: null, diffTabActive: false };
    case 'SET_DIFF_MODE': {
      try { localStorage.setItem('cc-diff-mode', action.mode); } catch { /* Best-effort operation; failure is non-fatal. */ }
      // Entering tab mode focuses the diff tab; leaving blurs it. Keeps the
      // active-surface tracking in lockstep with the surface the diff is on.
      return { ...state, diffMode: action.mode, diffTabActive: action.mode === 'tab' };
    }
    case 'SET_DIFF_TAB_ACTIVE':
      return { ...state, diffTabActive: action.active };
    default:
      return state;
  }
}

// ─── Initial State ────────────────────────────────────────────────────────────

const VALID_THEMES: ThemeColor[] = [
  'dark', 'light', 'cappuccino', 'sakura', 'lavender', 'mint',
  'obsidian', 'cobalt', 'moss',
  'crimson', 'sunset', 'amber', 'emerald', 'teal', 'indigo', 'fuchsia',
];
const VALID_SHAPES: ThemeShape[] = [
  'soft', 'slab', 'sharp', 'glass',
  'frost',
  'panel', 'carbon', 'monogram',
];
const VALID_ICON_THEMES: IconTheme[] = [
  'outline', 'material', 'vscode-icons', 'catppuccin-mocha',
  'devicon', 'fluent', 'symbols', 'coffee',
];

function getInitialState(): AppState {
  // Default 'obsidian' + 'panel' — the "严谨高级简约" out-of-box. Carbon's
  // hex-mesh + translucent chrome is polarizing (love-it-or-hate-it); obsidian
  // (#0a0a0a near-black, neutral, no hue tint) + panel (sharp 0-radius corners,
  // strong 2px borders) reads as a flat, restrained developer-tool aesthetic
  // that a broader 70% find acceptable vs carbon's 50/50 split. Panel is also
  // simpler than carbon (no mask/backdrop-filter/:not() nuclear rule), so less
  // to render-break across edge cases. KEEP index.html's pre-paint default in
  // sync with these two values or first paint flashes (obsidian/panel → React
  // hydrate). Existing users keep their saved theme/shape (localStorage wins).
  let theme: ThemeColor = 'obsidian';
  let shape: ThemeShape = 'panel';
  let iconTheme: IconTheme = 'devicon';
  let lang = 'zh-CN';
  let folderPath: string | null = null;

  try {
    const savedTheme = localStorage.getItem('cc-theme') as ThemeColor | null;
    if (savedTheme && VALID_THEMES.includes(savedTheme)) theme = savedTheme;
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  try {
    const savedShape = localStorage.getItem('cc-shape');
    if (savedShape === 'flower') {
      shape = 'monogram';
      localStorage.setItem('cc-shape', shape);
    } else if (savedShape === 'frost-deep' || savedShape === 'frost-ios') {
      // The 3 Frost variants were collapsed into a single 'frost' shape
      // (2026-08-05). Old picks migrate forward; the new one carries the
      // Apple-tuned frosted backdrop.
      shape = 'frost';
      localStorage.setItem('cc-shape', shape);
    } else if (savedShape && VALID_SHAPES.includes(savedShape as ThemeShape)) {
      shape = savedShape as ThemeShape;
    }
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  try {
    const savedIconTheme = localStorage.getItem('cc-icon-theme') as IconTheme | null;
    if (savedIconTheme && VALID_ICON_THEMES.includes(savedIconTheme)) iconTheme = savedIconTheme;
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  try { folderPath = localStorage.getItem('cc-folder'); } catch { /* Best-effort operation; failure is non-fatal. */ }

  try {
    const savedLang = localStorage.getItem('cc-lang');
    if (savedLang) lang = savedLang;
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  // No factory-default wallpaper — the bundled /wallpapers/default.png
  // didn't load reliably across platforms (Linux WebKit asset URL
  // resolution diverges from Windows/macOS WebView2/WKWebView), so a
  // chunk of new users saw a black panel and assumed wallpaper was
  // broken. Default is now an empty wallpaper; users who want one pick
  // their own via the theme menu.
  let bgPath = '';
  let bgType: 'image' | 'video' | 'none' = 'none';
  let termColorScheme = '';
  let termFont = '';
  let defaultShell = '';
  let wallpaperOpacity = 70;
  // Default Enter-to-send; only opt-out if the user explicitly stored 'false'.
  let gambitEnterToSend = true;
  // Default hotkey scheme = Alt+QWE (left=Q / Gambit=W / right=E) — one-hand
  // ergonomics + a memorable, purpose-built feel. matchHotkeyScheme + each
  // handler's preventDefault cancel the macOS Alt dead-key glyphs (œ/∑/´). The
  // Ctrl+QWE preset is opt-in despite clashing with terminal Ctrl+W/E/Q.
  // Overridden only by a stored valid scheme.
  let hotkeyScheme: HotkeyScheme = 'alt-qwe';
  let titlebarToggleDisplay: TitlebarToggleDisplay = 'icon-hotkey';
  try {
    const storedPath = localStorage.getItem('cc-bg-path');
    const storedType = localStorage.getItem('cc-bg-type') as 'image' | 'video' | 'none' | null;

    // Migration: clear legacy seeded /wallpapers/default.png from
    // existing installs so they don't keep trying to load a file we
    // no longer ship. Anything else (user-picked) is preserved.
    if (storedPath && storedPath.startsWith('/wallpapers/')) {
      bgPath = '';
      bgType = 'none';
      try {
        localStorage.removeItem('cc-bg-path');
        localStorage.removeItem('cc-bg-type');
        localStorage.removeItem('cc-bg-init');
      } catch { /* Best-effort operation; failure is non-fatal. */ }
    } else {
      bgPath = storedPath || '';
      bgType = storedType || 'none';
    }

    termColorScheme = localStorage.getItem('cc-term-scheme') || '';
    termFont = localStorage.getItem('cc-term-font') || '';
    defaultShell = localStorage.getItem('cc-default-shell') || '';
    gambitEnterToSend = localStorage.getItem('cc-gambit-enter-send') !== 'false';
    const storedScheme = localStorage.getItem('cc-hotkey-scheme');
    if (storedScheme && HOTKEY_SCHEMES.some(h => h.code === storedScheme)) {
      hotkeyScheme = storedScheme as HotkeyScheme;
    }
    const storedTtd = localStorage.getItem('cc-titlebar-toggle-display');
    if (storedTtd === 'icon-hotkey' || storedTtd === 'icon' || storedTtd === 'hidden') {
      titlebarToggleDisplay = storedTtd;
    }
    // New key (post-refactor): wallpaper opacity, 0-100, larger = more
    // visible. Old key was `cc-wallpaper-dim` (0-80, larger = darker
    // overlay). On first load after upgrade, fall back to the legacy
    // key with `opacity ≈ 100 - dim` so the user's perceived brightness
    // stays close to what they had set, then write the new key.
    const savedOpacity = localStorage.getItem('cc-wallpaper-opacity');
    if (savedOpacity !== null) {
      const n = parseInt(savedOpacity, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 100) wallpaperOpacity = n;
    } else {
      const savedDim = localStorage.getItem('cc-wallpaper-dim');
      if (savedDim !== null) {
        const n = parseInt(savedDim, 10);
        if (!Number.isNaN(n) && n >= 0 && n <= 80) {
          wallpaperOpacity = Math.max(0, Math.min(100, 100 - n));
        }
        try { localStorage.removeItem('cc-wallpaper-dim'); } catch { /* Best-effort operation; failure is non-fatal. */ }
      }
    }
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  const defaultTerminalId = crypto.randomUUID();

  let leftPanelHidden = false;
  let rightPanelHidden = false;
  let multiAgentLayout: 'grid' | 'columns' = 'grid';
  // Default 'note' (big sticky-note view) — the welcome guide + the whole
  // task-board UX are tuned for it. A saved pref in localStorage (written by
  // the SET_TASK_VIEW_MODE toggle) still wins for returning users. Previously
  // 'list', only flipped to 'note' by the TaskBoard first-launch seed — which
  // was fragile (cleared localStorage or a removed seed fell back to list).
  let taskViewMode: 'list' | 'note' | 'prompt' = 'note';
  // Default 'overlay' (the gentle half-height panel) — existing users see no
  // change. Only flips to 'tab' if the user explicitly expanded-to-tab before.
  let diffMode: 'overlay' | 'tab' = 'overlay';
  // Gambit (compose box) opens by default on launch; the user's open/close
  // choice persists via cc-gambit-open. NOT force-opened when an agent starts
  // (that was a v3.3.9 mistake, reverted).
  let gambitOpen = true;
  try {
    leftPanelHidden = localStorage.getItem('cc-left-hidden') === '1';
    rightPanelHidden = localStorage.getItem('cc-right-hidden') === '1';
    const savedLayout = localStorage.getItem('cc-ma-layout');
    if (savedLayout === 'columns' || savedLayout === 'grid') multiAgentLayout = savedLayout;
    const savedTaskView = localStorage.getItem('cc-task-view');
    if (savedTaskView === 'list' || savedTaskView === 'note' || savedTaskView === 'prompt') taskViewMode = savedTaskView;
    const savedDiffMode = localStorage.getItem('cc-diff-mode');
    if (savedDiffMode === 'tab' || savedDiffMode === 'overlay') diffMode = savedDiffMode;
    gambitOpen = localStorage.getItem('cc-gambit-open') !== '0';
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  return {
    currentTheme: theme,
    currentShape: shape,
    iconTheme,
    currentLang: lang,
    bgPath,
    bgType,
    wallpaperOpacity,
    termColorScheme,
    termFont,
    defaultShell,
    terminals: [{ id: defaultTerminalId, tool: null, folderPath }],
    activeTerminalId: defaultTerminalId,
    gambitOpen,
    settingsOpen: false,
    gambitEnterToSend,
    hotkeyScheme,
    titlebarToggleDisplay,
    leftPanelHidden,
    rightPanelHidden,
    multiAgentLayout,
    taskViewMode,
    diffSelection: null,
    diffMode,
    diffTabActive: false,
  };
}

// ─── Context ─────────────────────────────────────────────────────────────────
//
// Two separate contexts so components that only need to dispatch (not read
// state) don't get re-rendered on every state change. This is what lets the
// React.memo'd TierTerminal skip re-renders when unrelated state updates fire.

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<React.Dispatch<Action> | null>(null);

// Kept for backward compatibility with existing consumers that read both
// state and dispatch from a single hook. New code should prefer the split
// hooks below.
const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);
  // The combined-context value has to be recomputed whenever state changes,
  // so keeping the split contexts lets hot components subscribe only to the
  // half they care about.
  const combined = { state, dispatch };
  return (
    <DispatchContext.Provider value={dispatch}>
      <StateContext.Provider value={state}>
        <AppContext.Provider value={combined}>
          {children}
        </AppContext.Provider>
      </StateContext.Provider>
    </DispatchContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be inside AppProvider');
  return ctx;
}

/**
 * Dispatch-only hook for components that don't need to read state.
 *
 * Components using this hook do NOT re-render when state changes — the
 * DispatchContext value (the dispatch function itself) is stable across
 * every render, so useContext never triggers a subscription update.
 *
 * Use this in any hot-path component (e.g. TierTerminal) that reads all of
 * its state via props and only needs to call dispatch() in event handlers.
 */
export function useAppDispatch(): React.Dispatch<Action> {
  const ctx = useContext(DispatchContext);
  if (!ctx) throw new Error('useAppDispatch must be inside AppProvider');
  return ctx;
}
