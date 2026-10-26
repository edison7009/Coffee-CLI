import { useEffect, useState } from 'react';
import { commands, isTauri, type GitProjectStatus, type SessionGitContext } from '../tauri';
import { onWindowBackground, onWindowForeground } from './window-focus-filter';

export const gitFolderKey = (folder: string) => {
  const path = folder.replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
};
const cache = new Map<string, { at: number; value: GitProjectStatus | null }>();
const pending = new Map<string, Promise<GitProjectStatus | null>>();

export type GitStatusTarget = { folder: string; context?: SessionGitContext | null };
export const gitStatusKey = ({ folder, context }: GitStatusTarget) => gitFolderKey(folder) + (context ? '\0' + JSON.stringify(context) : '');

async function read(target: GitStatusTarget) {
  const key = gitStatusKey(target), cached = cache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let request = pending.get(key);
  if (!request) {
    request = commands.gitProjectStatus(target.folder, target.context).then(value => {
      cache.set(key, { at: Date.now(), value });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

/** Deduplicate identical targets, with at most two reads in flight. */
export function useProjectGitStatuses(targets: GitStatusTarget[]) {
  const signature = JSON.stringify([...new Map(targets.filter(target => target.folder).map(target => [gitStatusKey(target), target])).entries()].sort(([a], [b]) => a.localeCompare(b)));
  const [statuses, setStatuses] = useState<Map<string, GitProjectStatus | null>>(new Map());
  useEffect(() => {
    if (!isTauri) return;
    const paths: [string, GitStatusTarget][] = JSON.parse(signature);
    if (!paths.length) return;
    let cancelled = false, inFlight = false, foreground = true;
    const refresh = async () => {
      if (cancelled || inFlight || !foreground || document.hidden) return;
      inFlight = true;
      let next = 0;
      const worker = async () => {
        while (!cancelled && foreground && next < paths.length) {
          const [key, target] = paths[next++];
          try {
            const value = await read(target);
            if (!cancelled) setStatuses(previous => {
              if (previous.get(key) === value && previous.has(key)) return previous;
              return new Map(previous).set(key, value);
            });
          } catch { /* Unknown/unavailable is never reported as a failed CI check. */ }
        }
      };
      await Promise.all([worker(), worker()]);
      inFlight = false;
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const unsubscribeForeground = onWindowForeground(() => { foreground = true; void refresh(); });
    const unsubscribeBackground = onWindowBackground(() => { foreground = false; });
    return () => { cancelled = true; window.clearInterval(timer); unsubscribeForeground(); unsubscribeBackground(); };
  }, [signature]);
  return statuses;
}
