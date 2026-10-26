import type { TerminalSession } from '../store/app-state';

const STORAGE_KEY = 'coffee:unread-session-replies';
let unread = new Set<string>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  if (Array.isArray(saved)) unread = new Set(saved.filter((key): key is string => typeof key === 'string'));
} catch { /* Local markers stay available when storage is unavailable. */ }
const listeners = new Set<() => void>();
const identities = new Map<string, string>();
let visible = new Set<string>();
const reading = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus();
export const sessionReplyKey = (tool: string, token: string) => `${tool}:${token}`;
export const getUnreadSessionReplies = () => unread;
export const subscribeSessionReplies = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function publish(next: Set<string>) {
  unread = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...unread])); } catch { /* Best effort. */ }
  listeners.forEach(listener => listener());
}

/** Called only for a verified, successful live turn result, never history or idle transitions. */
export function recordSessionReply(id: string, tool: string, token: string) {
  if (!token) return;
  const key = sessionReplyKey(tool, token);
  identities.set(id, key);
  if (visible.has(id) && reading()) return;
  if (!unread.has(key)) publish(new Set(unread).add(key));
}

export function updateSessionReplyReaders(terminals: TerminalSession[], ids: string[]) {
  const live = new Set(terminals.map(tab => tab.id));
  for (const id of identities.keys()) if (!live.has(id)) identities.delete(id);
  for (const tab of terminals) if (tab.tool && tab.resumeToken) identities.set(tab.id, sessionReplyKey(tab.tool, tab.resumeToken));
  visible = new Set(ids);
  if (!reading()) return;
  const next = new Set(unread);
  for (const id of visible) {
    const key = identities.get(id);
    if (key) next.delete(key);
  }
  if (next.size !== unread.size) publish(next);
}

