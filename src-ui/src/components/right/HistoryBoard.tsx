import { useState, useEffect } from 'react';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { isTauri, commands } from '../../tauri';
import type { SavedSession } from '../../tauri';
import './HistoryBoard.css';

const SvgClaude = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fillRule="evenodd"></path>
  </svg>
);

const SvgCodex = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"></path>
    <path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#lobe-icons-codex-fill-right)"></path>
    <defs>
      <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-codex-fill-right" x1="12" x2="12" y1="3" y2="21">
        <stop stopColor="#B1A7FF"></stop>
        <stop offset=".5" stopColor="#7A9DFF"></stop>
        <stop offset="1" stopColor="#3941FF"></stop>
      </linearGradient>
    </defs>
  </svg>
);

const SvgInstaller = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="10" stroke="#C4956A" strokeWidth="2"/>
    <path d="M12 7v6l4 4" stroke="#C4956A" strokeWidth="2" strokeLinecap="round"/>
  </svg>
);

const SvgHermes = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <rect width="24" height="24" rx="4" fill="#111"/>
    <text x="12" y="17" textAnchor="middle" fontFamily="serif" fontWeight="bold" fontSize="14" fill="#fff">N</text>
  </svg>
);

const SvgOpenCode = () => (
  <svg width="1em" height="1em" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <rect width="96" height="96" fill="#131010"/>
    <rect x="24" y="18" width="48" height="60" fill="#FFFFFF"/>
    <rect x="36" y="30" width="24" height="36" fill="#5A5858"/>
    <rect x="36" y="30" width="24" height="12" fill="#131010"/>
  </svg>
);

const getToolIcon = (tool: string) => {
  switch (tool) {
    case 'claude': return <SvgClaude />;
    case 'codex': return <SvgCodex />;
    case 'installer': return <SvgInstaller />;
    case 'hermes': return <SvgHermes />;
    case 'opencode': return <SvgOpenCode />;
    default: return <div style={{width: 14, height: 14, borderRadius: 'var(--radius-xs)', background: '#555'}}/>;
  }
};

const getToolName = (tool: string, _lang: string) => {
  switch (tool) {
    case 'claude': return 'Claude Code';
    case 'codex': return 'Codex CLI';
    case 'installer': return 'Coffee Installer';
    case 'hermes': return 'Hermes';
    case 'opencode': return 'OpenCode';
    default: return tool.replace(/^\w/, c => c.toUpperCase());
  }
};

export function HistoryBoard() {
  const t = useT();
  const { state, dispatch } = useAppState();
  
  const [resumableSessions, setResumableSessions] = useState<SavedSession[]>([]);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');

  useEffect(() => {
    if (isTauri) {
      commands.getNativeHistory()
      .then((nativeSessions) => {
        const merged = [...(nativeSessions || [])];
        merged.sort((a, b) => {
          // Handle unit conversion for raw linux/macos timestamps in seconds
          let ams = Date.parse(a.saved_at);
          if (isNaN(ams)) { 
            const n = Number(a.saved_at); 
            if (!isNaN(n)) ams = n < 1e11 ? n * 1000 : n; 
          }
          let bms = Date.parse(b.saved_at);
          if (isNaN(bms)) { 
            const n = Number(b.saved_at); 
            if (!isNaN(n)) bms = n < 1e11 ? n * 1000 : n; 
          }
          return (bms || 0) - (ams || 0);
        });
        setResumableSessions(merged);
      })
      .catch(console.error);
    }
  }, []);

  const baseSessions: SavedSession[] = isTauri ? resumableSessions : resumableSessions.length > 0 ? resumableSessions : [
    { id: 'mock-1', name: 'build a flash card website', tool: 'claude', cwd: '~/projects/flashcards', session_token: 'tk1', saved_at: new Date().toISOString() },
    { id: 'mock-2', name: 'build a snake game', tool: 'claude', cwd: '~/projects/snake', session_token: 'tk2', saved_at: new Date(Date.now() - 3600000).toISOString() },
    { id: 'mock-3', name: 'refactor components', tool: 'codex', cwd: '~/projects/coffee', session_token: 'tk3', saved_at: new Date(Date.now() - 86400000 * 2).toISOString() },
  ];

  const filteredSessions = baseSessions.filter(s => {
    if (!sessionSearchQuery) return true;
    return s.name.toLowerCase().includes(sessionSearchQuery.toLowerCase());
  }).slice(0, 100);

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
      {filteredSessions.map(session => {
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
      
      {filteredSessions.length === 0 && (
        <div className="task-empty">
          <div className="task-empty-text">{t('menu.no_recent' as any) || 'No recent sessions'}</div>
        </div>
      )}
    </div>
  </>
  );
}
