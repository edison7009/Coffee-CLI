import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { orchestrationToolLabel } from '../../lib/orchestration-label';
import { arr, obj, str, num, pretty, type CodexMessage, type CodexRequest, type Json } from '../../lib/codex-protocol';
import { interruptCodex, loadCodexHistory, respondCodex, retainCodexSession, useCodexSession } from '../../lib/codex-session';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeSessionMeta } from './WelcomeGreeting';
import { CodexWelcomeIcon } from './CodexWelcomeIcon';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem } from './ConversationControls';
import './ConversationView.css';
import './ClaudeConversation.css';
import './CodexConversation.css';

function Measured({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const update = () => measure(id, node.getBoundingClientRect().height); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [id, measure]);
  return <div ref={ref}>{children}</div>;
}
function title(message: CodexMessage): string {
  const item = message.item;
  if (item.type === 'commandExecution') return str(item.command);
  if (item.type === 'fileChange') return arr(item.changes).map(value => str(obj(value).path)).join(', ');
  return str(item.tool) || str(item.query) || str(item.type);
}
function RequestCard({ sessionId, request }: { sessionId: string; request: CodexRequest }) {
  const t = useT(), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const questions = arr(request.params.questions).map(obj);
  const submit = async (response: Json, reject = false) => {
    if (pending) return; setPending(true); setError('');
    try { await respondCodex(sessionId, request.id, response, reject); } catch (error) { setError(String(error)); setPending(false); }
  };
  const permissions = request.method === 'item/permissions/requestApproval';
  const input = request.method === 'item/tool/requestUserInput';
  const incomplete = questions.some(q => !answers[str(q.id)]?.trim());
  const submitAnswers = () => {
    if (pending || incomplete) return;
    void submit({ answers: Object.fromEntries(questions.map(q => [str(q.id), { answers: [answers[str(q.id)]] }])) });
  };
  const supported = input || permissions || ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method);
  return <section className="claude-approval codex-request" aria-label={t(input ? 'codex.question' : 'codex.approval')}>
    <strong>{t(input ? 'codex.question' : 'codex.approval')}</strong>
    {!!request.params.reason && <p>{str(request.params.reason)}</p>}
    {input ? questions.map(question => <fieldset key={str(question.id)} disabled={pending}>
      <legend>{str(question.question)}</legend>
      {arr(question.options).map(value => { const option = obj(value); return <label key={str(option.label)}><input type="radio" name={`${JSON.stringify(request.id)}-${str(question.id)}`} checked={answers[str(question.id)] === option.label} onChange={() => setAnswers(a => ({ ...a, [str(question.id)]: str(option.label) }))} /><span>{str(option.label)}<small>{str(option.description)}</small></span></label>; })}
      {(!arr(question.options).length || question.isOther === true) && <input className="claude-custom-answer" type={question.isSecret ? 'password' : 'text'} aria-label={str(question.header) || str(question.question)} value={answers[str(question.id)] ?? ''} onChange={e => setAnswers(a => ({ ...a, [str(question.id)]: e.target.value }))} onKeyDown={e => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        if (!e.repeat) submitAnswers();
      }} />}
    </fieldset>) : <pre className="codex-request-details">{str(request.params.command) || pretty(request.params.permissions ?? request.params)}</pre>}
    {error && <p role="alert">{error}</p>}
    <div className="claude-approval-actions">
      {!supported ? <><span role="alert">{t('codex.unsupported_request')}</span><button type="button" disabled={pending} onClick={() => { void submit({}, true); }}>{t('codex.decline')}</button></> : input ? <button type="button" disabled={pending || incomplete} onClick={submitAnswers}>{t('codex.submit')}</button> : <>
        <button type="button" disabled={pending} onClick={() => { void submit(permissions ? { permissions: {} } : { decision: 'decline' }); }}>{t('codex.decline')}</button>
        {!permissions && <button type="button" disabled={pending} onClick={() => { void submit({ decision: 'acceptForSession' }); }}>{t('codex.allow_session')}</button>}
        <button type="button" disabled={pending} onClick={() => { void submit(permissions ? { permissions: request.params.permissions, scope: 'turn' } : { decision: 'accept' }); }}>{t('codex.allow')}</button>
      </>}
    </div>
  </section>;
}
type Row = CodexMessage & { members?: CodexMessage[] };
export function CodexConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, hasBg, bgUrl, bgType }: { sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; hasBg?: boolean; bgUrl?: string; bgType?: string }) {
  const s = useCodexSession(sessionId), t = useT(), { dispatch } = useAppState();
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const scroll = useRef<HTMLDivElement>(null), pinned = useRef(true), lastTop = useRef(0);
  const conversationMenu = useConversationMenu(scroll, sessionId, isActive);
  const viewport = useRef({ width: 0, height: 0 });
  const anchor = useRef<{ firstId: string; messageId: string; offset: number; top: number; height: number; applied: boolean } | null>(null);
  const [scrolled, setScrolled] = useState(false), [expanded, setExpanded] = useState<Record<string, boolean>>({}), [copied, setCopied] = useState('');
  const initialToken = useRef(resumeToken);
  useEffect(() => retainCodexSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  useEffect(() => { if (s.nativeId) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.nativeId }); }, [s.nativeId, sessionId, dispatch]);
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: s.requests.length ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [s.requests.length, s.busy, sessionId, dispatch]);
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const message of s.messages) {
      const activity = (message.role === 'tool' || message.role === 'reasoning') && message.item.type !== 'turnStatus';
      const previous = result.at(-1);
      if (activity && previous?.members && previous.turnId === message.turnId) {
        previous.members.push(message); previous.partial ||= message.partial; previous.content += `\n${title(message)}`;
      } else result.push(activity ? { ...message, id: `group:${message.id}`, content: title(message), members: [message] } : message);
    }
    return result;
  }, [s.messages]);
  const virtual = useConversationVirtualizer(rows, scroll);
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => rows.flatMap((row, messageIndex) => row.role === 'user' ? [{
    id: row.id, sourceMessageId: row.id, content: row.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null,
  }] : []), [rows, virtual.offsets]);
  const sync = useCallback(() => {
    const node = scroll.current; if (!node || !isVisible || !node.clientHeight) return;
    const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
    if (!resized && node.scrollTop < lastTop.current && node.scrollHeight - node.scrollTop - node.clientHeight > 2) pinned.current = false;
    viewport.current = { width: node.clientWidth, height: node.clientHeight };
    const saved = anchor.current;
    if (saved?.applied) {
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(el => el.dataset.messageId === saved.messageId);
      if (target) node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
    } else if (pinned.current) node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop; setScrolled(!pinned.current);
  }, [isVisible]);
  useEffect(() => { if (scroll.current) return bindAutoHideScrollbar(scroll.current, { wide: true }); }, []);
  useLayoutEffect(() => {
    const node = scroll.current, saved = anchor.current;
    if (!node || !isVisible || !node.clientHeight) return;
    if (saved && !saved.applied && s.messages[0]?.id !== saved.firstId) { node.scrollTop = saved.top + node.scrollHeight - saved.height; saved.applied = true; }
    sync();
  }, [s.messages, s.requests, virtual.total, virtual.start, virtual.end, isVisible, sync]);
  useEffect(() => { const node = scroll.current; if (!node) return; const observer = new ResizeObserver(sync); observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild); return () => observer.disconnect(); }, [sync]);
  useEffect(() => {
    if (!isActive) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && s.busy && !(e.target as HTMLElement)?.closest('[role="dialog"]')) { e.preventDefault(); void interruptCodex(sessionId); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [isActive, s.busy, sessionId]);
  const pause = () => { anchor.current = null; pinned.current = false; setScrolled(true); };
  const jumpToTurn = (item: ConversationNavigationItem) => {
    pause();
    virtual.scrollToIndex(item.messageIndex, 'instant');
    const node = scroll.current;
    if (node) {
      // Keep the selected turn aligned while virtual rows finish measuring.
      anchor.current = { firstId: s.messages[0].id, messageId: item.id, offset: 24, top: node.scrollTop, height: node.scrollHeight, applied: true };
      sync();
    }
  };
  const loadEarlier = () => {
    const node = scroll.current;
    pause();
    if (node && s.messages.length) {
      const top = node.getBoundingClientRect().top;
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(el => el.getBoundingClientRect().bottom > top);
      if (target) anchor.current = { firstId: s.messages[0].id, messageId: target.dataset.messageId!, offset: target.getBoundingClientRect().top - top, top: node.scrollTop, height: node.scrollHeight, applied: false };
    }
    void loadCodexHistory(sessionId);
  };
  const toggle = (id: string) => setExpanded(old => ({ ...old, [id]: !old[id] }));
  const copy = (id: string, content: string) => { void clipboardWrite(content).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }); };
  const tool = (message: CodexMessage) => {
    const label = orchestrationToolLabel(str(message.item.tool), t, str(message.item.server));
    return <div className={`codex-tool is-${message.interrupted ? 'interrupted' : message.toolStatus ?? 'reasoning'}`} key={message.id}>
    <div className="codex-tool-heading"><button type="button" className="claude-tool-heading" aria-expanded={!!expanded[message.id]} onClick={() => toggle(message.id)}><span className="codex-chevron" aria-hidden="true">{expanded[message.id] ? '⌄' : '›'}</span><strong>{label ?? (message.role === 'reasoning' ? t('conversation.reasoning') : message.item.type === 'fileChange' ? t('codex.files') : message.item.type === 'commandExecution' ? t('codex.command') : str(message.item.type))}</strong><span>{label ? str(obj(message.item.arguments).title) : title(message)}</span></button><MessageCopyButton copied={copied === message.id} onCopy={() => copy(message.id, [title(message), message.content].join('\n'))} /></div>
    {expanded[message.id] && (message.role === 'reasoning' ? <MarkdownContent content={message.content} /> : <pre className="codex-tool-body">{message.content || pretty(message.item)}</pre>)}
  </div>;
  };
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation codex-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
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
        {s.historyCursor && <button className="claude-expand" disabled={s.loadingHistory} onClick={loadEarlier}>{t(s.loadingHistory ? 'diff.loading' : 'claude.history_earlier')}</button>}
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {rows.slice(virtual.start, virtual.end).map((row, i) => <Measured key={row.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          <article className={`claude-row claude-row--${row.item.type === 'turnStatus' ? str(row.item.status) : row.partial && row.role !== 'user' ? 'running' : row.role} codex-row`} data-message-id={row.id}>
            {row.members ? <>
              <button type="button" className="codex-group-heading" aria-expanded={!!expanded[row.id]} onClick={() => toggle(row.id)}><span aria-hidden="true">{expanded[row.id] ? '⌄' : '›'}</span><span>{t('codex.activity', { count: row.members.length })}</span>{row.partial && <span className="codex-spinner" aria-hidden="true" />}<small>{title(row.members.at(-1)!)}</small></button>
              {expanded[row.id] && <div className="codex-activity-list">{row.members.map(tool)}</div>}
            </> : row.item.type === 'turnStatus' ? <div className="claude-turn-summary" role="status">{t(row.item.status === 'interrupted' ? 'claude.interrupted' : row.item.status === 'failed' ? 'codex.failed' : 'codex.completed')}{num(row.item.durationMs) > 0 && ` · ${Math.round(num(row.item.durationMs) / 1000)}s`}</div> : <>
              {row.role === 'user'
                ? <CollapsibleUserMessage expanded={!!expanded[row.id]} onToggle={() => setExpanded(old => ({ ...old, [row.id]: !old[row.id] }))}><MarkdownContent content={row.content} /></CollapsibleUserMessage>
                : <div><MarkdownContent content={row.content} /></div>}
              <MessageCopyButton copied={copied === row.id} onCopy={() => copy(row.id, row.content)} />
            </>}
          </article>
        </Measured>)}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(request => <RequestCard key={JSON.stringify(request.id)} sessionId={sessionId} request={request} />)}
        {s.ready && s.busy && <div className="codex-working" role="status"><span className="codex-spinner" aria-hidden="true" />{t(s.interrupting ? 'codex.stopping' : s.requests.length ? 'codex.waiting' : 'claude.status.working')}…</div>}
        {s.error && s.ready && <div className="claude-session-error" role="alert">{s.error}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {!directoryIssue && !rows.length && <div className="claude-empty"><CodexWelcomeIcon isActive={isVisible} /><WelcomeGreeting /><WelcomeSessionMeta cwd={cwd} model={s.model} /></div>}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scroll} onJump={jumpToTurn} />}
    {scrolled && <button type="button" className="gambit-send claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { anchor.current = null; pinned.current = true; lastTop.current = scroll.current?.scrollTop ?? 0; sync(); }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v11M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>}
    {s.error && !s.ready && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" title={directoryError || s.error} onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('codex.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
