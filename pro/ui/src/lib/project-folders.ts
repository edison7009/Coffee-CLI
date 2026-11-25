// The launchpad's recent project folders, shared with the session list: adding or removing a folder on the launchpad
// shows at once in the list's "added folders only" project view.
//
// In a browser the list is the desktop's own (see storage-mirror): it reloads whenever the desktop's copy changes,
// and folders added or removed in the browser are added or removed on the desktop.
import { onSharedStorage } from './storage-mirror';
const STORAGE_KEY = 'coffee:recent-folders';
const LIMIT = 8;

function load(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string' && !!f) : []; } catch { return []; }
}

let folders = load();
const listeners = new Set<() => void>();
function save(next: string[]) {
  if (next.length === folders.length && next.every((f, i) => f === folders[i])) return;
  folders = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Best-effort operation; failure is non-fatal. */ }
  listeners.forEach(listener => listener());
}

onSharedStorage(STORAGE_KEY, () => { folders = load(); listeners.forEach(listener => listener()); });

export const getProjectFolders = (): string[] => folders;
export function subscribeProjectFolders(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Puts a folder first, most recently used first, keeping the list's limit. */
export function addProjectFolder(folder: string): void { save([folder, ...folders.filter(f => f !== folder)].slice(0, LIMIT)); }
export function removeProjectFolder(folder: string): void { save(folders.filter(f => f !== folder)); }
