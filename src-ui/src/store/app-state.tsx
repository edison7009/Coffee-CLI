// Coffee CLI — Global App State (React Context)

import { createContext, useContext, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { ScanResult, ModelConfig } from '../tauri';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolType = 'claude' | 'codex' | 'gemini' | 'openclaw' | 'opencode' | 'arcade' | 'terminal' | 'remote' | 'history' | null;
export type AgentStatus = 'working' | 'idle' | 'wait_input';

export interface TerminalMenu {
  options: { index: number; badge: string; text: string; actionText?: string | null }[];
  activeIndex: number;
}

export interface TerminalSession {
  id: string;
  tool: ToolType;
  toolData?: string;  // Extra context for the tool (e.g. game filename for arcade)
  folderPath: string | null;
  scanData: ScanResult | null;
  agentStatus: AgentStatus;
  menu: TerminalMenu | null;
  hasInputText: boolean;
  restartKey?: number;
  isHidden?: boolean;
}

// ─── State Shape ─────────────────────────────────────────────────────────────

export interface AppState {
  // UI
  currentTheme: 'dark' | 'light';
  currentLang: 'en' | 'zh-CN';

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
  | { type: 'SET_THEME'; theme: 'dark' | 'light' }
  | { type: 'SET_LANG'; lang: 'en' | 'zh-CN' }
  | { type: 'SET_MODEL'; model: ModelConfig }
  | { type: 'ADD_TERMINAL'; session: TerminalSession }
  | { type: 'REMOVE_TERMINAL'; id: string }
  | { type: 'SET_ACTIVE_TERMINAL'; id: string | null }
  | { type: 'SET_TERMINAL_TOOL'; id: string; tool: ToolType; toolData?: string }
  | { type: 'SET_AGENT_STATUS'; id: string; status: AgentStatus }
  | { type: 'SET_TERMINAL_MENU'; id: string; menu: TerminalMenu | null }
  | { type: 'SET_HAS_INPUT_TEXT'; id: string; hasInputText: boolean }
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
        newTerminals = [{ id: defaultId, tool: null, folderPath, scanData: null, agentStatus: 'idle', menu: null, hasInputText: false }];
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
    case 'SET_AGENT_STATUS':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, agentStatus: action.status } : t)
      };
    case 'SET_TERMINAL_MENU':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, menu: action.menu } : t)
      };
    case 'SET_HAS_INPUT_TEXT':
      return {
        ...state,
        terminals: state.terminals.map(t => t.id === action.id ? { ...t, hasInputText: action.hasInputText } : t)
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
            agentStatus: 'idle',
            menu: null,
            hasInputText: false
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

function getInitialState(): AppState {
  let theme: 'dark' | 'light' = 'dark';
  let lang: 'en' | 'zh-CN' = 'zh-CN';
  let folderPath: string | null = null;

  try {
    const savedTheme = localStorage.getItem('cc-theme') as 'dark' | 'light' | null;
    if (savedTheme) theme = savedTheme;
  } catch {}

  try { folderPath = localStorage.getItem('cc-folder'); } catch {}

  try {
    const savedLang = localStorage.getItem('cc-lang') as 'en' | 'zh-CN' | null;
    if (savedLang) lang = savedLang;
  } catch {}

  const defaultTerminalId = crypto.randomUUID();

  return {
    currentTheme: theme,
    currentLang: lang,
    modelConfig: null,
    terminals: [{ id: defaultTerminalId, tool: null, folderPath, scanData: null, agentStatus: 'idle' as AgentStatus, menu: null, hasInputText: false }],
    activeTerminalId: defaultTerminalId,
  };
}

// ─── Context ─────────────────────────────────────────────────────────────────

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
} | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);
  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppState() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useAppState must be inside AppProvider');
  return ctx;
}
