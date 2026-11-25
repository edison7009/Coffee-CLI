// An open conversation as the history list knows it, shared by everything that offers its menu (Work's title bar,
// the Work rail): the saved record once it has one, else the open tab as a live entry.
import type { TerminalSession } from '../store/app-state';
import type { SavedSession } from '../tauri';

export function openSessionRecord(tab: TerminalSession, sessions: readonly SavedSession[]): { saved: SavedSession; record?: SavedSession } {
  const record = sessions.find(item => item.tool === tab.tool && !!tab.resumeToken && item.session_token === tab.resumeToken);
  const saved: SavedSession = record
    ?? { id: `live:${tab.id}`, name: tab.toolTitle ?? '', tool: tab.tool ?? '', cwd: tab.folderPath ?? '', session_token: tab.resumeToken ?? null, saved_at: new Date().toISOString() };
  return { saved, record };
}

// Renaming starts in Work's title bar, which shows only the active conversation: a rename asked for elsewhere (the
// rail's menu) switches to the conversation first and is picked up when its title mounts.
let pendingRename: string | null = null;
const RENAME_EVENT = 'coffee-rename-title';
export function requestTitleRename(tabId: string) {
  pendingRename = tabId;
  window.dispatchEvent(new CustomEvent(RENAME_EVENT, { detail: tabId }));
}
/** True once for the tab a rename was asked for. */
export function takeTitleRename(tabId: string): boolean {
  if (pendingRename !== tabId) return false;
  pendingRename = null;
  return true;
}
export function onTitleRename(listener: (tabId: string) => void): () => void {
  const handler = (event: Event) => listener(String((event as CustomEvent).detail));
  window.addEventListener(RENAME_EVENT, handler);
  return () => window.removeEventListener(RENAME_EVENT, handler);
}
