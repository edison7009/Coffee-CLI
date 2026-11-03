import type { AppState, TerminalSession } from '../store/app-state';

// Open tabs come back after a restart through the same `--resume <token>` path as
// history's "continue". Only tabs that can return to the same place are saved:
// a tool tab with a bound session token, or a plain shell in its folder. A tool
// tab without a token would start a brand-new session, and SSH tabs carry
// connection data, so both are left out, as are orchestration workers.
const KEY = 'cc-open-tabs';
const LIMIT = 30;

interface SavedTab {
  tool: NonNullable<TerminalSession['tool']>;
  folderPath: string;
  resumeToken?: string;
  claudeMode?: TerminalSession['claudeMode'];
  codexMode?: TerminalSession['codexMode'];
  opencodeMode?: TerminalSession['opencodeMode'];
  pinnedTitle?: string;
  toolTitle?: string;
  worktree?: TerminalSession['worktree'];
  worktreeOrigin?: string;
  active?: boolean;
}

function saved(tab: TerminalSession, active: boolean): SavedTab | null {
  // Workers come back through orchestration's own restore, under their coordinator.
  if (!tab.tool || tab.tool === 'remote' || tab.isHidden || tab.parentId || !tab.folderPath) return null;
  if (tab.tool !== 'terminal' && !tab.resumeToken) return null;
  return {
    tool: tab.tool, folderPath: tab.folderPath, resumeToken: tab.tool === 'terminal' ? undefined : tab.resumeToken,
    claudeMode: tab.claudeMode, codexMode: tab.codexMode, opencodeMode: tab.opencodeMode,
    pinnedTitle: tab.pinnedTitle, toolTitle: tab.toolTitle, worktree: tab.worktree, worktreeOrigin: tab.worktreeOrigin,
    ...(active ? { active } : {}),
  };
}

export function serializeOpenTabs(state: Pick<AppState, 'terminals' | 'tabOrder' | 'activeTerminalId'>): string {
  const byId = new Map(state.terminals.map(tab => [tab.id, tab]));
  const order = state.tabOrder.length ? state.tabOrder : state.terminals.map(tab => tab.id);
  const tabs = order.map(id => byId.get(id)).filter((tab): tab is TerminalSession => !!tab)
    .map(tab => saved(tab, tab.id === state.activeTerminalId)).filter((tab): tab is SavedTab => !!tab).slice(0, LIMIT);
  return JSON.stringify(tabs);
}

export function saveOpenTabs(state: Pick<AppState, 'terminals' | 'tabOrder' | 'activeTerminalId'>): void {
  try { localStorage.setItem(KEY, serializeOpenTabs(state)); } catch { /* Best-effort operation; failure is non-fatal. */ }
}

/** Fresh tab ids for the saved tabs, plus which one was active; null when there is nothing to restore. */
export function parseOpenTabs(text: string | null): { terminals: TerminalSession[]; activeId: string } | null {
  if (!text) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const terminals: TerminalSession[] = [];
  let activeId = '';
  for (const item of raw.slice(0, LIMIT) as Partial<SavedTab>[]) {
    if (!item || typeof item.tool !== 'string' || item.tool === 'remote' || typeof item.folderPath !== 'string' || !item.folderPath) continue;
    if (item.tool !== 'terminal' && (typeof item.resumeToken !== 'string' || !item.resumeToken)) continue;
    const id = crypto.randomUUID();
    terminals.push({
      id, tool: item.tool, folderPath: item.folderPath, resumeToken: item.tool === 'terminal' ? undefined : item.resumeToken,
      claudeMode: item.claudeMode, codexMode: item.codexMode, opencodeMode: item.opencodeMode,
      pinnedTitle: item.pinnedTitle, toolTitle: item.toolTitle, worktree: item.worktree, worktreeOrigin: item.worktreeOrigin, startedAt: Date.now(),
    });
    if (item.active) activeId = id;
  }
  if (!terminals.length) return null;
  return { terminals, activeId: activeId || terminals[0].id };
}

export function loadOpenTabs(): ReturnType<typeof parseOpenTabs> {
  try { return parseOpenTabs(localStorage.getItem(KEY)); } catch { return null; }
}
