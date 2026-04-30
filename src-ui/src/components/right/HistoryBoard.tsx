import { useState, useEffect, useSyncExternalStore } from 'react';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { isTauri } from '../../tauri';
import type { SavedSession } from '../../tauri';
import {
  prefetchHistory,
  subscribeHistory,
  getHistorySnapshot,
} from '../../lib/history-cache';
import './HistoryBoard.css';

// Tool icons live under /icons/tools/ — see CenterPanel.tsx for the canonical
// renderer. HistoryBoard only needs a subset, so we inline a minimal map here.

const TOOL_ICON_SRC: Record<string, string> = {
  claude:   '/icons/tools/claude.svg',
  codex:    '/icons/tools/codex.svg',
  gemini:   '/icons/tools/gemini.svg',
  qwen:     '/icons/tools/qwen.svg',
  hermes:   '/icons/tools/hermes.png',
  opencode: '/icons/tools/opencode.png',
};

const getToolIcon = (tool: string) => {
  const src = TOOL_ICON_SRC[tool];
  if (!src) return <div style={{ width: 14, height: 14, borderRadius: 'var(--radius-xs)', background: '#555' }}/>;
  const extra = (tool === 'hermes' || tool === 'opencode') ? { borderRadius: 'var(--radius-xs)', objectFit: 'cover' as const } : {};
  return <img src={src} alt="" style={{ width: '1em', height: '1em', flexShrink: 0, objectFit: 'contain', ...extra }}/>;
};

const getToolName = (tool: string, _lang: string) => {
  switch (tool) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex CLI';
    case 'gemini': return 'Gemini CLI';
    case 'qwen': return 'Qwen Code';
    case 'hermes': return 'Hermes Agent';
    case 'opencode': return 'OpenCode';
    default: return tool.replace(/^\w/, c => c.toUpperCase());
  }
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
  useEffect(() => { prefetchHistory(); }, []);
  const isLoading = isTauri && (status === 'idle' || status === 'loading') && cachedSessions.length === 0;

  const [sessionSearchQuery, setSessionSearchQuery] = useState('');

  const baseSessions: SavedSession[] = isTauri ? cachedSessions : cachedSessions.length > 0 ? cachedSessions : [
    { id: 'mock-1', name: 'build a flash card website', tool: 'claude', cwd: '~/projects/flashcards', session_token: 'tk1', saved_at: new Date().toISOString() },
    { id: 'mock-2', name: 'build a snake game', tool: 'claude', cwd: '~/projects/snake', session_token: 'tk2', saved_at: new Date(Date.now() - 3600000).toISOString() },
    { id: 'mock-3', name: 'refactor components', tool: 'qwen', cwd: '~/projects/coffee', session_token: 'tk3', saved_at: new Date(Date.now() - 86400000 * 2).toISOString() },
  ];

  const filteredSessions = baseSessions.filter(s => {
    if (!sessionSearchQuery) return true;
    return s.name.toLowerCase().includes(sessionSearchQuery.toLowerCase());
  }).slice(0, 30);

  const handleViewHistory = (saved: SavedSession) => {
    dispatch({ 
      type: 'OPEN_HISTORY_TAB', 
      sessionData: JSON.stringify(saved),
      folderPath: saved.cwd 
    });
  };

  return (
    <>
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
        />
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

        return (
          <div key={session.id} className="history-card" onClick={() => handleViewHistory(session)}>
            <div className="history-card-content">
              <span className="history-card-title">{session.name}</span>
              <div className="history-card-meta">
                <span className="history-card-tool-wrap">
                  {getToolIcon(session.tool)}
                  <span>{getToolName(session.tool, state.currentLang)} &middot; {dateStr} {session.turn_count ? ` \u00B7 ${(t('task.turns' as any) || '{count} turns').replace('{count}', session.turn_count.toString())}` : ''}</span>
                </span>
              </div>
            </div>
          </div>
        );
      })}
      
      {!isLoading && filteredSessions.length === 0 && (
        <div className="task-empty">
          <div className="task-empty-text">{t('menu.no_recent' as any) || 'No recent sessions'}</div>
        </div>
      )}
    </div>
  </>
  );
}
