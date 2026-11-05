import bundledNotes from '../../../install/release-notes-template.md?raw';
import { fetchNotesForVersion } from './update-manifest';

export const BUNDLED_VERSION = bundledNotes.match(/^### Coffee CLI v(\d+\.\d+\.\d+)/m)?.[1] ?? '';
export const RELEASE_NOTES_SEEN = 'cc-release-notes-seen';
const CACHE_KEY = 'cc-release-notes';

export function shouldShowReleaseNotes(version: string, seen: string | null): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  if (!seen || !/^\d+\.\d+\.\d+$/.test(seen)) return true;
  const current = version.split('.').map(Number), previous = seen.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (current[i] !== previous[i]) return current[i] > previous[i];
  }
  return false;
}

export function notesForLocale(notes: string, locale: string): string {
  const sections = [...notes.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)];
  if (!sections.length) return notes.trim();
  const labels: Record<string, string> = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어' };
  const picked = sections.find(section => section[1].includes(labels[locale] ?? 'English'))
    ?? sections.find(section => section[1].includes('English')) ?? sections[0];
  return picked[2].trim();
}

export function cachedReleaseNotes(version: string): string {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (cached?.version === version && typeof cached.notes === 'string' && cached.notes.trim()) return cached.notes;
  } catch { /* Optional local cache. */ }
  return version === BUNDLED_VERSION ? bundledNotes : '';
}

export async function loadReleaseNotes(version: string, signal: AbortSignal): Promise<string> {
  // Mirrors first, then the website (see update-manifest.ts); GitHub's
  // release API is the last resort.
  let notes = await fetchNotesForVersion(version, signal);
  if (!notes.trim()) {
    const response = await fetch(`https://api.github.com/repos/edison7009/Coffee-CLI/releases/tags/v${encodeURIComponent(version)}`, { signal });
    if (!response.ok) throw new Error('Release notes unavailable');
    const release = await response.json();
    if (release.tag_name !== `v${version}` || release.draft || typeof release.body !== 'string') throw new Error('Release notes do not match the installed version');
    notes = release.body;
  }
  if (!notes.trim()) throw new Error('Release notes are empty');
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ version, notes })); } catch { /* Optional local cache. */ }
  return notes;
}
