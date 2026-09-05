import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react';
import type { AgentStatus, TerminalSession, ToolType } from '../../store/app-state';
import type { ChatNavigationRow, ChatSessionRead, SavedSession } from '../../tauri';
import { commands, isTauri } from '../../tauri';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { clipboardRead, clipboardReadImage, clipboardWrite } from '../../lib/clipboard';
import { getHistorySnapshot } from '../../lib/history-cache';
import { subscribeTerminalEvents } from '../../lib/pty-event-bus';
import { useTerminalInteraction } from '../../lib/terminal-interaction';
import {
  updateChatTranscript, normalizePrompt, transcriptHasPrompt,
  type ChatMessage, type ChatTranscriptState,
} from '../../lib/chat-transcript';
import { MarkdownContent } from './MarkdownContent';
import { TermContextMenu, type TermContextMenuState } from './TermContextMenu';
import { TerminalInteractionCard } from './TerminalInteractionCard';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { useT } from '../../i18n/useT';
import './ConversationView.css';

interface ConversationViewProps {
  sessionId: string;
  tool: ToolType;
  folderPath: string | null;
  resumeToken?: string;
  startedAt?: number;
  pending?: TerminalSession['chatPending'];
  agentStatus?: AgentStatus;
  isActive: boolean;
  isVisible: boolean;
  onPendingResolved: () => void;
  onPasteToDraft: (text: string) => void;
  hasBg?: boolean;
  bgUrl?: string;
  bgType?: 'image' | 'video' | 'none';
  competingBindings?: Array<{ startedAt?: number; sentAt?: number }>;
}

interface ConversationNavigationItem {
  id: string;
  sourceMessageId: string;
  content: string;
  messageIndex: number;
  top: number;
  cursor: number | null;
}

function sameCompetingBindings(
  previous: ConversationViewProps['competingBindings'],
  next: ConversationViewProps['competingBindings'],
): boolean {
  const left = previous ?? [];
  const right = next ?? [];
  return left.length === right.length && left.every((binding, index) =>
    binding.startedAt === right[index].startedAt && binding.sentAt === right[index].sentAt
  );
}

/** Gambit's controlled draft lives in AppState, so each keystroke replaces the
 * active TerminalSession and re-renders CenterPanel. None of that changes the
 * conversation projection. Keep the potentially large Markdown tree out of
 * that hot path; its callbacks close over the stable session id + dispatch and
 * the component key remounts whenever that identity changes. */
function conversationPropsEqual(
  previous: ConversationViewProps,
  next: ConversationViewProps,
): boolean {
  return previous.sessionId === next.sessionId &&
    previous.tool === next.tool &&
    previous.folderPath === next.folderPath &&
    previous.resumeToken === next.resumeToken &&
    previous.startedAt === next.startedAt &&
    previous.pending?.text === next.pending?.text &&
    previous.pending?.sentAt === next.pending?.sentAt &&
    previous.agentStatus === next.agentStatus &&
    previous.isActive === next.isActive &&
    previous.isVisible === next.isVisible &&
    previous.hasBg === next.hasBg &&
    previous.bgUrl === next.bgUrl &&
    previous.bgType === next.bgType &&
    sameCompetingBindings(previous.competingBindings, next.competingBindings);
}

interface ConversationCacheEntry {
  source: SavedSession | null;
  transcript: ChatTranscriptState;
  raw: string;
  cursor: number | null;
  historyCursor: number | null;
  hasOlder: boolean;
  revision: string;
}

const conversationCache = new Map<string, ConversationCacheEntry>();
const sourceOwners = new Map<string, string>();
const CONVERSATION_CACHE_LIMIT = 12;
let historyRequest: Promise<SavedSession[]> | null = null;
let historyRequestForced = false;
let recentHistory: { sessions: SavedSession[]; fetchedAt: number } | null = null;
const HISTORY_CACHE_TTL_MS = 5_000;
const navigationCache = new Map<string, ChatNavigationRow[]>();
const navigationRequests = new Map<string, Promise<ChatNavigationRow[]>>();

function navigationCacheKey(source: SavedSession): string {
  return `${source.tool}:${source.id}:${source.session_token ?? ''}`;
}

function loadNavigationIndex(source: SavedSession): Promise<ChatNavigationRow[]> {
  const key = navigationCacheKey(source);
  const cached = navigationCache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = navigationRequests.get(key);
  if (pending) return pending;
  const request = commands.readChatNavigation(source)
    .then(rows => {
      navigationCache.set(key, rows);
      return rows;
    })
    .finally(() => navigationRequests.delete(key));
  navigationRequests.set(key, request);
  return request;
}

function writeConversationCache(ownerKey: string, entry: ConversationCacheEntry) {
  conversationCache.delete(ownerKey);
  conversationCache.set(ownerKey, entry);
  while (conversationCache.size > CONVERSATION_CACHE_LIMIT) {
    const oldestKey = conversationCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    conversationCache.delete(oldestKey);
  }
}

/** Share the expensive native-history scan across every chat tab. A scan can
 * take seconds on large histories (and much longer in Rust debug builds), so
 * callers must join the same promise instead of starting overlapping scans. */
async function loadConversationHistory(force = false): Promise<SavedSession[]> {
  // A forced refresh that arrives behind a normal cached scan must wait for a
  // fresh producer. Re-check in a loop after every await: several chat tabs
  // can reach this branch in the same tick, and without the second check they
  // would all start their own full native-history walk once the older request
  // settles.
  while (historyRequest) {
    const inFlightWasForced = historyRequestForced;
    const sessions = await historyRequest;
    // A forced caller must not silently inherit an older cached request. Once
    // that request settles, loop so it either joins another tab's fresh scan
    // or becomes the single producer below.
    if (!force || inFlightWasForced) return sessions;
  }
  if (!force && recentHistory && Date.now() - recentHistory.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return recentHistory.sessions;
  }
  historyRequestForced = force;
  historyRequest = commands.getNativeHistory(force)
    .then(sessions => {
      recentHistory = { sessions, fetchedAt: Date.now() };
      return sessions;
    })
    .finally(() => {
      historyRequest = null;
      historyRequestForced = false;
    });
  return historyRequest;
}

