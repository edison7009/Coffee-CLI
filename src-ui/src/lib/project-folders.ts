const STORAGE_KEY = 'coffee:recent-folders';
const MAX_FOLDERS = 8;

let folders: string[] = load();
const listeners = new Set<() => void>();

function load(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((folder): folder is string => typeof folder === 'string' && folder.trim() !== '');
  } catch {
    return [];
  }
}

function update(next: string[]): void {
  folders = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep the in-memory selection when storage is unavailable. */ }
  for (const listener of listeners) listener();
}

export function addProjectFolder(folder: string): void {
  if (!folder.trim()) return;
  update([folder, ...folders.filter(item => item !== folder)].slice(0, MAX_FOLDERS));
}

export function removeProjectFolder(folder: string): void {
  if (!folders.includes(folder)) return;
  update(folders.filter(item => item !== folder));
}

export function subscribeProjectFolders(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getProjectFoldersSnapshot(): string[] {
  return folders;
}
