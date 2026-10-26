import { useState, useEffect, useMemo, useRef, useSyncExternalStore, useId, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import { useAppState, type ToolType } from '../../store/app-state';
import { useSessionSplitDrag, type SessionSplitPlacement } from '../../lib/use-session-split-drag';
import { splitSessionIds } from '../../lib/session-split-layout';
import { commands, isTauri } from '../../tauri';
import type { SavedSession } from '../../tauri';
import { getToolDisplayName } from '../../lib/tool-info';
import { useAgentClient, openAgentConversation, refreshAgentConversations } from '../../lib/agent-client';
import {
  prefetchHistory,
  refreshHistory,
  subscribeHistory,
  getHistorySnapshot,
  sortByMtime,
} from '../../lib/history-cache';
import { subscribeHidden, getHiddenSnapshot, hideSession } from '../../lib/hidden-sessions';
import { subscribePinned, getPinnedSnapshot } from '../../lib/pinned-sessions';
import { subscribeRenamed, getRenamedSnapshot, setCustomName } from '../../lib/renamed-sessions';
import { SessionContextMenu, type SessionCtxMenuState } from './SessionContextMenu';
import { useTextContextMenu } from '../../lib/use-text-context-menu';
import { gitFolderKey, gitStatusKey, useProjectGitStatuses, type GitStatusTarget } from '../../lib/project-git-status';
import { HistoryGitMark } from './HistoryGitMark';
// hermes/opencode PNG assets live in src/icons-inline/ so the Launchpad
// can `?inline`-import them as data URIs and bypass the <img> async-decode
// flash. We pull the same data URIs here so HistoryBoard doesn't need a
// separate file copy on disk.
import CLAUDE_DATA_URL from '../../icons-inline/claude.svg?inline';
import CODEX_SVG from '../../icons-inline/codex.svg?raw';
import MIMOCODE_DATA_URL from '../../icons-inline/mimocode.png?inline';
import HERMES_DATA_URL from '../../icons-inline/hermes.png?inline';
import OPENCODE_DATA_URL from '../../icons-inline/opencode.png?inline';
// Kimi Code (PNG squircle) — fixed-color brand mark, ?inline data URI.
import KIMICODE_DATA_URL from '../../icons-inline/kimicode.png?inline';
// Pi is a fixed-color brand mark, rendered as an INLINE SVG so it shares the
// synchronous rendering path used by CenterPanel (?raw + inlineSvgIcon).
import PI_SVG from '../../icons-inline/pi.svg?raw';
import OMP_SVG from '../../icons-inline/omp.svg?raw';
// Grok Build - monochrome currentColor mark rendered inline so it inherits
// the surrounding text color across light/dark themes.
import GROK_SVG from '../../icons-inline/grok.svg?raw';
// OpenClaw (lobster mascot) — full-color brand mark (red gradient + teal
// eyes), NOT currentColor, so it renders as an INLINE SVG rather than <img>;
// inlining shares the same SVG bytes CenterPanel uses, no duplicate file on
// disk. The markup carries its own fills, so it does NOT go through the
// currentColor branch above.
import OPENCLAW_SVG from '../../icons-inline/openclaw.svg?raw';
// CodeBuddy — same full-color inline treatment as OpenClaw (gradient squircle
// with its own fills, no currentColor).
import CODEBUDDY_SVG from '../../icons-inline/codebuddy.svg?raw';
import './HistoryBoard.css';

// Tool icons — qwen loads via <img src=public/...>
// because HistoryBoard mounts once at app start and never re-mounts on tab
// switch, so the one-time decode flash is invisible. Other imported assets
// share the same bytes the Launchpad uses (no duplicate files).

const TOOL_ICON_SRC: Record<string, string> = {
  claude:      CLAUDE_DATA_URL,
  qwen:        '/icons/tools/qwen.svg',
  hermes:      HERMES_DATA_URL,
  opencode:    OPENCODE_DATA_URL,
  kimicode:    KIMICODE_DATA_URL,
  mimocode:    MIMOCODE_DATA_URL,
  kilo:        '/icons/tools/kilo.svg',
};

const getToolIcon = (tool: string) => {
  // Pi is a fixed-color brand mark. Keep it inline so it shares the
  // synchronous rendering path used by the launchpad; other fixed-color
  // brand marks stay <img>.
  if (tool === 'pi' || tool === 'grok' || tool === 'omp' || tool === 'codex') {
    const svg = tool === 'codex' ? CODEX_SVG : tool === 'pi' ? PI_SVG : tool === 'omp' ? OMP_SVG : GROK_SVG;
    return (
      <span
        aria-hidden
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '1em', height: '1em', flexShrink: 0 }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  // OpenClaw / CodeBuddy are full-color brand marks (lobster gradient; teal →
  // violet squircle) — inline SVG with their own fills, NOT currentColor.
  // Renders as an inline span so the markup's hardcoded colors show verbatim
  // (an <img> would also work, but we reuse the same SVG bytes CenterPanel
  // imports).
  if (tool === 'openclaw' || tool === 'codebuddy') {
    return (
      <span
        aria-hidden
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '1em', height: '1em', flexShrink: 0 }}
        dangerouslySetInnerHTML={{ __html: tool === 'codebuddy' ? CODEBUDDY_SVG : OPENCLAW_SVG }}
      />
    );
  }
  const src = TOOL_ICON_SRC[tool];
  if (!src) return null;
  const extra = (tool === 'hermes' || tool === 'opencode' || tool === 'kilo') ? { borderRadius: 'var(--radius-xs)', objectFit: 'cover' as const }
    : tool === 'kimicode' ? { borderRadius: 'var(--radius-xs)', objectFit: 'contain' as const }
    : {};
  return <img src={src} alt="" style={{ width: '1em', height: '1em', flexShrink: 0, objectFit: 'contain', ...extra }}/>;
};