function normalizedPath(path: string): string {
  let normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  // Windows drive/UNC paths are case-insensitive. Preserve case on Unix,
  // including case-sensitive macOS volumes and paths from remote sessions.
  if (/^(?:[a-z]:\/|\/\/)/i.test(normalized)) normalized = normalized.toLowerCase();
  const worktreeMarker = normalized.indexOf('/.claude/worktrees/');
  return worktreeMarker >= 0 ? normalized.slice(0, worktreeMarker) : normalized;
}

function savedAtMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return parsed;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e11 ? numeric * 1000 : numeric;
}

function sourceIdentityDistance(
  session: SavedSession,
  startedAt: number | undefined,
  sentAt?: number,
): number {
  const createdAt = session.created_at ? savedAtMs(session.created_at) : 0;
  if (createdAt <= 0) return Number.POSITIVE_INFINITY;
  const anchors = [startedAt, sentAt].filter((value): value is number => Boolean(value));
  if (anchors.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...anchors.map(anchor => Math.abs(createdAt - anchor)));
}

function selectSources(
  sessions: SavedSession[], tool: ToolType, folderPath: string | null,
  resumeToken: string | undefined, pending: TerminalSession['chatPending'],
  startedAt: number | undefined, ownerKey: string,
  competingBindings: Array<{ startedAt?: number; sentAt?: number }>,
): SavedSession[] {
  const matchingTool = sessions.filter(session => session.tool === tool);
  if (resumeToken) {
    const resumed = matchingTool.find(session => session.session_token === resumeToken);
    return resumed ? [resumed] : [];
  }
  // startedAt is the stable identity boundary for this PTY. saved_at remains
  // the per-turn activity timestamp used below to prove a pending prompt has
  // actually reached the source.
  const bindingSince = startedAt ?? pending?.sentAt;
  if (!bindingSince) return [];
  const cwd = folderPath ? normalizedPath(folderPath) : '';
  const sameWorkspace = matchingTool.filter(session => {
    const owner = sourceOwners.get(session.id);
    if (owner && owner !== ownerKey) return false;
    if (cwd && normalizedPath(session.cwd) !== cwd) return false;
    return true;
  });

  // A live file's mtime normally advances with the prompt. Keep that fast
  // path, but retain a few same-workspace fallbacks: some CLIs flush their
  // index timestamp later than the transcript itself. The prompt-content
  // check in discover() is the final authority and prevents an older session
  // from being attached to this tab.
  // The transcript must have been written after this terminal/prompt began.
  // Prompt text alone is not an identity: common messages such as “你好” can
  // exist in many sessions in the same workspace. A forced history scan will
  // surface the current file as soon as its first write lands, so waiting is
  // safer than falling back to an older candidate.
  const recent = sameWorkspace.filter(session => savedAtMs(session.saved_at) >= bindingSince);
  const identityOwned = recent.filter(session => {
    const ownDistance = sourceIdentityDistance(session, startedAt, pending?.sentAt);
    if (!Number.isFinite(ownDistance)) return true;
    return !competingBindings.some(binding =>
      sourceIdentityDistance(session, binding.startedAt, binding.sentAt) < ownDistance
    );
  });
  // saved_at is an update timestamp and therefore cannot identify which of
  // two concurrently-running terminals created a source. Prefer the stable
  // creation timestamp nearest this PTY launch; retain saved_at only as a
  // fallback for history produced by older backends.
  identityOwned.sort((a, b) => {
    const aDistance = sourceIdentityDistance(a, startedAt, pending?.sentAt);
    const bDistance = sourceIdentityDistance(b, startedAt, pending?.sentAt);
    const aHasIdentity = Number.isFinite(aDistance);
    const bHasIdentity = Number.isFinite(bDistance);
    if (aHasIdentity !== bHasIdentity) return aHasIdentity ? -1 : 1;
    if (aHasIdentity && aDistance !== bDistance) return aDistance - bDistance;
    return Math.abs(savedAtMs(a.saved_at) - bindingSince) - Math.abs(savedAtMs(b.saved_at) - bindingSince);
  });
  return identityOwned.slice(0, pending ? 6 : 1);
}

function promptIndexSince(messages: ChatMessage[], prompt: string, baselineUserCount: number): number {
  const target = normalizePrompt(prompt);
  let userOrdinal = 0;
  let match = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    if (userOrdinal >= baselineUserCount && normalizePrompt(message.content) === target) {
      match = index;
    }
    userOrdinal += 1;
  }
  return match;
}

function hasAssistantAfterPrompt(
  messages: ChatMessage[], prompt: string, baselineUserCount = 0,
): boolean {
  const userIndex = promptIndexSince(messages, prompt, baselineUserCount);
  return userIndex >= 0 && messages.slice(userIndex + 1).some(message => message.role === 'assistant');
}

function applySessionRead(
  current: ChatTranscriptState,
  currentRaw: string,
  read: ChatSessionRead,
): { transcript: ChatTranscriptState; raw: string } {
  if (read.unchanged) return { transcript: current, raw: currentRaw };
  if (read.prepend) {
    const raw = `${read.data}${currentRaw}`;
    return { transcript: updateChatTranscript(raw), raw };
  }
  if (read.append) {
    return {
      transcript: updateChatTranscript(read.data, current),
      raw: `${currentRaw}${read.data}`,
    };
  }
  return { transcript: updateChatTranscript(read.data), raw: read.data };
}

function jsonlRowId(line: string): string | null {
  try {
    const root = JSON.parse(line) as Record<string, unknown>;
    const message = root.message && typeof root.message === 'object'
      ? root.message as Record<string, unknown>
      : null;
    const payload = root.payload && typeof root.payload === 'object'
      ? root.payload as Record<string, unknown>
      : null;
    const id = root.uuid ?? root.id ?? message?.id ?? payload?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  } catch {
    return null;
  }
}

/** SQLite/document adapters poll with a refreshed tail snapshot rather than
 * byte appends. Merge that tail over the loaded history by durable row id so
 * a live update cannot throw away pages the user has already scrolled into. */
