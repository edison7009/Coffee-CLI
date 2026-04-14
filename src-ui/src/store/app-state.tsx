// Coffee CLI — Global App State (React Context)

import { createContext, useContext, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { ScanResult, ModelConfig } from '../tauri';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolType = 'claude' | 'codex' | 'installer' | 'hermes' | 'opencode' | 'arcade' | 'terminal' | 'remote' | 'history' | null;

// Theme: color palette (orthogonal to shape)
export type ThemeColor = 'dark' | 'light' | 'cappuccino' | 'sakura' | 'lavender' | 'mint';
// Theme: shape form (orthogonal to color)
export type ThemeShape = 'soft' | 'slab' | 'sharp' | 'blade' | 'panel';

export interface TerminalSession {
  id: string;
  tool: ToolType;
  toolData?: string;  // Extra context for the tool (e.g. game filename for arcade)
  folderPath: string | null;
  scanData: ScanResult | null;
  restartKey?: number;
  isHidden?: boolean;
}

// ─── State Shape ─────────────────────────────────────────────────────────────

export interface AppState {
  // UI
  currentTheme: ThemeColor;
  currentShape: ThemeShape;
  currentLang: string;

  // Model
  modelConfig: ModelConfig | null;

  // Terminals
  terminals: TerminalSession[];
  activeTerminalId: string | null;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type Action =
  | { type: 'SET_FOLDER'; path: string }
  | { type: 'CLEAR_FOLDER' }
  | { type: 'SET_SCAN'; data: ScanResult }
  | { type: 'SET_THEME'; theme: ThemeColor }
  | { type: 'SET_SHAPE'; shape: ThemeShape }
  | { type: 'SET_LANG'; lang: string }
  | { type: 'SET_MODEL'; model: ModelConfig }
  | { type: 'ADD_TERMINAL'; session: TerminalSession }
  | { type: 'REMOVE_TERMINAL'; id: string }
  | { type: 'SET_ACTIVE_TERMINAL'; id: string | null }
  | { type: 'SET_TERMINAL_TOOL'; id: string; tool: ToolType; toolData?: string }
  | { type: 'SET_TERMINAL_HIDDEN'; id: string; isHidden: boolean }
  | { type: 'RESTART_TERMINAL'; id: string; newId: string }
  | { type: 'OPEN_HISTORY_TAB'; sessionData: string; folderPath: string };

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
    case 'SET_LANG':
      return { ...state, currentLang: action.lang };
    case 'SET_MODEL':
      return { ...state, modelConfig: action.model };
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
    default:
      return state;
  }
}

// ─── Initial State ────────────────────────────────────────────────────────────

const VALID_THEMES: ThemeColor[] = ['dark', 'light', 'cappuccino', 'sakura', 'lavender', 'mint'];
const VALID_SHAPES: ThemeShape[] = ['soft', 'slab', 'sharp', 'blade', 'panel'];

function getInitialState(): AppState {
  let theme: ThemeColor = 'dark';
  let shape: ThemeShape = 'soft';
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

  try { folderPath = localStorage.getItem('cc-folder'); } catch {}

  try {
    const savedLang = localStorage.getItem('cc-lang');
    if (savedLang) lang = savedLang;
  } catch {}

  const defaultTerminalId = crypto.randomUUID();

  return {
    currentTheme: theme,
    currentShape: shape,
    currentLang: lang,
    modelConfig: null,
    terminals: [{ id: defaultTerminalId, tool: null, folderPath, scanData: null }],
    activeTerminalId: defaultTerminalId,
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
