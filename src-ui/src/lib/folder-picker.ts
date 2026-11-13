// Coffee CLI's own folder picker, shared by the desktop window, browsers and
// phones. `pickFolder()` opens it and resolves with the chosen path, or null.
// Paths follow the computer's conventions (its separator comes from
// `folder_picker_places`), never the device the picker is shown on.
import { useSyncExternalStore } from 'react';

export interface FolderPickerRequest { id: number; title?: string; start?: string | null; resolve: (path: string | null) => void }

let request: FolderPickerRequest | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());

export function pickFolder(options: { title?: string; start?: string | null } = {}): Promise<string | null> {
  // A second request replaces an open one, which resolves as cancelled.
  request?.resolve(null);
  return new Promise(resolve => {
    const id = nextId++;
    request = { ...options, id, resolve: path => { if (request?.id === id) request = null; publish(); resolve(path); } };
    publish();
  });
}

export function useFolderPickerRequest(): FolderPickerRequest | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => request, () => null);
}

/** Root of a path: `C:\` (or a `\\server\share\` UNC root) on Windows, `/` elsewhere. */
function rootOf(path: string, sep: string): string {
  if (sep === '\\') {
    const drive = path.match(/^[A-Za-z]:\\?/);
    if (drive) return drive[0].endsWith('\\') ? drive[0] : `${drive[0]}\\`;
    const unc = path.match(/^\\\\[^\\]+\\[^\\]+\\?/);
    if (unc) return unc[0].endsWith('\\') ? unc[0] : `${unc[0]}\\`;
    return '';
  }
  return path.startsWith('/') ? '/' : '';
}

/** Clickable segments from the root down to the path itself. */
export function crumbs(path: string, sep: string): { name: string; path: string }[] {
  const root = rootOf(path, sep);
  if (!root) return [];
  const rest = path.slice(root.length).split(sep).filter(Boolean);
  const list = [{ name: sep === '\\' ? root.replace(/\\$/, '') : root, path: root }];
  let current = root;
  for (const part of rest) {
    current = current.endsWith(sep) ? current + part : current + sep + part;
    list.push({ name: part, path: current });
  }
  return list;
}

/** The containing folder, or null at a root. */
export function parentOf(path: string, sep: string): string | null {
  const list = crumbs(path, sep);
  return list.length > 1 ? list[list.length - 2].path : null;
}

/** Normalizes a typed or pasted path the computer's way: separators, quotes, trailing separator. */
export function normalizeTypedPath(input: string, sep: string): string {
  let path = input.trim().replace(/^["']|["']$/g, '');
  if (sep === '\\') path = path.replace(/\//g, '\\');
  const root = rootOf(path, sep);
  while (path.length > root.length && path.endsWith(sep)) path = path.slice(0, -1);
  return path;
}

/** Hidden by default: dot folders, and on Windows the system's own. */
export function isHiddenFolder(name: string, sep: string): boolean {
  if (name.startsWith('.')) return true;
  return sep === '\\' && /^(\$recycle\.bin|system volume information|\$windows\.~bt|\$winreagent|config\.msi|recovery)$/i.test(name);
}
