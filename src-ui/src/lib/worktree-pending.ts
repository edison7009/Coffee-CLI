import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Tabs whose worktree is on its way: `creating` while git adds it (the tab the switch was clicked in), then
 * `starting` while the replacement tab's session connects in the new folder. The welcome screen shows a status for
 * both, and the composer holds back a message until they end.
 */
type Phase = 'creating' | 'starting';
const pending = new Map<string, Phase>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => { version++; listeners.forEach(listener => listener()); };

export function setWorktreePending(id: string, phase: Phase | null): void {
  if (phase) pending.set(id, phase); else if (!pending.delete(id)) return;
  notify();
}
export function isWorktreePending(id: string): boolean { return pending.has(id); }

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * Whether to show "creating worktree" on this tab's welcome screen. A replacement tab's phase ends once its session is
 * `settled` (ready or failed). The status appears only after `delayMs`, so a fast machine does not flash it.
 */
export function useWorktreePending(id: string, settled: boolean, delayMs = 300): boolean {
  useSyncExternalStore(subscribe, () => version);
  const phase = pending.get(id);
  useEffect(() => { if (phase === 'starting' && settled) setWorktreePending(id, null); }, [id, phase, settled]);
  const key = phase ? `${id}:${phase}` : '';
  const [shownKey, setShownKey] = useState('');
  useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => setShownKey(key), delayMs);
    return () => window.clearTimeout(timer);
  }, [key, delayMs]);
  return !!key && shownKey === key;
}
