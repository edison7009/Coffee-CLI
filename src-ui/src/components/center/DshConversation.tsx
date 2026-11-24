import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shownMessageText } from '../../lib/worker-prompt';
import { startErrorText } from '../../lib/start-error';
import { TurnSummary } from './TurnSummary';
import { useWorktreePending } from '../../lib/worktree-pending';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { arr, dshToolCard, obj, str, type DshRequest } from '../../lib/dsh-protocol';
import { respondDsh, retainDshSession, stopDsh, useDshSession } from '../../lib/dsh-session';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { useConversationVirtualizer } from './conversation-virtualizer';
import type { ChatMessage } from '../../lib/chat-transcript';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeRestoring, WelcomeSessionMeta } from './WelcomeGreeting';
import { ToolSwarm } from './ToolSwarm';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem } from './ConversationControls';
import { ClaudeThinking, ToolGroup } from './ToolSteps';
import { ChangedFilesCard, StepWorking, TurnFoldRow } from './TurnWork';
import { toolRuns } from '../../lib/tool-runs';
import { useTurnFolds } from '../../lib/use-turn-work';
import DSH_RUNNING_WHALE from '../../icons-inline/dsh-running-whale.png';
import './ConversationView.css';
import './ClaudeConversation.css';
import './CodexConversation.css';
import './DshConversation.css';
import { pasteImageIntoAnswer } from '../../lib/answer-image-paste';
import { ScrollLatestIcon } from './ScrollLatestIcon';

