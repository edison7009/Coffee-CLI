import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppLanguage, useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import type { ClaudeTranslate } from '../../lib/claude-i18n';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import type { ClaudeMessage } from '../../lib/claude-protocol';
import type { PiDialog } from '../../lib/pi-protocol';
import { abortPi, respondPi, retainPiSession, usePiSession } from '../../lib/pi-session';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeRestoring, WelcomeSessionMeta } from './WelcomeGreeting';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem } from './ConversationControls';
import { ClaudeThinking, ClaudeTool } from './ClaudeConversation';
import { PiMark, PiWelcomeLogo } from './PiWelcomeLogo';
import './ConversationView.css';
import './Gambit.css';
import './ClaudeConversation.css';
import './PiWelcomeLogo.css';

function count(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)); }
function elapsed(ms: number, t: ClaudeTranslate) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds >= 60 ? t('claude.time.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }) : t('claude.time.seconds', { seconds }); }

/** Pi's working status: its logo with the three colors moving clockwise, the label and the time. */
function Running({ label, startedAt }: { label: string; startedAt?: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <div className="pi-running" role="status">
    <PiMark />
    <span>{label}</span>
    {startedAt && <span className="pi-running-elapsed">{elapsed(now - startedAt, t)}</span>}
  </div>;
}

/** An extension's dialog: pick an option, confirm, or type an answer. */
function Dialog({ sessionId, request }: { sessionId: string; request: PiDialog }) {
  const t = useT();
  const [value, setValue] = useState(request.prefill);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const answer = async (response: Record<string, unknown>) => {
    if (pending) return; setPending(true); setError('');
    try { await respondPi(sessionId, request.id, response); } catch (e) { setError(String(e)); setPending(false); }
  };
  return <section className="claude-approval" aria-label={request.title || t('interaction.question')}>
    <strong>{request.title || t('interaction.question')}</strong>
    {request.message && <MarkdownContent content={request.message} />}
    {request.method === 'select' && <fieldset disabled={pending}>{request.options.map(option => <label key={option}><input type="radio" name={request.id} checked={value === option} onChange={() => setValue(option)} /><span>{option}</span></label>)}</fieldset>}
    {request.method === 'input' && <input className="claude-custom-answer" placeholder={request.placeholder} value={value} disabled={pending} onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void answer({ value }); } }} />}
    {request.method === 'editor' && <textarea className="claude-custom-answer" rows={6} value={value} disabled={pending} onChange={e => setValue(e.target.value)} />}
    {error && <div role="alert" className="claude-tool-error">{error}</div>}
    <div className="claude-approval-actions">
      {request.method === 'confirm' ? <>
        <button type="button" disabled={pending} onClick={() => { void answer({ confirmed: false }); }}>{t('claude.reject')}</button>
        <button type="button" disabled={pending} onClick={() => { void answer({ confirmed: true }); }}>{t('claude.allow_once')}</button>
      </> : <>
        <button type="button" disabled={pending} onClick={() => { void answer({ cancelled: true }); }}>{t('codex.decline')}</button>
        <button type="button" disabled={pending || (request.method === 'select' && !value)} onClick={() => { void answer({ value }); }}>{t('interaction.submit')}</button>
      </>}
    </div>
  </section>;
}

function MeasuredRow({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const update = () => measure(id, node.getBoundingClientRect().height); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [id, measure]);
  return <div ref={ref} className="claude-measured-row">{children}</div>;
}

