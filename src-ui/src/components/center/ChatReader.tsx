import { useEffect, useState, useRef } from 'react';
import { commands } from '../../tauri';
import type { SavedSession } from '../../tauri';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import './ChatReader.css';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking: string | null;
  turn_count?: number;
}

export function ChatReader({ sessionId }: { sessionId: string }) {
  const t = useT();
  const { state, dispatch } = useAppState();
  
  const terminal = state.terminals.find(t => t.id === sessionId);
  let currentSession: SavedSession | null = null;
  if (terminal?.toolData) {
    try {
      currentSession = JSON.parse(terminal.toolData) as SavedSession;
    } catch(e) {}
  }
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const toolDataStr = terminal?.toolData;

  useEffect(() => {
    let session: SavedSession | null = null;
    if (toolDataStr) {
      try { session = JSON.parse(toolDataStr); } catch(e) {}
    }
    
    if (!session || !session.file_path) {
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);

    const readPromise = commands.readNativeSession(session.file_path);

    readPromise
      .then((raw) => {
        if (!isMounted) return;
        
        const lines = raw.split('\n').filter(l => l.trim() !== '');
        const thread: ChatMessage[] = [];

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            let msgObj = parsed.message;
            if (!msgObj && parsed.payload && parsed.payload.type === 'message') {
              msgObj = parsed.payload;
            }
            
            // Only care about entries that possess a "role"
            if (msgObj && msgObj.role) {
              const role = msgObj.role;
              let content = '';
              let thinking = null;

              if (role === 'user') {
                if (typeof msgObj.content === 'string') {
                  // Skip agent internal system prompts
                  if (msgObj.content.includes('Run your Session Startup sequence')) continue;
                  content = msgObj.content;
                } else if (Array.isArray(msgObj.content)) {
                  for (const block of msgObj.content) {
                    if (block.type === 'text' || block.type === 'input_text') {
                      // Skip automated environment_context and agent session startup prompts
                      if (block.text && typeof block.text === 'string') {
                        if (block.text.trim().startsWith('<environment_context>')) continue;
                        if (block.text.includes('Run your Session Startup sequence')) continue;
                      }
                      content += block.text || '';
                    }
                  }
                }
              } else if (role === 'assistant') {
                const blocks = Array.isArray(msgObj.content) 
                  ? msgObj.content 
                  : [{ type: 'text', text: msgObj.content || '' }];
                
                for (const block of blocks) {
                  if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') content += block.text || '';
                  if (block.type === 'thinking') thinking = block.thinking;
                }
              }

              if (content.trim() !== '' || thinking) {
                thread.push({
                  id: parsed.uuid || crypto.randomUUID(),
                  role,
                  content,
                  thinking,
                  turn_count: parsed.turn_count
                });
              }
            }
          } catch (e) {
            // Ignore malformed json lines
          }
        }
        
        setMessages(thread);
        setLoading(false);
        
        // Auto scroll to bottom
        setTimeout(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        }, 100);
      })
      .catch(err => {
        console.error("Failed to read history jsonl", err);
        setLoading(false);
      });

    return () => { isMounted = false; };
  }, [toolDataStr]);

  if (!currentSession) return null;

  const handleClose = () => {
    dispatch({ type: 'REMOVE_TERMINAL', id: sessionId });
  };

  const handleResume = () => {
    if (!currentSession?.session_token) return;
    
    let targetId = state.activeTerminalId;
    const currentTerminal = state.terminals.find(t => t.id === targetId);
    
    if (currentTerminal?.tool !== null) {
      targetId = crypto.randomUUID();
      dispatch({
        type: 'ADD_TERMINAL',
        session: { id: targetId, tool: currentSession.tool as any, folderPath: currentSession.cwd }
      });
    } else if (targetId) {
      dispatch({ type: 'SET_TERMINAL_TOOL', id: targetId, tool: currentSession.tool as any });
      dispatch({ type: 'SET_FOLDER', path: currentSession.cwd });
    }

    if (!targetId) return;

    // Quit reader mode
    handleClose();

    commands.tierTerminalResume(
      currentSession.id, targetId, currentSession.tool, currentSession.session_token, 80, 24, currentSession.cwd
    ).catch(console.error);
  };

  return (
    <div className="chat-reader-container">
      <div className="chat-reader-header" style={{ justifyContent: 'flex-end' }}>
        <div className="chat-reader-actions">
          <button className="chat-reader-btn btn-secondary" onClick={handleClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            {t('action.close' as any) || 'Close'}
          </button>
          <button className="chat-reader-btn btn-primary" onClick={handleResume}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="5 12 12 5 19 12"></polyline>
              <line x1="12" y1="19" x2="12" y2="5"></line>
            </svg>
            {t('action.resume_terminal' as any) || 'Continue this session'}
          </button>
        </div>
      </div>

      <div className="chat-reader-body" ref={scrollRef}>
        {loading ? (
          <div className="tier-loading-splash" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 }}>
            <div className="splash-group">
              <div className="splash-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <mask id={`splashMask-${sessionId}`}>
                      <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                        d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
                        <animate attributeName="d" dur="3s" repeatCount="indefinite"
                          values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
                      </path>
                      <path d="M4 7h16v0h-16v12h16v-32h-16Z">
                        <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s" to="M4 2h16v5h-16v12h16v-24h-16Z"/>
                      </path>
                    </mask>
                  </defs>
                  <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                    <path fill="currentColor" fillOpacity="0" strokeDasharray="48"
                      d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
                      <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0"/>
                      <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1"/>
                    </path>
                    <path fill="none" strokeDasharray="16" strokeDashoffset="16"
                      d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
                      <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0"/>
                    </path>
                  </g>
                  <path fill="currentColor" d="M0 0h24v24H0z" mask={`url(#splashMask-${sessionId})`}/>
                </svg>
              </div>
              <span className="splash-label">{currentSession.name}</span>
              <div className="splash-dots">
                <span className="splash-dot" />
                <span className="splash-dot" />
                <span className="splash-dot" />
              </div>
            </div>
          </div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className={`chat-message-row ${msg.role}`}>
              <div className="chat-bubble">
                {msg.thinking && (
                  <div className="chat-thinking">
                    <div className="chat-thinking-header">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                      </svg>
                      Thinking Process
                    </div>
                    {msg.thinking}
                  </div>
                )}
                {msg.content && (
                  <div className="chat-text">
                    {msg.content}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        
        {!loading && messages.length === 0 && (
          <div className="chat-empty-state">
            No readable conversation records found.
          </div>
        )}
      </div>
    </div>
  );
}
