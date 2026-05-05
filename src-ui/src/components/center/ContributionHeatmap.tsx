import { useEffect, useMemo, useState } from 'react';
import { isTauri, commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import './ContributionHeatmap.css';

// 26 weeks ≈ 6 months. Half-year view keeps activity dense enough that
// the grid reads as a heatmap (not a sparsely-lit bar) for any user
// who's been active in the last few weeks.
const WEEKS = 26;
const DAYS = 7;

interface DayCell {
  date: string; // YYYY-MM-DD in local time
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Square-root scaling so a single 500-message marathon day doesn't
// squash the rest of the grid into level 1. Matches GitHub's behaviour
// where the ramp is perceptual, not strictly linear.
function levelFor(count: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (max <= 1) return 1;
  const ratio = Math.sqrt(count) / Math.sqrt(max);
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

// Heatmap data only changes day-by-day. Re-fetching every time the user
// switches launchpad ↔ tool tab (the component remounts on each visit)
// runs the 6-tool jsonl scan + opencode SQLite scan all over again. Cache
// the fetched entries keyed by today's localDayKey so:
//   - within one session: module-level memory hit, no API call at all
//   - across app restarts within same day: localStorage hit, skip the
//     Rust scan entirely
//   - new day: cache miss, fresh scan, both layers updated
//
// localStorage failures (private mode, quota exceeded) are silently
// ignored — the module-level cache still prevents intra-session refetch.
type HeatmapEntry = { ts: number; count: number };
type HeatmapCache = { date: string; entries: HeatmapEntry[]; fetchedAt: number };
const HEATMAP_CACHE_KEY = 'cc-heatmap-cache';
// Refetch coalescing window. Within this TTL, repeat mounts (user toggling
// between launchpad ↔ tool tab) skip the IPC call entirely. Past it, we
// rescan so heatmap reflects intra-day activity (new sessions, new messages
// in long-running CLI tabs). Backend `count_cache` keeps the rescan cheap —
// any jsonl whose mtime is unchanged skips the file read.
const FRESH_TTL_MS = 60_000;
let memoryCache: HeatmapCache | null = null;

function readPersistedHeatmapCache(): HeatmapCache | null {
  try {
    const raw = localStorage.getItem(HEATMAP_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HeatmapCache;
    if (typeof parsed?.date === 'string' && Array.isArray(parsed?.entries)) {
      // Older cache versions didn't store fetchedAt — treat as stale so
      // the next mount triggers a fresh scan rather than reusing yesterday's
      // numbers indefinitely.
      if (typeof parsed.fetchedAt !== 'number') parsed.fetchedAt = 0;
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writePersistedHeatmapCache(cache: HeatmapCache) {
  try {
    localStorage.setItem(HEATMAP_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

// Convert raw heatmap entries into the (messages, sessions) per-day Maps
// the component renders. Pulled out as a pure function so it can be called
// from both `useState` lazy init (first paint already has cached data, no
// empty-grid flash) and `useEffect` (post-fetch update).
function entriesToBuckets(entries: HeatmapEntry[]): {
  messages: Map<string, number>;
  sessions: Map<string, number>;
} {
  const messages = new Map<string, number>();
  const sessions = new Map<string, number>();
  for (const e of entries) {
    const key = localDayKey(new Date(e.ts * 1000));
    messages.set(key, (messages.get(key) ?? 0) + e.count);
    sessions.set(key, (sessions.get(key) ?? 0) + 1);
  }
  return { messages, sessions };
}

// Pick the freshest valid cache (memory beats localStorage; both must
// match today's date) for first-render state seeding. Returns null on
// any miss so callers can decide whether to fetch.
function pickInitialCache(): HeatmapCache | null {
  const today = localDayKey(new Date());
  if (memoryCache && memoryCache.date === today) return memoryCache;
  const persisted = readPersistedHeatmapCache();
  if (persisted && persisted.date === today) {
    memoryCache = persisted; // hydrate module cache so next mount skips localStorage too
    return persisted;
  }
  return null;
}

export function ContributionHeatmap() {
  const t = useT();
  // Lazy initializers seed state from cache BEFORE the first render — when
  // the user switches launchpad ↔ tool tab there's no empty-grid flash
  // because by paint time the buckets are already populated.
  const initialCache = pickInitialCache();
  const initialBuckets = initialCache ? entriesToBuckets(initialCache.entries) : null;
  const [buckets, setBuckets] = useState<Map<string, number>>(
    () => initialBuckets?.messages ?? new Map()
  );
  const [sessionBuckets, setSessionBuckets] = useState<Map<string, number>>(
    () => initialBuckets?.sessions ?? new Map()
  );
  const [loaded, setLoaded] = useState(initialCache !== null);

  useEffect(() => {
    if (!isTauri) {
      setLoaded(true);
      return;
    }
    // Skip the fetch ONLY if the cache is genuinely fresh (within TTL).
    // The previous "skip if same-day cache exists" check meant new sessions
    // created later in the day never showed up — heatmap was effectively
    // frozen from the morning's first scan until the day rolled over.
    if (initialCache && Date.now() - initialCache.fetchedAt < FRESH_TTL_MS) return;

    let cancelled = false;
    const today = localDayKey(new Date());

    commands.getMessageHeatmap()
      .then(entries => {
        if (cancelled) return;
        const cache: HeatmapCache = { date: today, entries, fetchedAt: Date.now() };
        memoryCache = cache;
        writePersistedHeatmapCache(cache);
        const next = entriesToBuckets(entries);
        setBuckets(next.messages);
        setSessionBuckets(next.sessions);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const { cells, total, totalMessages, totalSessions } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + (6 - today.getDay()));

    const grid: DayCell[][] = [];
    let max = 0;
    let periodMessages = 0;
    let periodSessions = 0;
    for (let col = 0; col < WEEKS; col++) {
      const week: DayCell[] = [];
      for (let row = 0; row < DAYS; row++) {
        const d = new Date(endDate);
        d.setDate(d.getDate() - ((WEEKS - 1 - col) * 7 + (DAYS - 1 - row)));
        const key = localDayKey(d);
        const count = buckets.get(key) ?? 0;
        const isFuture = d.getTime() > today.getTime();
        if (!isFuture) {
          periodMessages += count;
          periodSessions += sessionBuckets.get(key) ?? 0;
        }
        if (count > max) max = count;
        week.push({ date: key, count, level: 0, future: isFuture });
      }
      grid.push(week);
    }
    for (const week of grid) {
      for (const cell of week) {
        cell.level = levelFor(cell.count, max);
      }
    }
    let allTotal = 0;
    for (const v of buckets.values()) allTotal += v;
    return {
      cells: grid,
      total: allTotal,
      totalMessages: periodMessages,
      totalSessions: periodSessions,
    };
  }, [buckets, sessionBuckets]);

  const headerLabel = !loaded
    ? ''
    : total === 0
      ? t('heatmap.title_empty')
      : t('heatmap.title', {
          sessions: totalSessions.toLocaleString(),
          messages: totalMessages.toLocaleString(),
        });

  return (
    <div className={`heatmap-card${!loaded ? ' heatmap-loading' : ''}`}>
      <div
        className="heatmap-grid"
        role="img"
        aria-label={headerLabel || 'Activity heatmap'}
      >
        {cells.map((week, col) => (
          <div key={col} className="heatmap-week">
            {week.map(cell => {
              const tip = cell.future
                ? ''
                : cell.count === 0
                  ? t('heatmap.tooltip_none', { date: cell.date })
                  : cell.count === 1
                    ? t('heatmap.tooltip_one', { date: cell.date })
                    : t('heatmap.tooltip_some', { count: cell.count, date: cell.date });
              return (
                <div
                  key={cell.date}
                  className="heatmap-cell"
                  data-level={cell.future ? -1 : cell.level}
                  data-tip={tip || undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="heatmap-header">
        <span className="heatmap-title">{headerLabel}</span>
        <div className="heatmap-legend" aria-hidden>
          <span>{t('heatmap.legend_less')}</span>
          <div className="heatmap-cell heatmap-legend-cell" data-level="0" />
          <div className="heatmap-cell heatmap-legend-cell" data-level="1" />
          <div className="heatmap-cell heatmap-legend-cell" data-level="2" />
          <div className="heatmap-cell heatmap-legend-cell" data-level="3" />
          <div className="heatmap-cell heatmap-legend-cell" data-level="4" />
          <span>{t('heatmap.legend_more')}</span>
        </div>
      </div>
    </div>
  );
}
