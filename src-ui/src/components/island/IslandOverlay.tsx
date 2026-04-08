// IslandOverlay.tsx — System-level Dynamic Island
// Runs in a separate Tauri window (always-on-top, transparent, frameless).
// Listens for agent-status events and shows the most urgent status.
// Supports multi-agent: groups icons by priority status.
// Supports drag-to-reposition via data-tauri-drag-region.

import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useT } from '../../i18n/useT';
import './IslandOverlay.css';

// ─── Types ──────────────────────────────────────────────────────────────────

type AgentStatus = 'working' | 'idle' | 'wait_input';

interface AgentState {
  id: string;
  tool: string;
  status: AgentStatus;
  updatedAt: number;
}

interface AgentStatusPayload {
  id: string;
  status: string;
  silence_ms: number;
}

// Events from main window to tell island about tool assignments
interface ToolAssignPayload {
  id: string;
  tool: string;
}

// ─── Tool Icons (inline SVG for standalone window) ──────────────────────────

const ClaudeIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path clipRule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fillRule="evenodd" />
  </svg>
);

const CodexIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect width="24" height="24" rx="4.5" fill="#fff" />
    <path d="M12.546 13.909h3.636a.637.637 0 100-1.272h-3.636a.637.637 0 000 1.272zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="#5B6BFF" />
  </svg>
);

const RemoteIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect x="1" y="3" width="22" height="18" rx="3" fill="url(#ir)" />
    <path d="M7 10l3 3-3 3" stroke="#1E1E2E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="13" y1="16" x2="17" y2="16" stroke="#1E1E2E" strokeWidth="2" strokeLinecap="round" />
    <defs><linearGradient id="ir" x1="1" x2="23" y1="3" y2="21" gradientUnits="userSpaceOnUse"><stop stopColor="#4ade80" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
  </svg>
);

const GeminiIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <rect width="24" height="24" rx="4.4" fill="url(#ig)" />
    <path clipRule="evenodd" d="M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z" fill="#1E1E2E" fillRule="evenodd" />
    <defs><linearGradient id="ig" x1="24" x2="0" y1="6.6" y2="16.5" gradientUnits="userSpaceOnUse"><stop stopColor="#EE4D5D" /><stop offset=".33" stopColor="#B381DD" /><stop offset=".48" stopColor="#207CFE" /></linearGradient></defs>
  </svg>
);

const OpenClawIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 2.568c-6.33 0-9.495 5.275-9.495 9.495 0 4.22 3.165 8.44 6.33 9.494v2.11h2.11v-2.11s1.055.422 2.11 0v2.11h2.11v-2.11c3.165-1.055 6.33-5.274 6.33-9.494S18.33 2.568 12 2.568z" fill="#DD3333" />
    <circle cx="8.8" cy="7.8" r="1.2" fill="#050810" /><circle cx="15.2" cy="7.8" r="1.2" fill="#050810" />
  </svg>
);

const CoffeeBrandIcon = ({ size = 20 }: { size?: number }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24">
    <defs>
      <mask id="IconifyId19c6c7c36245d0fc551627147">
        <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
          <animate attributeName="d" dur="3s" repeatCount="indefinite" values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4" />
        </path>
        <path d="M4 7h16v0h-16v12h16v-32h-16Z">
          <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s" to="M4 2h16v5h-16v12h16v-24h-16Z" />
        </path>
      </mask>
    </defs>
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
      <path fill="currentColor" fillOpacity="0" strokeDasharray="48" d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
        <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0" />
        <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1" />
      </path>
      <path fill="none" strokeDasharray="16" strokeDashoffset="16" d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
        <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0" />
      </path>
    </g>
    <path fill="currentColor" d="M0 0h24v24H0z" mask="url(#IconifyId19c6c7c36245d0fc551627147)" />
  </svg>
);

const detectOS = (): 'win' | 'mac' | 'linux' => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win';
  if (ua.includes('mac')) return 'mac';
  return 'linux';
};

const TERMINAL_ICON_SRC: Record<string, string> = {
  win: '/icons/powershell.svg',
  mac: '/icons/macos-terminal.png',
  linux: '/icons/linux-terminal.png',
};

const TerminalIcon = ({ size = 20 }: { size?: number }) => (
  <img
    src={TERMINAL_ICON_SRC[detectOS()]}
    alt=""
    style={{ width: size, height: size, borderRadius: 3, objectFit: 'contain' }}
  />
);

const TOOL_ICONS: Record<string, (size: number) => React.ReactNode> = {
  claude: (s) => <ClaudeIcon size={s} />,
  codex: (s) => <CodexIcon size={s} />,
  gemini: (s) => <GeminiIcon size={s} />,
  remote: (s) => <RemoteIcon size={s} />,
  openclaw: (s) => <OpenClawIcon size={s} />,
  terminal: (s) => <TerminalIcon size={s} />,
};

// ─── Priority ───────────────────────────────────────────────────────────────

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  wait_input: 3,
  working: 2,
  idle: 1,
};



// ─── Elapsed Timer ──────────────────────────────────────────────────────────

