import { useState, useEffect, useRef } from 'react';
import { focusTerminal } from '../../lib/focus-registry';
import { TierTerminal } from './TierTerminal';
import { DosPlayer } from './DosPlayer';
import { ChatReader } from './ChatReader';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { useAppState, type ToolType } from '../../store/app-state';

export interface RemoteHistoryItem {
  id: string;
  protocol: 'ssh' | 'ws';
  host: string;
  port: string;
  user: string;
}
import { isTauri, commands } from '../../tauri';
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

const SvgInstaller = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="10" stroke="#C4956A" strokeWidth="2"/>
    <path d="M12 7v6l4 4" stroke="#C4956A" strokeWidth="2" strokeLinecap="round"/>
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

const SvgHermes = () => (
  <img src="/icons/hermes.png" alt="Hermes" style={{ width: '1em', height: '1em', flexShrink: 0, borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />
);

// ── Platform-aware Terminal Icon & Label ─────────────────────────────────────

const detectOS = (): 'win' | 'mac' | 'linux' => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win';
  if (ua.includes('mac')) return 'mac';
  return 'linux';
};

const TERMINAL_ICON: Record<string, string> = {
  win: '/icons/powershell.svg',
  mac: '/icons/macos-terminal.png',
  linux: '/icons/linux-terminal.png',
};

const TerminalIcon = () => {
  const os = detectOS();
  return (
    <img
      src={TERMINAL_ICON[os]}
      alt=""
      style={{ width: '1em', height: '1em', borderRadius: 'var(--radius-xs)', objectFit: 'contain', flexShrink: 0 }}
    />
  );
};

// (terminal label now from i18n: t('tool.terminal'))

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
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  const [showArcadeGames, setShowArcadeGames] = useState(false);
  const [arcadeGames, setArcadeGames] = useState<{name:string;path:string;size:number}[]>([]);
  const [disableDrawer, setDisableDrawer] = useState(false);

  // ── Remote Terminal SSH form state ─────────────────────────────────────────
  const [showRemoteForm, setShowRemoteForm] = useState(false);
  const [remoteProtocol, setRemoteProtocol] = useState<'ssh' | 'ws'>('ssh');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [sshPass, setSshPass] = useState('');
  
  const [remoteHistory, setRemoteHistory] = useState<RemoteHistoryItem[]>(() => {
    try { return JSON.parse(localStorage.getItem('remote_terminal_history') || '[]'); } catch { return []; }
  });

  const saveRemoteHistory = (item: Omit<RemoteHistoryItem, 'id'>) => {
    setRemoteHistory(prev => {
      const filtered = prev.filter(p => !(p.host === item.host && p.port === item.port && p.protocol === item.protocol));
      const next = [{ id: crypto.randomUUID(), ...item }, ...filtered].slice(0, 10);
      localStorage.setItem('remote_terminal_history', JSON.stringify(next));
      return next;
    });
  };

  const deleteRemoteHistory = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRemoteHistory(prev => {
      const next = prev.filter(p => p.id !== id);
      localStorage.setItem('remote_terminal_history', JSON.stringify(next));
      return next;
    });
  };
  const [connStatus, setConnStatus] = useState<'idle' | 'connecting' | 'failed'>('idle');

  // ── Global focus enforcer ────────────────────────────────────────────────
  // One pair of window listeners for the whole app (previously each
  // TierTerminal added its own focusin + mouseup handlers, causing O(N)
  // dispatch per click with N tabs). When focus wanders to the body or a
  // non-input element, steal it back for the currently active terminal.
  const activeIdRef = useRef(activeTerminalId);
  useEffect(() => { activeIdRef.current = activeTerminalId; }, [activeTerminalId]);
  useEffect(() => {
    const enforce = () => {
      setTimeout(() => {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.classList.contains('xterm-helper-textarea')) {
          return; // user is typing in a real input, leave them alone
        }
        const id = activeIdRef.current;
        if (id) focusTerminal(id);
      }, 10);
    };
    window.addEventListener('focusin', enforce);
    window.addEventListener('mouseup', enforce);
    return () => {
      window.removeEventListener('focusin', enforce);
      window.removeEventListener('mouseup', enforce);
    };
  }, []);

  // Load sticky config
  useEffect(() => {
    try {
      const saved = localStorage.getItem('coffee_remote_cfg');
      if (saved) {
        const c = JSON.parse(saved);
        if (c.protocol) setRemoteProtocol(c.protocol);
        if (c.host) setSshHost(c.host);
        if (c.port) setSshPort(String(c.port));
        if (c.username) setSshUser(c.username);
        if (c.password) setSshPass(c.password);
      }
    } catch (e) {}
  }, []);

  // Derived state — must be before hooks that depend on it
  const activeSession = terminals.find(t => t.id === activeTerminalId);
  const isLaunchpadMode = activeSession && activeSession.tool === null;



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


  const handleAddTab = () => {
    if (terminals.length >= 5) {
      setToastMsg(t('session.max'));
      return;
    }
    dispatch({
      type: 'ADD_TERMINAL',
      session: { id: crypto.randomUUID(), tool: null, folderPath: null, scanData: null }
    });
  };

  const handleCloseTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_TERMINAL', id });
  };

  const selectTool = (tool: ToolType, toolData?: string) => {
    if (activeTerminalId) {
      dispatch({ type: 'SET_TERMINAL_TOOL', id: activeTerminalId, tool, toolData });
    }
  };

  const handleRemoteConnect = async () => {
    if (!sshHost.trim()) return;
    if (remoteProtocol === 'ssh' && !sshUser.trim()) return;
    
    setConnStatus('connecting');

    saveRemoteHistory({ protocol: remoteProtocol, host: sshHost.trim(), port: sshPort.trim(), user: sshUser.trim() });

    // Validate network connection using real TCP check instead of mock
    let isOffline = false;
    try {
      const portNum = parseInt(sshPort) || (remoteProtocol === 'ssh' ? 22 : 7681);
      const isReachable = await commands.checkNetworkPort(sshHost.trim(), portNum);
      if (!isReachable) isOffline = true;
    } catch(err) {
      isOffline = true;
    }

    if (isOffline) {
      setConnStatus('failed');
      setTimeout(() => setConnStatus('idle'), 3000);
      return;
    }

    const connDataObj = {
      protocol: remoteProtocol,
      host: sshHost.trim(),
      port: parseInt(sshPort) || (remoteProtocol === 'ssh' ? 22 : 7681),
      username: sshUser.trim(),
      password: sshPass,
    };
    
    try {
      localStorage.setItem('coffee_remote_cfg', JSON.stringify(connDataObj));
    } catch(e) {}

    const connData = JSON.stringify(connDataObj);
    
    selectTool('remote', connData);
    setShowRemoteForm(false);
    setConnStatus('idle');
  };

  const ARCADE_META: Record<string, {icon:string; key: 'game.pal' | 'game.stardom' | 'game.redalert' | 'game.doom' | 'game.richman3' | 'game.simcity2000'}> = {
    'pal.jsdos':         { icon: '/icons/pal.jpg',         key: 'game.pal' },
    'stardom.jsdos':     { icon: '/icons/stardom.webp',    key: 'game.stardom' },
    'redalert.jsdos':    { icon: '/icons/redalert.png',    key: 'game.redalert' },
    'doom.jsdos':        { icon: '/icons/doom.png',         key: 'game.doom' },
    'richman3.jsdos':    { icon: '/icons/richman3.png',    key: 'game.richman3' },
    'simcity2000.jsdos': { icon: '/icons/simcity2000.png', key: 'game.simcity2000' },
  };

  // Helper to render the correct icon and title based on tool type
  const renderTabContent = (session: typeof terminals[0], isActive: boolean) => {
    switch (session.tool) {
      case 'claude': return { icon: <SvgClaude />, title: 'Claude Code' };
      case 'codex': return { icon: <SvgCodex />, title: 'Codex CLI' };
      case 'hermes': return { icon: <SvgHermes />, title: 'Hermes' };
      case 'opencode': return { icon: <SvgOpenCode />, title: 'OpenCode' };
      case 'installer': return { icon: <SvgInstaller />, title: t('tool.installer' as any) };
      case 'remote': {
        let title = t('tool.remote') as string;
        if (session.toolData) {
          try {
            const data = JSON.parse(session.toolData);
            if (data.protocol === 'ssh' && data.username && data.host) {
              title = `${data.username}@${data.host}`;
            } else if (data.host) {
              title = data.host;
            }
          } catch (e) {}
        }
        return { icon: <TerminalIcon />, title };
      }
      case 'terminal': return { icon: <TerminalIcon />, title: t('tool.terminal') };
      case 'arcade': {
        const gameName = session.toolData || '';
        const m = ARCADE_META[gameName.toLowerCase()];
        if (m) {
          const title = t(m.key as any);
          return { icon: <img src={m.icon} alt="" style={{ width: '1em', height: '1em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />, title };
        }
        return { icon: <span style={{ fontSize: '1em' }}>🎮</span>, title: 'Coffee Play' };
      }
      case 'history': {
        let titleParam = '回看历史';
        if (session.toolData) {
          try {
            const parsed = JSON.parse(session.toolData);
            if (parsed.name) titleParam = parsed.name; // Use the session name instead for the tab
          } catch (e) {}
        }
        return { 
          icon: <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 8v4l3 3"></path><circle cx="12" cy="12" r="10"></circle></svg>, 
          title: titleParam 
        };
      }
      default: return { icon: <SvgPlus active={isActive} />, title: t('tab.new') };
    }
  };

  return (
    <>
      <div className="chrome-tabs-header">
        {terminals.map(session => {
          if (session.isHidden && session.id !== activeTerminalId) return null;
          
          const isActive = session.id === activeTerminalId;
          const { icon, title } = renderTabContent(session, isActive);

          return (
            <div 
              key={session.id}
              className={`chrome-tab ${isActive ? 'active' : ''}`} 
              onClick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: session.id })}
            >
              {icon}
              <span className="tab-title" style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</span>
              <div className="tab-actions">
                <button 
                   className="tab-close-btn" 
                   onClick={(e) => handleCloseTab(e, session.id)}
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
            data-session-id={t.id}
            style={{ 
              display: t.id === activeTerminalId ? 'flex' : 'none',
              width: '100%',
              height: '100%',
              position: 'relative'
            }}
          >
            {t.tool === 'history' ? (
              <ChatReader sessionId={t.id} />
            ) : t.tool === 'arcade' ? (
              <DosPlayer sessionId={t.id} />
            ) : (
              <ErrorBoundary key={`err-${t.id}-${t.restartKey || 0}`} fallbackLabel="Tier Terminal Error">
                <TierTerminal
                  key={`tier-${t.id}-${t.restartKey || 0}`}
                  sessionId={t.id}
                  tool={t.tool}
                  theme={state.currentTheme}
                  lang={state.currentLang}
                  isActive={t.id === activeTerminalId}
                  toolData={t.toolData}
                  folderPath={t.folderPath}
                />
              </ErrorBoundary>
            )}
          </div>
        ) : null)}

        {isLaunchpadMode && activeTerminalId && (
          <div className="launchpad-container" style={{ position: 'relative' }}>
            {/* Close button removed: handles via Tab bar */}
            <div className="launchpad-slider-viewport">
              <div className={`launchpad-slider-track ${showArcadeGames ? 'slide-to-games' : ''}`}>
                
                {/* ─── Page 1: Tools ─── */}
                <div className="launchpad-page">
                  <div className="launchpad-inner">
                    <div className="launchpad-grid">
                      {[ 
                        { key: 'claude' as ToolType, label: 'Claude Code', icon: <SvgClaude /> },
                        { key: 'codex' as ToolType, label: 'Codex CLI', icon: <SvgCodex /> },
                        { key: 'hermes' as ToolType, label: 'Hermes', icon: <SvgHermes /> },
                        { key: 'opencode' as ToolType, label: 'OpenCode', icon: <SvgOpenCode /> },
                        { key: 'installer' as ToolType, label: t('tool.installer' as any), icon: <SvgInstaller /> },
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

                      {/* Terminal card with subtle Remote link */}
                      <div
                        className="launchpad-card"
                        onClick={() => selectTool('terminal')}
                      >
                        <div className="launchpad-icon"><TerminalIcon /></div>
                        <span>{t('tool.terminal')}</span>
                        
                        <div 
                          className="remote-link-hint"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowRemoteForm(true);
                          }}
                        >
                          {t('tool.remote.short' as any)}
                        </div>
                      </div>
                    </div>

                    {/* ─── Remote Terminal Connection Form ─── */}
                    {showRemoteForm && (
                      <div className="remote-form-overlay">
                        <div className="remote-form-wrapper">
                          <div className="remote-form-card">
                            <div className="remote-form-header">
                            <TerminalIcon />
                            <span>{t('remote.title' as any)}</span>
                            <button className="remote-form-close" onClick={() => setShowRemoteForm(false)}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                          </div>
                          <div className="remote-form-body">
                            {/* Protocol Toggle */}
                            <div className="remote-protocol-toggle">
                              <button
                                className={`remote-proto-btn ${remoteProtocol === 'ssh' ? 'active' : ''}`}
                                onClick={() => { setRemoteProtocol('ssh'); setSshPort('22'); }}
                              >SSH</button>
                              <button
                                className={`remote-proto-btn ${remoteProtocol === 'ws' ? 'active' : ''}`}
                                onClick={() => { setRemoteProtocol('ws'); setSshPort('7681'); }}
                              >WebSocket</button>
                            </div>
                            <div className="remote-form-row">
                              <label>{t('remote.host' as any)}</label>
                              <div className="remote-form-host-row">
                                <input
                                  type="text"
                                  placeholder={t('remote.host_placeholder' as any) || "192.168.1.100"}
                                  value={sshHost}
                                  onChange={e => setSshHost(e.target.value)}
                                  className="remote-input remote-input-host"
                                  autoFocus
                                  onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                />
                                <span className="remote-port-sep">:</span>
                                <input
                                  type="text"
                                  placeholder={remoteProtocol === 'ssh' ? '22' : '7681'}
                                  value={sshPort}
                                  onChange={e => setSshPort(e.target.value)}
                                  className="remote-input remote-input-port"
                                  onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                />
                              </div>
                            </div>
                            {remoteProtocol === 'ssh' && (
                              <>
                                <div className="remote-form-row">
                                  <label>{t('remote.username' as any)}</label>
                                  <input
                                    type="text"
                                    placeholder="root"
                                    value={sshUser}
                                    onChange={e => setSshUser(e.target.value)}
                                    className="remote-input"
                                    onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                  />
                                </div>
                                <div className="remote-form-row">
                                  <label>{t('remote.password' as any)}</label>
                                  <input
                                    type="password"
                                    value={sshPass}
                                    onChange={e => setSshPass(e.target.value)}
                                    className="remote-input"
                                    onKeyDown={e => e.key === 'Enter' && handleRemoteConnect()}
                                  />
                                </div>
                              </>
                            )}
                            <button
                              className={`remote-connect-btn status-${connStatus}`}
                              onClick={handleRemoteConnect}
                              disabled={!sshHost.trim() || (remoteProtocol === 'ssh' && !sshUser.trim()) || connStatus !== 'idle'}
                            >
                              {connStatus === 'connecting' && t('remote.connecting' as any)}
                              {connStatus === 'failed' && t('remote.connect_failed' as any)}
                              {connStatus === 'idle' && t('remote.connect' as any)}
                            </button>
                          </div>
                        </div>

                        {/* History Pills */}
                        {remoteHistory.length > 0 && (
                          <div className="remote-history-pills">
                            {remoteHistory.map(item => (
                              <div
                                key={item.id}
                                className={`remote-pill remote-pill-${item.protocol}`}
                                onClick={async () => {
                                  setRemoteProtocol(item.protocol);
                                  setSshHost(item.host);
                                  setSshPort(item.port);
                                  if (item.protocol === 'ssh') setSshUser(item.user);
                                  
                                  setConnStatus('connecting');
                                  saveRemoteHistory(item); // Refresh history order
                                  
                                  let isOffline = false;
                                  try {
                                    const portNum = parseInt(item.port) || (item.protocol === 'ssh' ? 22 : 7681);
                                    const isReachable = await commands.checkNetworkPort(item.host.trim(), portNum);
                                    if (!isReachable) isOffline = true;
                                  } catch(err) {
                                    isOffline = true;
                                  }

                                  if (isOffline) {
                                    setConnStatus('failed');
                                    setTimeout(() => setConnStatus('idle'), 3000);
                                    return;
                                  }

                                  const connDataObj = {
                                    protocol: item.protocol,
                                    host: item.host.trim(),
                                    port: parseInt(item.port) || (item.protocol === 'ssh' ? 22 : 7681),
                                    username: item.user || '',
                                    password: sshPass,
                                  };
                                  try { localStorage.setItem('coffee_remote_cfg', JSON.stringify(connDataObj)); } catch(e) {}
                                  selectTool('remote', JSON.stringify(connDataObj));
                                  setShowRemoteForm(false);
                                  setConnStatus('idle');
                                }}
                              >
                                <span className="remote-pill-proto">{item.protocol}</span>
                                <span>{item.host}</span>
                                <button className="remote-pill-close" onClick={(e) => deleteRemoteHistory(item.id, e)}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  </div>
                </div>

                {/* ─── Page 2: Arcade (Games) ─── */}
                <div className="launchpad-page">
                  <div className="launchpad-inner">
                    <div className="launchpad-grid">
                      {arcadeGames.map(game => {
                        const name = game.name.replace(/\.jsdos$/i, '').replace(/[_-]/g, ' ');
                        const m = ARCADE_META[game.name.toLowerCase()];
                        const title = m ? t(m.key as any) : name;
                        const icon = m?.icon;
                        return (
                          <div
                            key={game.name}
                            className="launchpad-card"
                            onClick={() => {
                              setShowArcadeGames(false);
                              selectTool('arcade');
                              // Set game name in toolData so tab shows correct title and DosPlayer auto-launches
                              const sid = state.activeTerminalId;
                              if (sid) dispatch({ type: 'SET_TERMINAL_TOOL', id: sid, tool: 'arcade', toolData: game.name });
                            }}
                          >
                            <div className="launchpad-icon">
                              {icon
                                ? <img src={icon} alt={title} style={{ width: '1.4em', height: '1.4em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />
                                : '🎮'}
                            </div>
                            <span>{title}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                
              </div>
            </div>

            {/* Global Mode switch button */}
            <div style={{ position: 'absolute', bottom: 18, right: 18 }}>
              <button
                className={`mode-switch-btn ${disableDrawer ? 'instant-click' : ''}`}
                onClick={() => {
                  setDisableDrawer(true);
                  setTimeout(() => setDisableDrawer(false), 500);
                  
                  if (!showArcadeGames) {
                    setShowArcadeGames(true);
                    if (isTauri) {
                      commands.listJsdosBundles().then((b: any[]) => {
                        const remoteAssets = [
                          { name: 'pal.jsdos', path: 'https://raw.githubusercontent.com/edison7009/Coffee-CLI/game-assets/play/pal.jsdos?v=3', size: 0 },
                          { name: 'stardom.jsdos', path: 'https://raw.githubusercontent.com/edison7009/Coffee-CLI/game-assets/play/stardom.jsdos?v=3', size: 0 }
                        ];
                        for (const asset of remoteAssets) {
                          if (!b.some((game: any) => game.name.toLowerCase() === asset.name)) {
                            b.push(asset);
                          }
                        }
                        setArcadeGames(b);
                      }).catch(() => {});
                    }
                  } else {
                    setShowArcadeGames(false);
                  }
                }}
              >
                <div className="mode-switch-drawer">
                  {!showArcadeGames 
                    ? (state.currentLang.startsWith('zh') ? '\u653e\u677e\u4e00\u4e0b' : 'Take a break')
                    : (state.currentLang.startsWith('zh') ? '\u56de\u5230\u5de5\u4f5c' : 'Back to work')}
                </div>
                <div className="mode-switch-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>
                  </svg>
                </div>
              </button>
            </div>
          </div>
                )}
      </div>
    </>
  );
}
