// Coffee CLI — Global App State (React Context)

import { createContext, useContext, useLayoutEffect, useReducer, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { isConversationSession, supportsEnhancedTool } from '../lib/chat-tools';
import { supportsAdditionalAgentStatus } from '../lib/terminal-agent-status';
import { insertSessionSplit, removeSessionSplit, replaceSplitSession, splitSessionIds, setSessionSplitRatio, type SessionSplitLayout, type SplitEdge } from '../lib/session-split-layout';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolType = 'claude' | 'qwen' | 'hermes' | 'opencode' | 'mimocode' | 'kilo' | 'openclaw' | 'codex' | 'grok' | 'antigravity' | 'pi' | 'crush' | 'aider' | 'kimicode' | 'goose' | 'copilot' | 'cursor' | 'cline' | 'omp' | 'codebuddy' | 'muse' | 'kiro' | 'minimax' | 'terminal' | 'remote' | null;
export type ClaudeMode = 'conversation' | 'terminal';

/**
 * Tab status shown as an animated 9-dot glyph. Three states only —
 * Native OSC titles and verified rendered-screen semantics drive this state
 * for enhanced integrations.
 *
 *   idle       — ready for input (green Wave-Double)
 *   working    — LLM generating / tool call in flight (orange Snake-CW)
 *   wait_input — permission prompt blocking, user must confirm (blue Ripple)
 *
 * CSS classes are `status-idle / -working / -waiting`
 * (the `wait_input → waiting` rename happens at render time).
 */
export type AgentStatus = 'idle' | 'working' | 'wait_input';

/** True only when the upstream CLI exposes authoritative state via OSC title. */
export function supportsNativeAgentStatus(tool: ToolType): boolean {
  return tool === 'claude' || tool === 'codex' || tool === 'omp';
}

/** OpenCode v2's process-local adapter and native titles can report status
 * without a conversation view or rendered-screen interaction parser. */
export function supportsAgentStatus(tool: ToolType): boolean {
  return tool === 'opencode' || supportsNativeAgentStatus(tool) || supportsEnhancedTool(tool) || supportsAdditionalAgentStatus(tool);
}

// Theme: color palette family (orthogonal to shape and to mode).
// 6 hues × 2 depths. The mid-depth row that shipped in v3.5.4 was dropped
// again — it read as a duplicate of its soft/deep neighbours (see
// RETIRED_THEMES for where a saved pick from that row lands now).
export type ThemeColor =
  | 'dark' | 'light' | 'sakura' | 'lavender' | 'mint'
  | 'obsidian' | 'moss'
  | 'amber' | 'teal' | 'indigo'
  | 'glacier' | 'slate';
// Theme: which half of that family's palette to paint. 'system' follows the OS
// light/dark preference live (App.tsx watches prefers-color-scheme), so the
// centre tabs in Settings ▸ Appearance is purely a view of this value.
export type ThemeMode = 'light' | 'dark' | 'system';
// Theme: shape form (orthogonal to color)
// Frost reuses the full glass chrome; only the frosted backdrop layer differs
// (see isFrostShape + [data-frost] CSS). App.tsx normalizes it to
// data-shape="glass" so every [data-shape="glass"] rule applies unchanged.
export type ThemeShape =
  | 'soft' | 'slab' | 'sharp' | 'glass'
  | 'frost'
  | 'panel' | 'carbon' | 'monogram' | 'characters';
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

export interface TerminalSession {
  id: string;
  tool: ToolType;
  toolData?: string;  // Extra context for the tool (e.g. SSH connection JSON for remote)
  claudeMode?: ClaudeMode;
  codexMode?: ClaudeMode;
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
  strictCwd?: boolean;
  parentId?: string;
  isHidden?: boolean;
  agentStatus?: AgentStatus;
  gambitDraft?: string;    // Unsent textarea content, preserved across tab switches
  /** Local launch timestamp used to reject older history files when binding
   *  a live conversation to this terminal tab. */
  startedAt?: number;
}

// ─── State Shape ─────────────────────────────────────────────────────────────

export type AgentPage = 'agent' | 'config';

export interface AppState {
  // UI
  currentTheme: ThemeColor;
  themeMode: ThemeMode;
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
  sessionSplit: SessionSplitLayout | null;
  agentPages: AgentPage[];
  agentPageActive: AgentPage | null;
  tabOrder: string[];

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
  usageOpen: boolean;
  toolSettingsOpen: boolean;
}

/// Snapshot of the file the user clicked in ChangesBoard, plus the folderPath
/// of the terminal tab that was active when they clicked — enough for DiffPanel
/// to render on either surface without re-resolving against a live terminal.
export interface DiffSelection {
  repoRoot: string;
  folderPath: string;   // active terminal tab's cwd at snapshot time (tab title only)
  path: string;         // absolute on-disk path
  rel: string;          // repo-relative path for git specs
  kind: 'uncommitted' | 'untracked' | 'committed' | 'file';
  fileSize?: number;    // Explorer's size hint, before reading a file preview
  commitHash?: string;
  added?: number;
  deleted?: number;
}

// ─── Diff context resolver ──────────────────────────────────────────────────
// File panels follow the real session focused in either single or split view.
interface DiffContext {
  sessionId: string;
  folderPath: string;
  tool: ToolType;
}

export function resolveDiffContext(session: TerminalSession | null | undefined): DiffContext | null {
  if (!session?.tool) return null;
  if (!session.folderPath) return null;
  return { sessionId: session.id, folderPath: session.folderPath, tool: session.tool };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type Action =
  | { type: 'SET_USAGE_OPEN'; open: boolean }
  | { type: 'SET_TOOL_SETTINGS_OPEN'; open: boolean }
  | { type: 'SET_FOLDER'; path: string }
  | { type: 'SET_TERMINAL_CWD'; id: string; path: string }
  | { type: 'CLEAR_FOLDER' }
  | { type: 'SET_THEME'; theme: ThemeColor }
  | { type: 'SET_THEME_MODE'; mode: ThemeMode }
  | { type: 'SET_SHAPE'; shape: ThemeShape }
  | { type: 'SET_ICON_THEME'; theme: IconTheme }
  | { type: 'SET_LANG'; lang: string }
  | { type: 'ADD_TERMINAL'; session: TerminalSession; split?: { targetId: string; edge: SplitEdge } }
  | { type: 'OPEN_SESSION_SPLIT'; id: string; targetId: string; edge: SplitEdge }
  | { type: 'CLOSE_SESSION_SPLIT'; id: string }
  | { type: 'RESIZE_SESSION_SPLIT'; path: string; ratio: number }
  | { type: 'LAUNCH_TERMINAL_TOOL'; id: string; tool: ToolType; cwd?: string; toolData?: string; resumeToken?: string; strictCwd?: boolean; claudeMode?: ClaudeMode; codexMode?: ClaudeMode; parentId?: string; background?: boolean }
  | { type: 'REMOVE_TERMINAL'; id: string }
  | { type: 'REORDER_TAB'; tabId: string; beforeId: string | null }
  | { type: 'SET_ACTIVE_TERMINAL'; id: string | null }
  | { type: 'SET_TERMINAL_TOOL'; id: string; tool: ToolType; toolData?: string; resumeToken?: string; claudeMode?: ClaudeMode; codexMode?: ClaudeMode }
  | { type: 'SET_TERMINAL_HIDDEN'; id: string; isHidden: boolean }
  | { type: 'RESTART_TERMINAL'; id: string; newId: string }
  | { type: 'OPEN_HYPER_AGENT_TAB' }
  | { type: 'SET_AGENT_STATUS'; id: string; status: AgentStatus | undefined }
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
  | { type: 'SET_SESSION_TOKEN'; id: string; token: string }
  | { type: 'TOGGLE_LEFT_PANEL' }
  | { type: 'TOGGLE_RIGHT_PANEL' }
  | { type: 'SET_TASK_VIEW_MODE'; mode: 'list' | 'note' | 'prompt' }
  | { type: 'SET_TAB_TITLE'; id: string; title: string }
  | { type: 'SET_DIFF_SELECTION'; selection: DiffSelection }
  | { type: 'CLEAR_DIFF' }
  | { type: 'SET_DIFF_MODE'; mode: 'overlay' | 'tab' }
  | { type: 'SET_DIFF_TAB_ACTIVE'; active: boolean }
  | { type: 'OPEN_AGENT_PAGE'; page: AgentPage }
  | { type: 'CLOSE_AGENT_PAGE'; page: AgentPage };

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function getTabOrder(state: Pick<AppState, 'terminals' | 'agentPages' | 'tabOrder'>): string[] {
  const ids = [...state.terminals.map(tab => tab.id), ...state.agentPages.map(page => `agent:${page}`)];
  const saved = (state.tabOrder ?? []).filter(id => ids.includes(id));
  return [...saved, ...ids.filter(id => !saved.includes(id))];
}

function splitForSession(state: AppState, id: string, targetId: string, edge: SplitEdge) {
  const target = state.terminals.find(session => session.id === targetId);
  if (!target?.tool) return null;
  const layout = splitSessionIds(state.sessionSplit).includes(targetId)
    ? state.sessionSplit! : { type: 'leaf' as const, sessionId: targetId };
  return insertSessionSplit(layout, targetId, id, edge);
}

function reducer(state: AppState, action: Action): AppState {
  if ((state.usageOpen || state.toolSettingsOpen) && !(action.type === 'LAUNCH_TERMINAL_TOOL' && action.background) && ['ADD_TERMINAL', 'LAUNCH_TERMINAL_TOOL', 'SET_ACTIVE_TERMINAL', 'OPEN_AGENT_PAGE', 'OPEN_SESSION_SPLIT', 'SET_DIFF_SELECTION', 'SET_DIFF_TAB_ACTIVE'].includes(action.type)) state = { ...state, usageOpen: false, toolSettingsOpen: false };
  switch (action.type) {
    case 'SET_USAGE_OPEN':
      return { ...state, usageOpen: action.open, toolSettingsOpen: false };
    case 'SET_TOOL_SETTINGS_OPEN':
      return { ...state, toolSettingsOpen: action.open, usageOpen: false };
    case 'OPEN_SESSION_SPLIT': {
      const session = state.terminals.find(session => session.id === action.id);
      if (!session?.tool) return state;
      const layout = splitForSession(state, action.id, action.targetId, action.edge);
      if (!layout || !splitSessionIds(layout).includes(action.id)) return state;
      return { ...state, sessionSplit: layout, activeTerminalId: action.id, agentPageActive: null, diffTabActive: false,
        terminals: session.isHidden ? state.terminals.map(t => t.id === session.id ? { ...t, isHidden: false } : t) : state.terminals };
    }
    case 'CLOSE_SESSION_SPLIT': {
      if (!splitSessionIds(state.sessionSplit).includes(action.id)) return state;
      const layout = removeSessionSplit(state.sessionSplit, action.id);
      return { ...state, sessionSplit: layout,
        activeTerminalId: state.activeTerminalId === action.id ? splitSessionIds(layout)[0] ?? state.activeTerminalId : state.activeTerminalId };
    }
    case 'RESIZE_SESSION_SPLIT':
      return { ...state, sessionSplit: setSessionSplitRatio(state.sessionSplit, action.path, action.ratio) };
    case 'SET_TERMINAL_CWD': {
      let changed = false;
      const terminals = state.terminals.map(t => {
        if (t.id === action.id && t.folderPath !== action.path) {
          changed = true;
          return { ...t, folderPath: action.path };
        }
        return t;
      });
      if (!changed) return state;
      if (action.id === state.activeTerminalId) {
        try { localStorage.setItem('cc-folder', action.path); } catch { /* Best-effort operation; failure is non-fatal. */ }
      }
      return { ...state, terminals };
    }
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
    case 'SET_THEME_MODE':
      return { ...state, themeMode: action.mode };
    case 'SET_SHAPE':
      return { ...state, currentShape: action.shape };
    case 'SET_ICON_THEME':
      return { ...state, iconTheme: action.theme };
    case 'SET_LANG':
      return { ...state, currentLang: action.lang };
    case 'ADD_TERMINAL': {
      // Resolve against current state so rapid history clicks cannot start
      // multiple writers for the same native conversation.
      const existing = action.session.resumeToken && state.terminals.find(t =>
        t.tool === action.session.tool && t.resumeToken === action.session.resumeToken);
      const layout = action.split ? splitForSession(state, existing ? existing.id : action.session.id, action.split.targetId, action.split.edge) : null;
      // A stale drop or full layout must not launch an invisible second writer.
      if (action.split && (!layout || !splitSessionIds(layout).includes(existing ? existing.id : action.session.id))) return state;
      if (existing) return {
        ...state,
        sessionSplit: action.split ? layout : state.sessionSplit,
        terminals: existing.isHidden ? state.terminals.map(t => t.id === existing.id ? { ...t, isHidden: false } : t) : state.terminals,
        activeTerminalId: existing.id,
        agentPageActive: null,
        diffTabActive: false,
      };
      const session = action.session.tool && !action.session.startedAt
        ? { ...action.session, startedAt: Date.now() }
        : action.session;
      return { 
        ...state, 
        sessionSplit: action.split ? layout : state.sessionSplit,
        terminals: [...state.terminals, session],
        tabOrder: [...getTabOrder(state), session.id],
        activeTerminalId: session.id,
        agentPageActive: null,
        diffTabActive: false,
      };
    }
    case 'LAUNCH_TERMINAL_TOOL': {
      const previous = state.terminals.find(tab => tab.id === action.id);
      const session: TerminalSession = {
        ...previous, id: action.id, tool: action.tool,
        folderPath: action.cwd ?? previous?.folderPath ?? null,
        toolData: action.toolData, resumeToken: action.resumeToken, strictCwd: action.strictCwd,
        parentId: action.parentId,
        claudeMode: action.tool === 'claude' ? action.claudeMode ?? 'conversation' : undefined,
        codexMode: action.tool === 'codex' ? action.codexMode ?? 'terminal' : undefined,
        toolTitle: undefined, agentStatus: undefined, startedAt: Date.now(),
      };
      if (action.cwd) {
        try { localStorage.setItem('cc-folder', action.cwd); } catch { /* Best-effort operation; failure is non-fatal. */ }
      }
      const order = getTabOrder(state);
      const family = state.terminals.filter(tab => tab.id === action.parentId || tab.parentId === action.parentId).map(tab => order.indexOf(tab.id));
      const index = action.parentId && family.length ? Math.max(...family) + 1 : order.length;
      return {
        ...state,
        terminals: previous ? state.terminals.map(tab => tab.id === action.id ? session : tab) : [...state.terminals, session],
        tabOrder: previous ? state.tabOrder : [...order.slice(0, index), action.id, ...order.slice(index)],
        activeTerminalId: action.background ? state.activeTerminalId : action.id,
        agentPageActive: action.background ? state.agentPageActive : null,
        diffTabActive: action.background ? state.diffTabActive : false,
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
         // The tool selector has no visible tab; prefer another real session.
         newActiveId = (newTerminals.filter(session => session.tool !== null).at(-1) ?? newTerminals[newTerminals.length - 1]).id;
      }
      const layout = removeSessionSplit(state.sessionSplit, action.id);
      if (state.activeTerminalId === action.id && splitSessionIds(layout).length) newActiveId = splitSessionIds(layout)[0];
      return { ...state, sessionSplit: layout, terminals: newTerminals, activeTerminalId: newActiveId, tabOrder: getTabOrder(state).filter(id => id !== action.id) };
    }
    case 'REORDER_TAB': {
      // Terminal and Agent pages share one strip. Keep terminal order in
      // sync so Agent session numbers still follow the displayed tabs.
      const order = getTabOrder(state);
      if (!order.includes(action.tabId)) return state;
      const without = order.filter(id => id !== action.tabId);
      const insertIdx = action.beforeId
        ? without.indexOf(action.beforeId)
        : without.length;
      if (insertIdx < 0) return state;
      const next = [...without.slice(0, insertIdx), action.tabId, ...without.slice(insertIdx)];
      if (next.every((id, i) => id === order[i])) return state;
      return {
        ...state, tabOrder: next,
        terminals: [...state.terminals].sort((a, b) => next.indexOf(a.id) - next.indexOf(b.id)),
        agentPages: [...state.agentPages].sort((a, b) => next.indexOf(`agent:${a}`) - next.indexOf(`agent:${b}`)),
      };
    }
    case 'SET_ACTIVE_TERMINAL':
      // Activating a terminal tab blurs the diff tab (they're peer tabs in
      // the strip; only one is focused at a time). diffMode is untouched —
      // the diff still renders in its chosen surface, just not focused.
      return { ...state, activeTerminalId: action.id, diffTabActive: false, agentPageActive: null };
    case 'SET_TERMINAL_TOOL':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, tool: action.tool, claudeMode: action.tool === 'claude' ? action.claudeMode ?? 'conversation' : undefined, codexMode: action.tool === 'codex' ? action.codexMode ?? 'terminal' : undefined, toolData: action.toolData, resumeToken: action.resumeToken, toolTitle: undefined, agentStatus: undefined, startedAt: Date.now() } : t)
      };
    case 'SET_TERMINAL_HIDDEN':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, isHidden: action.isHidden } : t)
      };
    case 'RESTART_TERMINAL':
      return {
        ...state,
        sessionSplit: replaceSplitSession(state.sessionSplit, action.id, action.newId),
        terminals: state.terminals.map(t =>
          t.id === action.id ? { ...t, id: action.newId, toolTitle: undefined, agentStatus: undefined, startedAt: Date.now() } : t
        ),
        tabOrder: getTabOrder(state).map(id => id === action.id ? action.newId : id),
        activeTerminalId: state.activeTerminalId === action.id ? action.newId : state.activeTerminalId
      };
    case 'SET_AGENT_STATUS': {
      // Native titles and rendered-screen spinners can both emit frequent
      // activity frames. Equal states must not re-render the app.
      let changed = false;
      const terminals = state.terminals.map(t => {
        if (t.id === action.id && supportsAgentStatus(t.tool) && t.agentStatus !== action.status) {
          changed = true; return { ...t, agentStatus: action.status };
        }
        return t;
      });
      return changed ? { ...state, terminals } : state;
    }
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
      if (!state.agentPageActive && !state.diffTabActive && isConversationSession(state.terminals.find(t => t.id === state.activeTerminalId))) return state;
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
    case 'SET_SESSION_TOKEN':
      return { ...state, terminals: state.terminals.map(t => t.id === action.id && t.resumeToken !== action.token ? { ...t, resumeToken: action.token } : t) };
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
        rightPanelHidden: state.diffMode === 'overlay' ? false : state.rightPanelHidden,
        agentPageActive: state.diffMode === 'tab' ? null : state.agentPageActive,
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
      return { ...state, diffMode: action.mode, rightPanelHidden: action.mode === 'overlay' ? false : state.rightPanelHidden, diffTabActive: action.mode === 'tab', agentPageActive: action.mode === 'tab' ? null : state.agentPageActive };
    }
    case 'SET_DIFF_TAB_ACTIVE':
      return { ...state, diffTabActive: action.active, agentPageActive: action.active ? null : state.agentPageActive };
    case 'OPEN_AGENT_PAGE':
      return {
        ...state,
        agentPages: state.agentPages.includes(action.page) ? state.agentPages : [...state.agentPages, action.page],
        tabOrder: state.agentPages.includes(action.page) ? state.tabOrder : [...getTabOrder(state), `agent:${action.page}`],
        agentPageActive: action.page, diffTabActive: false,
      };
    case 'CLOSE_AGENT_PAGE': {
      const agentPages = state.agentPages.filter(page => page !== action.page);
      return { ...state, agentPages, tabOrder: getTabOrder(state).filter(id => id !== `agent:${action.page}`), agentPageActive: state.agentPageActive === action.page ? agentPages.at(-1) ?? null : state.agentPageActive };
    }
    default:
      return state;
  }
}

