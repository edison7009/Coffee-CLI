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

export function ContributionHeatmap() {
  const t = useT();
  const [buckets, setBuckets] = useState<Map<string, number>>(new Map());
  const [sessionBuckets, setSessionBuckets] = useState<Map<string, number>>(new Map());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    commands.getMessageHeatmap()
      .then(entries => {
        if (cancelled) return;
        const messages = new Map<string, number>();
        const sessions = new Map<string, number>();
        for (const e of entries) {
          const key = localDayKey(new Date(e.ts * 1000));
          messages.set(key, (messages.get(key) ?? 0) + e.count);
          sessions.set(key, (sessions.get(key) ?? 0) + 1);
        }
        setBuckets(messages);
        setSessionBuckets(sessions);
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
