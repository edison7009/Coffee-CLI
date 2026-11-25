import { invoke } from '../tauri';

export interface UsageSummary {
  sessions: number; prompts: number; calls: number; days: number;
  input: number | null; output: number | null; cacheRead: number | null;
  cacheWrite: number | null; reasoning: number | null; tokens: number | null;
}
export interface UsageGroup { key: string; summary: UsageSummary }
export interface UsageReport {
  summary: UsageSummary; daily: UsageGroup[]; models: UsageGroup[]; projects: string[];
  sources: { tool: string; name?: string; files: number; available: boolean; errors: number }[];
}

const SNAPSHOT_KEY = 'cc-usage-snapshots-v1';
const snapshots = new Map<string, UsageReport>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) ?? 'null');
  if (Array.isArray(saved)) {
    for (const entry of saved.slice(-12)) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, report] = entry;
      if (typeof key === 'string' && report?.summary && Array.isArray(report.daily)
        && Array.isArray(report.models) && Array.isArray(report.projects) && Array.isArray(report.sources)) {
        snapshots.set(key, report);
      }
    }
  }
} catch { /* Unavailable or invalid storage starts with an empty snapshot cache. */ }

export function readUsageSnapshot(key: string) { return snapshots.get(key) ?? null; }
export function writeUsageSnapshot(key: string, report: UsageReport) {
  snapshots.delete(key);
  snapshots.set(key, report);
  // Keep only recent filter combinations so the persistent cache stays small.
  if (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value!);
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify([...snapshots])); }
  catch { /* The in-memory snapshot remains usable when storage is unavailable. */ }
}

export function getUsageStatistics(query: { from: number; to: number; tool: string; project: string }) {
  return invoke<UsageReport>('get_usage_statistics', { query });
}

export function usageRange(days: number, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days + 1);
  return { from: Math.floor(start.getTime() / 1000), to: Math.floor(now.getTime() / 1000) + 1 };
}
export function localDay(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
export function usageDays(daily: UsageGroup[], days: number) {
  const values = new Map(daily.map(day => [day.key, day.summary]));
  const start = new Date(usageRange(days).from * 1000);
  return Array.from({ length: days }, (_, index) => { const date = new Date(start); date.setDate(date.getDate() + index); const key = localDay(date); return { key, tokens: values.get(key)?.tokens ?? 0, sessions: values.get(key)?.sessions ?? 0 }; });
}
