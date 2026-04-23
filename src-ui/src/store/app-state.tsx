// Coffee CLI — Global App State (React Context)

import { createContext, useContext, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { ScanResult } from '../tauri';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolType = 'claude' | 'qwen' | 'installer' | 'hermes' | 'opencode' | 'codex' | 'gemini' | 'agent' | 'arcade' | 'terminal' | 'remote' | 'history' | 'vibeid' | 'insights_prerun' | 'multi-agent' | null;

/**
 * Tab status shown as an animated 9-dot glyph. Maps to CSS classes
 * `status-idle / -thinking / -executing / -waiting / -compacting / -error`
 * (note the CSS class name for `wait_input` is `waiting` — translated at render).
 *
 *   idle        — ready for input (green Wave-Double)
 *   thinking    — LLM generating text, no tool call yet (orange Wave-Pulse)
 *   executing   — tool call in flight (orange Snake-CCW)
 *   wait_input  — permission prompt or ask-tool blocking (blue Ripple)
 *   compacting  — PreCompact hook, context being summarized (purple Wave-Spiral)
 *   error       — PostToolUse error / session error (red fast Wave-Pulse)
 */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'executing'
  | 'wait_input'
  | 'compacting'
  | 'error';

// Theme: color palette (orthogonal to shape)
export type ThemeColor =
  | 'dark' | 'light' | 'cappuccino' | 'sakura' | 'lavender' | 'mint'
  | 'obsidian' | 'cobalt' | 'moss';
// Theme: shape form (orthogonal to color)
export type ThemeShape = 'soft' | 'slab' | 'sharp' | 'blade' | 'panel';
// Icon theme: visual style for file/folder icons in the explorer.
// 8 themes, each with genuinely distinct folder silhouette + file icon style.
// Fetched upstream (6): material, vscode-icons, catppuccin-mocha, devicon, fluent, symbols
// Self-authored (2): outline (line-frame), coffee (Coffee CLI brand)
export type IconTheme =
  | 'outline' | 'material' | 'vscode-icons' | 'catppuccin-mocha'
  | 'devicon' | 'fluent' | 'symbols' | 'coffee';

/// One pane inside a multi-agent Tab. Each pane maps to one portable-pty
/// session via sessionId = `${tabId}::pane-${paneIdx}`; the Rust MCP
/// server's list_panes returns the same ids.
export interface MultiAgentPane {
  paneIdx: number;
  tool: ToolType;
  toolData?: string;
  agentStatus?: AgentStatus;
}

/// State attached to a Tab with `tool === 'multi-agent'`. All four panes
/// are peers — there is no primary/worker distinction — so this type is
/// deliberately minimal. Each pane's CLI and toolData live on
/// `MultiAgentPane`; focus tracking happens inside `<MultiAgentGrid/>`.
export interface MultiAgentState {
  panes: MultiAgentPane[];
}

export interface TerminalSession {
  id: string;
  tool: ToolType;
  toolData?: string;  // Extra context for the tool (e.g. game filename for arcade)
  folderPath: string | null;
  scanData: ScanResult | null;
  restartKey?: number;
  isHidden?: boolean;
  agentStatus?: AgentStatus;
  gambitDraft?: string;    // Unsent textarea content, preserved across tab switches
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
  // Wallpaper dim overlay opacity, 0-80 (percent). 30 by default for legibility.
  wallpaperDim: number;

  // Terminal foreground color override ('' = use theme default)
  termColorScheme: string;

  // Terminals
  terminals: TerminalSession[];
  activeTerminalId: string | null;

  // Gambit (global floating compose window). Visibility is app-wide so the
  // panel doesn't appear/disappear when switching tabs; only the draft is
  // per-tab (stored on TerminalSession.gambitDraft).
  gambitOpen: boolean;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type Action =
  | { type: 'SET_FOLDER'; path: string }
  | { type: 'CLEAR_FOLDER' }
  | { type: 'SET_SCAN'; data: ScanResult }
  | { type: 'SET_THEME'; theme: ThemeColor }
  | { type: 'SET_SHAPE'; shape: ThemeShape }
  | { type: 'SET_ICON_THEME'; theme: IconTheme }
  | { type: 'SET_LANG'; lang: string }
  | { type: 'ADD_TERMINAL'; session: TerminalSession }
  | { type: 'REMOVE_TERMINAL'; id: string }
  | { type: 'SET_ACTIVE_TERMINAL'; id: string | null }
  | { type: 'SET_TERMINAL_TOOL'; id: string; tool: ToolType; toolData?: string }
  | { type: 'SET_TERMINAL_HIDDEN'; id: string; isHidden: boolean }
  | { type: 'RESTART_TERMINAL'; id: string; newId: string }
  | { type: 'OPEN_HISTORY_TAB'; sessionData: string; folderPath: string }
  | { type: 'SET_AGENT_STATUS'; id: string; status: AgentStatus }
  | { type: 'SET_BG'; path: string; bgType: 'image' | 'video' }
  | { type: 'CLEAR_BG' }
  | { type: 'SET_WALLPAPER_DIM'; dim: number }
  | { type: 'SET_WALLPAPER_DIM'; dim: number }
  | { type: 'SET_TERM_SCHEME'; scheme: string }
  | { type: 'TOGGLE_GAMBIT' }
  | { type: 'SET_GAMBIT_DRAFT'; id: string; draft: string }
  | { type: 'SET_PANE_TOOL'; tabId: string; paneIdx: number; tool: ToolType; toolData?: string };

// ─── Reducer ─────────────────────────────────────────────────────────────────

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_FOLDER':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === state.activeTerminalId ? { ...t, folderPath: action.path } : t)
      };
    case 'CLEAR_FOLDER':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === state.activeTerminalId ? { ...t, folderPath: null, scanData: null } : t)
      };
    case 'SET_SCAN':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === state.activeTerminalId ? { ...t, scanData: action.data } : t)
      };
    case 'SET_THEME':
      return { ...state, currentTheme: action.theme };
    case 'SET_SHAPE':
      return { ...state, currentShape: action.shape };
    case 'SET_ICON_THEME':
      return { ...state, iconTheme: action.theme };
    case 'SET_LANG':
      return { ...state, currentLang: action.lang };
    case 'ADD_TERMINAL':
      return { 
        ...state, 
        terminals: [...state.terminals, action.session],
        activeTerminalId: action.session.id 
      };
    case 'REMOVE_TERMINAL': {
      let newTerminals = state.terminals.filter(t => t.id !== action.id);
      let newActiveId = state.activeTerminalId;
      
      if (newTerminals.length === 0) {
        const defaultId = crypto.randomUUID();
        const folderPath = state.terminals.length > 0 ? state.terminals[0].folderPath : null;
        newTerminals = [{ id: defaultId, tool: null, folderPath, scanData: null }];
        newActiveId = defaultId;
      } else if (state.activeTerminalId === action.id) {
         newActiveId = newTerminals[newTerminals.length - 1].id;
      }
      return { ...state, terminals: newTerminals, activeTerminalId: newActiveId };
    }
    case 'SET_ACTIVE_TERMINAL':
      return { ...state, activeTerminalId: action.id };
    case 'SET_TERMINAL_TOOL':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, tool: action.tool, toolData: action.toolData } : t)
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
          t.id === action.id ? { ...t, id: action.newId } : t
        ),
        activeTerminalId: state.activeTerminalId === action.id ? action.newId : state.activeTerminalId
      };
    case 'OPEN_HISTORY_TAB': {
      const existingHistoryTab = state.terminals.find(t => t.tool === 'history');
      if (existingHistoryTab) {
        return {
          ...state,
          terminals: state.terminals.map(t => 
            t.id === existingHistoryTab.id ? { ...t, toolData: action.sessionData, folderPath: action.folderPath } : t
          ),
          activeTerminalId: existingHistoryTab.id
        };
      } else {
        const newId = crypto.randomUUID();
        return {
          ...state,
          terminals: [...state.terminals, {
            id: newId,
            tool: 'history',
            toolData: action.sessionData,
            folderPath: action.folderPath,
            scanData: null,
          }],
          activeTerminalId: newId
        };
      }
    }
    case 'SET_AGENT_STATUS':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, agentStatus: action.status } : t)
      };
    case 'SET_BG':
      return { ...state, bgPath: action.path, bgType: action.bgType };
    case 'CLEAR_BG':
      return { ...state, bgPath: '', bgType: 'none' };
    case 'SET_WALLPAPER_DIM':
      return { ...state, wallpaperDim: Math.max(0, Math.min(80, action.dim)) };
    case 'SET_TERM_SCHEME':
      return { ...state, termColorScheme: action.scheme };
    case 'TOGGLE_GAMBIT':
      return { ...state, gambitOpen: !state.gambitOpen };
    case 'SET_GAMBIT_DRAFT':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, gambitDraft: action.draft } : t)
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
            ?? ([0, 1, 2, 3].map(i => ({ paneIdx: i, tool: null as ToolType })) as MultiAgentPane[]);
          const panes = existing.map(p =>
            p.paneIdx === action.paneIdx
              ? { ...p, tool: action.tool, toolData: action.toolData }
              : p
          );
          return { ...t, multiAgent: { panes } };
        }),
      };
    }
    default:
      return state;
  }
}

