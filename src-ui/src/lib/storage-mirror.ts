// The desktop's saved preferences and records (recent folders, last folder per tool, launch modes,
// pinned and renamed sessions, prompt history…) are the browser's too: the browser holds a copy of
// the desktop's localStorage, and what it writes there is written on the desktop.
//
// Left per screen: layout that depends on the screen, caches each device fills for itself, and
// anything holding credentials.
import { REMOTE, remoteRequest } from '../remote/bridge';
import { mirrorSource, mirrorTarget } from './session-mirror';

const PER_SCREEN = new Set([
  // Layout follows the screen it is on.
  'cc-left-hidden', 'cc-right-hidden', 'cc-left-tab', 'cc-right-tab', 'cc-panel-widths', 'cc-gambit-dock-h', 'cc-gambit-open',
  'cc-ui-scale', 'cc-task-automations-collapsed', 'cc-native-lang',
  // Caches each side fills on its own.
  'cc-history-cache-v1', 'cc-heatmap-year-cache', 'cc-usage-snapshots-v1', 'cc-project-git-status-v1', 'cc-release-notes',
  'cc-release-notes-seen', 'cc-tool-skills-v1', 'cc-bg-init',
  // Remote-terminal profiles may hold passwords.
  'coffee_remote_cfg',
]);

export function isMirroredKey(key: string): boolean {
  return (key.startsWith('cc-') || key.startsWith('coffee:') || key.startsWith('coffee_')) && !PER_SCREEN.has(key);
}

/** Fired in the browser after the desktop's copy changed `keys`; code that read them can read again. */
export const STORAGE_EVENT = 'coffee-storage';

type Write = (key: string, value: string | null) => void;

function patchStorage(onWrite: Write): { set: (key: string, value: string) => void; remove: (key: string) => void } {
  const proto = Storage.prototype, set = proto.setItem, remove = proto.removeItem;
  proto.setItem = function (this: Storage, key: string, value: string) {
    set.call(this, key, value);
    if (this === window.localStorage && isMirroredKey(key)) onWrite(key, String(value));
  };
  proto.removeItem = function (this: Storage, key: string) {
    remove.call(this, key);
    if (this === window.localStorage && isMirroredKey(key)) onWrite(key, null);
  };
  return { set: (key, value) => set.call(window.localStorage, key, value), remove: key => remove.call(window.localStorage, key) };
}

function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && isMirroredKey(key)) out[key] = localStorage.getItem(key) ?? '';
  }
  return out;
}

let installed = false;

/** Desktop: offers its storage to browsers. Call once at startup. */
export function shareDesktopStorage(): void {
  if (installed || REMOTE || typeof window === 'undefined') return;
  installed = true;
  const changed = mirrorSource('app', 'storage', snapshot);
  patchStorage(() => changed());
}

/** Desktop: a browser wrote one of the mirrored keys. */
export function writeFromBrowser(key: string, value: string | null): void {
  if (!isMirroredKey(key)) throw new Error('Not a shared setting');
  if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
}

/** Browser: follows the desktop's storage; resolves once the first copy is in place. */
export function followDesktopStorage(): Promise<void> {
  if (installed || !REMOTE) return Promise.resolve();
  installed = true;
  const local = patchStorage((key, value) => {
    void remoteRequest('ui.storage', { key, value }).catch(error => console.error('[remote storage]', error));
  });
  return new Promise(resolve => {
    mirrorTarget('app', 'storage', state => {
      const desk = state as Record<string, string>, keys: string[] = [];
      for (const key of Object.keys(snapshot())) if (!(key in desk)) { local.remove(key); keys.push(key); }
      for (const [key, value] of Object.entries(desk)) if (localStorage.getItem(key) !== value) { local.set(key, value); keys.push(key); }
      if (keys.length) window.dispatchEvent(new CustomEvent(STORAGE_EVENT, { detail: keys }));
      resolve();
    });
  });
}
