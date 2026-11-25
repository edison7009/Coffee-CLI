import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { commands, isTauri, type GitProjectStatus, type SessionGitContext } from '../tauri';
import { onWindowBackground, onWindowForeground } from './window-focus-filter';

export const gitFolderKey = (folder: string) => {
  const path = folder.replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
};
const cache = new Map<string, { at: number; value: GitProjectStatus | null }>();
const pending = new Map<string, Promise<GitProjectStatus | null>>();
const STORAGE_KEY = 'cc-project-git-status-v1';
const MAX_SNAPSHOT_ENTRIES = 256;

function validStatus(value: unknown): value is GitProjectStatus | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const status = value as GitProjectStatus, pr = status.pull_request;
  return typeof status.repo_root === 'string' && typeof status.branch === 'string'
    && ['ok', 'unavailable', 'not_github'].includes(status.github)
    && (pr === null || Boolean(pr && Number.isSafeInteger(pr.number) && pr.number > 0
      && typeof pr.url === 'string' && pr.url.startsWith('https://github.com/')
      && ['open', 'draft', 'merged', 'closed'].includes(pr.state)
      && (pr.ci === null || ['success', 'failure', 'pending'].includes(pr.ci))));
}

try {
  const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  if (Array.isArray(saved)) for (const entry of saved.slice(-MAX_SNAPSHOT_ENTRIES)) {
    if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && validStatus(entry[1])) {
      // Restored values render immediately; their first refresh still checks native state.
      cache.set(entry[0], { at: 0, value: entry[1] });
    }
  }
} catch { /* An unavailable or corrupt snapshot does not prevent live reads. */ }
let snapshot = new Map([...cache].map(([key, entry]) => [key, entry.value]));
const listeners = new Set<() => void>();
const getSnapshot = () => snapshot;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function publish() {
  snapshot = new Map([...cache].map(([key, entry]) => [key, entry.value]));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...snapshot].slice(-MAX_SNAPSHOT_ENTRIES))); } catch { /* Memory remains available. */ }
  listeners.forEach(listener => listener());
}

export type GitStatusTarget = { folder: string; context?: SessionGitContext | null };
export const gitStatusKey = ({ folder, context }: GitStatusTarget) => gitFolderKey(folder) + (context ? '\0' + JSON.stringify(context) : '');

async function read(target: GitStatusTarget) {
  const key = gitStatusKey(target), cached = cache.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let request = pending.get(key);
  if (!request) {
    request = commands.gitProjectStatus(target.folder, target.context).then(value => {
      const previous = cache.get(key)?.value;
      if (value?.github === 'unavailable' && !value.pull_request && previous?.pull_request
        && gitFolderKey(value.repo_root) === gitFolderKey(previous.repo_root) && value.branch === previous.branch) {
        value = { ...value, pull_request: previous.pull_request };
      }
      const unchanged = JSON.stringify(previous) === JSON.stringify(value);
      if (unchanged && previous !== undefined) value = previous;
      cache.delete(key);
      cache.set(key, { at: Date.now(), value });
      if (!unchanged) publish();
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

/** Deduplicate identical targets, with at most two reads in flight. */
export function useProjectGitStatuses(targets: GitStatusTarget[]) {
  const signature = JSON.stringify([...new Map(targets.filter(target => target.folder).map(target => [gitStatusKey(target), target])).entries()].sort(([a], [b]) => a.localeCompare(b)));
  const statuses = useSyncExternalStore(subscribe, getSnapshot);
  const selected = useMemo(() => {
    const result = new Map<string, GitProjectStatus | null>();
    for (const [key] of JSON.parse(signature) as [string, GitStatusTarget][]) {
      if (statuses.has(key)) result.set(key, statuses.get(key)!);
    }
    return result;
  }, [signature, statuses]);
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
          const [, target] = paths[next++];
          try {
            await read(target);
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
  return selected;
}
