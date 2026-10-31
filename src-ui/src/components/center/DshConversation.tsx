import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { arr, obj, str, type DshMessage, type DshRequest } from '../../lib/dsh-protocol';
import { respondDsh, retainDshSession, stopDsh, useDshSession } from '../../lib/dsh-session';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { useConversationVirtualizer } from './conversation-virtualizer';
import type { ChatMessage } from '../../lib/chat-transcript';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeSessionMeta } from './WelcomeGreeting';
import { DshWelcomeIcon } from './DshWelcomeIcon';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem } from './ConversationControls';
import DSH_RUNNING_WHALE from '../../icons-inline/dsh-running-whale.png';
import './ConversationView.css';
import './ClaudeConversation.css';
import './CodexConversation.css';
import './DshConversation.css';

function Measured({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const update = () => measure(id, node.getBoundingClientRect().height); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [id, measure]);
  return <div ref={ref}>{children}</div>;
}
/** One-line summary of a tool call: its first string argument, else the raw arguments. */
function title(message: DshMessage): string {
  if (message.role === 'reasoning') return message.content.split('\n').find(line => line.trim())?.trim() ?? '';
  try { const input = obj(JSON.parse(message.toolInput ?? '')); const first = Object.values(input).find(v => typeof v === 'string'); return [message.toolName, first].filter(Boolean).join(' · '); }
  catch { return [message.toolName, message.toolInput].filter(Boolean).join(' · '); }
}
/** DeepSeek Harness's running status: the swinging whale tail and a blue sweep over "deep diving for …". */
function Running({ since, stopping }: { since?: number; stopping: boolean }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const total = Math.floor(Math.max(1000, now - (since ?? now)) / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60;
  const duration = `${hours ? `${hours}${t('dsh.time.hour')}` : ''}${total >= 60 ? `${minutes}${t('dsh.time.minute')}` : ''}${total % 60}${t('dsh.time.second')}`;
  const label = stopping ? `${t('codex.stopping')}…` : since ? t('dsh.deep_diving_for', { duration }) : t('dsh.deep_diving');
  return <div className="dsh-running">
    <span className="dsh-running-status" role="status">{stopping ? t('codex.stopping') : t('dsh.deep_diving')}</span>
    <span className="dsh-running-whale" aria-hidden="true" style={{ maskImage: `url(${DSH_RUNNING_WHALE})`, WebkitMaskImage: `url(${DSH_RUNNING_WHALE})` }} />
    <span className="dsh-shimmer" aria-hidden="true">{label}</span>
  </div>;
}
function RequestCard({ sessionId, request }: { sessionId: string; request: DshRequest }) {
  const t = useT(), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string[]>>({}), [custom, setCustom] = useState<Record<string, string>>({});
  const question = request.method === 'user-question/ask';
  const questions = arr(request.params.questions).map(obj);
  const submit = async (result: Record<string, unknown>) => {
    if (pending) return; setPending(true); setError('');
    try { await respondDsh(sessionId, request.id, result); } catch (error) { setError(String(error)); setPending(false); }
  };
  const incomplete = questions.some(q => !(answers[str(q.id)]?.length || custom[str(q.id)]?.trim()));
  const choose = (id: string, label: string, multi: boolean) => setAnswers(old => {
    const current = old[id] ?? [];
    return { ...old, [id]: multi ? (current.includes(label) ? current.filter(x => x !== label) : [...current, label]) : [label] };
  });
  return <section className="claude-approval codex-request" aria-label={t(question ? 'codex.question' : 'codex.approval')}>
    <strong>{t(question ? 'codex.question' : 'codex.approval')}</strong>
    {question ? questions.map(q => { const id = str(q.id), multi = q.multiSelect === true; return <fieldset key={id} disabled={pending}>
      <legend>{str(q.question)}</legend>
      {!!q.detail && <MarkdownContent content={str(q.detail)} />}
      {arr(q.options).map(value => { const option = obj(value), label = str(option.label); return <label key={label}><input type={multi ? 'checkbox' : 'radio'} name={`${request.id}-${id}`} checked={(answers[id] ?? []).includes(label)} onChange={() => choose(id, label, multi)} /><span>{label}<small>{str(option.description)}</small></span></label>; })}
      <input className="claude-custom-answer" type="text" aria-label={str(q.header) || str(q.question)} value={custom[id] ?? ''} onChange={e => setCustom(c => ({ ...c, [id]: e.target.value }))} />
    </fieldset>; }) : <>
      <pre className="codex-request-details">{[str(request.params.toolName), str(request.params.reason)].filter(Boolean).join('\n')}</pre>
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="claude-approval-actions">
      {question ? <>
        <button type="button" disabled={pending} onClick={() => { void submit({ cancelled: true }); }}>{t('codex.decline')}</button>
        <button type="button" disabled={pending || incomplete} onClick={() => { void submit({ answers: questions.map(q => { const id = str(q.id), text = custom[id]?.trim(); return { id, selected: answers[id] ?? [], ...(text ? { custom: text } : {}) }; }) }); }}>{t('codex.submit')}</button>
      </> : <>
        <button type="button" disabled={pending} onClick={() => { void submit({ outcome: 'rejected' }); }}>{t('codex.decline')}</button>
        <button type="button" disabled={pending} onClick={() => { void submit({ outcome: 'allowed-once' }); }}>{t('codex.allow')}</button>
      </>}
    </div>
  </section>;
}
type Row = DshMessage & { members?: DshMessage[]; running?: boolean };
export function DshConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, hasBg, bgUrl, bgType }: { sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; hasBg?: boolean; bgUrl?: string; bgType?: string }) {
  const s = useDshSession(sessionId), t = useT(), { dispatch } = useAppState();
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const scroll = useRef<HTMLDivElement>(null), pinned = useRef(true), lastTop = useRef(0);
  const conversationMenu = useConversationMenu(scroll, sessionId, isActive);
  const viewport = useRef({ width: 0, height: 0 });
  const anchor = useRef<{ messageId: string; offset: number } | null>(null);
  const [scrolled, setScrolled] = useState(false), [expanded, setExpanded] = useState<Record<string, boolean>>({}), [copied, setCopied] = useState('');
  const initialToken = useRef(resumeToken);
  useEffect(() => retainDshSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  useEffect(() => { if (s.sessionId) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.sessionId }); }, [s.sessionId, sessionId, dispatch]);
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: s.requests.length ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [s.requests.length, s.busy, sessionId, dispatch]);
  // Tool calls and reasoning within one turn fold into a single process row, as in DeepSeek Harness.
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const message of s.messages) {
      const activity = message.role === 'tool' || message.role === 'reasoning';
      const previous = result.at(-1);
      if (activity && previous?.members && previous.turn === message.turn) { previous.members.push(message); previous.running ||= message.toolStatus === 'running'; }
      else result.push(activity ? { ...message, id: `group:${message.id}`, members: [message], running: message.toolStatus === 'running' } : message);
    }
    return result;
  }, [s.messages]);
  // The virtualizer reads id/role/content only; notice rows take its default height estimate.
  const virtual = useConversationVirtualizer(rows as unknown as ChatMessage[], scroll);
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => rows.flatMap((row, messageIndex) => row.role === 'user' ? [{
    id: row.id, sourceMessageId: row.id, content: row.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null,
  }] : []), [rows, virtual.offsets]);
  const sync = useCallback(() => {
    const node = scroll.current; if (!node || !isVisible || !node.clientHeight) return;
    const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
    if (!resized && node.scrollTop < lastTop.current && node.scrollHeight - node.scrollTop - node.clientHeight > 2) pinned.current = false;
    viewport.current = { width: node.clientWidth, height: node.clientHeight };
    const saved = anchor.current;
    if (saved) {
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(el => el.dataset.messageId === saved.messageId);
      if (target) node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
    } else if (pinned.current) node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop; setScrolled(!pinned.current);
  }, [isVisible]);
  useEffect(() => { if (scroll.current) return bindAutoHideScrollbar(scroll.current, { wide: true }); }, []);
  useLayoutEffect(() => { sync(); }, [s.messages, s.requests, s.busy, virtual.total, virtual.start, virtual.end, isVisible, sync]);
  useEffect(() => { const node = scroll.current; if (!node) return; const observer = new ResizeObserver(sync); observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild); return () => observer.disconnect(); }, [sync]);
  useEffect(() => {
    if (!isActive) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && s.busy && !(e.target as HTMLElement)?.closest('[role="dialog"]')) { e.preventDefault(); void stopDsh(sessionId); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [isActive, s.busy, sessionId]);
  const pause = () => { anchor.current = null; pinned.current = false; setScrolled(true); };
  const jumpToTurn = (item: ConversationNavigationItem) => {
    pause(); virtual.scrollToIndex(item.messageIndex, 'instant');
    // Keep the selected turn aligned while virtual rows finish measuring.
    anchor.current = { messageId: item.id, offset: 24 }; sync();
  };
  const toggle = (id: string) => setExpanded(old => ({ ...old, [id]: !old[id] }));
  const copy = (id: string, content: string) => { void clipboardWrite(content).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }); };
  const step = (message: DshMessage) => <div className={`codex-tool is-${message.toolStatus ?? 'reasoning'}`} key={message.id}>
    <div className="codex-tool-heading"><button type="button" className="claude-tool-heading" aria-expanded={!!expanded[message.id]} onClick={() => toggle(message.id)}><span className="codex-chevron" aria-hidden="true">{expanded[message.id] ? '⌄' : '›'}</span><strong>{message.role === 'reasoning' ? t('conversation.reasoning') : message.toolName}</strong><span>{message.role === 'reasoning' ? title(message) : title(message).replace(`${message.toolName} · `, '')}</span></button><MessageCopyButton copied={copied === message.id} onCopy={() => copy(message.id, [message.toolInput, message.content].filter(Boolean).join('\n'))} /></div>
    {expanded[message.id] && (message.role === 'reasoning' ? <MarkdownContent content={message.content} /> : <pre className="codex-tool-body">{[message.toolInput, message.content].filter(Boolean).join('\n\n')}</pre>)}
  </div>;
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation codex-conversation dsh-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
    {hasBg && bgUrl && <div className="conversation-background">{bgType === 'video' ? <video src={bgUrl} autoPlay loop muted /> : <img src={bgUrl} alt="" />}</div>}
    <div className="claude-scroll" ref={scroll} onContextMenu={conversationMenu.onContextMenu} onCopy={conversationMenu.onCopy} onWheelCapture={e => { if (e.deltaY < 0 && !e.ctrlKey) pause(); }} onTouchMoveCapture={pause} onKeyDownCapture={e => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) && !(e.target as HTMLElement).closest('input,textarea,select')) pause(); }} onScroll={() => {
      const node = scroll.current; if (!node?.clientHeight) return;
      if (node.scrollTop !== lastTop.current) anchor.current = null;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
      if (!resized && node.scrollTop < lastTop.current && distance > 2) pinned.current = false;
      else if (node.scrollTop > lastTop.current && distance < 2) pinned.current = true;
      lastTop.current = node.scrollTop; setScrolled(!pinned.current);
    }}>
      <div className={`claude-thread${!rows.length ? ' is-empty' : ''}`}>
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {rows.slice(virtual.start, virtual.end).map((row, i) => <Measured key={row.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          <article className={`claude-row claude-row--${row.members ? (row.running ? 'running' : 'tool') : row.role} codex-row`} data-message-id={row.id}>
            {row.members ? <>
              <button type="button" className="codex-group-heading" aria-expanded={!!expanded[row.id]} onClick={() => toggle(row.id)}><span aria-hidden="true">{expanded[row.id] ? '⌄' : '›'}</span><span>{t('codex.activity', { count: row.members.length })}</span>{row.running && <span className="codex-spinner" aria-hidden="true" />}<small>{title(row.members.at(-1)!)}</small></button>
              {expanded[row.id] && <div className="codex-activity-list">{row.members.map(step)}</div>}
            </> : row.role === 'notice' ? <div className={`claude-turn-summary${row.tone === 'error' ? ' is-error' : ''}`} role="status">{row.content === 'interrupted' ? t('claude.interrupted') : row.content === 'commands-unsupported' ? t('dsh.commands_unsupported') : row.tone === 'error' && !row.content.startsWith('/') ? `${t('codex.failed')} · ${row.content}` : row.content}</div> : <>
              {row.role === 'user'
                ? <CollapsibleUserMessage sentAt={row.timestamp} expanded={!!expanded[row.id]} onToggle={() => setExpanded(old => ({ ...old, [row.id]: !old[row.id] }))}><MarkdownContent content={row.content} /></CollapsibleUserMessage>
                : <div><MarkdownContent content={row.content} /></div>}
              <MessageCopyButton copied={copied === row.id} onCopy={() => copy(row.id, row.content)} />
            </>}
          </article>
        </Measured>)}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(request => <RequestCard key={String(request.id)} sessionId={sessionId} request={request} />)}
        {(s.busy || (s.restarting && s.stopping)) && !s.requests.length && <Running since={s.busy ? s.startedAt : undefined} stopping={!!s.restarting} />}
        {/* A failed start must say why; Reconnect alone hides the cause. */}
        {s.error && !directoryIssue && <div className="claude-session-error" role="alert">{s.error}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {!directoryIssue && !rows.length && <div className="claude-empty"><DshWelcomeIcon isActive={isVisible} /><WelcomeGreeting /><WelcomeSessionMeta cwd={cwd} model={s.models.find(m => m.provider === s.route.provider && m.model === s.route.model)?.name ?? s.route.model} /></div>}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scroll} onJump={jumpToTurn} />}
    {scrolled && <button type="button" className="gambit-send claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { anchor.current = null; pinned.current = true; lastTop.current = scroll.current?.scrollTop ?? 0; sync(); }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v11M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>}
    {s.error && !s.ready && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('dsh.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