// ─── Initial State ────────────────────────────────────────────────────────────

const VALID_THEMES: ThemeColor[] = [
  'dark', 'light', 'sakura', 'lavender', 'mint',
  'obsidian', 'moss',
  'amber', 'teal', 'indigo',
  'glacier', 'slate',
];
// Palettes the picker no longer offers because their row was redundant. A
// saved pick from that row moves to its own column's deep neighbour, which
// keeps the hue the user chose (代码夜 → 黑曜石, 钴蓝 → 靛蓝, …) instead of
// dumping them on the default theme.
const RETIRED_THEMES: Record<string, ThemeColor> = {
  cappuccino: 'obsidian',
  crimson: 'slate',
  sunset: 'dark',
  emerald: 'moss',
  cobalt: 'indigo',
  fuchsia: 'teal',
};
const VALID_THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];
const VALID_SHAPES: ThemeShape[] = [
  'soft', 'slab', 'sharp', 'glass',
  'frost',
  'panel', 'carbon', 'monogram', 'characters',
];
const VALID_ICON_THEMES: IconTheme[] = [
  'outline', 'material', 'vscode-icons', 'catppuccin-mocha',
  'devicon', 'fluent', 'symbols', 'coffee',
];

function getInitialState(): AppState {
  // Keep theme/shape defaults in sync with index.html's pre-paint script.
  // Saved preferences take priority for returning users.
  let theme: ThemeColor = 'obsidian';
  let themeMode: ThemeMode = 'dark';
  let shape: ThemeShape = 'characters';
  let iconTheme: IconTheme = 'devicon';
  let lang = 'zh-CN';
  let folderPath: string | null = null;

  try {
    const savedTheme = localStorage.getItem('cc-theme');
    if (savedTheme && VALID_THEMES.includes(savedTheme as ThemeColor)) {
      theme = savedTheme as ThemeColor;
    } else if (savedTheme && RETIRED_THEMES[savedTheme]) {
      theme = RETIRED_THEMES[savedTheme];
      localStorage.setItem('cc-theme', theme);
    }
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  // Mode is new in v3.5.4. Users who predate it are migrated from their saved
  // theme: the one light palette we used to ship ('light') means they were on
  // the day half of that family, everyone else was on a night palette. Reading
  // 'cc-theme' before 'cc-mode' matters here — without the migration a saved
  // 'light' pick would silently turn into the new night-only 石墨 palette.
  try {
    const savedMode = localStorage.getItem('cc-mode') as ThemeMode | null;
    if (savedMode && VALID_THEME_MODES.includes(savedMode)) themeMode = savedMode;
    else themeMode = theme === 'light' ? 'light' : 'dark';
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
  let titlebarToggleDisplay: TitlebarToggleDisplay = 'icon';
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
  // Default 'note' (big sticky-note view) — the welcome guide + the whole
  // task-board UX are tuned for it. A saved pref in localStorage (written by
  // the SET_TASK_VIEW_MODE toggle) still wins for returning users. Previously
  // 'list', only flipped to 'note' by the TaskBoard first-launch seed — which
  // was fragile (cleared localStorage or a removed seed fell back to list).
  let taskViewMode: 'list' | 'note' | 'prompt' = 'note';
  // Default 'overlay' (the gentle half-height panel) — existing users see no
  // change. Only flips to 'tab' if the user explicitly expanded-to-tab before.
  let diffMode: 'overlay' | 'tab' = 'overlay';
  // Gambit starts closed unless the user saved an open preference.
  let gambitOpen = false;
  try {
    leftPanelHidden = localStorage.getItem('cc-left-hidden') === '1';
    rightPanelHidden = localStorage.getItem('cc-right-hidden') === '1';
    const savedTaskView = localStorage.getItem('cc-task-view');
    if (savedTaskView === 'list' || savedTaskView === 'note' || savedTaskView === 'prompt') taskViewMode = savedTaskView;
    const savedDiffMode = localStorage.getItem('cc-diff-mode');
    if (savedDiffMode === 'tab' || savedDiffMode === 'overlay') diffMode = savedDiffMode;
    gambitOpen = localStorage.getItem('cc-gambit-open') === '1';
  } catch { /* Best-effort operation; failure is non-fatal. */ }

  return {
    currentTheme: theme,
    themeMode,
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
    sessionSplit: null,
    gambitOpen,
    settingsOpen: false,
    gambitEnterToSend,
    hotkeyScheme,
    titlebarToggleDisplay,
    leftPanelHidden,
    rightPanelHidden,
    taskViewMode,
    diffSelection: null,
    diffMode,
    diffTabActive: false,
    usageOpen: false,
    toolSettingsOpen: false,
    agentPages: [],
    agentPageActive: null,
    tabOrder: [defaultTerminalId],
  };
}

// ─── Context ─────────────────────────────────────────────────────────────────
//
// Keep dispatch, event-time state reads, and translations independent of the
// full state subscription so hidden terminals and conversations can stay memoized.

const StateRefContext = createContext<RefObject<AppState> | null>(null);
const LanguageContext = createContext<string | null>(null);
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
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; }, [state]);
  // The combined-context value has to be recomputed whenever state changes,
  // so keeping the split contexts lets hot components subscribe only to the
  // half they care about.
  const combined = { state, dispatch };
  return (
    <DispatchContext.Provider value={dispatch}>
      <StateRefContext.Provider value={stateRef}>
        <LanguageContext.Provider value={state.currentLang}>
          <AppContext.Provider value={combined}>
            {children}
          </AppContext.Provider>
        </LanguageContext.Provider>
      </StateRefContext.Provider>
    </DispatchContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be inside AppProvider');
  return ctx;
}

/** Latest committed state for event handlers; does not subscribe to renders. */
export function useAppStateRef(): RefObject<AppState> {
  const ref = useContext(StateRefContext);
  if (!ref) throw new Error('useAppStateRef must be inside AppProvider');
  return ref;
}

export function useAppLanguage(): string {
  const lang = useContext(LanguageContext);
  if (lang === null) throw new Error('useAppLanguage must be inside AppProvider');
  return lang;
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
