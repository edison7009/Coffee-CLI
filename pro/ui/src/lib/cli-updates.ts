// Tool versions and updates run on the desktop: a browser shows the desktop's entries, and its
// update button asks the desktop to update, so both screens show the same progress.
import { useSyncExternalStore } from 'react';
import { commands, type CliUpdateStatus } from '../tauri';
import { REMOTE } from '../remote/bridge';
import { mirrorCall, mirrorSource, mirrorTarget, registerMirrorActions } from './session-mirror';

interface Entry { status?: CliUpdateStatus; busy: boolean; error?: string }
const key = 'cc-cli-updates-v1', empty: Entry = { busy: false };
const entries = new Map<string, Entry>(), pending = new Map<string, Promise<void>>(), listeners = new Set<() => void>();
if (!REMOTE) try {
  const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
  if (Array.isArray(saved)) for (const status of saved) {
    if (status && typeof status.tool === 'string' && typeof status.available === 'boolean' && (status.current === null || typeof status.current === 'string') && (status.latest === null || typeof status.latest === 'string')) entries.set(status.tool, { status, busy: false });
  }
} catch { /* Cached versions are optional. */ }

function publish(tool: string, entry: Entry) {
  entries.set(tool, entry);
  try { localStorage.setItem(key, JSON.stringify([...entries.values()].flatMap(value => value.status ? [value.status] : []))); } catch { /* Cached versions are optional. */ }
  listeners.forEach(listener => listener());
}
if (!REMOTE) listeners.add(mirrorSource('app', 'cli-updates', () => Object.fromEntries(entries)));

let following = false;
function followDesktop() {
  if (following) return;
  following = true;
  mirrorTarget('app', 'cli-updates', state => {
    entries.clear();
    for (const [tool, entry] of Object.entries((state ?? {}) as Record<string, Entry>)) entries.set(tool, entry);
    listeners.forEach(listener => listener());
  });
}

const subscribe = (listener: () => void) => { if (REMOTE) followDesktop(); listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useCliUpdate(tool: string) { return useSyncExternalStore(subscribe, () => entries.get(tool) ?? empty); }

export async function checkCliUpdate(tool: string) {
  if (REMOTE) return mirrorCall<void>('app', 'checkCliUpdate', [tool]).catch(() => { /* The desktop keeps its last version. */ });
  if (entries.get(tool)?.busy) return;
  const request = pending.get(tool);
  if (request) return request;
  const task = commands.checkCliUpdate(tool).then(status => {
    if (!entries.get(tool)?.busy) publish(tool, { status, busy: false });
  }).catch(() => { /* Keep the last version while the local probe is unavailable. */ }).finally(() => { pending.delete(tool); });
  pending.set(tool, task);
  return task;
}

export async function updateCli(tool: string) {
  if (REMOTE) return mirrorCall<void>('app', 'updateCli', [tool]).catch(error => console.error('[cli update]', error));
  const current = entries.get(tool);
  if (current?.busy || !current?.status?.available) return;
  publish(tool, { status: current.status, busy: true });
  // An older version check must finish before the update can publish its result.
  await pending.get(tool);
  try { publish(tool, { status: await commands.updateCli(tool), busy: false }); }
  catch (error) { publish(tool, { status: current.status, busy: false, error: String(error) }); }
}

// An update can take minutes; the browser follows its progress through the mirrored entries.
registerMirrorActions('app', { checkCliUpdate: (tool: string) => { void checkCliUpdate(tool); }, updateCli: (tool: string) => { void updateCli(tool); } });