function useElapsedTimer(active: boolean): string {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());

  useEffect(() => {
    if (active) {
      startRef.current = Date.now();
      setElapsed(0);
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setElapsed(0);
    }
  }, [active]);

  if (!active || elapsed < 2) return '';
  if (elapsed < 60) return `${elapsed}s`;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function IslandOverlay() {
  const t = useT();
  const [agents, setAgents] = useState<Map<string, AgentState>>(new Map());
  const [hidden, setHidden] = useState(false);
  const islandWindow = useRef(getCurrentWindow());
  const [forceShow, setForceShow] = useState(false);

  // Listen for agent-status events (from Rust backend, broadcasts to all windows)
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<AgentStatusPayload>('agent-status', (event) => {
      const { id, status } = event.payload;
      if (status !== 'working' && status !== 'idle' && status !== 'wait_input') return;

      // Island only has two visual states: working or wait_input.
      // Backend 'idle' means agent is at prompt → same as wait_input for the island.
      const islandStatus: AgentStatus = status === 'idle' ? 'wait_input' : status as AgentStatus;

      setAgents(prev => {
        const next = new Map(prev);
        const existing = next.get(id);
        next.set(id, {
          id,
          tool: existing?.tool || 'claude', // default until tool-assign arrives
          status: islandStatus,
          updatedAt: Date.now(),
        });
        return next;
      });
    }).then(u => unlisteners.push(u));

    // Listen for tool assignment from main window
    listen<ToolAssignPayload>('island-tool-assign', (event) => {
      const { id, tool } = event.payload;
      setAgents(prev => {
        const next = new Map(prev);
        const existing = next.get(id);
        if (existing) {
          next.set(id, { ...existing, tool });
        } else {
          next.set(id, { id, tool, status: 'idle', updatedAt: Date.now() });
        }
        return next;
      });
    }).then(u => unlisteners.push(u));

    // Listen for session removal
    listen<{ id: string }>('island-session-remove', (event) => {
      setAgents(prev => {
        const next = new Map(prev);
        next.delete(event.payload.id);
        return next;
      });
    }).then(u => unlisteners.push(u));

    return () => unlisteners.forEach(u => u());
  }, []);

  const [minimized, setMinimized] = useState(false);

  // Show/hide based on main window minimize state
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen('main-window-restored', () => {
      setMinimized(false);
    }).then(u => unlisteners.push(u));

    listen('main-window-minimized', () => {
      setMinimized(true);
    }).then(u => unlisteners.push(u));

    listen<{ forceShow: boolean }>('island-toggle', (event) => {
      const next = event.payload.forceShow;
      setForceShow(next);
      if (next) setHidden(false);
    }).then(u => unlisteners.push(u));

    return () => unlisteners.forEach(u => u());
  }, []);

  // Hide when user closes island
  const handleClose = () => {
    setHidden(true);
    setForceShow(false);
    import('@tauri-apps/api/event').then(({ emit }) => {
      emit('island-state-sync', { forced: false });
    }).catch(() => { });
    islandWindow.current.hide();
  };

  // ── Island Interaction ───────────────────────────────────────────────────
  // Dragging: data-tauri-drag-region on the pill (native, smooth)
  // Open:     button click (same mechanism as close — proven to work)

  const handleOpen = () => {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke('show_main_window').catch(console.error);
    });
    import('@tauri-apps/api/event').then(({ emit }) => {
      const urgent = Array.from(agents.values())
        .filter(a => a.status !== 'idle')
        .sort((a, b) => STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status]);
      emit('island-clicked', { agentId: urgent[0]?.id || null });
    });
  };

  // ── Compute display state ─────────────────────────────────────────────────

  // Consider all known agents, sorted by priority
  const sorted = Array.from(agents.values()).sort(
    (a, b) => STATUS_PRIORITY[b.status] - STATUS_PRIORITY[a.status]
  );

  // Top agent = most urgent
  const topAgent = sorted[0] || null;
  const topStatus: AgentStatus = topAgent?.status || 'idle';
  const otherAgents = sorted.slice(1);

  // Elapsed timer for the top agent
  const timerText = useElapsedTimer(topStatus === 'working');

  // Core visibility rule: show when minimized OR manually forced, and not human-hidden
  const shouldShow = (minimized || forceShow) && !hidden;

  useEffect(() => {
    if (shouldShow) {
      islandWindow.current.show();
    } else {
      islandWindow.current.hide();
    }
  }, [shouldShow]);

  // Brand mode (minimized but no active agents)
  if (!topAgent) {
    if (!shouldShow) return <div className="island-root" />;

    return (
      <div className="island-root">
        <div className="island-pill glow-brand" data-tauri-drag-region>
          <button className="island-open" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handleOpen(); }}>
            <span className="island-icon-primary" style={{ color: '#c4956a' }}>
              <CoffeeBrandIcon size={20} />
            </span>
          </button>
          <span className="island-status-text" data-tauri-drag-region>
            Coffee CLI
          </span>
          <button className="island-close" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handleClose(); }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // Glow class based on top agent's tool
  const glowClass = `glow-${topAgent.tool}`;

  return (
    <div className="island-root">
      <div
        className={`island-pill ${glowClass}`}
        data-tauri-drag-region
      >
        {/* Open button (click to restore main window) */}
        <button className="island-open" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handleOpen(); }}>
          <div className="island-icons">
            <span className={`island-icon-primary icon-${topStatus}`}>
              {TOOL_ICONS[topAgent.tool]?.(20)}
            </span>
            {otherAgents.map(a => (
              <span key={a.id} className="island-icon-secondary">
                {TOOL_ICONS[a.tool]?.(14)}
              </span>
            ))}
          </div>
        </button>

        {/* Status dot */}
        <span className={`island-status-dot ${topStatus}`} data-tauri-drag-region />

        {/* Status text */}
        <span className="island-status-text" data-tauri-drag-region>
          {t(`island.status.${topStatus}` as any)}
        </span>

        {/* Elapsed timer */}
        {timerText && (
          <span className="island-timer" data-tauri-drag-region>{timerText}</span>
        )}

        {/* Close button */}
        <button className="island-close" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handleClose(); }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
