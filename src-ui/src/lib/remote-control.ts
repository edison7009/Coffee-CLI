// Controlling other computers: each opens in a window of its own (src/remote_window.rs) showing
// that computer's Web 端 page. This module turns what the user pastes into that page's address and
// remembers recent computers so they reopen without pairing again (the page keeps its own key).
import { parsePairingLink } from '../remote/protocol';

/** `name` is the computer's name once its page connects, `host:port` before; `title` adds the window's prefix. */
export interface RemoteWindow { label: string; name: string; title: string; origin: string }
export interface RecentRemote { origin: string; title: string; usedAt: number }

/**
 * The other computer's Web 端 address, from either thing its Settings → 设备连接 offers: the address
 * (`http://host:port/?remote#pair=…`) or the bare pairing link (`coffeecli://pair?…`). Null otherwise.
 */
export function controlAddress(text: string): string | null {
  const value = text.trim();
  if (/^coffeecli:\/\/pair\?/i.test(value)) {
    try {
      const link = parsePairingLink(value);
      const host = link.hosts[0].includes(':') ? `[${link.hosts[0]}]` : link.hosts[0];
      return `http://${host}:${link.port}/?remote#pair=${encodeURIComponent(value)}`;
    } catch { return null; }
  }
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || !url.searchParams.has('remote')) return null;
    return url.href;
  } catch { return null; }
}

/** `http://host:port` of an address, which identifies the computer. */
export function originOf(address: string): string {
  try { return new URL(address).origin; } catch { return ''; }
}

const RECENT_KEY = 'cc-remote-recent';
const RECENT_MAX = 8;

export function loadRecentRemotes(): RecentRemote[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter(item => typeof item?.origin === 'string' && typeof item?.title === 'string').slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

function saveRecentRemotes(list: RecentRemote[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch { /* the list is a convenience */ }
}

/** Most recent first; one entry per computer. A known name is kept over the `host:port` placeholder. */
export function rememberRemote(origin: string, title: string, now = Date.now()): RecentRemote[] {
  const previous = loadRecentRemotes();
  const old = previous.find(item => item.origin === origin);
  const placeholder = !title || origin.endsWith(`//${title}`);
  const keep = old && placeholder ? old.title : title;
  const next = [{ origin, title: keep || old?.title || origin, usedAt: now }, ...previous.filter(item => item.origin !== origin)];
  saveRecentRemotes(next);
  return next.slice(0, RECENT_MAX);
}

export function forgetRemote(origin: string): RecentRemote[] {
  const next = loadRecentRemotes().filter(item => item.origin !== origin);
  saveRecentRemotes(next);
  return next;
}

/** Reopening a recent computer: its page reconnects with the key it saved when it paired. */
export function recentAddress(origin: string): string {
  return `${origin}/?remote`;
}

/** `a` is an older x.y.z version than `b`. Anything unreadable counts as not older. */
export function olderThan(a: string, b: string): boolean {
  const parse = (v: string) => v.trim().replace(/^v/, '').split(/[.-]/).slice(0, 3).map(n => Number(n));
  const x = parse(a), y = parse(b);
  if (x.length < 3 || y.length < 3 || [...x, ...y].some(n => !Number.isFinite(n))) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}