// ─── Initial State ────────────────────────────────────────────────────────────

const VALID_THEMES: ThemeColor[] = [
  'dark', 'light', 'cappuccino', 'sakura', 'lavender', 'mint',
  'obsidian', 'cobalt', 'moss',
];
const VALID_SHAPES: ThemeShape[] = ['soft', 'slab', 'sharp', 'blade', 'panel'];
const VALID_ICON_THEMES: IconTheme[] = [
  'outline', 'material', 'vscode-icons', 'catppuccin-mocha',
  'devicon', 'fluent', 'symbols', 'coffee',
];

function getInitialState(): AppState {
  let theme: ThemeColor = 'dark';
  let shape: ThemeShape = 'soft';
  let iconTheme: IconTheme = 'outline';
  let lang = 'zh-CN';
  let folderPath: string | null = null;

  try {
    const savedTheme = localStorage.getItem('cc-theme') as ThemeColor | null;
    if (savedTheme && VALID_THEMES.includes(savedTheme)) theme = savedTheme;
  } catch {}

  try {
    const savedShape = localStorage.getItem('cc-shape') as ThemeShape | null;
    if (savedShape && VALID_SHAPES.includes(savedShape)) shape = savedShape;
  } catch {}

  try {
    const savedIconTheme = localStorage.getItem('cc-icon-theme') as IconTheme | null;
    if (savedIconTheme && VALID_ICON_THEMES.includes(savedIconTheme)) iconTheme = savedIconTheme;
  } catch {}

  try { folderPath = localStorage.getItem('cc-folder'); } catch {}

  try {
    const savedLang = localStorage.getItem('cc-lang');
    if (savedLang) lang = savedLang;
  } catch {}

  let bgPath = '';
  let bgType: 'image' | 'video' | 'none' = 'none';
  let termColorScheme = '';
  let wallpaperDim = 30;
  try {
    bgPath = localStorage.getItem('cc-bg-path') || '';
    bgType = (localStorage.getItem('cc-bg-type') as 'image' | 'video' | 'none') || 'none';
    termColorScheme = localStorage.getItem('cc-term-scheme') || '';
    const savedDim = localStorage.getItem('cc-wallpaper-dim');
    if (savedDim !== null) {
      const n = parseInt(savedDim, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 80) wallpaperDim = n;
    }
  } catch {}

  const defaultTerminalId = crypto.randomUUID();

  return {
    currentTheme: theme,
    currentShape: shape,
    iconTheme,
    currentLang: lang,
    bgPath,
    bgType,
    wallpaperDim,
    termColorScheme,
    terminals: [{ id: defaultTerminalId, tool: null, folderPath, scanData: null }],
    activeTerminalId: defaultTerminalId,
    gambitOpen: false,
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
