import { useState, useEffect } from 'react';
import { TierTerminal } from './TierTerminal';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useAppState, type ToolType, type AgentStatus } from '../../store/app-state';
import { isTauri, commands, type SavedSession } from '../../tauri';
import { useT } from '../../i18n/useT';
import './CenterPanel.css';

// SVG Definitions for reusability
const SvgClaude = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fillRule="evenodd"></path>
  </svg>
);

const SvgCodex = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"></path>
    <path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#lobe-icons-codex-fill)"></path>
    <defs>
      <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-codex-fill" x1="12" x2="12" y1="3" y2="21">
        <stop stopColor="#B1A7FF"></stop>
        <stop offset=".5" stopColor="#7A9DFF"></stop>
        <stop offset="1" stopColor="#3941FF"></stop>
      </linearGradient>
    </defs>
  </svg>
);

const SvgGemini = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z" fill="url(#lobe-icons-gemini-cli-fill)"></path>
    <path clipRule="evenodd" d="M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z" fill="#1E1E2E" fillRule="evenodd"></path>
    <defs>
      <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-gemini-cli-fill" x1="24" x2="0" y1="6.587" y2="16.494">
        <stop stopColor="#EE4D5D"></stop>
        <stop offset=".328" stopColor="#B381DD"></stop>
        <stop offset=".476" stopColor="#207CFE"></stop>
      </linearGradient>
    </defs>
  </svg>
);

const SvgOpenClaw = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M12 2.568c-6.33 0-9.495 5.275-9.495 9.495 0 4.22 3.165 8.44 6.33 9.494v2.11h2.11v-2.11s1.055.422 2.11 0v2.11h2.11v-2.11c3.165-1.055 6.33-5.274 6.33-9.494S18.33 2.568 12 2.568z" fill="url(#lobe-icons-open-claw-fill-0)"></path>
    <path d="M3.56 9.953C.396 8.898-.66 11.008.396 13.118c1.055 2.11 3.164 1.055 4.22-1.055.632-1.477 0-2.11-1.056-2.11z" fill="url(#lobe-icons-open-claw-fill-1)"></path>
    <path d="M20.44 9.953c3.164-1.055 4.22 1.055 3.164 3.165-1.055 2.11-3.164 1.055-4.22-1.055-.632-1.477 0-2.11 1.056-2.11z" fill="url(#lobe-icons-open-claw-fill-2)"></path>
    <path d="M5.507 1.875c.476-.285 1.036-.233 1.615.037.577.27 1.223.774 1.937 1.488a.316.316 0 01-.447.447c-.693-.693-1.279-1.138-1.757-1.361-.475-.222-.795-.205-1.022-.069a.317.317 0 01-.326-.542zM16.877 1.913c.58-.27 1.14-.323 1.616-.038a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.069-.478.223-1.064.668-1.756 1.361a.316.316 0 11-.448-.447c.714-.714 1.36-1.218 1.936-1.487z" fill="#FF4D4D"></path>
    <path d="M8.835 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532zM15.165 9.109a1.266 1.266 0 100-2.532 1.266 1.266 0 000 2.532z" fill="#050810"></path>
    <path d="M9.046 8.16a.527.527 0 100-1.056.527.527 0 000 1.055zM15.376 8.16a.527.527 0 100-1.055.527.527 0 000 1.054z" fill="#00E5CC"></path>
    <defs>
      <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-open-claw-fill-0" x1="-.659" x2="27.023" y1=".458" y2="22.855"><stop stopColor="#FF4D4D"></stop><stop offset="1" stopColor="#991B1B"></stop></linearGradient>
      <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-open-claw-fill-1" x1="0" x2="4.311" y1="9.672" y2="14.949"><stop stopColor="#FF4D4D"></stop><stop offset="1" stopColor="#991B1B"></stop></linearGradient>
      <linearGradient gradientUnits="userSpaceOnUse" id="lobe-icons-open-claw-fill-2" x1="19.385" x2="24.399" y1="9.953" y2="14.462"><stop stopColor="#FF4D4D"></stop><stop offset="1" stopColor="#991B1B"></stop></linearGradient>
    </defs>
  </svg>
);