function Measured({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const update = () => measure(id, node.getBoundingClientRect().height); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [id, measure]);
  return <div ref={ref}>{children}</div>;
}
/** One-line summary of a step: a command's description, else its first string argument; reasoning shows its first line. */
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
      <input className="claude-custom-answer" type="text" aria-label={str(q.header) || str(q.question)} value={custom[id] ?? ''} onChange={e => setCustom(c => ({ ...c, [id]: e.target.value }))} onPaste={e => pasteImageIntoAnswer(e, value => setCustom(c => ({ ...c, [id]: value })))} />
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
export function DshConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, hasBg, bgUrl, bgType }: { sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; hasBg?: boolean; bgUrl?: string; bgType?: string }) {
  const s = useDshSession(sessionId), t = useT(), { dispatch } = useAppState();
  const creatingWorktree = useWorktreePending(sessionId, s.ready || !!s.error);
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const scroll = useRef<HTMLDivElement>(null), pinned = useRef(true), pointerHeld = useRef(false), lastTop = useRef(0);
  const conversationMenu = useConversationMenu(scroll, sessionId, isActive);
  const viewport = useRef({ width: 0, height: 0 });
  const anchor = useRef<{ messageId: string; offset: number } | null>(null);
  const [scrolled, setScrolled] = useState(false), [expanded, setExpanded] = useState<Record<string, boolean>>({}), [copied, setCopied] = useState('');
  const initialToken = useRef(resumeToken);
  // Captured at mount like initialToken; state, not a ref, because the welcome screen renders from it.
  const [resumed] = useState(() => !!resumeToken);
  useEffect(() => retainDshSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  useEffect(() => { if (s.sessionId) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.sessionId }); }, [s.sessionId, sessionId, dispatch]);
  // The conversation's own title names the tab, as a terminal tab takes the tool's OSC title.
  useEffect(() => { const title = s.title.trim(); if (title) dispatch({ type: 'SET_TAB_TITLE', id: sessionId, title }); }, [s.title, sessionId, dispatch]);
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: s.requests.length ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [s.requests.length, s.busy, sessionId, dispatch]);
  // Every tool draws its steps alike: calls (as the shared tool card reads them) and thoughts on one line, a finished turn folded.
  const rows = useMemo(() => s.messages.map(message => message.role === 'tool' ? { ...dshToolCard(message), source: message } : { id: message.id, role: message.role, content: message.content, timestamp: message.timestamp, partial: message.streaming, turnStats: message.turnStats && { ...message.turnStats, usage: { ...message.turnStats.usage, cacheWrite1h: 0 } }, source: message }), [s.messages]);
  const runs = useMemo(() => toolRuns(rows, 1), [rows]);
  const folds = useTurnFolds(rows, s.busy);
  // The virtualizer reads id/role/content only; notice rows take its default height estimate.
  const virtual = useConversationVirtualizer(rows as unknown as ChatMessage[], scroll);
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => rows.flatMap((row, messageIndex) => row.role === 'user' ? [{
    id: row.id, sourceMessageId: row.id, content: row.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null,
  }] : []), [rows, virtual.offsets]);
  const sync = useCallback(() => {
    const node = scroll.current; if (!node || !isVisible || !node.clientHeight) return;
    const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
    if (pointerHeld.current && !resized && node.scrollTop < lastTop.current && node.scrollHeight - node.scrollTop - node.clientHeight > 2) pinned.current = false;
    viewport.current = { width: node.clientWidth, height: node.clientHeight };
    const saved = anchor.current;
    if (saved) {
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(el => el.dataset.messageId === saved.messageId);
      if (target) node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset;
    } else if (pinned.current) node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop; setScrolled(!pinned.current);
  }, [isVisible]);
  useEffect(() => {
    const node = scroll.current; if (!node) return;
    const unbind = bindAutoHideScrollbar(node, { wide: true, onDragStart: () => { anchor.current = null; pinned.current = false; setScrolled(true); } });
    const release = () => { pointerHeld.current = false; };
    document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
    return () => { unbind(); document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); };
  }, []);
  useLayoutEffect(() => { sync(); }, [s.messages, s.requests, s.busy, virtual.total, virtual.start, virtual.end, isVisible, sync]);
  useEffect(() => { const node = scroll.current; if (!node) return; const observer = new ResizeObserver(sync); observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild); return () => observer.disconnect(); }, [sync]);
  useEffect(() => {
    if (!isActive) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && s.busy && !(e.target as HTMLElement)?.closest('[role="dialog"]')) { e.preventDefault(); void stopDsh(sessionId); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [isActive, s.busy, sessionId]);
  // Moving away from the latest message; a thread too short to scroll has nowhere to go (a swipe on a phone is not a read-back).
  const pause = () => {
    const node = scroll.current;
    if (node && node.scrollHeight - node.clientHeight <= 2) return;
    anchor.current = null; pinned.current = false; setScrolled(true);
  };
  const jumpToTurn = (item: ConversationNavigationItem) => {
    pause(); virtual.scrollToIndex(item.messageIndex, 'instant');
    // Keep the selected turn aligned while virtual rows finish measuring.
    anchor.current = { messageId: item.id, offset: 24 }; sync();
  };
  // Activity rows start open so each step's card shows as it happens; a click folds one away.
  const copy = (id: string, content: string) => { void clipboardWrite(shownMessageText(content)).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }); };
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation codex-conversation dsh-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
    {hasBg && bgUrl && <div className="conversation-background">{bgType === 'video' ? <video src={bgUrl} autoPlay loop muted /> : <img src={bgUrl} alt="" />}</div>}
    <div className="claude-scroll" ref={scroll} onPointerDownCapture={e => { if (e.button === 0) pointerHeld.current = true; }} onContextMenu={conversationMenu.onContextMenu} onCopy={conversationMenu.onCopy} onWheelCapture={e => { if (e.deltaY < 0 && !e.ctrlKey) pause(); }} onTouchMoveCapture={pause} onKeyDownCapture={e => { if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) && !(e.target as HTMLElement).closest('input,textarea,select')) pause(); }} onScroll={() => {
      const node = scroll.current; if (!node?.clientHeight) return;
      if (node.scrollTop !== lastTop.current) anchor.current = null;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
      if (!resized && node.scrollTop < lastTop.current && distance > 2) {
        // Only a held pointer (text selection) moves away here; wheel, touch, keys and the
        // scrollbar pause first. Otherwise the engine restored an older position (macOS WebKit).
        if (pointerHeld.current) pinned.current = false;
        else if (pinned.current) node.scrollTop = node.scrollHeight;
      } else if (node.scrollTop > lastTop.current && distance < 2) pinned.current = true;
      lastTop.current = node.scrollTop; setScrolled(!pinned.current);
    }}>
      <div className={`claude-thread${!rows.length ? ' is-empty' : ''}`}>
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {rows.slice(virtual.start, virtual.end).map((card, i) => {
          const index = virtual.start + i, row = card.source, fold = folds.owner.get(index), folded = !!fold && !folds.isOpen(fold), foldLead = fold?.start === index;
          const run = runs.lead.has(index) ? rows.slice(index, runs.lead.get(index)! + 1) : undefined;
          const stats = (run ?? [card]).findLast(member => member.turnStats);
          return <Measured key={card.id} id={virtual.measurementKeys[index]} measure={virtual.measureRow}>
          {fold && foldLead && <TurnFoldRow fold={fold} open={!folded} onToggle={() => folds.toggle(fold)} />}
          {!(runs.follower.has(index) || folded) && <article className={`claude-row claude-row--${run ? (run.some(m => m.toolStatus === 'running') ? 'running' : 'tool') : row.role}${run ? ' claude-row--group' : ''} codex-row`} data-message-id={card.id}>
            {run ? <ToolGroup messages={run} />
            : card.role === 'reasoning' ? <ClaudeThinking message={card} expanded={!!expanded[card.id]} onToggle={open => setExpanded(old => ({ ...old, [card.id]: open }))} />
            : row.role === 'notice' ? <div className={`claude-turn-summary${row.tone === 'error' ? ' is-error' : ''}`} role="status">{row.content === 'interrupted' ? t('claude.interrupted') : row.content === 'commands-unsupported' ? t('dsh.commands_unsupported') : row.tone === 'error' && !row.content.startsWith('/') ? `${t('codex.failed')} · ${row.content}` : row.content}</div> : <>
              {row.role === 'user'
                ? <CollapsibleUserMessage sentAt={row.timestamp} text={row.content} expanded={!!expanded[row.id]} onToggle={() => setExpanded(old => ({ ...old, [row.id]: !old[row.id] }))}><MarkdownContent content={row.content} /></CollapsibleUserMessage>
                : <div><MarkdownContent content={row.content} /></div>}
              <MessageCopyButton copied={copied === row.id} onCopy={() => copy(row.id, row.content)} />
              {folds.byReply.has(index) && <ChangedFilesCard files={folds.byReply.get(index)!} />}
            </>}
            {stats?.turnStats && <TurnSummary stats={stats.turnStats} sessionKey={s.sessionId} messageId={stats.id} />}
          </article>}
        </Measured>; })}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(request => <RequestCard key={String(request.id)} sessionId={sessionId} request={request} />)}
        {(s.busy || (s.restarting && s.stopping)) && !s.requests.length && <StepWorking className="dsh-working" startedAt={s.busy ? s.startedAt : undefined}
          mark={<span className="dsh-running-whale" style={{ maskImage: `url(${DSH_RUNNING_WHALE})`, WebkitMaskImage: `url(${DSH_RUNNING_WHALE})` }} />}
          label={s.stopping ? t('codex.stopping') : t('dsh.deep_diving')} />}
        {/* A failed start must say why; Reconnect alone hides the cause. */}
        {s.error && !directoryIssue && <div className="claude-session-error" role="alert">{startErrorText(s.error, 'DeepSeek Harness', t)}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {!directoryIssue && !rows.length && <div className="claude-empty"><ToolSwarm tool="dsh" isActive={isVisible} /><WelcomeGreeting />{(creatingWorktree || resumed && !s.ready && !s.error) && <WelcomeRestoring label={creatingWorktree ? t('gambit.worktree_creating') : undefined} className="dsh-running" labelClassName="dsh-shimmer" mark={<span className="dsh-running-whale" aria-hidden="true" style={{ maskImage: `url(${DSH_RUNNING_WHALE})`, WebkitMaskImage: `url(${DSH_RUNNING_WHALE})` }} />} />}<WelcomeSessionMeta cwd={cwd} model={s.models.find(m => m.provider === s.route.provider && m.model === s.route.model)?.name ?? s.route.model} /></div>}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scroll} onJump={jumpToTurn} />}
    {scrolled && <button type="button" className="claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { anchor.current = null; pinned.current = true; lastTop.current = scroll.current?.scrollTop ?? 0; sync(); }}>
      <ScrollLatestIcon working={s.busy && !s.requests.length ? <span className="dsh-running-whale dsh-scroll-whale" aria-hidden="true" style={{ maskImage: `url(${DSH_RUNNING_WHALE})`, WebkitMaskImage: `url(${DSH_RUNNING_WHALE})` }} /> : undefined} />
    </button>}
    {s.error && !s.ready && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('dsh.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