const getToolName = (tool: string) => getToolDisplayName(tool);

// Project folder basename (e.g. "EchoBird" from "E:\EchoBird", "coffee"
// from "~/projects/coffee") — the icon already conveys the tool, so the
// text line earns its keep by showing which project the session belongs
// to. Falls back to the tool name only when cwd wasn't recorded (rare:
// legacy sessions that predate cwd capture, or whose ~/.claude.json
// project entry is gone).
const projectName = (cwd: string, tool: string) => {
  // OpenClaw has no user-project concept — its sessions all carry the same
  // internal `~/.openclaw/workspace` cwd, so the basename would print the
  // meaningless "workspace" on every card. Show the tool name instead,
  // matching the project-filter dropdown that already excludes openclaw
  // (it has no user-project concept). Same story as the launchpad: the row
  // should read "OpenClaw", not a leaked internal folder name.
  if (tool === 'openclaw') {
    return getToolName(tool);
  }
  if (cwd) {
    const trimmed = cwd.replace(/[\\/]+$/, '');
    const idx = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (idx >= 0) return trimmed.slice(idx + 1);
    if (trimmed) return trimmed;
  }
  return getToolName(tool);
};

// Windows drive paths ignore case; Unix paths retain their case-sensitive identity.
const normCwd = (cwd: string) => {
  const normalized = cwd.replace(/[\\/]+$/, '').replace(/\//g, '\\');
  return /^[a-z]:\\/i.test(normalized) ? normalized.toLowerCase() : normalized;
};

export function HistoryBoard() {
  const t = useT();
  const { state, dispatch } = useAppState();
  const splitDrag = useSessionSplitDrag();
  const { conversations, conversationId: activeAgentConversation } = useAgentClient();
  const agentConversations = useMemo(() => conversations.filter(conversation => conversation.messageCount > 0), [conversations]);
  const [agentError, setAgentError] = useState('');
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // The shared cache restores the previous list before this first render.
  // Opening the panel starts one background scan without hiding cached rows.
  const { sessions: cachedSessions, status } = useSyncExternalStore(
    subscribeHistory,
    getHistorySnapshot,
    getHistorySnapshot,
  );
  // Soft-delete (hide) markers from localStorage - re-renders the list the
  // instant a user hides a session, no refresh needed.
  const hidden = useSyncExternalStore(subscribeHidden, getHiddenSnapshot);
  // Pinned (置顶) markers from localStorage - re-renders + re-sorts the list
  // the instant a pin toggles from the context menu.
  const pinned = useSyncExternalStore(subscribePinned, getPinnedSnapshot);
  // Identity is tool + native conversation token, never the folder/title.
  const workingSessions = useMemo(() => new Set(state.terminals
    .filter(session => session.resumeToken && session.agentStatus === 'working')
    .map(session => `${session.tool}:${session.resumeToken}`)), [state.terminals]);
  const workingSignature = [...workingSessions].sort().join('|');
  useEffect(() => {
    if (!workingSignature) return;
    // Give the CLI time to create its new history file; reuse the single
    // throttled cache scan rather than polling separately for every row.
    const timer = window.setTimeout(refreshHistory, 1_000);
    return () => window.clearTimeout(timer);
  }, [workingSignature]);
  // Custom session titles from localStorage (rename feature) - re-renders
  // the list the instant a rename lands.
  const renamed = useSyncExternalStore(subscribeRenamed, getRenamedSnapshot);
  // Inline-rename editing state: which card is being renamed (`${tool}:${id}`
  // key, null = none) and the draft value.
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Escape should cancel (discard) the rename, but unmounting the focused
  // input fires onBlur — which would otherwise commit the draft anyway. This
  // flag is set on Escape so onBlur knows to skip the save. Reset each edit.
  const cancelRenameRef = useRef(false);
  const [ctxMenu, setCtxMenu] = useState<SessionCtxMenuState | null>(null);
  const [preview, setPreview] = useState<{ key: string; left: number; top: number } | null>(null);
  const previewId = useId();
  useEffect(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [preview]);
  useEffect(() => { prefetchHistory(); refreshAgentConversations().catch(() => {}); }, []);
  const isLoading = isTauri && (status === 'idle' || status === 'loading') && cachedSessions.length === 0 && agentConversations.length === 0;

  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSelection, setSearchSelection] = useState(0);
  const searchDialogRef = useRef<HTMLDialogElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchResultsRef = useRef<HTMLDivElement>(null);
  const searchId = useId();
  const [layout, setLayout] = useState<'list' | 'projects'>(() => {
    try { return localStorage.getItem('cc-history-layout') === 'projects' ? 'projects' : 'list'; } catch { return 'list'; }
  });
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  useEffect(() => { try { localStorage.setItem('cc-history-layout', layout); } catch { /* Storage unavailable. */ } }, [layout]);
  useEffect(() => {
    const dialog = searchDialogRef.current;
    if (!dialog) return;
    if (searchOpen) { dialog.showModal(); searchInputRef.current?.focus(); }
    else if (dialog.open) dialog.close();
  }, [searchOpen]);
  const { menu: ctxMenuEl, openMenu: openCtxMenu } = useTextContextMenu();

  // Memoize baseSessions on cachedSessions so the filter useMemo below doesn't
  // re-run every render (the isTauri? ternary otherwise rebuilds a fresh array
  // literal each render, defeating the debounce — a burst of keystrokes would
  // filter the whole list once per render instead of once per debounce tick).
  const nativeSessions: SavedSession[] = useMemo(() => isTauri ? cachedSessions : cachedSessions.length > 0 ? cachedSessions : [
    { id: 'mock-1', name: 'build a flash card website', tool: 'claude', cwd: '~/projects/flashcards', session_token: 'tk1', saved_at: new Date(nowMs).toISOString() },
    { id: 'mock-2', name: 'build a snake game', tool: 'claude', cwd: '~/projects/snake', session_token: 'tk2', saved_at: new Date(nowMs - 3600000).toISOString() },
    { id: 'mock-3', name: 'refactor components', tool: 'qwen', cwd: '~/projects/coffee', session_token: 'tk3', saved_at: new Date(nowMs - 86400000 * 2).toISOString() },
  ], [cachedSessions, nowMs]);
  const liveSessions = useMemo(() => state.terminals.filter(session => session.tool && !nativeSessions.some(saved => saved.tool === session.tool && saved.session_token && saved.session_token === session.resumeToken)), [state.terminals, nativeSessions]);
  const baseSessions: SavedSession[] = useMemo(() => sortByMtime([...nativeSessions, ...liveSessions.map(session => ({
    id: `live:${session.id}`, name: session.toolTitle || getToolDisplayName(session.tool!), tool: session.tool!,
    cwd: session.folderPath ?? '', session_token: session.resumeToken ?? null, saved_at: new Date(session.startedAt ?? nowMs).toISOString(),
  })), ...agentConversations.map(conversation => ({
    id: conversation.id, name: conversation.title, tool: 'coffee-agent', cwd: '', session_token: null,
    saved_at: new Date(conversation.updatedAt).toISOString(), turn_count: conversation.messageCount,
  }))]), [nativeSessions, liveSessions, agentConversations, nowMs]);

  const availableSessions = useMemo(() => {
    const list = baseSessions.filter(session => !hidden.has(`${session.tool ?? ''}:${session.id}`));
    if (!pinned.size) return list;
    return list.sort((a, b) => Number(pinned.has(`${b.tool ?? ''}:${b.id}`)) - Number(pinned.has(`${a.tool ?? ''}:${a.id}`)));
  }, [baseSessions, hidden, pinned]);
  const projects = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; cwd: string; sessions: SavedSession[] }>();
    for (const session of availableSessions) {
      const cwd = session.tool === 'openclaw' ? '' : (session.cwd ?? '').trim();
      const key = cwd ? 'cwd:' + normCwd(cwd) : 'tool:' + session.tool;
      let group = groups.get(key);
      if (!group) {
        group = { key, name: session.tool === 'coffee-agent' ? 'Coffee Agent' : projectName(cwd, session.tool), cwd, sessions: [] };
        groups.set(key, group);
      }
      group.sessions.push(session);
    }
    const all = [...groups.values()];
    const names = new Map<string, number>();
    for (const group of all) names.set(group.name, (names.get(group.name) ?? 0) + 1);
    for (const group of all) {
      if (group.cwd && (names.get(group.name) ?? 0) > 1) {
        // Full paths distinguish identically named folders under different parents.
        group.name = group.cwd;
      }
    }
    return all;
  }, [availableSessions]);
  const rows = useMemo(() => layout === 'list'
    ? availableSessions.map(session => ({ kind: 'session' as const, session, grouped: false }))
    : projects.flatMap(group => [
      { kind: 'project' as const, group },
      ...(collapsedProjects.has(group.key) ? [] : group.sessions.map(session => ({ kind: 'session' as const, session, grouped: true }))),
    ] as Array<{ kind: 'project'; group: typeof group } | { kind: 'session'; session: SavedSession; grouped: boolean }>), [layout, availableSessions, projects, collapsedProjects]);

  // Search works across titles, tools and full project paths, independently of the sidebar view.
  const matchesQuery = useCallback((session: SavedSession, query: string) => {
    const q = query.trim().replace(/\s+/g, ' ').toLowerCase();
    const name = renamed[`${session.tool ?? ''}:${session.id}`] ?? session.name ?? '';
    const tool = session.tool === 'coffee-agent' ? 'Coffee Agent' : getToolName(session.tool);
    return [name, session.tool === 'openclaw' ? '' : session.cwd ?? '', projectName(session.cwd ?? '', session.tool), tool].some(value => value.toLowerCase().includes(q));
  }, [renamed]);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(sessionSearchQuery), 150);
    return () => clearTimeout(timer);
  }, [sessionSearchQuery]);
  const matchedSessions = useMemo(() => availableSessions.filter(session => matchesQuery(session, debouncedQuery)), [availableSessions, debouncedQuery, matchesQuery]);
  const PAGE = 30;
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const [searchCount, setSearchCount] = useState(PAGE);
  const filteredRows = rows.slice(0, visibleCount);
  const liveSessionFolders = useMemo(() => new Map(state.terminals
    .filter(session => session.resumeToken && session.folderPath)
    .map(session => [`${session.tool}:${session.resumeToken}`, session.folderPath!])), [state.terminals]);
  const sessionGitTarget = (session: SavedSession): GitStatusTarget => {
    const liveFolder = liveSessionFolders.get(`${session.tool}:${session.session_token}`);
    return { folder: liveFolder ?? (session.git_context ? session.cwd : ''), context: session.git_context };
  };
  const gitTargets = filteredRows.map(row => row.kind === 'project' ? { folder: row.group.cwd } : sessionGitTarget(row.session));
  const gitStatuses = useProjectGitStatuses(gitTargets);
  const searchResults = searchOpen ? matchedSessions.slice(0, searchCount) : [];
  const selectedSearchIndex = Math.min(searchSelection, Math.max(0, searchResults.length - 1));
  const hasMore = rows.length > visibleCount;
  const searchHasMore = matchedSessions.length > searchCount;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const searchSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        if (entry.target === sentinelRef.current) setVisibleCount(count => count + PAGE);
        else setSearchCount(count => count + PAGE);
      }
    }, { rootMargin: '100px' });
    if (hasMore && sentinelRef.current) observer.observe(sentinelRef.current);
    if (searchOpen && searchHasMore && searchSentinelRef.current) observer.observe(searchSentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, searchOpen, searchHasMore, debouncedQuery]);
  useEffect(() => {
    if (searchOpen) searchResultsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [searchOpen, selectedSearchIndex, debouncedQuery]);
  const openSearch = () => {
    setPreview(null); setSessionSearchQuery(''); setDebouncedQuery(''); setSearchSelection(0); setSearchCount(PAGE); setSearchOpen(true);
  };
  const openSearchResult = (session: SavedSession) => { searchDialogRef.current?.close(); handleViewHistory(session); };

  // Enter inline-rename mode on a card (invoked from the context menu).
  const startRename = (saved: SavedSession) => {
    setPreview(null);
    const k = `${saved.tool ?? ''}:${saved.id}`;
    cancelRenameRef.current = false;
    setRenamingKey(k);
    setRenameValue(renamed[k] ?? saved.name ?? '');
  };

  const handleViewHistory = async (saved: SavedSession, split?: SessionSplitPlacement) => {
    setAgentError('');
    if (saved.tool === 'coffee-agent') {
      dispatch({ type: 'OPEN_AGENT_PAGE', page: 'agent' });
      openAgentConversation(saved.id).catch(error => setAgentError(String(error)));
      return;
    }
    const live = liveSessions.find(session => `live:${session.id}` === saved.id);
    if (live) {
      dispatch(split ? { type: 'OPEN_SESSION_SPLIT', id: live.id, ...split } : { type: 'SET_ACTIVE_TERMINAL', id: live.id });
      return;
    }
    if (!saved.session_token) return;
    // Fresh CLI tabs may already own this conversation without a resumeToken
    // in UI state. Read only authoritative native IDs, never guess by cwd.
    if (isTauri && !state.terminals.some(session => session.tool === saved.tool && session.resumeToken === saved.session_token)) {
      try {
        await Promise.all(state.terminals.filter(session => session.tool === saved.tool && !session.resumeToken).map(async session => {
          const token = await commands.getTerminalSessionToken(session.id);
          if (token) dispatch({ type: 'SET_SESSION_TOKEN', id: session.id, token });
        }));
      } catch (error) {
        setAgentError(String(error));
        return;
      }
    }
    const targetId = crypto.randomUUID();
    let codexMode: 'conversation' | undefined;
    try { if (saved.tool === 'codex' && localStorage.getItem('coffee:codex-launch-mode') === 'conversation') codexMode = 'conversation'; } catch { /* optional preference */ }
    dispatch({
      type: 'ADD_TERMINAL',
      split,
      session: { id: targetId, tool: saved.tool as ToolType, folderPath: saved.cwd, resumeToken: saved.session_token, codexMode }
    });
  };

  const handleDeleteHistory = async (saved: SavedSession) => {
    setAgentError('');
    setPreview(null);
    const closing = state.terminals.filter(tab => tab.tool === saved.tool &&
      (`live:${tab.id}` === saved.id || !!saved.session_token && tab.resumeToken === saved.session_token));
    if (!closing.length && isTauri && saved.session_token) {
      try {
        const candidates = state.terminals.filter(tab => tab.tool === saved.tool && !tab.resumeToken);
        const tokens = await Promise.all(candidates.map(tab => commands.getTerminalSessionToken(tab.id)));
        closing.push(...candidates.filter((_, index) => tokens[index] === saved.session_token));
      } catch (error) {
        setAgentError(String(error));
        return;
      }
    }
    hideSession(saved.tool ?? '', saved.id);
    for (const tab of closing) dispatch({ type: 'REMOVE_TERMINAL', id: tab.id });
    if (saved.tool === 'coffee-agent' && saved.id === activeAgentConversation) dispatch({ type: 'CLOSE_AGENT_PAGE', page: 'agent' });
  };

  const renderSession = (session: SavedSession, grouped = false) => {
        // Parse saved_at carefully to handle unix ms strings or invalid SystemTime strings
        let savedMs = Date.parse(session.saved_at);
        if (isNaN(savedMs)) {
          const num = Number(session.saved_at);
          if (!isNaN(num) && num > 0) savedMs = num < 1e11 ? num * 1000 : num;
          else savedMs = nowMs - 86400000;
        }
        const dateDiff = nowMs - savedMs;
        let dateStr = '';
        const now = new Date(nowMs);
        const savedDate = new Date(savedMs);
        
        const isSameDay = now.getDate() === savedDate.getDate() && now.getMonth() === savedDate.getMonth() && now.getFullYear() === savedDate.getFullYear();
        
        const yesterday = new Date(nowMs - 86400000);
        const isYesterday = yesterday.getDate() === savedDate.getDate() && yesterday.getMonth() === savedDate.getMonth() && yesterday.getFullYear() === savedDate.getFullYear();

        if (dateDiff < 3600000) {
          dateStr = t('time.just_now') || 'Just now';
        } else if (isSameDay) {
          dateStr = t('time.today') || 'Today';
        } else if (isYesterday) {
          dateStr = t('time.yesterday') || 'Yesterday';
        } else {
          const days = Math.floor(dateDiff / 86400000);
          if (days < 7) {
            dateStr = (t('time.days_ago') || '{days} days ago').replace('{days}', days.toString());
          } else {
            const locale = state.currentLang === 'zh-CN' ? 'zh-CN' : 'en-US';
            dateStr = savedDate.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
          }
        }

        const sessionKey = `${session.tool ?? ''}:${session.id}`;
        const displayName = renamed[sessionKey] ?? session.name;
        const isRenaming = renamingKey === sessionKey;
        const owner = state.terminals.find(tab => `live:${tab.id}` === session.id || tab.tool === session.tool && session.session_token && tab.resumeToken === session.session_token);
        const isWorking = owner?.agentStatus === 'working' || Boolean(session.session_token && workingSessions.has(`${session.tool}:${session.session_token}`));
        const isActive = owner?.id === state.activeTerminalId && !state.agentPageActive && !state.diffTabActive || session.tool === 'coffee-agent' && session.id === activeAgentConversation && state.agentPageActive === 'agent';
        const gitStatus = gitStatuses.get(gitStatusKey(sessionGitTarget(session)));
        return (
          <div
            key={`${sessionKey}:${session.file_path ?? session.saved_at}`}
            className={`history-card${isWorking ? ' history-card-working' : ''}${grouped ? ' history-card-grouped' : ''}${isActive ? ' history-card-active' : ''}`}
            aria-describedby={preview?.key === sessionKey ? previewId : undefined}
            onPointerDown={event => {
              if (isRenaming || session.tool === 'coffee-agent') return;
              setPreview(null);
              splitDrag.begin(event, owner?.id, placement => { setPreview(null); void handleViewHistory(session, placement); });
            }}
            onDragStart={event => event.preventDefault()}
            onMouseEnter={(event) => {
              if (isRenaming || ctxMenu || searchOpen) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const width = Math.min(320, window.innerWidth - 16);
              setPreview({ key: sessionKey, left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.top + (rect.height - 72) / 2, window.innerHeight - 80)) });
            }}
            onMouseLeave={() => setPreview(null)}
            onClick={() => { setPreview(null); if (!splitDrag.suppressClick.current) void handleViewHistory(session); }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setPreview(null);
              if (session.tool === 'coffee-agent') return;
              setCtxMenu({ session, x: e.clientX, y: e.clientY });
            }}
          >
            <div className="history-card-content">
              <div className="history-card-title-row">
                <span className="history-card-tool-icon" aria-hidden="true">
                  {session.tool !== 'coffee-agent' && getToolIcon(session.tool)}
                </span>
                {isRenaming ? (
                  <input
                    className="history-card-rename-input"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    // Keep the card's click-to-resume and right-click menu off
                    // the editing field.
                    onClick={(e) => e.stopPropagation()}
                    onContextMenu={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        cancelRenameRef.current = false;
                        setCustomName(session.tool ?? '', session.id, renameValue);
                        setRenamingKey(null);
                      } else if (e.key === 'Escape') {
                        // Discard: flag the blur handler to skip the save, then
                        // unmount (blur fires on the way out).
                        cancelRenameRef.current = true;
                        setRenamingKey(null);
                      }
                    }}
                    onBlur={() => {
                      if (!cancelRenameRef.current) {
                        setCustomName(session.tool ?? '', session.id, renameValue);
                      }
                      cancelRenameRef.current = false;
                      setRenamingKey(null);
                    }}
                    onFocus={(e) => e.target.select()}
                  />
                ) : (
                  <>
                    <span className="history-card-title">{displayName}</span>
                    {isWorking && <span className="history-card-working-indicator" role="img" aria-label={t('claude.status.working')}><span /></span>}
                    {!isWorking && <HistoryGitMark status={gitStatus} />}
                    {/* One-click soft-delete (hide), revealed in the title row.
                        stopPropagation keeps it from resuming the session. */}
                    <button
                      type="button"
                      className="history-card-delete-btn"
                      aria-label={t('menu.delete')}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDeleteHistory(session);
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="m19 6-.867 13.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
                        <path d="M10 11v6"/><path d="M14 11v6"/>
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
            {preview?.key === sessionKey && !isRenaming && createPortal(<div id={previewId} className="history-card-preview" role="tooltip" style={{ left: preview.left, top: preview.top }}>
              <div className="history-card-preview-title">{displayName}</div>
              <div className="history-card-meta">
                <span className="history-card-tool-wrap">
                  {session.tool !== 'coffee-agent' && getToolIcon(session.tool)}
                  <span className="history-card-meta-text">{session.tool === 'coffee-agent' ? 'Coffee Agent' : projectName(session.cwd, session.tool)} &middot; {dateStr} {session.turn_count ? ` · ${(t('task.messages') || '{count} messages').replace('{count}', session.turn_count.toString())}` : ''}</span>
                </span>
              </div>
            </div>, document.body)}
          </div>
        );
  };

  return (
    <>
      <button type="button" className="history-search-trigger" onClick={openSearch}>
        {/* Lucide search; license in /icons/LICENSE-lucide.txt. */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></svg>
        <span>{t('history.search')}</span>
      </button>
      <button type="button" className="history-layout-toggle" aria-label={t(layout === 'list' ? 'history.projects' : 'history.list')} aria-pressed={layout === 'projects'} onClick={() => { setPreview(null); setLayout(layout === 'list' ? 'projects' : 'list'); setVisibleCount(PAGE); }}>
        <span>{t(layout === 'list' ? 'history.list' : 'history.projects')}</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{layout === 'list' ? <><path d="M3 7h6l2 3h10v10H3z" /><path d="M7 3h6l2 3h6" /></> : <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>}</svg>
      </button>
      {agentError && <p className="agent-feedback error" role="alert">{agentError}</p>}
      <div className="task-list history-session-list" style={{ marginTop: '0', paddingBottom: '20px' }}>
      {isLoading && Array.from({ length: 6 }).map((_, i) => (
        <div key={`skel-${i}`} className="history-card history-card-skeleton" aria-hidden="true">
          <div className="history-card-content">
            <span className="skeleton-bar skeleton-bar-title" />
          </div>
        </div>
      ))}
      {!isLoading && filteredRows.map(row => row.kind === 'session' ? renderSession(row.session, row.grouped) : (
        <button type="button" key={row.group.key} className="history-project-row" aria-expanded={!collapsedProjects.has(row.group.key)} onClick={() => {
          setPreview(null);
          setCollapsedProjects(current => { const next = new Set(current); if (next.has(row.group.key)) next.delete(row.group.key); else next.add(row.group.key); return next; });
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
          <span>{row.group.name}</span>
          <HistoryGitMark status={gitStatuses.get(gitFolderKey(row.group.cwd))} />
          <svg className="history-project-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m5 3 5 5-5 5" /></svg>
        </button>
      ))}

      {hasMore && (
        <>
          {/* Skeleton placeholders give immediate visual feedback that
           * "more is coming" the moment scroll reaches the end —
           * without them React's brief commit gap reads as "stuck".
           * Sentinel sits at the bottom of the skeleton group so the
           * observer fires while the user is still scrolling through
           * them, by which point the next batch is already rendered. */}
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={`load-skel-${i}`} className="history-card history-card-skeleton" aria-hidden="true">
              <div className="history-card-content">
                <span className="skeleton-bar skeleton-bar-title" />
              </div>
            </div>
          ))}
          <div ref={sentinelRef} style={{ height: 1 }} />
        </>
      )}

      {!isLoading && availableSessions.length === 0 && (
        <div className="task-empty">
          <div className="task-empty-text">{t('menu.no_recent') || 'No recent sessions'}</div>
        </div>
      )}
    </div>
    {createPortal(<dialog className="history-search-dialog" ref={searchDialogRef} aria-labelledby={searchId} onKeyDown={event => event.stopPropagation()} onClose={() => setSearchOpen(false)} onMouseDown={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
    }}>
      <header className="history-search-header"><h2 id={searchId}>{t('history.search_title')}</h2><button type="button" className="close-button" aria-label={t('history.close_search')} onClick={() => searchDialogRef.current?.close()}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 3 10 10M3 13 13 3" /></svg></button></header>
      <div className="agent-session-search-wrap">
        <svg className="agent-session-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></svg>
        <input ref={searchInputRef} className="agent-session-search" role="combobox" aria-label={t('history.search_title')} aria-autocomplete="list" aria-expanded={searchOpen} aria-controls={searchId + '-results'} aria-activedescendant={searchResults.length ? searchId + '-result-' + selectedSearchIndex : undefined} placeholder={t('history.search_title')} value={sessionSearchQuery} onChange={event => { setSessionSearchQuery(event.target.value); setSearchSelection(0); setSearchCount(PAGE); }} onContextMenu={event => openCtxMenu(event, setSessionSearchQuery)} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSearchSelection(index => Math.max(0, Math.min(searchResults.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))); }
          if (event.key === 'Enter') {
            event.preventDefault();
            const selected = sessionSearchQuery === debouncedQuery ? searchResults[selectedSearchIndex] : availableSessions.find(session => matchesQuery(session, sessionSearchQuery));
            if (selected) openSearchResult(selected);
          }
        }} />
      </div>
      <div className="history-search-results" id={searchId + '-results'} ref={searchResultsRef} role="listbox" aria-label={t('explorer.tab.history')}>
        {searchResults.map((session, index) => <button type="button" tabIndex={-1} key={session.tool + ':' + session.id} id={searchId + '-result-' + index} className="history-search-result" role="option" aria-selected={selectedSearchIndex === index} onMouseEnter={() => setSearchSelection(index)} onClick={() => openSearchResult(session)}>
          {session.tool !== 'coffee-agent' && getToolIcon(session.tool)}
          <span><strong>{renamed[session.tool + ':' + session.id] ?? session.name}</strong><small>{session.tool === 'coffee-agent' ? 'Coffee Agent' : projectName(session.cwd ?? '', session.tool)}</small></span>
        </button>)}
        {searchHasMore && <div ref={searchSentinelRef} className="history-search-sentinel" />}
        {!searchResults.length && <div className="history-search-empty"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></svg><span>{t(isLoading ? 'diff.loading' : 'menu.no_recent')}</span></div>}
      </div>
      <footer className="history-search-footer">{t('history.search_hint')}</footer>
    </dialog>, document.body)}
    {ctxMenu && <SessionContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} onRename={startRename} onDelete={handleDeleteHistory}
      onOpenSplit={state.terminals.some(tab => tab.id === state.activeTerminalId && tab.tool) && (ctxMenu.session.session_token || liveSessions.some(tab => `live:${tab.id}` === ctxMenu.session.id)) ? saved => { void handleViewHistory(saved, { targetId: state.activeTerminalId!, edge: 'right' }); } : undefined}
      splitFull={splitSessionIds(state.sessionSplit).includes(state.activeTerminalId ?? '') && splitSessionIds(state.sessionSplit).length >= 4 && !state.terminals.some(tab => splitSessionIds(state.sessionSplit).includes(tab.id) && (`live:${tab.id}` === ctxMenu.session.id || tab.tool === ctxMenu.session.tool && tab.resumeToken === ctxMenu.session.session_token))} />}
    {splitDrag.overlay}
    {ctxMenuEl}
  </>
  );
}