function mergeSessionSnapshot(
  current: ChatTranscriptState,
  currentRaw: string,
  snapshotRaw: string,
): { transcript: ChatTranscriptState; raw: string } {
  const snapshot = updateChatTranscript(snapshotRaw);
  if (!currentRaw || current.messages.length === 0) {
    return { transcript: snapshot, raw: snapshotRaw };
  }

  const currentMessageIndexes = new Map(current.messages.map((message, index) => [message.id, index]));
  const snapshotMessageIds = new Set(snapshot.messages.map(message => message.id));
  const firstMessageOverlap = snapshot.messages.find(message => currentMessageIndexes.has(message.id));
  const messageCut = firstMessageOverlap
    ? currentMessageIndexes.get(firstMessageOverlap.id) ?? current.messages.length
    : current.messages.length;
  const messagePrefix = current.messages
    .slice(0, messageCut)
    .filter(message => !snapshotMessageIds.has(message.id));

  const currentLines = currentRaw.split(/\r?\n/).filter(Boolean);
  const snapshotLines = snapshotRaw.split(/\r?\n/).filter(Boolean);
  const currentLineIndexes = new Map<string, number>();
  currentLines.forEach((line, index) => {
    const id = jsonlRowId(line);
    if (id !== null && !currentLineIndexes.has(id)) currentLineIndexes.set(id, index);
  });
  const snapshotLineIds = new Set<string>();
  let lineCut = currentLines.length;
  let foundLineOverlap = false;
  snapshotLines.forEach(line => {
    const id = jsonlRowId(line);
    if (id === null) return;
    snapshotLineIds.add(id);
    if (!foundLineOverlap && currentLineIndexes.has(id)) {
      lineCut = currentLineIndexes.get(id) ?? currentLines.length;
      foundLineOverlap = true;
    }
  });
  const linePrefix = currentLines
    .slice(0, lineCut)
    .filter(line => {
      const id = jsonlRowId(line);
      return id === null || !snapshotLineIds.has(id);
    });
  const mergedLines = [...linePrefix, ...snapshotLines];

  return {
    transcript: {
      messages: [...messagePrefix, ...snapshot.messages],
      remainder: snapshot.remainder,
      nextLineIndex: mergedLines.length,
    },
    raw: mergedLines.length > 0 ? `${mergedLines.join('\n')}\n` : '',
  };
}

function ToolRow({ message }: { message: ChatMessage }) {
  const status = message.toolStatus ?? 'running';
  // Success and failure rows share the same collapsed-by-default behavior.
  // The red status dot is enough to surface an error; opening potentially
  // large stderr output is an explicit user choice.
  const [expanded, setExpanded] = useState(false);
  const open = expanded;
  return (
    <details
      className="conversation-tool"
      open={open}
      onToggle={event => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className={`conversation-tool-status conversation-tool-status--${status}`} aria-hidden="true" />
        <span>{message.toolName}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </summary>
      {open && message.content && <pre>{message.content}</pre>}
    </details>
  );
}

function ReasoningRow({ message }: { message: ChatMessage }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="conversation-reasoning"
      open={expanded}
      onToggle={event => setExpanded(event.currentTarget.open)}
    >
      <summary><span className="conversation-reasoning-glyph">✦</span> {t('conversation.reasoning')}</summary>
      {expanded && <MarkdownContent content={message.content} />}
    </details>
  );
}

function MessageCopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`conversation-copy${copied ? ' conversation-copy--copied' : ''}`}
      aria-label={copied ? t('conversation.copied') : t('conversation.copy_message')}
      onClick={onCopy}
    >
      {copied ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="5 13 9 17 19 7" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      )}
    </button>
  );
}