export function PiConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, bgUrl, bgType, hasBg }: {
  sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; bgUrl?: string; bgType?: string; hasBg?: boolean;
}) {
  const t = useT();
  const language = useAppLanguage();
  const { dispatch } = useAppState();
  const s = usePiSession(sessionId);
  const initialToken = useRef(resumeToken);
  // Captured at mount like initialToken; state, not a ref, because the welcome screen renders from it.
  const [resumed] = useState(() => !!resumeToken);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationMenu = useConversationMenu(scrollRef, sessionId, isActive);
  const pinned = useRef(true), pointerHeld = useRef(false), lastScrollTop = useRef(0);
  const anchor = useRef<{ messageId: string; offset: number } | null>(null);
  const [copied, setCopied] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const [thinkingExpansion, setThinkingExpansion] = useState<Record<string, boolean>>({});
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const virtual = useConversationVirtualizer(s.messages, scrollRef);
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => s.messages.flatMap((message, messageIndex) => message.role === 'user' ? [{ id: message.id, sourceMessageId: message.id, content: message.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null }] : []), [s.messages, virtual.offsets]);
  useEffect(() => retainPiSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: s.requests.length ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [sessionId, s.busy, s.requests.length, dispatch]);
  // The ID becomes a history token only once the Session has a message, so it never points at an empty file.
  const started = s.messages.some(m => m.role === 'user');
  useEffect(() => { if (s.sessionId && started) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.sessionId }); }, [sessionId, s.sessionId, started, dispatch]);
  useEffect(() => { if (s.title.trim()) dispatch({ type: 'SET_TAB_TITLE', id: sessionId, title: s.title.trim() }); }, [sessionId, s.title, dispatch]);
  const syncScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !isVisible || !scroll.clientHeight) return;
    if (pointerHeld.current && scroll.scrollTop < lastScrollTop.current && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 2) pinned.current = false;
    const saved = anchor.current;
    if (saved) {
      const node = [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === saved.messageId);
      if (node) scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset;
    } else if (pinned.current) scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'instant' });
    lastScrollTop.current = scroll.scrollTop;
  }, [isVisible]);
  useLayoutEffect(() => { syncScroll(); }, [s.messages, s.requests, s.busy, virtual.total, virtual.start, virtual.end, isVisible, syncScroll]);
  useEffect(() => {
    const scroll = scrollRef.current; if (!scroll) return;
    const observer = new ResizeObserver(syncScroll); observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  }, [syncScroll]);
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && s.busy && !s.requests.length && !(e.target as HTMLElement)?.closest('[role="dialog"]')) { e.preventDefault(); void abortPi(sessionId); } };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [isActive, s.busy, s.requests.length, sessionId]);
  const pauseFollow = useCallback(() => { anchor.current = null; pinned.current = false; setScrolled(true); }, []);
  useEffect(() => { const scroll = scrollRef.current; if (!scroll) return; return bindAutoHideScrollbar(scroll, { wide: true, onDragStart: pauseFollow }); }, [pauseFollow]);
  useEffect(() => {
    const release = () => { pointerHeld.current = false; };
    document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
    return () => { document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); };
  }, []);
  const jumpToTurn = (item: ConversationNavigationItem) => {
    pauseFollow(); virtual.scrollToIndex(item.messageIndex, 'instant');
    // Keep the selected turn aligned while virtual rows finish measuring.
    anchor.current = { messageId: item.id, offset: 24 }; syncScroll();
  };
  const onScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !scroll.clientHeight) return;
    if (scroll.scrollTop !== lastScrollTop.current) anchor.current = null;
    const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    if (scroll.scrollTop < lastScrollTop.current && distance >= 2) {
      // Wheel, touch, keys and the scrollbar pause follow before they move; a held pointer is a text
      // selection. Anything else is the engine restoring an older position (macOS WebKit).
      if (pointerHeld.current) pinned.current = false;
      else if (pinned.current) scroll.scrollTop = scroll.scrollHeight;
    } else if (scroll.scrollTop > lastScrollTop.current && distance < 2) pinned.current = true;
    lastScrollTop.current = scroll.scrollTop;
    setScrolled(!pinned.current);
  }, []);
  const copy = (message: ClaudeMessage) => { void clipboardWrite(message.content).then(() => { setCopied(message.id); setTimeout(() => setCopied(''), 1500); }); };
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const noModel = s.error === 'no-model' || (s.ready && !s.model && !s.models.length);
  const empty = !directoryIssue && !s.messages.length && !s.busy && !s.requests.length;
  const restoring = resumed && !s.ready && !s.error;
  const label = s.status === 'compacting' ? t('claude.status.compacting') : s.status === 'retrying' && s.retry ? t('pi.retrying', { attempt: s.retry.attempt, max: s.retry.maxAttempts }) : t('pi.working');
  const used = s.stats.input + s.stats.output + s.stats.cacheRead + s.stats.cacheWrite;
  const summary = !empty && !s.busy && s.endedAt && s.startedAt && <div className="claude-turn-summary">{t('claude.worked_for', { duration: elapsed(s.endedAt - s.startedAt, t) })}{used > 0 && <> · {t('claude.tokens', { count: count(used) })}</>}{s.stats.cost > 0 && <> · ~${s.stats.cost.toFixed(4)}</>}</div>;
  const system = (m: ClaudeMessage) => m.content === 'compacted' ? t('pi.compacted') : m.content;
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation pi-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
    {hasBg && bgUrl && <div className="conversation-background">{bgType === 'video' ? <video src={bgUrl} autoPlay loop muted /> : <img src={bgUrl} alt="" />}</div>}
    <div className="claude-scroll" ref={scrollRef} onPointerDownCapture={event => { if (event.button === 0) pointerHeld.current = true; }} onContextMenu={conversationMenu.onContextMenu} onCopy={conversationMenu.onCopy} onScroll={onScroll} onWheelCapture={event => { if (event.deltaY < 0 && !event.ctrlKey) pauseFollow(); }} onTouchMoveCapture={pauseFollow} onKeyDownCapture={event => { if ((['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) && !(event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) pauseFollow(); }}>
      <div className={`claude-thread${empty ? ' is-empty' : ''}`}>
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {s.messages.slice(virtual.start, virtual.end).map((m, i) => <MeasuredRow key={m.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          {new Date(m.timestamp).toDateString() !== new Date(s.messages[virtual.start + i - 1]?.timestamp ?? 0).toDateString() && <div className="claude-date">{new Date(m.timestamp).toLocaleDateString(language, { weekday: 'short', month: 'short', day: 'numeric' })}</div>}
          <article data-message-id={m.id} className={`claude-row claude-row--${m.role} ${m.toolStatus ? `claude-row--${m.interrupted ? 'interrupted' : m.toolStatus}` : ''}`}>
            {m.role === 'user' ? <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><CollapsibleUserMessage sentAt={m.timestamp} expanded={!!expandedMessages[m.id]} onToggle={() => setExpandedMessages(old => ({ ...old, [m.id]: !old[m.id] }))}><MarkdownContent content={m.content} /></CollapsibleUserMessage></>
              : m.role === 'tool' ? <ClaudeTool message={m} />
              : m.role === 'reasoning' ? <ClaudeThinking message={m} expanded={thinkingExpansion[m.id] ?? false} onToggle={open => setThinkingExpansion(previous => ({ ...previous, [m.id]: open }))} />
              : m.role === 'notice' ? <div className={`claude-turn-summary${m.toolStatus === 'failed' ? ' is-error' : ''}`} role="status">{system(m)}</div>
              : <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><MarkdownContent content={m.content} /></>}
            {(m.role === 'user' || m.role === 'assistant') && !m.partial && <MessageCopyButton copied={copied === m.id} onCopy={() => copy(m)} />}
            {virtual.start + i === s.messages.length - 1 && summary}
          </article>
        </MeasuredRow>)}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(request => <Dialog key={request.id} sessionId={sessionId} request={request} />)}
        {s.ready && s.busy && !s.requests.length && <Running label={label} startedAt={s.startedAt} />}
        {s.interrupted && !s.busy && !s.error && <div className="claude-interrupted" role="status">{t('claude.interrupted')}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {noModel && <div className="claude-session-error" role="alert">{t('pi.no_model')}</div>}
        {s.error && !noModel && !directoryIssue && <div className="claude-session-error" role="alert">{s.error}</div>}
        {empty && <div className="claude-empty">
          <PiWelcomeLogo isActive={isVisible} />
          <WelcomeGreeting />
          {restoring && <WelcomeRestoring labelClassName="claude-working-word" mark={<PiMark />} />}
          <WelcomeSessionMeta cwd={cwd} model={s.model?.name ?? ''} />
        </div>}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scrollRef} onJump={jumpToTurn} />}
    {scrolled && <button type="button" className="claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { anchor.current = null; pinned.current = true; syncScroll(); setScrolled(false); }}>
      {s.ready && s.busy && !s.requests.length
        ? <PiMark />
        : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v11M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>}
    {s.error && !s.ready && !noModel && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('pi.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
