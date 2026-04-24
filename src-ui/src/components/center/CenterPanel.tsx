import { useState, useEffect, useRef } from 'react';
import { focusTerminal } from '../../lib/focus-registry';
import { TierTerminal } from './TierTerminal';
import { DosPlayer } from './DosPlayer';
import { ChatReader } from './ChatReader';
import { MultiAgentGrid } from './MultiAgentGrid';
import { FourSplitGrid } from './FourSplitGrid';
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
import { fetchAgentsCatalog, getCachedAgentsCatalog, type RemoteAgentEntry } from '../../utils/agents-catalog';
import './CenterPanel.css';

// Tool icons — all assets live under /icons/tools/.
// Adding a new tool = drop an SVG/PNG in that folder + reference the URL here.

const toolIcon = (src: string, size = '1em', extra: React.CSSProperties = {}) => (
  <img src={src} alt="" style={{ width: size, height: size, flexShrink: 0, objectFit: 'contain', ...extra }} />
);

const SvgClaude    = () => toolIcon('/icons/tools/claude.svg');
const SvgQwen      = () => toolIcon('/icons/tools/qwen.svg');
const SvgOpenCode  = () => toolIcon('/icons/tools/opencode.svg');
const SvgCodex     = () => toolIcon('/icons/tools/codex.svg');
const SvgGemini    = () => toolIcon('/icons/tools/gemini.svg');
const SvgVibeID    = () => toolIcon('/icons/tools/vibeid.png', '1.4em');
const SvgHermes    = () => toolIcon('/icons/tools/hermes.png', '1em', { borderRadius: 'var(--radius-xs)', objectFit: 'cover' });

// One-click installer glyph — clock face with hour hands. Inlined (instead
// of loading /icons/tools/installer.svg as <img>) so the stroke can inherit
// currentColor and follow the theme accent, matching our other in-house
// glyphs (multi-agent, four-split). Third-party logos (Claude, Gemini,
// Codex...) stay as <img> to preserve their brand colors.
const SvgInstaller = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    style={{ flexShrink: 0, color: 'var(--accent)' }}
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 7v6l4 4" />
  </svg>
);

// Multi-Agent glyph — same lucide layout-grid path used by the titlebar's
// "2×2 grid" layout toggle. Inline so it tints with the theme (currentColor)
// and stays in lockstep with the titlebar. Rendered at 1em so it picks up
// the card/tab font-size (Launchpad card ≈ 22px, Tab ≈ 13px) without
// per-callsite tweaks.
// Multi-Agent glyph — one whole frame divided into 4 quadrants by a cross.
// Reads as "a single coordinated system split into 4 roles", matching the
// MCP peer-coordination model (the 4 panes share one workspace and one MCP
// endpoint, so conceptually they're one entity with 4 heads).
const SvgMultiAgent = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="5" y="5" width="14" height="14" />
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

// Two-Split glyph — 2 tall rectangles side-by-side with a gap. Conveys
// "two independent full-height panes" — the most common split case
// (diff review, A/B comparison, doc + terminal).
const SvgTwoSplit = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="5"  y="5" width="6" height="14" />
    <rect x="13" y="5" width="6" height="14" />
  </svg>
);

// Three-Split glyph — 3 tall rectangles side-by-side. Second-most common
// split case (editor + terminal + preview, or 3-way merge).
const SvgThreeSplit = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="4"  y="5" width="4" height="14" />
    <rect x="10" y="5" width="4" height="14" />
    <rect x="16" y="5" width="4" height="14" />
  </svg>
);

// Four-Split glyph — 4 individually-framed rectangles with visible gaps
// between them. Reads as "4 standalone windows on one screen" — which is
// literally what 独立四屏 is: 4 independent PTYs, independent folders,
// independent tools, zero coordination.
const SvgFourSplit = () => (
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="square"
    strokeLinejoin="miter"
    style={{ flexShrink: 0, color: 'var(--accent)', verticalAlign: '-0.125em' }}
  >
    <rect x="5"  y="5"  width="6" height="6" />
    <rect x="13" y="5"  width="6" height="6" />
    <rect x="13" y="13" width="6" height="6" />
    <rect x="5"  y="13" width="6" height="6" />
  </svg>
);

// ── Platform-aware Terminal Icon & Label ─────────────────────────────────────