const SvgFreeCode = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <rect x="1" y="1" width="22" height="22" rx="6" fill="url(#fc-bg)"/>
    <path d="M12 7.5V6a3 3 0 0 0-3 3v1.5h6V9a3 3 0 0 0-3-3z" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.85"/>
    <rect x="7.5" y="11" width="9" height="7" rx="1.5" fill="#fff" opacity="0.9"/>
    <circle cx="12" cy="14.5" r="1.2" fill="url(#fc-bg)"/>
    <line x1="12" y1="15.5" x2="12" y2="16.5" stroke="url(#fc-bg)" strokeWidth="1.2" strokeLinecap="round"/>
    <defs>
      <linearGradient id="fc-bg" x1="1" y1="1" x2="23" y2="23" gradientUnits="userSpaceOnUse">
        <stop stopColor="#D97757"/>
        <stop offset="1" stopColor="#B85C3A"/>
      </linearGradient>
    </defs>
  </svg>
);

const SvgPlus = ({ active }: { active: boolean }) => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: active ? 'var(--accent)' : 'inherit' }}>
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
);

export function CenterPanel() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const terminals = state.terminals;
  const activeTerminalId = state.activeTerminalId;

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [resumableSessions, setResumableSessions] = useState<SavedSession[]>([]);
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});

  // Derived state — must be before hooks that depend on it
  const activeSession = terminals.find(t => t.id === activeTerminalId);
  const isLaunchpadMode = activeSession && activeSession.tool === null;

  // Load resumable sessions on mount
  useEffect(() => {
    if (!isTauri) return;
    commands.getResumableSessions()
      .then(sessions => setResumableSessions(sessions))
      .catch(() => {});
  }, []);

  // ── Island bridge: show island only when main window is MINIMIZED ──
  // When the window is visible (even unfocused), tab dots are sufficient.
  useEffect(() => {
    if (!isTauri) return;
    let polling: ReturnType<typeof setInterval> | null = null;
    let wasMinimized = false;

    // Poll minimize state every 500ms (Tauri v2 doesn't expose onMinimize on web)
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const mainWin = getCurrentWindow();
      const { emit } = await import('@tauri-apps/api/event');

      polling = setInterval(async () => {
        try {
          const minimized = await mainWin.isMinimized();
          if (minimized && !wasMinimized) {
            wasMinimized = true;
            emit('main-window-minimized');
          } else if (!minimized && wasMinimized) {
            wasMinimized = false;
            emit('main-window-restored');
          }
        } catch { /* window not ready */ }
      }, 500);
    })();

    // Listen for island-clicked → restore & focus main window + switch tab
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ agentId: string }>('island-clicked', async (event) => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await win.show();
        await win.unminimize();
        await win.setFocus();
        if (event.payload?.agentId) {
          dispatch({ type: 'SET_ACTIVE_TERMINAL', id: event.payload.agentId });
        }
      }).then(u => { unlisten = u; });
    });

    return () => {
      if (polling) clearInterval(polling);
      unlisten?.();
    };
  }, [dispatch]);

  // Detect tool availability each time Launchpad is shown
  useEffect(() => {
    if (!isTauri || !isLaunchpadMode) return;
    commands.checkToolsInstalled()
      .then(result => setToolsInstalled(result))
      .catch(() => {});
  }, [isLaunchpadMode]);

  // Auto-hide toast
  useEffect(() => {
    if (toastMsg) {
      const timer = setTimeout(() => setToastMsg(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMsg]);

  // Listen for agent-status events from the backend
  // + Notification system: sound + system notification on key state transitions
  useEffect(() => {
    // Request notification permission on first mount
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    // Track previous status per session to detect transitions
    const prevStatus = new Map<string, string>();

    // Subtle notification chime using Web Audio API
    const playChime = (type: 'complete' | 'attention') => {
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.08; // very subtle

        if (type === 'complete') {
          // Two-tone ascending chime = "done!"
          osc.frequency.value = 523; // C5
          osc.start();
          osc.frequency.setValueAtTime(659, ctx.currentTime + 0.12); // E5
          osc.stop(ctx.currentTime + 0.25);
        } else {
          // Single soft tone = "needs attention"
          osc.frequency.value = 440; // A4
          osc.start();
          osc.stop(ctx.currentTime + 0.15);
        }
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.onended = () => ctx.close();
      } catch { /* audio not available */ }
    };

    const sendNotification = (title: string, body: string) => {
      // Only notify when app is not focused (avoid interrupting active users)
      if (document.hasFocus()) return;

      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, {
          body,
          icon: '/coffee-icon.png',
          silent: true, // we play our own chime
        });
        // Auto-close after 5s
        setTimeout(() => n.close(), 5000);
        // Click notification → focus app
        n.onclick = () => { window.focus(); n.close(); };
      }
    };

    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<{ id: string; status: string }>('agent-status', (event) => {
          const { id, status } = event.payload;
          if (status === 'working' || status === 'idle' || status === 'wait_input') {
            const prev = prevStatus.get(id);
            prevStatus.set(id, status);

            // Detect meaningful transitions
            if (prev === 'working' && status === 'idle') {
              playChime('complete');
              sendNotification('Coffee Mode', 'Agent has finished working.');
            } else if (prev === 'working' && status === 'wait_input') {
              playChime('attention');
              sendNotification('Coffee Mode', 'Agent needs your input.');
            }

            dispatch({ type: 'SET_AGENT_STATUS', id, status: status as AgentStatus });
          }
        });
      } catch { /* not in Tauri context */ }
    })();
    return () => { unlisten?.(); };
  }, [dispatch]);


  const handleAddTab = () => {
    if (terminals.length >= 5) {
      setToastMsg('最多只能同时打开 5 个会话。');
      return;
    }
    dispatch({
      type: 'ADD_TERMINAL',
      session: { id: crypto.randomUUID(), tool: null, folderPath: null, scanData: null, agentStatus: 'idle' as const, menu: null }
    });
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_TERMINAL', id });
    // Notify island overlay to remove session
    if (isTauri) {
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('island-session-remove', { id });
      });
    }
  };

  const selectTool = (tool: ToolType) => {
    if (activeTerminalId) {
      dispatch({ type: 'SET_TERMINAL_TOOL', id: activeTerminalId, tool });
      // Notify island overlay about tool assignment
      if (isTauri) {
        import('@tauri-apps/api/event').then(({ emit }) => {
          emit('island-tool-assign', { id: activeTerminalId, tool });
        });
      }
    }
  };

  // Helper to render the correct icon and title based on tool type
  const renderTabContent = (tool: ToolType, isActive: boolean) => {
    switch (tool) {
      case 'claude': return { icon: <SvgClaude />, title: 'Claude Code' };
      case 'codex': return { icon: <SvgCodex />, title: 'Codex' };
      case 'gemini': return { icon: <SvgGemini />, title: 'Gemini CLI' };
      case 'openclaw': return { icon: <SvgOpenClaw />, title: 'OpenClaw' };
      case 'freecode': return { icon: <SvgFreeCode />, title: 'Free Code' };
      default: return { icon: <SvgPlus active={isActive} />, title: t('tab.new') };
    }
  };

  return (
    <>
      <div className="chrome-tabs-header">
        {terminals.map(session => {
          const isActive = session.id === activeTerminalId;
          const { icon, title } = renderTabContent(session.tool, isActive);

          return (
            <div 
              key={session.id}
              className={`chrome-tab ${isActive ? 'active' : ''}`} 
              onClick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: session.id })}
            >
              {icon}
              <span className="tab-title" style={{ flex: 1, minWidth: 0, textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</span>
              <div className="tab-actions">
                {session.tool && <span className="tab-health-dot connected" />}
                <button 
                   className="tab-close-btn" 
                   onClick={(e) => handleCloseTab(e, session.id)}
                   style={{ opacity: !session.tool ? 1 : undefined, transform: !session.tool ? 'scale(1)' : undefined, pointerEvents: !session.tool ? 'auto' : undefined }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
          );
        })}

        <button className="chrome-tab-new" onClick={handleAddTab}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        </button>
      </div>
      <div className="main-content">
        {/* Premium Toast Notification */}
        {toastMsg && (
          <div className="toast-notification">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
            {toastMsg}
          </div>
        )}

        {terminals.map(t => t.tool !== null ? (
          <div 
            key={t.id} 
            className="terminal-wrapper"
            style={{ 
              display: t.id === activeTerminalId ? 'flex' : 'none',
              width: '100%',
              height: '100%',
              position: 'relative'
            }}
          >
            {/* Floating close buttons removed in favor of Tab-integrated controls */}
            <ErrorBoundary fallbackLabel="Tier Terminal Error">
              <TierTerminal sessionId={t.id} tool={t.tool} />
            </ErrorBoundary>
          </div>
        ) : null)}

        {isLaunchpadMode && activeTerminalId && (
          <div className="launchpad-container" style={{ position: 'relative' }}>
            {/* Close button removed: handles via Tab bar */}
            <div className="launchpad-inner">
              <div className="launchpad-grid">
                {[
                  { key: 'claude' as ToolType, label: 'Claude Code', icon: <SvgClaude /> },
                  { key: 'freecode' as ToolType, label: 'Free Code', icon: <SvgFreeCode /> },
                  { key: 'codex' as ToolType, label: 'Codex', icon: <SvgCodex /> },
                  { key: 'gemini' as ToolType, label: 'Gemini CLI', icon: <SvgGemini /> },
                  { key: 'openclaw' as ToolType, label: 'OpenClaw', icon: <SvgOpenClaw /> },
                ].map(tool => {
                  const installed = toolsInstalled[tool?.key ?? ''] !== false;
                  return (
                    <div
                      key={tool.key}
                      className={`launchpad-card ${!installed ? 'launchpad-card-disabled' : ''}`}
                      onClick={() => installed && selectTool(tool.key)}
                    >
                      <div className="launchpad-icon">{tool.icon}</div>
                      <span>{tool.label}</span>
                    </div>
                  );
                })}
              </div>

              {/* Resumable Sessions */}
              {resumableSessions.length > 0 && (
                <div className="resume-section">
                  <div className="resume-section-title">Resumable Sessions</div>
                  <div className="resume-list">
                    {resumableSessions.map(saved => {
                      const toolIcon = (() => {
                        switch (saved.tool) {
                          case 'claude': return <SvgClaude />;
                          case 'codex': return <SvgCodex />;
                          case 'gemini': return <SvgGemini />;
                          case 'openclaw': return <SvgOpenClaw />;
                          default: return null;
                        }
                      })();
                      const toolTitle = (() => {
                        switch (saved.tool) {
                          case 'claude': return 'Claude Code';
                          case 'codex': return 'Codex';
                          case 'gemini': return 'Gemini CLI';
                          case 'openclaw': return 'OpenClaw';
                          default: return saved.tool;
                        }
                      })();
                      return (
                        <div
                          key={saved.id}
                          className="resume-card"
                          onClick={() => {
                            if (!activeTerminalId || !saved.session_token) return;
                            dispatch({ type: 'SET_TERMINAL_TOOL', id: activeTerminalId, tool: saved.tool as ToolType });
                            commands.tierTerminalResume(
                              saved.id, activeTerminalId, saved.tool,
                              saved.session_token, 80, 24
                            ).then(() => {
                              setResumableSessions(prev => prev.filter(s => s.id !== saved.id));
                            }).catch((err) => {
                              setToastMsg(`Resume failed: ${err}`);
                            });
                          }}
                        >
                          <span className="resume-card-icon">{toolIcon}</span>
                          <span className="resume-card-info">
                            <span className="resume-card-title">{toolTitle}</span>
                            <span className="resume-card-token">{saved.session_token?.slice(0, 8)}...</span>
                          </span>
                          <span className="resume-card-badge">Resume</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
