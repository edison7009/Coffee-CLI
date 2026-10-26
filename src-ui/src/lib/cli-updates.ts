import { useSyncExternalStore } from 'react';
import { commands, type CliUpdateStatus } from '../tauri';

interface Entry { status?: CliUpdateStatus; busy: boolean; error?: string }
const key = 'cc-cli-updates-v1', empty: Entry = { busy: false };
const entries = new Map<string, Entry>(), pending = new Map<string, Promise<void>>(), listeners = new Set<() => void>();
try {
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
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useCliUpdate(tool: string) { return useSyncExternalStore(subscribe, () => entries.get(tool) ?? empty); }

export async function checkCliUpdate(tool: string) {
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
  const current = entries.get(tool);
  if (current?.busy || !current?.status?.available) return;
  publish(tool, { status: current.status, busy: true });
  // An older version check must finish before the update can publish its result.
  await pending.get(tool);
  try { publish(tool, { status: await commands.updateCli(tool), busy: false }); }
  catch (error) { publish(tool, { status: current.status, busy: false, error: String(error) }); }
}
