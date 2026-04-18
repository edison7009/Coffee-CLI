import { useState, useEffect, useRef } from 'react';
import { focusTerminal } from '../../lib/focus-registry';
import { TierTerminal } from './TierTerminal';
import { DosPlayer } from './DosPlayer';
import { ChatReader } from './ChatReader';
import { WorkstationPanel, type WorkstationActiveTeamInfo } from './WorkstationPanel';
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
import { fetchGameCatalog, type RemoteGameEntry } from '../../utils/game-catalog';
import './CenterPanel.css';

// SVG Definitions for reusability
const SvgClaude = () => (
  <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fillRule="evenodd"></path>
  </svg>
);

const SvgQwen = () => (
  <svg height="1em" viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
    <path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" fill="url(#lobe-icons-qwen-fill)" fillRule="nonzero"/>
    <defs>
      <linearGradient id="lobe-icons-qwen-fill" x1="0%" x2="100%" y1="0%" y2="0%">
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
  const [showWorkstation, setShowWorkstation] = useState(false);
  const [workstationActiveTeam, setWorkstationActiveTeam] = useState<WorkstationActiveTeamInfo | null>(null);
  const [arcadeGames, setArcadeGames] = useState<{name:string;path:string;size:number;icon?:string;title?:string}[]>([]);
  const [gameCatalog, setGameCatalog] = useState<RemoteGameEntry[]>([]);
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
  const [lastCwdByTool, setLastCwdByTool] = useState<Record<string, string>>({});

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

  // Load sticky config — non-sensitive fields from localStorage, password from OS keychain
  useEffect(() => {
    try {
      const saved = localStorage.getItem('coffee_remote_cfg');
      if (saved) {
        const c = JSON.parse(saved);
        if (c.protocol) setRemoteProtocol(c.protocol);
        if (c.host) setSshHost(c.host);
        if (c.port) setSshPort(String(c.port));
        if (c.username) setSshUser(c.username);
        if (isTauri && c.host && c.username) {
          commands.loadPassword(c.host, c.username)
            .then(pw => { if (pw) setSshPass(pw); })
            .catch(() => {});
        }
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
    try {
      const raw = localStorage.getItem('coffee:last-cwd-by-tool');
      if (raw) setLastCwdByTool(JSON.parse(raw));
    } catch {}
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

  const formatCwd = (cwd: string): string => {
    if (!cwd) return '';
    // Detect Windows path (e.g. C:\... or c:/...)
    const isWin = /^[a-zA-Z]:/.test(cwd);
    if (isWin) {
      // Uppercase drive letter, normalize to backslashes
      const formatted = cwd[0].toUpperCase() + ':' + cwd.slice(2).replace(/\//g, '\\');
      return formatted.length > 30 ? '\u2026' + formatted.slice(-28) : formatted;
    }
    // Unix path — show last 2 segments
    const parts = cwd.split('/').filter(Boolean);
    if (parts.length === 0) return cwd;
    const label = parts.length >= 2
      ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
      : parts[parts.length - 1];
    return label.length > 30 ? '\u2026' + label.slice(-28) : label;
  };

  const selectTool = (tool: ToolType, toolData?: string, cwd?: string) => {
    if (activeTerminalId) {
      if (cwd) {
        dispatch({ type: 'SET_FOLDER', path: cwd });
        setLastCwdByTool(prev => {
          const next = { ...prev, [tool as string]: cwd };
          try { localStorage.setItem('coffee:last-cwd-by-tool', JSON.stringify(next)); } catch {}
          return next;
        });
      }
      dispatch({ type: 'SET_TERMINAL_TOOL', id: activeTerminalId, tool, toolData });
    }
  };

  const handlePickFolder = async (toolKey: ToolType) => {
    if (!toolKey) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true });
      if (selected && typeof selected === 'string') {
        selectTool(toolKey, undefined, selected);
      }
    } catch (err) {
      console.error('[CenterPanel] Folder picker failed:', err);
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
      // password intentionally omitted — stored in OS keychain, not localStorage
    };

    try {
      localStorage.setItem('coffee_remote_cfg', JSON.stringify(connDataObj));
    } catch(e) {}

    // Save password to OS keychain (Windows Credential Manager / macOS Keychain)
    if (isTauri && sshPass) {
      commands.savePassword(sshHost.trim(), sshUser.trim(), sshPass).catch(() => {});
    }

    // connData sent in-memory to Rust for the connection — includes password
    const connData = JSON.stringify({ ...connDataObj, password: sshPass });

    selectTool('remote', connData);
    setShowRemoteForm(false);
    setConnStatus('idle');
  };

  // Game catalog loaded from coffeecli.com/play/game.json, re-resolved on lang change
  useEffect(() => {
    fetchGameCatalog(state.currentLang).then(setGameCatalog).catch(() => {});
  }, [state.currentLang]);

  // Re-fetch arcade game list when language changes while the game page is open
  useEffect(() => {
    if (!showArcadeGames || !isTauri) return;
    Promise.allSettled([commands.listJsdosBundles(), fetchGameCatalog(state.currentLang)])
      .then(([bundlesResult, catalogResult]) => {
        const localBundles: any[] = bundlesResult.status === 'fulfilled' ? bundlesResult.value : [];
        const catalog: RemoteGameEntry[] = catalogResult.status === 'fulfilled' ? catalogResult.value : [];
        const games = catalog.map(entry => {
          const cached = localBundles.find((b: any) => b.name.toLowerCase() === entry.file.toLowerCase());
          return { name: entry.file, path: cached ? cached.path : entry.download, size: cached ? cached.size : 0, icon: entry.icon, title: entry.title };
        });
        setArcadeGames(games);
      });
  }, [state.currentLang, showArcadeGames]);

  // Last path segment, Windows ("\") and POSIX ("/") safe. null when path unknown.
  const cwdBasename = (p: string | null | undefined): string | null => {
    if (!p) return null;
    const trimmed = p.replace(/[\\/]+$/, '');
    if (!trimmed) return '/';
    if (/^[A-Za-z]:$/.test(trimmed)) return trimmed + '\\';
    const parts = trimmed.split(/[\\/]/);
    return parts[parts.length - 1] || trimmed;
  };

  // Local shell-bearing tabs show cwd basename (Explorer-style): icon = tool identity,
  // text = location. Remote/non-shell tabs keep their existing labels.
  const renderTabContent = (session: typeof terminals[0], isActive: boolean) => {
    const cwd = cwdBasename(session.folderPath);
    const pathTip = session.folderPath ?? undefined;

    // Mode overrides: when the active tab is showing Workstation or Arcade
    // mode (both triggered on tabs with tool=null via the bottom mode dock),
    // surface a mode-appropriate title so the outer tab reads as "选择团队"
    // or follows the active team/game — not the generic "Select Tool".
    if (isActive && session.tool === null) {
      if (showWorkstation) {
        if (workstationActiveTeam) {
          return {
            icon: <span style={{ fontSize: '1em', lineHeight: 1 }}>{workstationActiveTeam.icon}</span>,
            title: workstationActiveTeam.name,
            tooltip: undefined,
          };
        }
        return {
          icon: <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
          title: state.currentLang.startsWith('zh') ? '\u9009\u62e9\u56e2\u961f' : 'Select Team',
          tooltip: undefined,
        };
      }
      if (showArcadeGames) {
        return {
          icon: <span style={{ fontSize: '1em', lineHeight: 1 }}>🎮</span>,
          title: state.currentLang.startsWith('zh') ? '\u9009\u62e9\u6e38\u620f' : 'Select Game',
          tooltip: undefined,
        };
      }
    }

    switch (session.tool) {
      case 'claude': return { icon: <SvgClaude />, title: cwd ?? 'Claude Code', tooltip: pathTip };
      case 'qwen': return { icon: <SvgQwen />, title: cwd ?? 'Qwen Code', tooltip: pathTip };
      case 'hermes': return { icon: <SvgHermes />, title: cwd ?? 'Hermes', tooltip: pathTip };
      case 'opencode': return { icon: <SvgOpenCode />, title: cwd ?? 'OpenCode', tooltip: pathTip };
      case 'installer': return { icon: <SvgInstaller />, title: t('tool.installer' as any), tooltip: undefined };
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
        return { icon: <TerminalIcon />, title, tooltip: undefined };
      }
      case 'terminal': return { icon: <TerminalIcon />, title: cwd ?? t('tool.terminal'), tooltip: pathTip };
      case 'arcade': {
        const gameName = session.toolData || '';
        const meta = gameCatalog.find(m => m.file.toLowerCase() === gameName.toLowerCase());
        if (meta) {
          return { icon: <img src={meta.icon} alt="" style={{ width: '1em', height: '1em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />, title: meta.title, tooltip: undefined };
        }
        return { icon: <span style={{ fontSize: '1em' }}>🎮</span>, title: 'Coffee Play', tooltip: undefined };
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
          title: titleParam,
          tooltip: undefined
        };
      }
      default: return { icon: <SvgPlus active={isActive} />, title: t('tab.new'), tooltip: undefined };
    }
  };

  // ── Custom background (image/video) ──────────────────────────────────────
  // Background state lives in global AppState (set via theme menu in Explorer)
  const bgPath = state.bgPath;
  const bgType = state.bgType;
  const hasBg = bgType !== 'none' && bgPath !== '';

  // Convert local file path to a displayable URL.
  // Use Tauri's convertFileSrc (asset protocol) for zero-copy streaming.
  const [bgUrl, setBgUrl] = useState('');
  useEffect(() => {
    if (!hasBg) { setBgUrl(''); return; }
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      setBgUrl(convertFileSrc(bgPath));
    }).catch(() => {
      setBgUrl('file:///' + bgPath.replace(/\\/g, '/'));
    });
  }, [hasBg, bgPath]);

  return (
    <>
      <div className="chrome-tabs-header" data-count={terminals.filter(s => !s.isHidden || s.id === activeTerminalId).length}>
        {terminals.map(session => {
          if (session.isHidden && session.id !== activeTerminalId) return null;

          const isActive = session.id === activeTerminalId;
          const { icon, title, tooltip } = renderTabContent(session, isActive);

          return (
            <div
              key={session.id}
              className={`chrome-tab ${isActive ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: session.id })}
            >
              {icon}
              <span className="tab-title" title={tooltip} style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</span>
              <div className="tab-actions">
                {(['claude', 'qwen', 'hermes', 'opencode'] as const).includes(session.tool as 'claude' | 'qwen' | 'hermes' | 'opencode') && (
                  <div className={`tab-status-grid status-${session.agentStatus === 'wait_input' ? 'waiting' : session.agentStatus ?? 'idle'}`}>
                    {Array.from({ length: 9 }, (_, i) => <div key={i} className="tab-status-dot" />)}
                  </div>
                )}
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
                  hasBg={hasBg}
                  bgUrl={bgUrl}
                  bgType={bgType}
                  termColorScheme={state.termColorScheme}
                />
              </ErrorBoundary>
            )}
          </div>
        ) : null)}

        {isLaunchpadMode && activeTerminalId && (
          <div className={`launchpad-container${hasBg && bgUrl ? ' launchpad-has-bg' : ''}`} style={{ position: 'relative' }}>
            {hasBg && bgUrl && (
              <div className="launchpad-bg">
                {bgType === 'video'
                  ? <video src={bgUrl} autoPlay loop muted playsInline onError={() => { setBgUrl(''); }} />
                  : <img src={bgUrl} alt="" onError={() => { setBgUrl(''); }} />}
              </div>
            )}
            {/* Close button removed: handles via Tab bar */}
            {showWorkstation && (
              <WorkstationPanel
                onExit={() => setShowWorkstation(false)}
                onActiveTeamChange={setWorkstationActiveTeam}
              />
            )}
            <div className="launchpad-slider-viewport" style={{ display: showWorkstation ? 'none' : undefined }}>
              <div className={`launchpad-slider-track ${showArcadeGames ? 'slide-to-games' : ''}`}>
                
                {/* ─── Page 1: Tools ─── */}
                <div className="launchpad-page">
                  <div className="launchpad-inner">
                    <div className="launchpad-grid">
                      {[
                        { key: 'claude' as ToolType, label: 'Claude Code', icon: <SvgClaude /> },
                        { key: 'qwen' as ToolType, label: 'Qwen Code', icon: <SvgQwen /> },
                        { key: 'hermes' as ToolType, label: 'Hermes', icon: <SvgHermes /> },
                        { key: 'opencode' as ToolType, label: 'OpenCode', icon: <SvgOpenCode /> },
                        { key: 'installer' as ToolType, label: t('tool.installer' as any), icon: <SvgInstaller /> },
                      ].map(tool => {
                        const installed = toolsInstalled[tool?.key ?? ''] !== false;
                        return (
                          <div key={tool.key} className={`launchpad-card-group ${!installed ? 'launchpad-card-disabled' : ''}`}>
                            <div
                              className="launchpad-card"
                              onClick={() => installed && selectTool(tool.key, undefined, lastCwdByTool[tool.key!])}
                            >
                              <div className="launchpad-icon">{tool.icon}</div>
                              <div className="launchpad-card-info">
                                <span>{tool.label}</span>
                                {lastCwdByTool[tool.key!] && (
                                  <span className="launchpad-card-cwd">
                                    {formatCwd(lastCwdByTool[tool.key!])}
                                  </span>
                                )}
                              </div>
                              <div className="launchpad-folder-btn" onClick={(e) => { e.stopPropagation(); installed && handlePickFolder(tool.key); }}>
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                </svg>
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {/* Terminal card with subtle Remote icon */}
                      <div className="launchpad-card-group">
                        <div
                          className="launchpad-card"
                          onClick={() => selectTool('terminal', undefined, lastCwdByTool['terminal'])}
                        >
                          <div className="launchpad-icon"><TerminalIcon /></div>
                          <div className="launchpad-card-info">
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              {t('tool.terminal')}
                              <span
                                className="remote-link-hint"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowRemoteForm(true);
                                }}
                              >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="10"/>
                                  <path d="M2 12h20"/>
                                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                </svg>
                              </span>
                            </span>
                            {lastCwdByTool['terminal'] && (
                              <span className="launchpad-card-cwd">
                                {formatCwd(lastCwdByTool['terminal'])}
                              </span>
                            )}
                          </div>
                          <div className="launchpad-folder-btn" onClick={(e) => { e.stopPropagation(); handlePickFolder('terminal'); }}>
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            </svg>
                          </div>
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
                                    // password omitted from localStorage
                                  };
                                  try { localStorage.setItem('coffee_remote_cfg', JSON.stringify(connDataObj)); } catch(e) {}
                                  // Load password for this specific host from keychain, fall back to current sshPass state
                                  const doConnect = (pw: string) => {
                                    if (isTauri && pw) commands.savePassword(item.host.trim(), item.user || '', pw).catch(() => {});
                                    selectTool('remote', JSON.stringify({ ...connDataObj, password: pw }));
                                  };
                                  if (isTauri && item.host && item.user) {
                                    commands.loadPassword(item.host.trim(), item.user)
                                      .then(pw => doConnect(pw ?? sshPass))
                                      .catch(() => doConnect(sshPass));
                                  } else {
                                    doConnect(sshPass);
                                  }
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
                        const title = game.title || game.name.replace(/\.jsdos$/i, '').replace(/[_-]/g, ' ');
                        return (
                          <div
                            key={game.name}
                            className="launchpad-card"
                            onClick={() => {
                              setShowArcadeGames(false);
                              selectTool('arcade');
                              const sid = state.activeTerminalId;
                              if (sid) dispatch({ type: 'SET_TERMINAL_TOOL', id: sid, tool: 'arcade', toolData: game.name });
                            }}
                          >
                            <div className="launchpad-icon">
                              {game.icon
                                ? <img src={game.icon} alt={title} style={{ width: '1.4em', height: '1.4em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />
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

            {/* Bottom center mode dock — hover reveals Games on the left and
                Workstation on the right. When already in games mode, the left
                side flips to "back to tools"; workstation mode mirrors it on
                the right. One dock, three destinations. */}
            <div className="mode-dock-wrap">
              <div className={`mode-dock ${disableDrawer ? 'instant-click' : ''}`}>
                {/* Left side — Games */}
                <button
                  className="mode-dock-side mode-dock-side--left"
                  onClick={() => {
                    setDisableDrawer(true);
                    setTimeout(() => setDisableDrawer(false), 500);
                    if (showArcadeGames) {
                      setShowArcadeGames(false);
                      return;
                    }
                    setShowWorkstation(false);
                    setShowArcadeGames(true);
                    if (isTauri) {
                      Promise.allSettled([commands.listJsdosBundles(), fetchGameCatalog(state.currentLang)])
                        .then(([bundlesResult, catalogResult]) => {
                          const localBundles: any[] = bundlesResult.status === 'fulfilled' ? bundlesResult.value : [];
                          const catalog: RemoteGameEntry[] = catalogResult.status === 'fulfilled' ? catalogResult.value : [];
                          const games = catalog.map(entry => {
                            const cached = localBundles.find((b: any) => b.name.toLowerCase() === entry.file.toLowerCase());
                            return { name: entry.file, path: cached ? cached.path : entry.download, size: cached ? cached.size : 0, icon: entry.icon, title: entry.title };
                          });
                          setArcadeGames(games);
                        });
                    }
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="6" y1="11" x2="10" y2="11"/><line x1="8" y1="9" x2="8" y2="13"/>
                    <line x1="15" y1="12" x2="15.01" y2="12"/><line x1="18" y1="10" x2="18.01" y2="10"/>
                    <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258A4 4 0 0 0 17.32 5z"/>
                  </svg>
                  <span>
                    {showArcadeGames
                      ? (state.currentLang.startsWith('zh') ? '\u56de\u5230\u5de5\u5177' : 'Back')
                      : (state.currentLang.startsWith('zh') ? '\u6e38\u620f' : 'Games')}
                  </span>
                </button>

                {/* Center icon — decorative pivot */}
                <div className="mode-dock-center">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/>
                  </svg>
                </div>

                {/* Right side — Workstation */}
                <button
                  className="mode-dock-side mode-dock-side--right"
                  onClick={() => {
                    setDisableDrawer(true);
                    setTimeout(() => setDisableDrawer(false), 500);
                    if (showWorkstation) {
                      setShowWorkstation(false);
                      return;
                    }
                    setShowArcadeGames(false);
                    setShowWorkstation(true);
                  }}
                >
                  <span>
                    {showWorkstation
                      ? (state.currentLang.startsWith('zh') ? '\u56de\u5230\u5de5\u5177' : 'Back')
                      : (state.currentLang.startsWith('zh') ? '\u5de5\u4f5c\u7ad9' : 'Workstation')}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" rx="1"/>
                    <rect x="14" y="3" width="7" height="7" rx="1"/>
                    <rect x="3" y="14" width="7" height="7" rx="1"/>
                    <rect x="14" y="14" width="7" height="7" rx="1"/>
                  </svg>
                </button>
              </div>
            </div>

          </div>
                )}
      </div>
    </>
  );
}