const detectOS = (): 'win' | 'mac' | 'linux' => {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win';
  if (ua.includes('mac')) return 'mac';
  return 'linux';
};

const TERMINAL_ICON: Record<string, string> = {
  win: '/icons/tools/terminal-powershell.svg',
  mac: '/icons/tools/terminal-macos.png',
  linux: '/icons/tools/terminal-linux.png',
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
  const [libraryTab, setLibraryTab] = useState<'agents' | 'games'>('agents');
  const [pinnedItems, setPinnedItems] = useState<string[]>(() => {
    // Hard cap must match MAX_PINS constant below. Inlined as a literal
    // because MAX_PINS is declared after this initializer runs.
    const CAP = 6;
    try {
      const stored = localStorage.getItem('coffee_pinned_items');
      if (stored !== null) {
        let arr = JSON.parse(stored);
        if (!Array.isArray(arr)) return [];
        // One-shot migration: existing users who launched before the
        // multi-agent quadrant shipped won't have it pinned. Inject it
        // once so they discover the feature. If they're already at cap,
        // evict the oldest pin to make room (they can unpin multi-agent
        // via the library if they don't want it).
        if (!arr.includes('agent:multi-agent')) {
          if (arr.length >= CAP) arr.shift();
          arr.push('agent:multi-agent');
        }
        // Defensive cap: historical bugs (e.g. earlier migrations that
        // pushed past the limit) may have left > CAP items in storage.
        // Trim and persist back so the state stays consistent.
        if (arr.length > CAP) arr = arr.slice(0, CAP);
        try { localStorage.setItem('coffee_pinned_items', JSON.stringify(arr)); } catch {}
        return arr;
      }
      // First launch: pre-pin 6 useful defaults so desktop shows a full MAX_PINS
      // grid out of the box (4 AI CLIs covering major providers + 2 utilities).
      // Returning users' pin choices are respected (stored !== null path above).
      const defaults = [
        'agent:claude',
        'agent:codex',
        'agent:opencode',
        'agent:gemini',
        'agent:multi-agent',
        'agent:terminal',
      ];
      localStorage.setItem('coffee_pinned_items', JSON.stringify(defaults));
      return defaults;
    } catch { return []; }
  });

  const MAX_PINS = 6;

  // Remote agents catalog — initialised from localStorage cache (if any) to avoid
  // a fallback → remote content flicker on mount.
  const [remoteAgents, setRemoteAgents] = useState<RemoteAgentEntry[]>(() => getCachedAgentsCatalog());
  // `agentsLoading` / `gamesLoading` drive the skeleton overlay in the Library view.
  // Initialised based on whether we already have cached data (skeleton only when truly empty).
  const [agentsLoading, setAgentsLoading] = useState<boolean>(() => getCachedAgentsCatalog().length === 0);
  const [gamesLoading, setGamesLoading] = useState<boolean>(true);

  useEffect(() => {
    fetchAgentsCatalog()
      .then(setRemoteAgents)
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, []);

  // Auto-sync the VibeID skill on every launch. Small files (SKILL.md,
  // matrix.json, scripts) are re-fetched every time (~10 KB total, <1s on
  // normal networks) so existing users automatically pick up skill logic
  // upgrades without manually deleting ~/.claude/skills/vibeid/. Persona
  // images (~2 MB) are downloaded only on first install.
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      const BASE = 'https://coffeecli.com/CC-VibeID-test';
      const CODES = [
        'PFVL','PFVH','PFAL','PFAH','PSVL','PSVH','PSAL','PSAH',
        'TFVL','TFVH','TFAL','TFAH','TSVL','TSVH','TSAL','TSAH',
      ];
      const textFiles = [
        { remote: 'SKILL.md', local: 'SKILL.md' },
        { remote: 'matrix.json', local: 'matrix.json' },
        { remote: 'scripts/analyze.js', local: 'scripts/analyze.js' },
        { remote: 'scripts/inject.js', local: 'scripts/inject.js' },
      ];
      const pullText = async (f: { remote: string; local: string }) => {
        const res = await fetch(`${BASE}/${f.remote}`);
        if (!res.ok) throw new Error(`${f.remote}: ${res.status}`);
        const bytes = new TextEncoder().encode(await res.text());
        await commands.writeSkillFile(f.local, Array.from(bytes));
      };
      const pullBinary = async (f: { remote: string; local: string }) => {
        const res = await fetch(`${BASE}/${f.remote}`);
        if (!res.ok) throw new Error(`${f.remote}: ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        await commands.writeSkillFile(f.local, Array.from(buf));
      };
      try {
        // Always keep SKILL.md / matrix / scripts fresh.
        await Promise.all(textFiles.map(pullText));

        // Fetch persona images only if this is a fresh install.
        const installed = await commands.checkSkillInstalled('vibeid').catch(() => true);
        if (!installed) {
          const imageFiles = CODES.map(c => ({
            remote: `personas/images/${c}.png`,
            local: `images/${c}.png`,
          }));
          await Promise.all(imageFiles.map(pullBinary));
          console.log('[vibeid] first-time install complete (images + logic)');
        } else {
          console.log('[vibeid] skill logic synced (images already present)');
        }
      } catch (err) {
        console.warn('[vibeid] skill sync failed:', err);
      }
    })();
  }, []);

  // Force a fresh catalog fetch every time the Library opens so newly-deployed
  // agents show up without an app restart (dodges module + CDN caches).
  useEffect(() => {
    if (!showArcadeGames) return;
    // Only show skeleton if we genuinely have nothing to display.
    if (remoteAgents.length === 0) setAgentsLoading(true);
    fetchAgentsCatalog({ fresh: true })
      .then(setRemoteAgents)
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, [showArcadeGames]);

  // Built-in inline SVG icons keyed by agent id. Used when catalog entry id matches;
  // otherwise falls back to entry.icon URL.
  const BUILTIN_ICONS: Record<string, React.ReactNode> = {
    claude: <SvgClaude />,
    opencode: <SvgOpenCode />,
    codex: <SvgCodex />,
    gemini: <SvgGemini />,
    qwen: <SvgQwen />,
    hermes: <SvgHermes />,
  };

  // Hardcoded 6 AI CLI fallback — used only when remote fetch fails AND no cache exists.
  const BUILTIN_AI_CLI_FALLBACK: { key: ToolType; label: string }[] = [
    { key: 'claude', label: 'Claude Code' },
    { key: 'opencode', label: 'OpenCode' },
    { key: 'codex', label: 'Codex CLI' },
    { key: 'gemini', label: 'Gemini CLI' },
    { key: 'qwen', label: 'Qwen Code' },
    { key: 'hermes', label: 'Hermes Agent' },
  ];

  // Set of keys that have dedicated hardcoded backend match arms in tier_terminal_start.
  // Remote catalog entries matching these keys route through the built-in spawn path;
  // non-matching keys (e.g. "openclaw") route through the generic `'agent'` path
  // which sends binary+args to the backend via toolData JSON.
  const BUILTIN_SPAWN_KEYS = new Set(['claude', 'opencode', 'codex', 'gemini', 'qwen', 'hermes', 'installer', 'terminal', 'vibeid']);

  // Unified agent catalog — computed from remote (preferred) or fallback to hardcoded.
  // AI CLIs come from catalog; installer/terminal are built-in utilities (Q3 decision).
  // - `type`: semantic category ('ai-cli' | 'utility'). Lets future code group/filter items.
  // - `requiresCwd`: behavior flag — drives folder-button + cwd display on Desktop cards.
  // - `remote`: present only for catalog entries whose id is NOT in BUILTIN_SPAWN_KEYS.
  //   Carries the binary + args needed by the backend's `'agent'` match arm.
  const AGENT_CATALOG: { key: ToolType; label: string; icon: React.ReactNode; type: 'ai-cli' | 'utility'; requiresCwd: boolean; remote?: { binary: string; args: string[] } }[] = (() => {
    const aiCliEntries = remoteAgents.length > 0
      ? remoteAgents.map(agent => ({
          key: agent.id as ToolType,
          label: agent.name,
          icon: BUILTIN_ICONS[agent.id]
            ?? <img src={agent.icon} alt={agent.name} style={{ width: '1.4em', height: '1.4em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />,
          type: 'ai-cli' as const,
          requiresCwd: true,
          remote: BUILTIN_SPAWN_KEYS.has(agent.id)
            ? undefined
            : { binary: agent.binary, args: agent.args },
        }))
      : BUILTIN_AI_CLI_FALLBACK.map(item => ({
          key: item.key,
          label: item.label,
          icon: BUILTIN_ICONS[item.key as string] ?? null,
          type: 'ai-cli' as const,
          requiresCwd: true,
          remote: undefined,
        }));

    const utilities = [
      { key: 'installer' as ToolType, label: t('tool.installer' as any), icon: <SvgInstaller />, type: 'utility' as const, requiresCwd: false, remote: undefined },
      // Terminal is an AI-CLI-like tool (needs cwd) rather than a 'utility'.
      { key: 'terminal' as ToolType, label: t('tool.terminal'), icon: <TerminalIcon />, type: 'ai-cli' as const, requiresCwd: true, remote: undefined },
      // VibeID is a built-in skill-launcher utility: click → spawn `claude` binary
      // in a tab, then auto-write `/vibeid\r` to trigger the remote vibeid skill.
      // No cwd required (runs against ~/.claude/usage-data/report.html globally).
      { key: 'vibeid' as ToolType, label: t('tool.vibeid' as any), icon: <SvgVibeID />, type: 'utility' as const, requiresCwd: false, remote: undefined },
      // Multi-agent quadrant: independent tab type that renders as 2×2
      // peer panes. Each pane hosts a separate CLI; any pane can call
      // coffee-cli MCP to observe/drive the others.
      //
      // `requiresCwd: true` — same folder-picker flow as every other
      // CLI card. The selected workspace is where we create the
      // `.multi-agent/` meta directory and write thin-pointer
      // CLAUDE.md / AGENTS.md / GEMINI.md files on tab mount.
      {
        key: 'multi-agent' as ToolType,
        label: t('tool.multi_agent' as any),
        icon: <SvgMultiAgent />,
        type: 'utility' as const,
        requiresCwd: true,
        remote: undefined,
      },
      // Two-Split: 2 independent side-by-side panes. Most common split
      // case (diff review, A/B compare, doc + terminal). Same no-MCP,
      // per-pane-folder semantics as four-split.
      {
        key: 'two-split' as ToolType,
        label: t('tool.two_split' as any),
        icon: <SvgTwoSplit />,
        type: 'utility' as const,
        requiresCwd: false,
        remote: undefined,
      },
      // Three-Split: 3 independent side-by-side panes (editor + terminal +
      // preview, 3-way merge, etc).
      {
        key: 'three-split' as ToolType,
        label: t('tool.three_split' as any),
        icon: <SvgThreeSplit />,
        type: 'utility' as const,
        requiresCwd: false,
        remote: undefined,
      },
      // Four-Split: same 2×2 pane grid as multi-agent, but with NO MCP
      // coordination — pure "4 independent terminals on one screen".
      // Workspace filesystem is never touched (no `.multi-agent/` dir,
      // no thin-pointer CLAUDE.md/AGENTS.md/GEMINI.md writes). Same 3
      // CLIs supported (Claude/Codex/Gemini) for visual parity.
      //
      // `requiresCwd: false` — each pane picks its OWN folder when the
      // user chooses a CLI in the empty picker, so Desktop-level folder
      // selection would be redundant. This is the core differentiator
      // from multi-agent (which is single-workspace by design).
      {
        key: 'four-split' as ToolType,
        label: t('tool.four_split' as any),
        icon: <SvgFourSplit />,
        type: 'utility' as const,
        requiresCwd: false,
        remote: undefined,
      },
    ];

    return [...aiCliEntries, ...utilities];
  })();

  const togglePin = (id: string) => {
    setPinnedItems(prev => {
      const isPinned = prev.includes(id);
      let next: string[];
      if (isPinned) {
        next = prev.filter(x => x !== id);
      } else {
        if (prev.length >= MAX_PINS) return prev;
        next = [...prev, id];
      }
      try { localStorage.setItem('coffee_pinned_items', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const renderPinIcon = (isPinned: boolean) => (
    isPinned ? (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="8" fill="currentColor" />
        <path d="M5.5 9.5L7.5 11.5L12.5 6.5" stroke="#1a1917" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="8" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    )
  );
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
        // Any focused INPUT/TEXTAREA is the real target, INCLUDING xterm's
        // .xterm-helper-textarea. Earlier this branch excluded the xterm
        // helper to "steal focus back to the active terminal", but that
        // broke the multi-agent quadrant — every pane has its own xterm
        // helper, and stealing the focus always landed on the wrong one.
        // The enforcer now only pulls focus back when it wanders to
        // genuinely non-input DOM (<div>, <body>, a clicked tab bar).
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          return;
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



  // Detect tool availability only when the Desktop (not Library) is actually visible.
  // Library is pure UI: pin/unpin never trigger IPC, scan is silent during browsing.
  // Scan runs on:
  //   - Launchpad first shown
  //   - Remote catalog refreshed
  //   - User returns from Library to Desktop (back arrow) — picks up new pins' install state
  // Never on pinnedItems changes → pin click stays instant.
  useEffect(() => {
    if (!isTauri || !isLaunchpadMode) return;
    if (showArcadeGames) return; // Library open: stay silent
    const remoteBinaries = AGENT_CATALOG
      .filter(a => a.remote)
      .map(a => a.remote!.binary);
    commands.checkToolsInstalled(remoteBinaries.length > 0 ? remoteBinaries : undefined)
      .then(result => setToolsInstalled(result))
      .catch(() => {});
    try {
      const raw = localStorage.getItem('coffee:last-cwd-by-tool');
      if (raw) setLastCwdByTool(JSON.parse(raw));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLaunchpadMode, remoteAgents, showArcadeGames]);

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
    // VibeID launcher: before spawning /vibeid, make sure the /insights usage
    // report exists. If not, auto-run /insights in a pre-run tab and poll for
    // the report file. When it lands, kill the pre-run PTY and remount the
    // tab with tool='vibeid'. End-to-end one click.
    if (tool === 'vibeid' && isTauri) {
      handleVibeidSelect(cwd);
      return;
    }
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

  const handleVibeidSelect = async (cwd?: string) => {
    if (!activeTerminalId) return;
    const currentId = activeTerminalId;
    if (cwd) {
      dispatch({ type: 'SET_FOLDER', path: cwd });
    }

    // Step A: Pass the user's Coffee CLI UI locale to the skill via a
    // hint file at ~/.claude/skills/vibeid/.user_lang. The skill Step 0
    // reads this file first — 100% reliable. Scanning session jsonl
    // can mis-detect because the auto-run /insights tab is all English.
    try {
      const lang = state.currentLang || 'en';
      const bytes = Array.from(new TextEncoder().encode(lang));
      await commands.writeSkillFile('.user_lang', bytes);
    } catch {
      // Non-fatal — skill falls back to jsonl scanning.
    }

    // Step B: ALWAYS regenerate /insights on every click. The user
    // clicked because they want an up-to-date analysis *right now*;
    // reusing a stale report would give outdated personality results.
    const clickTs = Math.floor(Date.now() / 1000);

    dispatch({ type: 'SET_TERMINAL_TOOL', id: currentId, tool: 'insights_prerun' });

    // Step C: Poll report.html's mtime. mtime > clickTs (minus a small
    // clock-skew tolerance) means the report was freshly regenerated.
    // Then kill the /insights PTY and remount the tab as vibeid.
    const TOLERANCE_S = 5;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const POLL_MS = 3000;
    const startMs = Date.now();
    const poll = window.setInterval(async () => {
      if (Date.now() - startMs > TIMEOUT_MS) {
        window.clearInterval(poll);
        setToastMsg(t('vibeid.insights_timeout') as string);
        return;
      }
      const mtime = await commands.checkVibeidReportMtime().catch(() => 0);
      if (mtime <= clickTs - TOLERANCE_S) return;
      window.clearInterval(poll);
      try { await commands.tierTerminalKill(currentId); } catch {}
      const newId = (crypto && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `vibeid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      dispatch({ type: 'SET_TERMINAL_TOOL', id: currentId, tool: 'vibeid' });
      dispatch({ type: 'RESTART_TERMINAL', id: currentId, newId });
    }, POLL_MS);
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

  // Fetch arcade catalog on mount (and on lang change) so pinned games can render on Desktop
  // without waiting for the user to open the Library.
  useEffect(() => {
    if (!isTauri) {
      setGamesLoading(false);
      return;
    }
    setGamesLoading(true);
    Promise.allSettled([commands.listJsdosBundles(), fetchGameCatalog(state.currentLang)])
      .then(([bundlesResult, catalogResult]) => {
        const localBundles: any[] = bundlesResult.status === 'fulfilled' ? bundlesResult.value : [];
        const catalog: RemoteGameEntry[] = catalogResult.status === 'fulfilled' ? catalogResult.value : [];
        const games = catalog.map(entry => {
          const cached = localBundles.find((b: any) => b.name.toLowerCase() === entry.file.toLowerCase());
          return { name: entry.file, path: cached ? cached.path : entry.download, size: cached ? cached.size : 0, icon: entry.icon, title: entry.title };
        });
        setArcadeGames(games);
      })
      .finally(() => setGamesLoading(false));
  }, [state.currentLang]);

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
    switch (session.tool) {
      case 'claude': return { icon: <SvgClaude />, title: cwd ?? 'Claude Code', tooltip: pathTip };
      case 'qwen': return { icon: <SvgQwen />, title: cwd ?? 'Qwen Code', tooltip: pathTip };
      case 'hermes': return { icon: <SvgHermes />, title: cwd ?? 'Hermes Agent', tooltip: pathTip };
      case 'opencode': return { icon: <SvgOpenCode />, title: cwd ?? 'OpenCode', tooltip: pathTip };
      case 'codex': return { icon: <SvgCodex />, title: cwd ?? 'Codex CLI', tooltip: pathTip };
      case 'gemini': return { icon: <SvgGemini />, title: cwd ?? 'Gemini CLI', tooltip: pathTip };
      case 'agent': {
        // Remote-catalog agent: look up display info by id embedded in toolData
        let entry: typeof AGENT_CATALOG[number] | undefined;
        try {
          const spec = JSON.parse(session.toolData ?? '{}');
          if (spec?.id) entry = AGENT_CATALOG.find(a => a.key === spec.id);
        } catch {}
        return {
          icon: entry?.icon ?? <span>🤖</span>,
          title: cwd ?? entry?.label ?? 'Agent',
          tooltip: pathTip,
        };
      }
      case 'installer': return { icon: <SvgInstaller />, title: t('tool.installer' as any), tooltip: undefined };
      case 'vibeid': return { icon: <SvgVibeID />, title: t('tool.vibeid' as any), tooltip: undefined };
      case 'insights_prerun': return { icon: <SvgVibeID />, title: t('tool.insights_prerun' as any), tooltip: undefined };
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
      case 'multi-agent': return { icon: <SvgMultiAgent />, title: cwd ?? t('tool.multi_agent' as any), tooltip: pathTip };
      case 'two-split': return { icon: <SvgTwoSplit />, title: cwd ?? t('tool.two_split' as any), tooltip: pathTip };
      case 'three-split': return { icon: <SvgThreeSplit />, title: cwd ?? t('tool.three_split' as any), tooltip: pathTip };
      case 'four-split': return { icon: <SvgFourSplit />, title: cwd ?? t('tool.four_split' as any), tooltip: pathTip };
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
          const { icon, title } = renderTabContent(session, isActive);

          return (
            <div
              key={session.id}
              className={`chrome-tab ${isActive ? 'active' : ''}`}
              onClick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: session.id })}
            >
              {icon}
              <span className="tab-title" style={{ flex: '0 1 auto', minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</span>
              <div className="tab-actions">
                {(['claude', 'qwen', 'hermes', 'opencode', 'codex', 'gemini', 'agent', 'installer', 'terminal', 'remote', 'vibeid', 'insights_prerun', 'multi-agent', 'two-split', 'three-split', 'four-split'] as const).includes(session.tool as 'claude' | 'qwen' | 'hermes' | 'opencode' | 'codex' | 'gemini' | 'agent' | 'installer' | 'terminal' | 'remote' | 'vibeid' | 'insights_prerun' | 'multi-agent' | 'two-split' | 'three-split' | 'four-split') && (
                  // Only Claude Code has a real hook-driven status machine.
                  // The other tools render the steady-green idle pulse —
                  // we explicitly chose not to guess their state from PTY
                  // output, which tends to produce misleading flicker.
                  // Claude's executing state uses the Claude-brand orange
                  // (#D97757) to match the "Thinking..." color in the CLI.
                  <div className={`tab-status-grid status-${
                    session.tool === 'claude'
                      ? (session.agentStatus === 'wait_input' ? 'waiting' : session.agentStatus ?? 'idle')
                      : 'idle'
                  }`}>
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
            ) : t.tool === 'multi-agent' ? (
              // Independent four-pane peer mode. Standalone Tab type —
              // does not share layout with the single-terminal path
              // below. Every pane is a peer; any CLI can drive the
              // others via coffee-cli MCP tools.
              <MultiAgentGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
              />
            ) : t.tool === 'two-split' ? (
              <FourSplitGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={2}
              />
            ) : t.tool === 'three-split' ? (
              <FourSplitGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={3}
              />
            ) : t.tool === 'four-split' ? (
              // Independent Quad (独立四屏): same 2×2 pane grid as
              // multi-agent but with zero MCP coordination — panes
              // cannot observe or drive each other.
              <FourSplitGrid
                tab={t}
                hasBg={hasBg}
                bgUrl={bgUrl}
                bgType={bgType}
                paneCount={4}
              />
            ) : (
              <ErrorBoundary key={`err-${t.id}-${t.restartKey || 0}`} fallbackLabel="Tier Terminal Error">
                <TierTerminal
                  key={`tier-${t.id}-${t.restartKey || 0}`}
                  sessionId={t.id}
                  tool={t.tool}
                  toolName={(() => {
                    if (t.tool === 'agent' && t.toolData) {
                      try {
                        const spec = JSON.parse(t.toolData);
                        if (spec?.id) return AGENT_CATALOG.find(a => a.key === spec.id)?.label;
                      } catch {}
                      return undefined;
                    }
                    return AGENT_CATALOG.find(a => a.key === t.tool)?.label;
                  })()}
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
            <div className="launchpad-slider-viewport">
              <div className={`launchpad-slider-track ${showArcadeGames ? 'slide-to-games' : ''}`}>
                
                {/* ─── Page 1: Desktop (pinned items) ─── */}
                <div className="launchpad-page">
                  <div className="launchpad-inner">
                    {(() => {
                      const pinnedAgents = AGENT_CATALOG.filter(a => pinnedItems.includes(`agent:${a.key}`));
                      const pinnedGames = arcadeGames.filter(g => pinnedItems.includes(`game:${g.name}`));

                      if (pinnedAgents.length === 0 && pinnedGames.length === 0) {
                        return null;
                      }

                      return (
                        <div className="launchpad-grid">
                          {pinnedAgents.map(tool => {
                            const isTerminal = tool.key === 'terminal';
                            const installed = isTerminal || toolsInstalled[tool.key ?? ''] !== false;
                            return (
                              <div key={`agent-${tool.key}`} className={`launchpad-card-group ${!installed ? 'launchpad-card-disabled' : ''}`}>
                                <div
                                  className="launchpad-card"
                                  onClick={() => {
                                    if (!installed) return;
                                    if (tool.remote) {
                                      // Include id alongside binary+args so tab/splash can
                                      // look up name + icon from the catalog. Backend ignores id.
                                      selectTool(
                                        'agent',
                                        JSON.stringify({ id: tool.key, ...tool.remote }),
                                        lastCwdByTool[tool.key!]
                                      );
                                    } else {
                                      selectTool(tool.key, undefined, lastCwdByTool[tool.key!]);
                                    }
                                  }}
                                >
                                  <div className="launchpad-icon">{tool.icon}</div>
                                  <div className="launchpad-card-info">
                                    <span style={isTerminal ? { display: 'inline-flex', alignItems: 'center', gap: '6px' } : undefined}>
                                      {tool.label}
                                      {isTerminal && (
                                        <span
                                          className="remote-link-hint"
                                          onClick={(e) => { e.stopPropagation(); setShowRemoteForm(true); }}
                                        >
                                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                            <circle cx="12" cy="12" r="10"/>
                                            <path d="M2 12h20"/>
                                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                          </svg>
                                        </span>
                                      )}
                                    </span>
                                    {tool.requiresCwd && lastCwdByTool[tool.key!] && (
                                      <span className="launchpad-card-cwd">
                                        {formatCwd(lastCwdByTool[tool.key!])}
                                      </span>
                                    )}
                                  </div>
                                  {tool.requiresCwd && (
                                    <div className="launchpad-folder-btn" onClick={(e) => { e.stopPropagation(); if (installed) handlePickFolder(tool.key!); }}>
                                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                      </svg>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}

                          {pinnedGames.map(game => {
                            const title = game.title || game.name.replace(/\.jsdos$/i, '').replace(/[_-]/g, ' ');
                            return (
                              <div key={`game-${game.name}`} className="launchpad-card-group">
                                <div
                                  className="launchpad-card"
                                  onClick={() => {
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
                                  <div className="launchpad-card-info">
                                    <span>{title}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}

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

                {/* ─── Page 2: Library (Agents / Games) ─── */}
                <div className="launchpad-page library-page">
                  <div className="launchpad-inner">
                    <div className="library-grid">
                      {libraryTab === 'agents' && agentsLoading && remoteAgents.length === 0 ? (
                        Array.from({ length: 6 }, (_, i) => (
                          <div key={`skel-agent-${i}`} className="library-item library-item-skeleton">
                            <div className="library-item-icon library-skeleton-block" />
                            <span className="library-skeleton-line" />
                            <div className="library-pin-btn library-skeleton-pin" />
                          </div>
                        ))
                      ) : libraryTab === 'games' && gamesLoading && arcadeGames.length === 0 ? (
                        Array.from({ length: 6 }, (_, i) => (
                          <div key={`skel-game-${i}`} className="library-item library-item-skeleton">
                            <div className="library-item-icon library-skeleton-block" />
                            <span className="library-skeleton-line" />
                            <div className="library-pin-btn library-skeleton-pin" />
                          </div>
                        ))
                      ) : libraryTab === 'agents' ? (
                        AGENT_CATALOG.map(item => {
                          const pinId = `agent:${item.key}`;
                          const isPinned = pinnedItems.includes(pinId);
                          return (
                            <div
                              key={item.key}
                              className="library-item"
                              onClick={() => togglePin(pinId)}
                            >
                              <div className="library-item-icon">{item.icon}</div>
                              <span className="library-item-name">{item.label}</span>
                              <div className={`library-pin-btn ${isPinned ? 'pinned' : ''}`}>
                                {renderPinIcon(isPinned)}
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        arcadeGames.map(game => {
                          const title = game.title || game.name.replace(/\.jsdos$/i, '').replace(/[_-]/g, ' ');
                          const pinId = `game:${game.name}`;
                          const isPinned = pinnedItems.includes(pinId);
                          return (
                            <div
                              key={game.name}
                              className="library-item"
                              onClick={() => togglePin(pinId)}
                            >
                              <div className="library-item-icon">
                                {game.icon
                                  ? <img src={game.icon} alt={title} style={{ width: '1.4em', height: '1.4em', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }} />
                                  : '🎮'}
                              </div>
                              <span className="library-item-name">{title}</span>
                              <div className={`library-pin-btn ${isPinned ? 'pinned' : ''}`}>
                                {renderPinIcon(isPinned)}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Pin counter above tabs */}
                  <div className="library-counter">{pinnedItems.length}/{MAX_PINS}</div>

                  {/* Bottom tab switcher: Agents / Games */}
                  <div className="library-tabs">
                    <button
                      className={`library-tab ${libraryTab === 'agents' ? 'active' : ''}`}
                      onClick={() => setLibraryTab('agents')}
                    >
                      Agents
                    </button>
                    <button
                      className={`library-tab ${libraryTab === 'games' ? 'active' : ''}`}
                      onClick={() => setLibraryTab('games')}
                    >
                      Games
                    </button>
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
                  } else {
                    setShowArcadeGames(false);
                  }
                }}
              >
                <div className="mode-switch-icon">
                  {!showArcadeGames ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="5" cy="5" r="1.6"/>
                      <circle cx="12" cy="5" r="1.6"/>
                      <circle cx="19" cy="5" r="1.6"/>
                      <circle cx="5" cy="12" r="1.6"/>
                      <circle cx="12" cy="12" r="1.6"/>
                      <circle cx="19" cy="12" r="1.6"/>
                      <circle cx="5" cy="19" r="1.6"/>
                      <circle cx="12" cy="19" r="1.6"/>
                      <circle cx="19" cy="19" r="1.6"/>
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 12H5"/>
                      <path d="M12 19l-7-7 7-7"/>
                    </svg>
                  )}
                </div>
              </button>
            </div>

          </div>
                )}
      </div>
    </>
  );
}