function MeasuredConversationRow({
  messageId, onMeasure, children,
}: {
  messageId: string;
  onMeasure: (messageId: string, height: number) => void;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => onMeasure(messageId, row.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [messageId, onMeasure]);
  return <div ref={rowRef} className="conversation-virtual-row">{children}</div>;
}

interface ConversationNavigationProps {
  items: ConversationNavigationItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: (item: ConversationNavigationItem) => void;
}

/** Navigation owns every high-frequency hover/scroll state update. Keeping it
 * outside ConversationViewImpl prevents a tooltip move or active-line change
 * from reconciling the full Markdown transcript. Target positions are measured
 * only when layout changes; scrolling performs an O(log n) lookup over that
 * cache instead of getBoundingClientRect() on every user turn each frame. */
const ConversationNavigation = memo(function ConversationNavigation({
  items, scrollRef, onJump,
}: ConversationNavigationProps) {
  const t = useT();
  const navigationRef = useRef<HTMLElement>(null);
  const navigationScrollRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tooltipTop, setTooltipTop] = useState(0);

  const hoveredIndex = items.findIndex(item => item.id === hoveredId);
  const hoveredItem = hoveredIndex >= 0 ? items[hoveredIndex] : null;

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || items.length === 0) return;

    let activeFrame: number | null = null;

    const updateActive = () => {
      activeFrame = null;
      const readingTop = scroll.scrollTop + Math.min(120, scroll.clientHeight * 0.24);

      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (items[middle].top < readingTop) low = middle + 1;
        else high = middle;
      }
      let closest = Math.min(low, items.length - 1);
      if (closest > 0 &&
          Math.abs(items[closest - 1].top - readingTop) <=
            Math.abs(items[closest].top - readingTop)) {
        closest -= 1;
      }
      const nextId = items[closest].id;
      setActiveId(current => current === nextId ? current : nextId);
    };

    const scheduleActive = () => {
      if (activeFrame === null) activeFrame = window.requestAnimationFrame(updateActive);
    };

    scroll.addEventListener('scroll', scheduleActive, { passive: true });
    scheduleActive();

    return () => {
      scroll.removeEventListener('scroll', scheduleActive);
      if (activeFrame !== null) window.cancelAnimationFrame(activeFrame);
    };
  }, [items, scrollRef]);

  useEffect(() => {
    const container = navigationScrollRef.current;
    if (!container || !activeId) return;
    const centreActiveItem = () => {
      const item = container.querySelector<HTMLElement>(
        `[data-conversation-navigation-target="${CSS.escape(activeId)}"]`,
      );
      if (!item) return;
      // Use viewport-relative rectangles instead of offsetTop: the navigation
      // wrapper is positioned, so offsetParent changes must not skew the inner
      // scroll coordinate. Re-run when Gambit resizing changes the rail height.
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const itemTop = itemRect.top - containerRect.top + container.scrollTop;
      container.scrollTop = itemTop - (container.clientHeight - itemRect.height) / 2;
    };

    centreActiveItem();
    const observer = new ResizeObserver(centreActiveItem);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeId]);

  const showTooltip = (messageId: string, item: HTMLElement) => {
    const navigation = navigationRef.current;
    if (!navigation) return;
    const itemRect = item.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    setHoveredId(messageId);
    setTooltipTop(itemRect.top + itemRect.height / 2 - navigationRect.top);
  };

  return (
    <nav
      ref={navigationRef}
      className="conversation-navigation"
      aria-label={t('conversation.navigation')}
      onMouseLeave={() => setHoveredId(null)}
    >
      <div
        ref={navigationScrollRef}
        className="conversation-navigation-scroll"
        onScroll={() => {
          if (!hoveredId) return;
          const item = navigationScrollRef.current?.querySelector<HTMLElement>(
            `[data-conversation-navigation-target="${CSS.escape(hoveredId)}"]`,
          );
          if (item) showTooltip(hoveredId, item);
        }}
      >
        {items.map((item, index) => {
          const hoverDistance = hoveredIndex < 0 ? undefined : Math.abs(index - hoveredIndex);
          return (
            <button
              type="button"
              key={item.id}
              className="conversation-navigation-item"
              data-conversation-navigation-target={item.id}
              data-active={activeId === item.id ? 'true' : undefined}
              data-hover-distance={hoverDistance !== undefined && hoverDistance <= 2
                ? hoverDistance
                : undefined}
              aria-label={t('conversation.jump_to_turn', { turn: index + 1 })}
              aria-current={activeId === item.id ? 'step' : undefined}
              aria-describedby={hoveredId === item.id ? tooltipId : undefined}
              onMouseEnter={event => showTooltip(item.id, event.currentTarget)}
              onFocus={event => showTooltip(item.id, event.currentTarget)}
              onBlur={() => setHoveredId(null)}
              onClick={() => onJump(item)}
            >
              <span aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {hoveredItem && (
        <div
          id={tooltipId}
          className="conversation-navigation-tooltip"
          role="tooltip"
          style={{ top: tooltipTop }}
        >
          <span>{hoveredItem.content.replace(/\s+/g, ' ').trim()}</span>
        </div>
      )}
    </nav>
  );
});

function ConversationViewImpl({
  sessionId, tool, folderPath, resumeToken, startedAt, pending, agentStatus, isActive, isVisible,
  onPendingResolved, onPasteToDraft, hasBg, bgUrl, bgType, competingBindings = [],
}: ConversationViewProps) {
  const t = useT();
  const interaction = useTerminalInteraction(sessionId);
  const ownerKey = `${sessionId}:${tool ?? 'none'}:${resumeToken ?? 'fresh'}:${startedAt ?? 'unknown'}`;
  const cached = conversationCache.get(ownerKey);
  const initialTranscript = cached?.transcript ?? { messages: [], remainder: '', nextLineIndex: 0 };
  const [source, setSource] = useState<SavedSession | null>(cached?.source ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialTranscript.messages);
  const [navigationRows, setNavigationRows] = useState<ChatNavigationRow[]>(
    cached?.source ? navigationCache.get(navigationCacheKey(cached.source)) ?? [] : [],
  );
  const transcriptRef = useRef<ChatTranscriptState>(initialTranscript);
  const rawRef = useRef(cached?.raw ?? '');
  const cursorRef = useRef<number | null>(cached?.cursor ?? null);
  const historyCursorRef = useRef<number | null>(cached?.historyCursor ?? null);
  const hasOlderRef = useRef(cached?.hasOlder ?? false);
  const revisionRef = useRef(cached?.revision ?? '');
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const selectAllProxyRef = useRef<HTMLTextAreaElement>(null);
  const pinnedRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const loadOlderRef = useRef<() => void>(() => undefined);
  const prependAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const pendingNavigationJumpRef = useRef<{
    sourceMessageId: string;
    content: string;
  } | null>(null);
  const onPendingResolvedRef = useRef(onPendingResolved);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<TermContextMenuState | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);
  const pendingBaselineRef = useRef<{ sentAt: number; userCount: number } | null>(null);
  const competingBindingsRef = useRef(competingBindings);
  competingBindingsRef.current = competingBindings;
  const competingBindingsKey = competingBindings
    .map(binding => `${binding.startedAt ?? 0}:${binding.sentAt ?? 0}`)
    .sort()
    .join('|');

  if (pending && pendingBaselineRef.current?.sentAt !== pending.sentAt) {
    pendingBaselineRef.current = {
      sentAt: pending.sentAt,
      userCount: messages.filter(message => message.role === 'user').length,
    };
  } else if (!pending && pendingBaselineRef.current) {
    pendingBaselineRef.current = null;
  }

  useEffect(() => {
    onPendingResolvedRef.current = onPendingResolved;
  }, [onPendingResolved]);

  useLayoutEffect(() => {
    if (isActive && isVisible) return;
    setCtxMenu(null);
  }, [isActive, isVisible]);

  useEffect(() => {
    if (!source) return;
    sourceOwners.set(source.id, ownerKey);
    return () => {
      if (sourceOwners.get(source.id) === ownerKey) sourceOwners.delete(source.id);
    };
  }, [source, ownerKey]);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    void loadNavigationIndex(source).then(rows => {
      if (!cancelled) setNavigationRows(rows);
    }).catch(error => {
      console.warn('[Conversation] navigation index unavailable', source.id, error);
    });
    return () => { cancelled = true; };
  }, [source]);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const copyMessage = (messageId: string, content: string) => {
    void clipboardWrite(content).then(() => {
      if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
      setCopiedMessageId(messageId);
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedMessageId(current => current === messageId ? null : current);
        copyResetTimerRef.current = null;
      }, 1_500);
    });
  };

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const selectionText = (): string => {
    const root = scrollRef.current;
    const selection = window.getSelection();
    if (root && selection && !selection.isCollapsed && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (root.contains(range.commonAncestorContainer)) return selection.toString();
    }
    const proxy = selectAllProxyRef.current;
    if (!proxy || proxy.selectionStart === proxy.selectionEnd) return '';
    return proxy.value.slice(proxy.selectionStart, proxy.selectionEnd);
  };

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setCtxMenu({ x: event.clientX, y: event.clientY, hasSelection: Boolean(selectionText()) });
  };

  useEffect(() => {
    if (!isTauri) return;
    if (!isActive) return;
    if (source || (!resumeToken && !pending && !startedAt)) return;
    let cancelled = false;
    let timer: number | null = null;
    let capturedToken: string | undefined;
    let nextForcedScanAt = pending ? Date.now() + 400 : Number.POSITIVE_INFINITY;
    const bindFrom = async (sessions: SavedSession[]): Promise<boolean> => {
      const exactToken = resumeToken ?? capturedToken;
      const candidates = selectSources(
        sessions, tool, folderPath, exactToken, pending, startedAt, ownerKey,
        competingBindingsRef.current,
      );
      for (const candidate of candidates) {
        let read: ChatSessionRead;
        try {
          read = await commands.readChatSession(candidate);
        } catch (error) {
          // A stale index row or one partially-written transcript must not
          // prevent later candidates from binding to this live terminal.
          console.warn('[Conversation] skip unreadable candidate', candidate.id, error);
          continue;
        }
        if (cancelled) return false;
        let applied = applySessionRead(
          { messages: [], remainder: '', nextLineIndex: 0 }, '', read,
        );
        const liveCursor = read.cursor;
        // A busy agent can emit enough tool rows to push its initiating prompt
        // outside the first tail page before discovery binds the source. Walk
        // a few older windows for identity validation; this remains bounded
        // and happens only during initial attachment, never on every poll.
        let validationPages = 0;
        while (pending && !transcriptHasPrompt(applied.transcript.messages, pending.text) &&
               read.has_older && read.history_cursor !== null && validationPages < 8) {
          const older = await commands.readChatSession(
            candidate, liveCursor, read.revision || undefined, read.history_cursor,
          );
          if (!older.prepend || older.unchanged) break;
          applied = applySessionRead(applied.transcript, applied.raw, older);
          read = { ...older, cursor: liveCursor };
          validationPages += 1;
        }
        const nextTranscript = applied.transcript;
        const nextMessages = nextTranscript.messages;
        const updatedAfterPrompt = !pending || savedAtMs(candidate.saved_at) >= pending.sentAt;
        if (pending && !updatedAfterPrompt) continue;
        if (pending && updatedAfterPrompt && !transcriptHasPrompt(nextMessages, pending.text)) continue;
        // Another pending view may have validated the same candidate while
        // this read was in flight. Claim synchronously after validation so two
        // same-workspace terminals can never attach to one transcript.
        const currentOwner = sourceOwners.get(candidate.id);
        if (currentOwner && currentOwner !== ownerKey) continue;

        sourceOwners.set(candidate.id, ownerKey);
        transcriptRef.current = nextTranscript;
        rawRef.current = applied.raw;
        cursorRef.current = liveCursor;
        historyCursorRef.current = read.history_cursor;
        hasOlderRef.current = read.has_older;
        revisionRef.current = read.revision;
        writeConversationCache(ownerKey, {
          source: candidate, transcript: nextTranscript, raw: applied.raw,
          cursor: liveCursor, historyCursor: read.history_cursor,
          hasOlder: read.has_older, revision: read.revision,
        });
        setMessages(nextMessages);
        setSource(candidate);
        const baselineState = pendingBaselineRef.current;
        const baseline = baselineState && baselineState.sentAt === pending?.sentAt
          ? baselineState.userCount
          : 0;
        if (pending && hasAssistantAfterPrompt(nextMessages, pending.text, baseline)) {
          onPendingResolvedRef.current();
        }
        return true;
      }
      return false;
    };
    const discover = async () => {
      try {
        // Claude and a few CLIs expose their freshly-created native session id
        // through PTY output. Prefer that authoritative identity whenever it
        // is available; creation-time matching below remains the fallback for
        // tools that never print a token.
        if (!resumeToken && !capturedToken) {
          capturedToken = await commands.getTerminalSessionToken(sessionId) ?? undefined;
        }
        // The app-wide history cache often already contains the source. Try it
        // first for resumed/pending turns; content validation below makes stale
        // metadata safe. A fresh direct-terminal session has no fingerprint,
        // so it deliberately goes through one fresh native scan instead.
        const snapshot = getHistorySnapshot().sessions;
        if ((resumeToken || pending) && snapshot.length > 0 && await bindFrom(snapshot)) {
          return;
        }
        // A prompt can create a new transcript after both frontend and Rust
        // history caches were populated. Bypass those caches after a short
        // grace period, then at most once every three seconds until bound.
        const now = Date.now();
        const forceScan = Boolean(pending) && now >= nextForcedScanAt;
        if (forceScan) nextForcedScanAt = now + 3_000;
        const sessions = await loadConversationHistory(forceScan || (!resumeToken && !pending));
        if (cancelled || await bindFrom(sessions)) return;
      } catch (error) {
        console.error('[Conversation] discover session failed', error);
      }
      // Recursive timeout (rather than setInterval) guarantees a slow native
      // scan finishes before another starts. A no-prompt fresh view gets one
      // attempt only; pending/resumed sessions may appear shortly after mount.
      if (!cancelled && (pending || resumeToken || agentStatus === 'working')) {
        timer = window.setTimeout(discover, pending ? 400 : 1200);
      }
    };
    void discover();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [source, tool, folderPath, resumeToken, pending, startedAt, ownerKey, agentStatus, isActive, isVisible, competingBindingsKey, sessionId]);

  useEffect(() => {
    if (!isTauri) return;
    if (!isActive) return;
    if (!source) return;
    let cancelled = false;
    let pollTimer: number | null = null;
    let outputTimer: number | null = null;
    let unsubscribe: (() => void) | null = null;
    let reading = false;
    let readAgain = false;
    const active = Boolean(pending) || agentStatus === 'working';

    const scheduleOutputRefresh = () => {
      if (cancelled || outputTimer !== null) return;
      // Give the CLI a brief moment to flush JSONL/SQLite after emitting PTY
      // output. This makes chat feel streamed without rereading every chunk.
      outputTimer = window.setTimeout(() => {
        outputTimer = null;
        void refresh();
      }, 140);
    };

    const refresh = async () => {
      // PTY output can be very chunky. Coalesce overlapping notifications and
      // perform one trailing read instead of queueing full-transcript IPCs.
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      try {
        const read = await commands.readChatSession(
          source, cursorRef.current, revisionRef.current || undefined,
        );
        // An upward history read owns the transcript snapshot while it is in
        // flight. Discard a concurrent poll response; the next heartbeat will
        // cheaply catch up from the retained live cursor.
        if (!cancelled && !loadingOlderRef.current && !read.unchanged) {
          const previousHistoryCursor = historyCursorRef.current;
          const mergeSnapshot = !read.append && cursorRef.current === null &&
            previousHistoryCursor !== null && read.history_cursor !== null &&
            read.history_cursor >= previousHistoryCursor;
          const applied = mergeSnapshot
            ? mergeSessionSnapshot(transcriptRef.current, rawRef.current, read.data)
            : applySessionRead(transcriptRef.current, rawRef.current, read);
          const nextTranscript = applied.transcript;
          const nextMessages = nextTranscript.messages;
          transcriptRef.current = nextTranscript;
          rawRef.current = applied.raw;
          if (!read.prepend) cursorRef.current = read.cursor;
          if (!read.append && !mergeSnapshot) {
            historyCursorRef.current = read.history_cursor;
            hasOlderRef.current = read.has_older;
          }
          revisionRef.current = read.revision;
          writeConversationCache(ownerKey, {
            source, transcript: nextTranscript, raw: applied.raw,
            cursor: cursorRef.current, historyCursor: historyCursorRef.current,
            hasOlder: hasOlderRef.current, revision: read.revision,
          });
          setMessages(nextMessages);
          const baselineState = pendingBaselineRef.current;
          const baseline = baselineState && baselineState.sentAt === pending?.sentAt
            ? baselineState.userCount
            : 0;
          if (pending && hasAssistantAfterPrompt(nextMessages, pending.text, baseline)) {
            onPendingResolvedRef.current();
          }
        }
      } catch (error) {
        console.error('[Conversation] read session failed', error);
      } finally {
        reading = false;
        if (!cancelled && readAgain) {
          readAgain = false;
          scheduleOutputRefresh();
        }
      }
    };

    const poll = async () => {
      await refresh();
      if (!cancelled) {
        // Some tools persist before/after their PTY write, and a few do not
        // emit output for every transcript mutation. Keep a quick active
        // fallback, then drop to a cheap idle heartbeat.
        pollTimer = window.setTimeout(poll, active ? 320 : 1200);
      }
    };

    void subscribeTerminalEvents(sessionId, {
      onOutput: scheduleOutputRefresh,
      onStatus: scheduleOutputRefresh,
    }).then(stop => {
      if (cancelled) stop();
      else unsubscribe = stop;
    }).catch(error => {
      console.error('[Conversation] subscribe terminal events failed', error);
    });
    void poll();
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      if (outputTimer !== null) window.clearTimeout(outputTimer);
    };
  }, [source, pending, ownerKey, sessionId, agentStatus, isActive]);

  const loadOlder = useCallback(async (target?: ConversationNavigationItem) => {
    let before = historyCursorRef.current;
    const scroll = scrollRef.current;
    if (!source || !scroll || loadingOlderRef.current || !hasOlderRef.current || before === null) {
      return;
    }
    loadingOlderRef.current = true;
    const expectedRaw = rawRef.current;
    pinnedRef.current = false;
    prependAnchorRef.current = target ? null : {
        scrollHeight: scroll.scrollHeight,
        scrollTop: scroll.scrollTop,
    };
    try {
      const olderChunks: string[] = [];
      let hasOlder: boolean = hasOlderRef.current;
      let revision = revisionRef.current;
      do {
        const read = await commands.readChatSession(
          source, cursorRef.current, revision || undefined, before,
        );
        if (read.unchanged || !read.prepend || rawRef.current !== expectedRaw) {
          prependAnchorRef.current = null;
          return;
        }
        olderChunks.push(read.data);
        before = read.history_cursor;
        hasOlder = read.has_older;
        revision = read.revision;
      } while (target?.cursor !== null && target?.cursor !== undefined &&
               hasOlder && before !== null && before > target.cursor);

      // A direct rail jump can cross many pages. Rebuild once after collecting
      // them instead of reparsing an ever-growing transcript after every IPC
      // response (which becomes quadratic on very long histories).
      const raw = `${olderChunks.reverse().join('')}${expectedRaw}`;
      const transcript = updateChatTranscript(raw);

      transcriptRef.current = transcript;
      rawRef.current = raw;
      historyCursorRef.current = before;
      hasOlderRef.current = hasOlder;
      revisionRef.current = revision;
      if (target) {
        pendingNavigationJumpRef.current = {
          sourceMessageId: target.sourceMessageId,
          content: target.content,
        };
      }
      writeConversationCache(ownerKey, {
        source,
        transcript,
        raw,
        cursor: cursorRef.current,
        historyCursor: before,
        hasOlder,
        revision,
      });
      setMessages(transcript.messages);
    } catch (error) {
      prependAnchorRef.current = null;
      console.error('[Conversation] read older session page failed', error);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [source, ownerKey]);
  loadOlderRef.current = () => { void loadOlder(); };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = (event: Event) => {
      pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
      if (event.isTrusted && element.scrollTop < 520) loadOlderRef.current();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  // A heavily filtered page can contain fewer visible bubbles than one
  // viewport. In that case there is no scrollbar for the user to reach the
  // normal top threshold, so quietly pull older pages until the viewport is
  // filled (or history is exhausted).
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (source && hasOlderRef.current && element &&
          element.scrollHeight <= element.clientHeight + 80) {
        loadOlderRef.current();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, source]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    return bindAutoHideScrollbar(element, { slim: true });
  }, []);

  // Gambit is a fixed dock whose live CSS height shrinks this scroll owner
  // while its top edge is being dragged. Unlike xterm (which refits through
  // its ResizeObserver), a normal overflow container preserves scrollTop when
  // its clientHeight decreases. That leaves the newest messages below the new
  // clipping edge and makes the dock appear to cover them. Follow the moving
  // bottom edge only while the conversation was already pinned; a user who
  // deliberately scrolled up to read history keeps their exact position.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (pinnedRef.current && element.clientHeight > 0) element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, []);

  const baselineState = pendingBaselineRef.current;
  const pendingBaseline = baselineState && baselineState.sentAt === pending?.sentAt
    ? baselineState.userCount
    : 0;
  const pendingPromptIndex = useMemo(() => pending
    ? promptIndexSince(messages, pending.text, pendingBaseline)
    : -1, [messages, pending, pendingBaseline]);
  const promptInTranscript = pendingPromptIndex >= 0;
  const assistantAfterPending = pendingPromptIndex >= 0 && messages
    .slice(pendingPromptIndex + 1)
    .some(message => message.role === 'assistant');
  const lastConversationalRole = messages.findLast(message =>
    message.role === 'user' || message.role === 'assistant'
  )?.role;
  const activeTurnStartIndex = pending
    ? pendingPromptIndex
    : messages.findLastIndex(message => message.role === 'user');
  // A tool result changes its row from `running` to `done`/`failed` before the
  // agent necessarily finishes the turn. Keep the execution label visible
  // throughout that tool phase instead of dropping it between consecutive
  // tool calls or while the agent processes the latest result.
  const lastToolIndex = messages.findLastIndex(message => message.role === 'tool');
  const hasToolInActiveTurn = activeTurnStartIndex >= 0 && lastToolIndex > activeTurnStartIndex;
  const isExecuting = (Boolean(pending) || agentStatus === 'working') && hasToolInActiveTurn;
  const isThinking = !isExecuting && (pending
    ? !assistantAfterPending
    : agentStatus === 'working' && lastConversationalRole === 'user');
  const activityLabel = isExecuting
    ? t('conversation.executing')
    : isThinking ? t('conversation.thinking') : null;
  const virtual = useConversationVirtualizer(messages, scrollRef);
  const indexedNavigationMessages = useMemo(() => navigationRows.flatMap((row, rowIndex) => {
    const parsed = updateChatTranscript(row.data).messages;
    return parsed
      .filter(message => message.role === 'user')
      .map((message, messageIndex) => ({
        id: `navigation:${row.cursor}:${rowIndex}:${messageIndex}`,
        sourceMessageId: message.id,
        content: message.content,
        cursor: row.cursor,
      }));
  }), [navigationRows]);
  const navigationMessages = useMemo(() => {
    const indexedIdCounts = new Map<string, number>();
    indexedNavigationMessages.forEach(item => {
      indexedIdCounts.set(item.sourceMessageId, (indexedIdCounts.get(item.sourceMessageId) ?? 0) + 1);
    });
    const loadedUserIndexes = new Map<string, number>();
    messages.forEach((message, messageIndex) => {
      if (message.role === 'user') loadedUserIndexes.set(message.id, messageIndex);
    });
    const items: ConversationNavigationItem[] = indexedNavigationMessages.length > 0
      ? indexedNavigationMessages.map(item => {
          // Some legacy transcript formats have no durable message id. Their
          // parser fallback repeats when each lightweight navigation row is
          // parsed alone, so only use id matching when the full index proves
          // that id is unique. Cursor-driven paging remains authoritative.
          const messageIndex = indexedIdCounts.get(item.sourceMessageId) === 1
            ? loadedUserIndexes.get(item.sourceMessageId) ?? -1
            : -1;
          return {
            ...item,
            messageIndex,
            top: messageIndex >= 0 ? (virtual.offsets[messageIndex] ?? 0) + 34 : 0,
          };
        })
      : messages
          .map((message, messageIndex) => ({ message, messageIndex }))
          .filter(({ message }) => message.role === 'user')
          .map(({ message, messageIndex }) => ({
            id: message.id,
            sourceMessageId: message.id,
            content: message.content,
            messageIndex,
            top: (virtual.offsets[messageIndex] ?? 0) + 34,
            cursor: null,
          }));
    if (indexedNavigationMessages.length > 0) {
      const indexedIds = new Set(indexedNavigationMessages.map(item => item.sourceMessageId));
      messages.forEach((message, messageIndex) => {
        if (message.role !== 'user' || indexedIds.has(message.id)) return;
        items.push({
          id: `loaded:${message.id}`,
          sourceMessageId: message.id,
          content: message.content,
          messageIndex,
          top: (virtual.offsets[messageIndex] ?? 0) + 34,
          cursor: null,
        });
      });
    }
    if (pending && !promptInTranscript) {
      items.push({
        id: `pending:${pending.sentAt}`,
        sourceMessageId: `pending:${pending.sentAt}`,
        content: pending.text,
        messageIndex: messages.length,
        top: (virtual.offsets[messages.length] ?? 0) + 34,
        cursor: null,
      });
    }
    return items;
  }, [messages, indexedNavigationMessages, pending, promptInTranscript, virtual.offsets]);
  // One conversation turn can contain several assistant narration fragments
  // around tool calls. The copy action belongs to the LAST assistant fragment
  // of EACH turn: either the assistant immediately preceding the next user
  // prompt, or the trailing assistant at the end of the current history. Walk
  // backwards over conversational roles so tool/reasoning rows do not split a
  // turn. While the agent is still working, withhold only the current trailing
  // candidate; summaries from completed earlier turns remain copyable.
  const assistantSummaryMessageIds = useMemo(() => {
    const summaryIds = new Set<string>();
    let nextConversationalRole: 'user' | 'assistant' | null = null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant') {
        if (nextConversationalRole === null || nextConversationalRole === 'user') {
          summaryIds.add(message.id);
        }
        nextConversationalRole = 'assistant';
      } else if (message.role === 'user') {
        nextConversationalRole = 'user';
      }
    }
    if (agentStatus === 'working' && (!pending || promptInTranscript)) {
      const lastUserIndex = messages.findLastIndex(message => message.role === 'user');
      for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
        if (messages[index].role === 'assistant') {
          summaryIds.delete(messages[index].id);
          break;
        }
      }
    }
    return summaryIds;
  }, [messages, agentStatus, pending, promptInTranscript]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || element.clientHeight === 0) return;
    const prependAnchor = prependAnchorRef.current;
    if (prependAnchor) {
      prependAnchorRef.current = null;
      element.scrollTop = prependAnchor.scrollTop +
        Math.max(0, element.scrollHeight - prependAnchor.scrollHeight);
      return;
    }
    if (pinnedRef.current) element.scrollTop = element.scrollHeight;
  }, [messages, pending, activityLabel, interaction?.fingerprint, virtual.total, isActive, isVisible]);

  useLayoutEffect(() => {
    const target = pendingNavigationJumpRef.current;
    if (!target) return;
    let messageIndex = messages.findIndex(message =>
      message.role === 'user' && message.id === target.sourceMessageId
    );
    if (messageIndex < 0) {
      const normalized = normalizePrompt(target.content);
      messageIndex = messages.findLastIndex(message =>
        message.role === 'user' && normalizePrompt(message.content) === normalized
      );
    }
    if (messageIndex < 0) return;
    pendingNavigationJumpRef.current = null;
    pinnedRef.current = false;
    virtual.scrollToIndex(messageIndex, 'auto');
  }, [messages, virtual]);

  const jumpToNavigationMessage = useCallback((item: ConversationNavigationItem) => {
    pinnedRef.current = false;
    if (item.messageIndex >= 0 && item.messageIndex < messages.length) {
      virtual.scrollToIndex(item.messageIndex);
      return;
    }
    if (item.messageIndex >= messages.length) {
      const scroll = scrollRef.current;
      if (scroll) scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
      return;
    }
    const historyCursor = historyCursorRef.current;
    const targetShouldAlreadyBeLoaded = item.cursor === null || historyCursor === null ||
      item.cursor >= historyCursor;
    if (targetShouldAlreadyBeLoaded) {
      const normalized = normalizePrompt(item.content);
      const loadedIndex = messages.findLastIndex(message =>
        message.role === 'user' && normalizePrompt(message.content) === normalized
      );
      if (loadedIndex >= 0) {
        virtual.scrollToIndex(loadedIndex);
        return;
      }
    }
    if (item.cursor !== null) void loadOlder(item);
  }, [messages, virtual, loadOlder]);

  return (
    <div
      className={`conversation-view${hasBg && bgUrl ? ' conversation-view--has-bg' : ''}${navigationMessages.length > 1 ? ' conversation-view--has-navigation' : ''}`}
      onContextMenu={openContextMenu}
    >
      {hasBg && bgUrl && (
        <div className="conversation-background" aria-hidden="true">
          {bgType === 'video'
            ? <video src={bgUrl} autoPlay loop muted playsInline />
            : <img src={bgUrl} alt="" draggable={false} />}
        </div>
      )}
      {navigationMessages.length > 1 && isActive && isVisible && (
        <ConversationNavigation
          items={navigationMessages}
          scrollRef={scrollRef}
          onJump={jumpToNavigationMessage}
        />
      )}
      <div className="conversation-scroll" ref={scrollRef}>
        <div className="conversation-thread" ref={threadRef}>
        <div className="conversation-virtual-spacer" style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {messages.slice(virtual.start, virtual.end).map((message, visibleIndex) => {
          const messageIndex = virtual.start + visibleIndex;
          let content: ReactNode;
          if (message.role === 'tool') {
            content = <ToolRow message={message} />;
          } else if (message.role === 'reasoning') {
            content = <ReasoningRow message={message} />;
          } else {
            content = (
              <article
                className={`conversation-message conversation-message--${message.role}`}
                data-conversation-navigation-id={message.role === 'user' ? message.id : undefined}
              >
                <div className="conversation-bubble"><MarkdownContent content={message.content} /></div>
                {(message.role === 'user' || assistantSummaryMessageIds.has(message.id)) && (
                  <MessageCopyButton
                    copied={copiedMessageId === message.id}
                    onCopy={() => copyMessage(message.id, message.content)}
                  />
                )}
              </article>
            );
          }
          return (
            <MeasuredConversationRow
              key={message.id}
              messageId={virtual.measurementKeys[messageIndex] ?? message.id}
              onMeasure={virtual.measureRow}
            >
              {content}
              <span className="conversation-virtual-index" data-message-index={messageIndex} aria-hidden="true" />
            </MeasuredConversationRow>
          );
        })}
        <div className="conversation-virtual-spacer" style={{ height: virtual.bottomSpacer }} aria-hidden="true" />

        {pending && !promptInTranscript && (
          <article
            className="conversation-message conversation-message--user conversation-message--optimistic"
            data-conversation-navigation-id={`pending:${pending.sentAt}`}
          >
            <div className="conversation-bubble"><MarkdownContent content={pending.text} /></div>
            <MessageCopyButton
              copied={copiedMessageId === `pending:${pending.sentAt}`}
              onCopy={() => copyMessage(`pending:${pending.sentAt}`, pending.text)}
            />
          </article>
        )}

        {interaction && (
          <TerminalInteractionCard
            key={interaction.fingerprint}
            sessionId={sessionId}
            interaction={interaction}
            keyboardEnabled={isActive && isVisible}
          />
        )}

        {activityLabel && !interaction && (
          <div className="conversation-thinking" role="status" aria-live="polite">
            <span className="conversation-thinking-braille" aria-hidden="true" />
            <span className="conversation-thinking-text">{activityLabel}</span>
          </div>
        )}
        </div>
      </div>
      <textarea
        ref={selectAllProxyRef}
        className="conversation-selection-proxy"
        readOnly
        tabIndex={-1}
        aria-hidden="true"
      />
      {ctxMenu && (
        <TermContextMenu
          menu={ctxMenu}
          onClose={closeCtxMenu}
          onCopy={() => {
            const text = selectionText();
            if (text) void clipboardWrite(text);
            if (selectAllProxyRef.current) selectAllProxyRef.current.value = '';
            closeCtxMenu();
          }}
          onPaste={async () => {
            const imagePath = await clipboardReadImage();
            if (imagePath) {
              onPasteToDraft(imagePath);
              closeCtxMenu();
              return;
            }
            const text = await clipboardRead();
            if (text) onPasteToDraft(text);
            closeCtxMenu();
          }}
          onSelectAll={() => {
            const proxy = selectAllProxyRef.current;
            if (proxy) {
              proxy.value = messages.map(message => {
                if (message.role === 'tool' && message.toolName) {
                  return `${message.toolName}\n${message.content}`;
                }
                return message.content;
              }).filter(Boolean).join('\n\n');
              if (pending && !promptInTranscript) {
                proxy.value += `${proxy.value ? '\n\n' : ''}${pending.text}`;
              }
              proxy.focus({ preventScroll: true });
              proxy.select();
            }
            closeCtxMenu();
          }}
        />
      )}
    </div>
  );
}

export const ConversationView = memo(ConversationViewImpl, conversationPropsEqual);
