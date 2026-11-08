import type { I18nKey } from '../i18n/en';
// Automations: a prompt sent on a schedule to a new desktop conversation of a chosen tool, in a chosen folder.
// They run while Coffee is open; one missed while it was closed runs once when it opens again.

export type AutomationTool = 'claude' | 'codex' | 'dsh' | 'opencode' | 'pi';
export const AUTOMATION_TOOLS: AutomationTool[] = ['claude', 'codex', 'dsh', 'opencode', 'pi'];

export type AutomationSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  /** Days are 0 (Sunday) to 6, any number of them. */
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; minutes: number };

/** The shortest interval: each run opens a new conversation. */
export const MIN_INTERVAL_MINUTES = 5;

export interface AutomationRun { at: number; sessionId?: string; ok: boolean; error?: string }

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  tool: AutomationTool;
  cwd: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  createdAt: number;
  /** When it runs next; undefined once a one-off has run or it is paused. */
  nextAt?: number;
  lastRun?: AutomationRun;
}

const STORAGE_KEY = 'cc-automations';
const DAY = 24 * 60 * 60 * 1000;

function parseTime(time: string): [number, number] {
  const [h, m] = time.split(':').map(Number);
  return [Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 9, Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0];
}

/** The first run strictly after `after`, or undefined when there is none (a one-off already past). */
export function nextRunAt(schedule: AutomationSchedule, after: number, anchor = after): number | undefined {
  switch (schedule.kind) {
    case 'once': return schedule.at > after ? schedule.at : undefined;
    case 'interval': {
      const step = Math.max(MIN_INTERVAL_MINUTES, Math.round(schedule.minutes)) * 60 * 1000;
      if (anchor > after) return anchor;
      return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    default: {
      const [h, m] = parseTime(schedule.time);
      const start = new Date(after);
      for (let offset = 0; offset <= 8; offset++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, h, m, 0, 0);
        if (day.getTime() <= after) continue;
        const weekday = day.getDay();
        if (schedule.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
        if (schedule.kind === 'weekly' && !schedule.days.includes(weekday)) continue;
        return day.getTime();
      }
      return after + DAY;
    }
  }
}

/** Sets when an automation runs next: from now on edits and resumes, after the run that just happened otherwise. */
export function scheduleNext(automation: Automation, after: number): Automation {
  const nextAt = automation.enabled ? nextRunAt(automation.schedule, after, automation.schedule.kind === 'interval' ? (automation.lastRun?.at ?? automation.createdAt) : after) : undefined;
  // A one-off with nothing left to run turns itself off.
  return { ...automation, nextAt, enabled: automation.enabled && nextAt !== undefined };
}

function load(): Automation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Automation => !!item && typeof item === 'object' && typeof (item as Automation).id === 'string' && AUTOMATION_TOOLS.includes((item as Automation).tool))
      // Intervals were once whole hours, and a week had one day.
      .map(item => {
        const s = item.schedule as { kind: string; hours?: number; minutes?: number; day?: number; days?: number[]; time?: string };
        if (s.kind === 'interval' && typeof s.minutes !== 'number') return { ...item, schedule: { kind: 'interval', minutes: (s.hours ?? 1) * 60 } };
        if (s.kind === 'weekly' && !Array.isArray(s.days)) return { ...item, schedule: { kind: 'weekly', days: [s.day ?? 1], time: s.time ?? '09:00' } };
        return item;
      });
  } catch { return []; }
}

let automations = load();
const listeners = new Set<() => void>();
export const getAutomations = (): Automation[] => automations;
export function subscribeAutomations(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setAutomations(update: (current: Automation[]) => Automation[]): void {
  automations = update(automations);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(automations)); } catch { /* Best-effort operation; failure is non-fatal. */ }
  listeners.forEach(listener => listener());
}
export function saveAutomation(automation: Automation): void {
  const next = scheduleNext(automation, Date.now());
  setAutomations(current => current.some(item => item.id === next.id) ? current.map(item => item.id === next.id ? next : item) : [...current, next]);
}
export function removeAutomation(id: string): void { setAutomations(current => current.filter(item => item.id !== id)); }
/** Due now: enabled, with a next run at or before `now`. */
export const dueAutomations = (now: number): Automation[] => automations.filter(item => item.enabled && item.nextAt !== undefined && item.nextAt <= now);
/** Runs one automation now, outside its schedule (the runner listens for this). */
export function runAutomationNow(id: string): void { window.dispatchEvent(new CustomEvent('coffee-run-automation', { detail: id })); }

/** The last segment of a folder path, as rows and chips show it. */
export const folderName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/** How often an automation runs, in a few words: "Daily 09:00", "Every 1 h 30 min", "Mon 09:00" or a one-off date. */
export function scheduleSummary(s: AutomationSchedule, t: (key: I18nKey, vars?: Record<string, string | number>) => string, lang: string): string {
  if (s.kind === 'once') return new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(s.at);
  if (s.kind === 'interval') {
    const h = Math.floor(s.minutes / 60), m = s.minutes % 60;
    return t('automation.summary.interval', { every: [h ? `${h} ${t('automation.unit.h')}` : '', m ? `${m} ${t('automation.unit.min')}` : ''].filter(Boolean).join(' ') });
  }
  if (s.kind === 'weekly') {
    const day = new Intl.DateTimeFormat(lang, { weekday: 'short' });
    // Monday first, as the editor lists them.
    const days = [...s.days].sort((a, b) => (a || 7) - (b || 7)).map(d => day.format(new Date(2024, 0, 7 + d)));
    return `${new Intl.ListFormat(lang, { style: 'narrow', type: 'unit' }).format(days)} ${s.time}`;
  }
  return t(s.kind === 'weekdays' ? 'automation.summary.weekdays' : 'automation.summary.daily', { time: s.time });
}
