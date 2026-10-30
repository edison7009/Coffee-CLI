// Plan usage and balance for the endpoint a tab's CLI is configured to call.
// Official sign-ins report through the CLI's own protocol (Claude get_usage,
// Codex account/rateLimits/read); third-party keys are resolved read-only from
// the tool's configuration by the backend (src/usage_quota). Anything missing
// hides the meter: there is no failure state.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../tauri';
import { controlClaude, useClaudeSession } from './claude-session';
import { readCodexRateLimits, useCodexSession } from './codex-session';

export type QuotaPeriod = 'fiveHour' | 'daily' | 'weekly' | 'monthly';
export interface Quota { period?: QuotaPeriod; used?: number; resetAt?: number; balance?: number; unit?: string }

type Json = Record<string, unknown>;
const REFRESH_MS = 60_000;
// Turn ends refresh conversation tabs; terminal tabs have no turn signal. A slow
// poll keeps both honest without asking the CLI or provider every minute.
const IDLE_REFRESH_MS = 5 * 60_000;
const ORDER: QuotaPeriod[] = ['fiveHour', 'daily', 'weekly', 'monthly'];

const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined;
const obj = (value: unknown): Json => value && typeof value === 'object' ? value as Json : {};

function periodFromMinutes(minutes: number | undefined): QuotaPeriod | undefined {
  if (!minutes) return undefined;
  return minutes <= 300 ? 'fiveHour' : minutes <= 1440 ? 'daily' : minutes <= 10080 ? 'weekly' : 'monthly';
}

export function claudeQuotas(response: Json): Quota[] {
  if (response.rate_limits_available === false) return [];
  const limits = obj(response.rate_limits);
  return ([['five_hour', 'fiveHour'], ['seven_day', 'weekly']] as const).flatMap(([key, period]) => {
    const window = obj(limits[key]), used = num(window.utilization);
    const resetAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : undefined;
    return used === undefined ? [] : [{ period, used, resetAt: resetAt && Number.isFinite(resetAt) ? resetAt : undefined }];
  });
}

export function codexQuotas(response: Json): Quota[] {
  const limits = obj(response.rateLimits);
  const windows = [limits.primary, limits.secondary].map(obj).flatMap(window => {
    const used = num(window.usedPercent), reset = num(window.resetsAt);
    return used === undefined ? [] : [{ period: periodFromMinutes(num(window.windowDurationMins)), used, resetAt: reset ? reset * 1000 : undefined }];
  });
  const credits = obj(limits.credits), balance = num(credits.balance);
  return credits.hasCredits === true && credits.unlimited !== true && balance !== undefined ? [...windows, { balance, unit: 'credits' }] : windows;
}

export function providerQuotas(quotas: unknown): Quota[] {
  return (Array.isArray(quotas) ? quotas : []).map(obj).flatMap((quota): Quota[] => {
    const balance = num(quota.balance);
    if (balance !== undefined) return [{ balance, unit: typeof quota.balanceUnit === 'string' ? quota.balanceUnit : undefined }];
    const used = num(quota.percentage);
    const period = ORDER.includes(quota.period as QuotaPeriod) ? quota.period as QuotaPeriod : undefined;
    return used === undefined ? [] : [{ period, used, resetAt: num(quota.resetAt) || undefined }];
  });
}

/** Windows first (shortest period first), then a balance, at most two meters. */
export function visibleQuotas(quotas: Quota[]): Quota[] {
  const windows = quotas.filter(q => q.balance === undefined).sort((a, b) => (a.period ? ORDER.indexOf(a.period) : 9) - (b.period ? ORDER.indexOf(b.period) : 9));
  return [...windows, ...quotas.filter(q => q.balance !== undefined).slice(0, 1)].slice(0, 2);
}

export function remainingPercent(quota: Quota): number {
  return Math.min(100, Math.max(0, 100 - (quota.used ?? 0)));
}

export function compactCountdown(resetAt: number | undefined, now: number): string {
  if (!resetAt || !Number.isFinite(resetAt)) return '';
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
}

export function formatBalance(quota: Quota): string {
  const amount = (quota.balance ?? 0).toFixed(2), unit = quota.unit?.toUpperCase();
  return unit === 'CNY' ? `¥${amount}` : unit === 'USD' ? `$${amount}` : unit ? `${amount} ${quota.unit}` : amount;
}

export function useUsageQuota(id: string, tool: string | undefined, cwd: string | undefined, conversation: 'claude' | 'codex' | null): Quota[] {
  // Keyed so a tab switch never shows the previous tab's numbers while loading.
  const [result, setResult] = useState<{ key: string; quotas: Quota[] }>({ key: '', quotas: [] });
  const claudeIdle = useClaudeSession(conversation === 'claude' ? id : '', s => s.ready && !s.busy);
  const codexIdle = useCodexSession(conversation === 'codex' ? id : '', s => s.ready && !s.busy);
  // Becomes true when the session is ready and idle: at start and after each turn.
  const idle = conversation === 'claude' ? claudeIdle : conversation === 'codex' ? codexIdle : true;
  const last = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const key = `${id}\n${tool ?? ''}\n${cwd ?? ''}`;

  useEffect(() => {
    if (!tool) return;
    let cancelled = false;
    const load = async (force: boolean) => {
      if (!force && Date.now() - last.current.at < REFRESH_MS) return;
      last.current = { key, at: Date.now() };
      try {
        const route = await invoke<Json>('usage_quota_query', { tool, cwd: cwd ?? null });
        let next: Quota[] = [];
        if (route.kind === 'provider') next = providerQuotas(route.quotas);
        else if (route.kind === 'official' && conversation === 'claude') next = claudeQuotas(await controlClaude(id, { subtype: 'get_usage', skip_behaviors: true }) as Json);
        else if (route.kind === 'official' && conversation === 'codex') next = codexQuotas(await readCodexRateLimits(id) as Json);
        if (!cancelled) setResult({ key, quotas: next });
      } catch {
        if (!cancelled) setResult({ key, quotas: [] });
      }
    };
    if (!idle) return () => { cancelled = true; };
    void load(last.current.key !== key);
    const timer = setInterval(() => { void load(false); }, IDLE_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [id, tool, cwd, conversation, idle, key]);

  return tool && result.key === key ? result.quotas : [];
}
