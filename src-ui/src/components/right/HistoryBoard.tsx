import { useState, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { isTauri } from '../../tauri';
import type { SavedSession } from '../../tauri';
import { getToolDisplayName } from '../../lib/tool-info';
import {
  prefetchHistory,
  subscribeHistory,
  getHistorySnapshot,
} from '../../lib/history-cache';
import { subscribeHidden, getHiddenSnapshot } from '../../lib/hidden-sessions';
import { subscribePinned, getPinnedSnapshot } from '../../lib/pinned-sessions';
import { SessionContextMenu, type SessionCtxMenuState } from './SessionContextMenu';
import { useTextContextMenu } from '../../lib/use-text-context-menu';
// hermes/opencode PNG assets live in src/icons-inline/ so the Launchpad
// can `?inline`-import them as data URIs and bypass the <img> async-decode
// flash. We pull the same data URIs here so HistoryBoard doesn't need a
// separate file copy on disk.
import HERMES_DATA_URL from '../../icons-inline/hermes.png?inline';
import OPENCODE_DATA_URL from '../../icons-inline/opencode.png?inline';
// Kimi Code (PNG squircle) — fixed-color brand mark, ?inline data URI.
import KIMICODE_DATA_URL from '../../icons-inline/kimicode.png?inline';
// Pi is a MONOCHROME currentColor mark (its <style> sets fill: currentColor),
// so it must render as an INLINE SVG (not an <img>) to inherit the surrounding
// text color — otherwise currentColor resolves to black and the mark is
// invisible on dark themes. CenterPanel does the same (?raw + inlineSvgIcon).
import PI_SVG from '../../icons-inline/pi.svg?raw';
// Grok Build - same monochrome currentColor mark treatment as Pi: inline SVG
// so it inherits the surrounding text color across light/dark themes.
import GROK_SVG from '../../icons-inline/grok.svg?raw';
import './HistoryBoard.css';

// Tool icons — claude/codex/qwen/antigravity load via <img src=public/...>
// because HistoryBoard mounts once at app start and never re-mounts on tab
// switch, so the one-time decode flash is invisible. Hermes/OpenCode are
// PNG-inlined to share the same bytes the Launchpad uses (no duplicate files).
//
// Antigravity covers both new agy sessions and any older Gemini-CLI
// sessions sitting in the same `~/.gemini/tmp/` dir — see
// `parse_gemini_session_jsonl` in server.rs for why we label both as
// Antigravity rather than splitting the rows by writer.

const TOOL_ICON_SRC: Record<string, string> = {
  claude:      '/icons/tools/claude.svg',
  codex:       '/icons/tools/codex.svg',
  qwen:        '/icons/tools/qwen.svg',
  antigravity: '/icons/tools/antigravity.svg',
  hermes:      HERMES_DATA_URL,
  opencode:    OPENCODE_DATA_URL,
  kimicode:    KIMICODE_DATA_URL,
  mimocode:    '/icons/tools/mimocode.svg',
};

const getToolIcon = (tool: string) => {
  // Pi is a monochrome currentColor mark — render it as an INLINE SVG so it
  // inherits the surrounding text color (theme-adaptive, matching the
  // launchpad's inlineSvgIcon treatment). An <img> would isolate the SVG and
  // resolve currentColor to black — invisible on dark themes (issue: "会话记录
  // 列表 Pi 图标一直是黑色看不清"). The other tools are fixed-color brand
  // marks (logo orange, codex gradient, kimi squircle…) and stay <img>.
  if (tool === 'pi' || tool === 'grok') {
    const svg = tool === 'pi' ? PI_SVG : GROK_SVG;
    return (
      <span
        aria-hidden
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '1em', height: '1em', flexShrink: 0 }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  const src = TOOL_ICON_SRC[tool];
  if (!src) return <div style={{ width: 14, height: 14, borderRadius: 'var(--radius-xs)', background: '#555' }}/>;
  const extra = (tool === 'hermes' || tool === 'opencode') ? { borderRadius: 'var(--radius-xs)', objectFit: 'cover' as const }
    : tool === 'kimicode' ? { borderRadius: 'var(--radius-xs)', objectFit: 'contain' as const }
    : {};
  return <img src={src} alt="" style={{ width: '1em', height: '1em', flexShrink: 0, objectFit: 'contain', ...extra }}/>;
};

const getToolName = (tool: string, _lang: string) => getToolDisplayName(tool);

// Project folder basename (e.g. "EchoBird" from "E:\EchoBird", "coffee"
// from "~/projects/coffee") — the icon already conveys the tool, so the
// text line earns its keep by showing which project the session belongs
// to. Falls back to the tool name only when cwd wasn't recorded (rare:
// legacy sessions that predate cwd capture, or whose ~/.claude.json
// project entry is gone).
const projectName = (cwd: string, tool: string) => {
  if (cwd) {
    const trimmed = cwd.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (idx >= 0) return trimmed.slice(idx + 1);
    if (trimmed) return trimmed;
  }
  return getToolName(tool, '');
};

export function HistoryBoard() {
  const t = useT();
  const { state, dispatch } = useAppState();

  // History is prefetched at app startup (see App.tsx). We just subscribe
  // to the shared cache so the panel renders instantly when data is ready.
  // The prefetch call here is idempotent — it only fires if no load ran yet.
  const { sessions: cachedSessions, status } = useSyncExternalStore(
    subscribeHistory,
    getHistorySnapshot,
    getHistorySnapshot,
  );
  // Soft-delete (hide) markers from localStorage - re-renders the list the
  // instant a user hides a session, no refresh needed.
  const hidden = useSyncExternalStore(subscribeHidden, getHiddenSnapshot);
  // Pinned (置顶) markers from localStorage - re-renders + re-sorts the list
  // the instant a pin toggles from the context menu.
  const pinned = useSyncExternalStore(subscribePinned, getPinnedSnapshot);
  const [ctxMenu, setCtxMenu] = useState<SessionCtxMenuState | null>(null);
  useEffect(() => { prefetchHistory(); }, []);
  const isLoading = isTauri && (status === 'idle' || status === 'loading') && cachedSessions.length === 0;

  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  // Agent filter dropdown: which tool's sessions to show (null = all). The
  // option list is derived from the *visible* (unhidden) data so its counts
  // always match what the list would show.
  const [activeTool, setActiveTool] = useState<string | null>(null);
  // The filter is a themed dropdown (NOT a native <select> — that can't be
  // themed, and can't even open while a terminal is active because the
  // global focus enforcer steals focus back; see FontPicker.tsx). React-
  // state controlled + portaled to body like FontPicker's.
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [filterMenuPos, setFilterMenuPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);

  const toggleFilterMenu = () => {
    if (filterMenuOpen) { setFilterMenuOpen(false); return; }
    const r = filterTriggerRef.current?.getBoundingClientRect();
    if (r) {
      // Right-align to the trigger — the menu is wider than the button and
      // the trigger hugs the rail's right edge.
      const width = Math.max(r.width, 180);
      setFilterMenuPos({ left: r.right - width, top: r.bottom + 4, width });
    }
    setFilterMenuOpen(true);
  };

  // Keep the portaled menu glued to the trigger on scroll/resize (it's
  // fixed-positioned; same pattern as FontPicker).
  useEffect(() => {
    if (!filterMenuOpen) return;
    const reposition = () => {
      const r = filterTriggerRef.current?.getBoundingClientRect();
      if (r) {
        const width = Math.max(r.width, 180);
        setFilterMenuPos({ left: r.right - width, top: r.bottom + 4, width });
      }
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [filterMenuOpen]);
  // Right-click cut/copy/paste/select menu for the search box (same one
  // Gambit/terminal/task-list use).
  const { menu: ctxMenuEl, openMenu: openCtxMenu } = useTextContextMenu();

  // Memoize baseSessions on cachedSessions so the filter useMemo below doesn't
  // re-run every render (the isTauri? ternary otherwise rebuilds a fresh array
  // literal each render, defeating the debounce — a burst of keystrokes would
  // filter the whole list once per render instead of once per debounce tick).
  const baseSessions: SavedSession[] = useMemo(() => isTauri ? cachedSessions : cachedSessions.length > 0 ? cachedSessions : [
    { id: 'mock-1', name: 'build a flash card website', tool: 'claude', cwd: '~/projects/flashcards', session_token: 'tk1', saved_at: new Date().toISOString() },
    { id: 'mock-2', name: 'build a snake game', tool: 'claude', cwd: '~/projects/snake', session_token: 'tk2', saved_at: new Date(Date.now() - 3600000).toISOString() },
    { id: 'mock-3', name: 'refactor components', tool: 'qwen', cwd: '~/projects/coffee', session_token: 'tk3', saved_at: new Date(Date.now() - 86400000 * 2).toISOString() },
  ], [cachedSessions]);

  // Chip data: per-tool session counts over the *visible* (unhidden) list,
  // most-used first so the agent you reach for most often stays leftmost.
  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of baseSessions) {
      const tool = s.tool ?? '';
      if (!tool || hidden.has(`${tool}:${s.id}`)) continue;
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [baseSessions, hidden]);

  // If the active tool vanishes from the data (e.g. all its sessions got
  // hidden), fall back to "all" instead of staring at an empty list.
  useEffect(() => {
    if (activeTool && !toolCounts.some(([tool]) => tool === activeTool)) {
      setActiveTool(null);
    }
  }, [toolCounts, activeTool]);

  // Debounce the raw query so fast typing doesn't re-filter the full session
  // list on every keystroke (history-cache can hold thousands of sessions —
  // a per-key full scan stutters). 150ms is short enough to feel instant and
  // long enough to coalesce a burst of keystrokes into one filter pass.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(sessionSearchQuery), 150);
    return () => clearTimeout(h);
  }, [sessionSearchQuery]);

  // Normalize once: trim + collapse runs of whitespace + lowercase. Empty after
  // normalization means "no query → show all". Matching against projectName(cwd)
  // too so a user can find a project's sessions by typing its folder name — the
  // folder is already printed on every card, so this is the one search
  // dimension the flat time-sorted list genuinely earns. The tool display name
  // is matched as well ("kimi" surfaces all Kimi Code sessions) — the chip row
  // below covers mouse users, this covers keyboard users. All fields are
  // null-guarded: legacy sessions can carry a blank cwd (projectName then
  // falls back to the tool display name).
  const matchedSessions = useMemo(() => {
    // Hide filter first so soft-deleted sessions never take a visible slot or
    // count toward load-more paging.
    let list = baseSessions;
    if (hidden.size > 0) {
      list = list.filter(s => !hidden.has(`${s.tool ?? ''}:${s.id}`));
    }
    // Agent chip filter (AND with the text query below).
    if (activeTool) {
      list = list.filter(s => (s.tool ?? '') === activeTool);
    }
    const q = debouncedQuery.trim().replace(/\s+/g, ' ').toLowerCase();
    if (q) {
      list = list.filter(s => {
        const name = (s.name ?? '').toLowerCase();
        const proj = projectName(s.cwd ?? '', s.tool ?? '').toLowerCase();
        const tool = getToolName(s.tool ?? '', '').toLowerCase();
        return name.includes(q) || proj.includes(q) || tool.includes(q);
      });
    }
    // Pinned (置顶) sessions sort to the top. history-cache already returns
    // saved_at desc, so a stable sort on the pinned flag keeps that order
    // within each group. Skipped entirely when nothing is pinned.
    if (pinned.size > 0) {
      list = [...list].sort((a, b) => {
        const pa = pinned.has(`${a.tool ?? ''}:${a.id}`) ? 1 : 0;
        const pb = pinned.has(`${b.tool ?? ''}:${b.id}`) ? 1 : 0;
        return pb - pa;
      });
    }
    return list;
  }, [baseSessions, debouncedQuery, hidden, pinned, activeTool]);

  // Progressive render: data is already fully in memory (history-cache reads
  // every jsonl on startup), so "load more" is just rendering more rows.
  // IntersectionObserver on a bottom sentinel bumps visibleCount when it
  // scrolls into view. Reset to PAGE on the debounced query landing — keying
  // on the raw query would reset mid-burst while results haven't changed yet,
  // making the list flap; the debounced value only moves when results actually
  // change.
  const PAGE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE);
  useEffect(() => { setVisibleCount(PAGE); }, [debouncedQuery, activeTool]);
  const filteredSessions = matchedSessions.slice(0, visibleCount);
  const hasMore = matchedSessions.length > visibleCount;
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setVisibleCount(c => c + PAGE);
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore]);

  const handleViewHistory = (saved: SavedSession) => {
    // Click = resume directly. The old flow opened a ChatReader tab (read-
    // only bubble view) and made the user click "Continue this session"
    // inside it; that intermediate step was slower than just resuming —
    // claude --resume loads its own TUI history faster than the bubble
    // view renders, and the extra tab was one more concept to navigate.
    // Now a click stages a real terminal tab with resumeToken;
    // TierTerminal's mount effect spawns `<tool> --resume <token>` in
    // saved.cwd. Sessions without a token (legacy / unresolved cwd) are
    // silently skipped — nothing to resume.
    if (!saved.session_token) return;
    const targetId = crypto.randomUUID();
    dispatch({
      type: 'ADD_TERMINAL',
      session: { id: targetId, tool: saved.tool as any, folderPath: saved.cwd, resumeToken: saved.session_token }
    });
    dispatch({ type: 'SET_ACTIVE_TERMINAL', id: targetId });
  };

  return (
    <>
      <div className="agent-session-search-row">
        <div className="agent-session-search-wrap">
          <svg className="agent-session-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            className="agent-session-search"
            placeholder={t('task.search_sessions' as any) || 'Search sessions...'}
            value={sessionSearchQuery}
            onChange={e => setSessionSearchQuery(e.target.value)}
            onContextMenu={(e) => openCtxMenu(e, setSessionSearchQuery)}
          />
        </div>
        {/* Agent filter dropdown — only worth the control when there's more
            than one agent to tell apart. Shows the active agent's icon (or
            全部), opens the portaled menu below. */}
        {toolCounts.length >= 2 && (
          <button
            ref={filterTriggerRef}
            type="button"
            className={`history-tool-filter-trigger${activeTool ? ' active' : ''}`}
            onClick={toggleFilterMenu}
          >
            {activeTool ? (
              getToolIcon(activeTool)
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
            )}
            <span className="history-tool-filter-label">
              {activeTool ? getToolName(activeTool, '') : (t('task.filter_all' as any) || 'All')}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      <div className="task-list" style={{ marginTop: '0', paddingBottom: '20px' }}>
      {isLoading && Array.from({ length: 6 }).map((_, i) => (
        <div key={`skel-${i}`} className="history-card history-card-skeleton" aria-hidden="true">
          <div className="history-card-content">
            <span className="skeleton-bar skeleton-bar-title" />
            <div className="history-card-meta">
              <span className="skeleton-bar skeleton-bar-meta" />
            </div>
          </div>
        </div>
      ))}
      {!isLoading && filteredSessions.map(session => {
        // Parse saved_at carefully to handle unix ms strings or invalid SystemTime strings
        let savedMs = Date.parse(session.saved_at);
        if (isNaN(savedMs)) {
          const num = Number(session.saved_at);
          if (!isNaN(num) && num > 0) savedMs = num < 1e11 ? num * 1000 : num;
          else savedMs = Date.now() - 86400000;
        }
        const dateDiff = Date.now() - savedMs;
        let dateStr = '';
        const now = new Date();
        const savedDate = new Date(savedMs);
        
        const isSameDay = now.getDate() === savedDate.getDate() && now.getMonth() === savedDate.getMonth() && now.getFullYear() === savedDate.getFullYear();
        
        const yesterday = new Date(Date.now() - 86400000);
        const isYesterday = yesterday.getDate() === savedDate.getDate() && yesterday.getMonth() === savedDate.getMonth() && yesterday.getFullYear() === savedDate.getFullYear();

        if (dateDiff < 3600000) {
          dateStr = t('time.just_now' as any) || 'Just now';
        } else if (isSameDay) {
          dateStr = t('time.today' as any) || 'Today';
        } else if (isYesterday) {
          dateStr = t('time.yesterday' as any) || 'Yesterday';
        } else {
          const days = Math.floor(dateDiff / 86400000);
          if (days < 7) {
            dateStr = (t('time.days_ago' as any) || '{days} days ago').replace('{days}', days.toString());
          } else {
            const locale = state.currentLang === 'zh-CN' ? 'zh-CN' : 'en-US';
            dateStr = savedDate.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
          }
        }

        const isPinnedSession = pinned.has(`${session.tool ?? ''}:${session.id}`);
        return (
          <div
            key={session.id}
            className="history-card"
            onClick={() => handleViewHistory(session)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtxMenu({ session, x: e.clientX, y: e.clientY });
            }}
          >
            <div className="history-card-content">
              <span className="history-card-title">{session.name}</span>
              <div className="history-card-meta">
                <span className="history-card-tool-wrap">
                  {getToolIcon(session.tool)}
                  <span>{projectName(session.cwd, session.tool)} &middot; {dateStr} {session.turn_count ? ` \u00B7 ${(t('task.messages' as any) || '{count} messages').replace('{count}', session.turn_count.toString())}` : ''}</span>
                </span>
                {isPinnedSession && (
                  <span className="history-card-pin" aria-hidden="true">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 17v5"/>
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
                    </svg>
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {hasMore && (
        <>
          {/* Skeleton placeholders give immediate visual feedback that
           * "more is coming" the moment scroll reaches the end —
           * without them React's brief commit gap reads as "stuck".
           * Sentinel sits at the bottom of the skeleton group so the
           * observer fires while the user is still scrolling through
           * them, by which point the next batch is already rendered. */}
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={`load-skel-${i}`} className="history-card history-card-skeleton" aria-hidden="true">
              <div className="history-card-content">
                <span className="skeleton-bar skeleton-bar-title" />
                <div className="history-card-meta">
                  <span className="skeleton-bar skeleton-bar-meta" />
                </div>
              </div>
            </div>
          ))}
          <div ref={sentinelRef} style={{ height: 1 }} />
        </>
      )}

      {!isLoading && filteredSessions.length === 0 && (
        <div className="task-empty">
          <div className="task-empty-text">{t('menu.no_recent' as any) || 'No recent sessions'}</div>
        </div>
      )}
    </div>
    {filterMenuOpen && filterMenuPos && createPortal(
      <>
        <div className="history-tool-filter-backdrop" onClick={() => setFilterMenuOpen(false)} />
        <div
          className="history-tool-filter-menu"
          style={{ position: 'fixed', left: filterMenuPos.left, top: filterMenuPos.top, width: filterMenuPos.width }}
        >
          <button
            type="button"
            className={`history-tool-filter-opt${activeTool === null ? ' active' : ''}`}
            onClick={() => { setActiveTool(null); setFilterMenuOpen(false); }}
          >
            <span className="history-tool-filter-opt-name">{t('task.filter_all' as any) || 'All'}</span>
            <span className="history-tool-filter-count">{toolCounts.reduce((n, [, c]) => n + c, 0)}</span>
          </button>
          {toolCounts.map(([tool, count]) => (
            <button
              type="button"
              key={tool}
              className={`history-tool-filter-opt${activeTool === tool ? ' active' : ''}`}
              onClick={() => { setActiveTool(activeTool === tool ? null : tool); setFilterMenuOpen(false); }}
            >
              {getToolIcon(tool)}
              <span className="history-tool-filter-opt-name">{getToolName(tool, '')}</span>
              <span className="history-tool-filter-count">{count}</span>
            </button>
          ))}
        </div>
      </>,
      document.body
    )}
    {ctxMenu && <SessionContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
    {ctxMenuEl}
  </>
  );
}
