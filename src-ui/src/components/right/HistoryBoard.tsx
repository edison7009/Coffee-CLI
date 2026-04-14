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

const SvgQwen = () => (
  <svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" fill="url(#hist-qwen-fill)" fillRule="nonzero"/>
    <defs>
      <linearGradient id="hist-qwen-fill" x1="0%" x2="100%" y1="0%" y2="0%">
        <stop offset="0%" stopColor="#6336E7" stopOpacity=".84"/>
        <stop offset="100%" stopColor="#6F69F7" stopOpacity=".84"/>
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
    case 'qwen': return <SvgQwen />;
    case 'installer': return <SvgInstaller />;
    case 'hermes': return <SvgHermes />;
    case 'opencode': return <SvgOpenCode />;
    default: return <div style={{width: 14, height: 14, borderRadius: 'var(--radius-xs)', background: '#555'}}/>;
  }
};

const getToolName = (tool: string, _lang: string) => {
  switch (tool) {
    case 'claude': return 'Claude Code';
    case 'qwen': return 'Qwen Code';
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
    { id: 'mock-3', name: 'refactor components', tool: 'qwen', cwd: '~/projects/coffee', session_token: 'tk3', saved_at: new Date(Date.now() - 86400000 * 2).toISOString() },
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
