import { useState, useEffect } from 'react';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { isTauri, commands } from '../../tauri';
import type { SavedSession } from '../../tauri';
import './HistoryBoard.css';

export function HistoryBoard() {
  const t = useT();
  const { state, dispatch } = useAppState();
  
  const [resumableSessions, setResumableSessions] = useState<SavedSession[]>([]);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');

  useEffect(() => {
    if (isTauri) {
      Promise.all([
        commands.getResumableSessions(),
        commands.getNativeHistory()
      ])
      .then(([ptySessions, nativeSessions]) => {
        const merged = [...(ptySessions || []), ...(nativeSessions || [])];
        merged.sort((a, b) => {
          let ams = Date.parse(a.saved_at);
          if (isNaN(ams)) { const n = Number(a.saved_at); if (!isNaN(n)) ams = n; }
          let bms = Date.parse(b.saved_at);
          if (isNaN(bms)) { const n = Number(b.saved_at); if (!isNaN(n)) bms = n; }
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
  });

  const handleResume = (saved: SavedSession) => {
    if (!saved.session_token) return;
    
    let targetId = state.activeTerminalId;
    const currentTerminal = state.terminals.find(t => t.id === targetId);
    
    if (currentTerminal?.tool !== null) {
      // Active terminal busy, spawn a new tab
      targetId = crypto.randomUUID();
      dispatch({ 
        type: 'ADD_TERMINAL', 
        session: { id: targetId, tool: saved.tool as any, folderPath: saved.cwd, scanData: null, agentStatus: 'idle', menu: null, hasInputText: false } 
      });
    } else if (targetId) {
      // Adopt empty launchpad
      dispatch({ type: 'SET_TERMINAL_TOOL', id: targetId, tool: saved.tool as any });
      dispatch({ type: 'SET_FOLDER', path: saved.cwd });
    }

    if (!targetId) return;

    commands.tierTerminalResume(
      saved.id, targetId, saved.tool, saved.session_token, 80, 24
    ).then(() => {
      // Remove the session from local view list since it's active now
      setResumableSessions(prev => prev.filter(s => s.id !== saved.id));
    }).catch(console.error);
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
          // If parsing fails, and it's a numeric string, parse it as Number
          const num = Number(session.saved_at);
          if (!isNaN(num) && num > 0) savedMs = num;
          else savedMs = Date.now() - 86400000; // fallback to yesterday
        }
        const dateDiff = Date.now() - savedMs;
        const timeDisplay = dateDiff < 3600000 ? 'Just now' : dateDiff < 86400000 ? 'Today' : 'Yesterday';
        
        const renderToolIcon = (tool: string) => {
          const t_ = tool.toLowerCase();
          let bg = '#666', text = tool[0].toUpperCase();
          if (t_ === 'claude') { bg = '#d56e54'; text = 'C'; }
          else if (t_ === 'codex') { bg = '#4d88ff'; text = 'Cx'; }
          else if (t_ === 'gemini') { bg = '#8e62d4'; text = 'G'; }
          else if (t_ === 'openclaw') { bg = '#e74c3c'; text = 'O'; }
          return (
            <div style={{
              width: 18, height: 18, borderRadius: 4, background: bg, color: '#fff', 
              display: 'flex', alignItems: 'center', justifyContent: 'center', 
              fontSize: 11, fontWeight: 'bold'
            }}>
              {text}
            </div>
          );
        };

        return (
          <div key={session.id} className="history-card" onClick={() => handleResume(session)}>
            <div className="history-card-content">
              <span className="history-card-title">{session.name}</span>
              <div className="history-card-meta">
                <div className="history-card-tool">
                  {renderToolIcon(session.tool)}
                  <span>{session.tool === 'terminal' ? 'Local' : session.tool.replace(/^\w/, c => c.toUpperCase())}</span>
                </div>
                <span className="history-card-time">{timeDisplay}</span>
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
