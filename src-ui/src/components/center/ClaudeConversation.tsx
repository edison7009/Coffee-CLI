import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { shownMessageText } from '../../lib/worker-prompt';
import { toolRuns, toolRunStatus } from '../../lib/tool-runs';
import { useTurnFolds } from '../../lib/use-turn-work';
import { ChangedFilesCard, TurnFoldRow } from './TurnWork';
import { startErrorText } from '../../lib/start-error';
import { useWorktreePending } from '../../lib/worktree-pending';
import { useAppLanguage, useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { formatElapsed } from '../../lib/claude-i18n';
import { TurnSummary } from './TurnSummary';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { continueClaudeInNewConversation, controlClaude, loadClaudeHistory, respondClaude, retainClaudeSession, settleClaudeColdReturn, useClaudeSession } from '../../lib/claude-session';
import { object, list, text, resultText, type ClaudeMessage, type ClaudeRequest } from '../../lib/claude-protocol';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeRestoring, WelcomeSessionMeta } from './WelcomeGreeting';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem, ColdReturnCard } from './ConversationControls';
import CLAUDE_WORKING_MARK from '../../icons-inline/claude-working-mark.webp';
import { turnTitle } from '../../lib/turn-title';
import './ConversationView.css';
import './Gambit.css';
import './ClaudeConversation.css';
import { pasteImageIntoAnswer } from '../../lib/answer-image-paste';
import { ScrollLatestIcon } from './ScrollLatestIcon';
import { ClaudeThinking, ClaudeTool, Code, ToolGroup } from './ToolSteps';
import { ToolSwarm } from './ToolSwarm';

function useClock(active: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(timer); }, [active, ms]);
  return now;
}
const elapsed = formatElapsed;

/** Text that changes the way Claude Desktop's status line does: the old face rises 3px and
 *  fades while the new one rises in from 3px below, and the width follows, over 180ms. */
function MorphText({ text, faceClassName }: { text: string; faceClassName?: string }) {
  const [faces, setFaces] = useState<{ shown: string; leaving?: string; key: number }>({ shown: text, key: 0 });
  if (faces.shown !== text) setFaces(prev => ({ shown: text, leaving: prev.shown, key: prev.key + 1 }));
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    // Measure the new face at its natural width, then move from the old width to it.
    const from = node.style.width;
    node.style.width = 'auto';
    const to = `${node.getBoundingClientRect().width}px`;
    if (!from || from === to) { node.style.width = to; return; }
    node.style.width = from;
    void node.offsetWidth;
    node.style.width = to;
  }, [faces.shown]);
  return <span ref={box} className="claude-morph">
    {faces.leaving !== undefined && <span key={`out-${faces.key}`} className="claude-morph-face is-leaving" aria-hidden="true" onAnimationEnd={() => setFaces(prev => prev.key === faces.key ? { ...prev, leaving: undefined } : prev)}><span className={faceClassName}>{faces.leaving}</span></span>}
    <span key={`in-${faces.key}`} className={`claude-morph-face${faces.key ? ' is-entering' : ''}`}><span className={faceClassName}>{faces.shown}</span></span>
  </span>;
}

/** The turn's one timer, under its steps: the mark, a word or Claude's title for the step, and the time so far. */
function Working({ status, startedAt, title }: { status: string; startedAt?: number; title?: string }) {
  const t = useT();
  const now = useClock(true);
  const words = [t('claude.status.thinking'), t('claude.status.brewing'), t('claude.status.considering'), t('claude.status.working'), t('claude.status.crafting'), t('claude.status.pondering')];
  const age = now - (startedAt ?? now);
  const wordIndex = age < 2000 ? 0 : age < 5000 ? 1 : 2 + Math.floor((age - 5000) / 5000);
  // Claude Code's own description of the current step titles the turn; the rotating words fill in until it gives one.
  const word = status === 'stopping' ? t('codex.stopping') : status === 'compacting' ? t('claude.status.compacting') : status === 'starting' ? t('claude.status.connecting') : title ?? (status === 'tool' ? t('claude.status.working') : words[wordIndex % words.length]);
  return <div className="claude-working" role="status"><span className="claude-working-mark" aria-hidden="true"><img src={CLAUDE_WORKING_MARK} alt="" /></span><MorphText faceClassName="claude-working-word" text={`${word}…`} />
    {startedAt && <span className="claude-elapsed">{elapsed(age, t)}</span>}</div>;
}

function Question({ id, pending }: { id: string; pending: ClaudeRequest }) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const input = object(pending.request.input), tool = text(pending.request.tool_name), questions = list(input.questions).map(object);
  const respond = async (response: Record<string, unknown>) => {
    if (sending) return;
    setSending(true); setError('');
    try { await respondClaude(id, pending.id, response); } catch (e) { setError(String(e)); setSending(false); }
  };
  const question = tool === 'AskUserQuestion';
  const incomplete = question && questions.some(q => !(answers[text(q.question)]?.length || custom[text(q.question)]?.trim()));
  const approve = () => {
    if (sending || incomplete) return;
    void respond({ behavior: 'allow', updatedInput: question ? { ...input, answers: Object.fromEntries(questions.map(q => { const key = text(q.question); return [key, [...(answers[key] ?? []), ...(custom[key]?.trim() ? [custom[key].trim()] : [])].join(', ')]; })) } : input });
  };
  return <section className="claude-approval" aria-label={t(question ? 'interaction.question' : 'interaction.permission')}>
    <strong>{question ? t('claude.question') : tool === 'ExitPlanMode' ? t('claude.plan_ready') : t('claude.allow_tool', { tool: tool || text(pending.request.subtype) })}</strong>
    {question ? questions.map((q, i) => {
      const key = text(q.question), values = answers[key] ?? [];
      return <fieldset key={i}><legend>{key}</legend>{list(q.options).map((v, j) => { const option = object(v), label = text(option.label); return <label key={j}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={key} checked={values.includes(label)} onChange={() => setAnswers(a => ({ ...a, [key]: q.multiSelect ? values.includes(label) ? values.filter(v => v !== label) : [...values, label] : [label] }))} /><span>{label}{!!option.description && <small>{text(option.description)}</small>}</span></label>; })}<input className="claude-custom-answer" placeholder={t('interaction.custom_placeholder')} value={custom[key] ?? ''} onChange={e => setCustom(a => ({ ...a, [key]: e.target.value }))} onPaste={e => pasteImageIntoAnswer(e, value => setCustom(a => ({ ...a, [key]: value })))} onKeyDown={e => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        e.preventDefault();
        if (!e.repeat) approve();
      }} /></fieldset>;
    }) : <Code content={text(input.command) || text(input.plan) || text(input.file_path) || resultText(input)} path={tool === 'Bash' ? 'command.sh' : 'request.md'} />}
    {error && <div role="alert" className="claude-tool-error">{error}</div>}
    <div className="claude-approval-actions"><button disabled={sending} onClick={() => void respond({ behavior: 'deny', message: 'The user declined this request. Wait for further instructions.' })}>{t('claude.reject')}</button>
      <button disabled={sending || incomplete} onClick={approve}>{t(question ? 'interaction.submit' : 'claude.allow_once')}</button></div>
  </section>;
}

function MeasuredRow({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const update = () => measure(id, node.getBoundingClientRect().height); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [id, measure]);
  return <div ref={ref} className="claude-measured-row">{children}</div>;
}

function ClaudeColdReturn({ id, idleMinutes, tokens }: { id: string; idleMinutes: number; tokens: number }) {
  const { state, dispatch } = useAppState();
  const safelyIdle = useClaudeSession(id, s => !s.busy && !s.requests.length && !s.backgroundTasks.length);
  // Both ends of a coordinator/worker link keep their session identity.
  const linkedToWorkers = state.terminals.some(tab => tab.parentId && (tab.id === id || tab.parentId === id));
  return <ColdReturnCard idleMinutes={idleMinutes} tokens={tokens} detailKey="claude.cold_return.detail"
    onNew={linkedToWorkers || !safelyIdle ? undefined : () => { const newId = crypto.randomUUID(); if (continueClaudeInNewConversation(id, newId)) dispatch({ type: 'RESTART_TERMINAL', id, newId, fresh: true }); }}
    onFull={() => { void settleClaudeColdReturn(id, 'full'); }} onNever={() => { void settleClaudeColdReturn(id, 'never'); }}
    onCancel={() => { void settleClaudeColdReturn(id, 'cancel').then(draft => dispatch({ type: 'SET_GAMBIT_DRAFT', id, draft })); }} />;
}
export function ClaudeConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, bgUrl, bgType, hasBg }: {
  sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; bgUrl?: string; bgType?: string; hasBg?: boolean;
}) {
  const t = useT();
  const language = useAppLanguage();
  const { dispatch } = useAppState();
  const s = useClaudeSession(sessionId);
  const initialToken = useRef(resumeToken);
  // Captured at mount like initialToken; state, not a ref, because the welcome screen renders from it.
  const [resumed] = useState(() => !!resumeToken);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationMenu = useConversationMenu(scrollRef, sessionId, isActive);
  const pinned = useRef(true);
  const pointerHeld = useRef(false);
  const scrollbarHeld = useRef(false);
  const lastScrollTop = useRef(0);
  const prependAnchor = useRef<{ firstId: string; messageId: string; offset: number; top: number; height: number; applied: boolean } | null>(null);
  const [copied, setCopied] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState(false);
  const [thinkingExpansion, setThinkingExpansion] = useState<Record<string, boolean>>({});
  const virtual = useConversationVirtualizer(s.messages, scrollRef);
  // Adjacent tool calls fold into one group row; the rest of the run renders empty (lib/tool-runs.ts).
  // Clear shows every call as a step card, even alone; Code folds runs of two or more and keeps a single
  // call's full card (its diff or command output open).
  const clear = useAppState().state?.layoutMode === 'work';
  const runs = useMemo(() => toolRuns(s.messages, clear ? 1 : 2), [s.messages, clear]);
  const folds = useTurnFolds(s.messages, s.busy);
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => s.messages.flatMap((message, messageIndex) => message.role === 'user' ? [{ id: message.id, sourceMessageId: message.id, content: message.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null }] : []), [s.messages, virtual.offsets]);
  useEffect(() => retainClaudeSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: s.requests.length ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [sessionId, s.busy, s.requests.length, dispatch]);
  useEffect(() => { if (s.nativeId) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.nativeId }); }, [sessionId, s.nativeId, dispatch]);
  useEffect(() => { if (s.title) dispatch({ type: 'SET_TAB_TITLE', id: sessionId, title: s.title }); }, [sessionId, s.title, dispatch]);
  const syncScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !isVisible || !scroll.clientHeight) return;
    if (pointerHeld.current && scroll.scrollTop < lastScrollTop.current && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 2) pinned.current = false;
    const anchor = prependAnchor.current;
    if (anchor?.applied) {
      // Measurements above the viewport can settle over several virtual-list frames.
      const node = [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.dataset.messageId === anchor.messageId);
      if (node) scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
    } else if (pinned.current) {
      // A smooth scroll's target becomes stale while a reply continues growing.
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'instant' });
    }
    lastScrollTop.current = scroll.scrollTop;
  }, [isVisible]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current, anchor = prependAnchor.current;
    if (!scroll || !isVisible || !scroll.clientHeight) return;
    if (anchor && !anchor.applied && s.messages[0]?.id !== anchor.firstId) {
      scroll.scrollTop = anchor.top + scroll.scrollHeight - anchor.height;
      anchor.applied = true;
    }
    syncScroll();
  }, [s.messages, s.requests, virtual.total, virtual.start, virtual.end, isVisible, syncScroll]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const observer = new ResizeObserver(syncScroll);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  }, [syncScroll]);
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => { if (e.ctrlKey && e.key.toLowerCase() === 'o' && !e.isComposing) { e.preventDefault(); setExpandedThinking(v => !v); setThinkingExpansion({}); } if (e.key === 'Escape' && s.busy && !s.requests.length) void controlClaude(sessionId, { subtype: 'interrupt' }).catch(() => {}); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [isActive, s.busy, s.requests.length, sessionId]);
  const pauseFollow = useCallback(() => { prependAnchor.current = null; pinned.current = false; setScrolled(true); }, []);
  useEffect(() => { const scroll = scrollRef.current; if (!scroll) return; return bindAutoHideScrollbar(scroll, { wide: true, onDragStart: () => { scrollbarHeld.current = true; pointerHeld.current = true; pauseFollow(); } }); }, [pauseFollow]);
  useEffect(() => {
    const release = () => {
      if (!pointerHeld.current) return;
      pointerHeld.current = false;
      const draggedScrollbar = scrollbarHeld.current;
      scrollbarHeld.current = false;
      // Re-follow only once the drag ends: following mid-drag fights the slider and jitters.
      const scroll = scrollRef.current;
      if (draggedScrollbar && scroll?.clientHeight && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2) { pinned.current = true; setScrolled(false); }
    };
    document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
    return () => { document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release); };
  }, []);
  const jumpToTurn = (item: ConversationNavigationItem) => {
    pauseFollow();
    virtual.scrollToIndex(item.messageIndex, 'instant');
    const scroll = scrollRef.current;
    if (scroll) {
      // Keep the selected turn aligned while virtual rows finish measuring.
      prependAnchor.current = { firstId: s.messages[0].id, messageId: item.id, offset: 24, top: scroll.scrollTop, height: scroll.scrollHeight, applied: true };
      syncScroll();
    }
  };
  const onScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !scroll.clientHeight) return;
    if (scroll.scrollTop !== lastScrollTop.current) prependAnchor.current = null;
    const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    if (scroll.scrollTop < lastScrollTop.current && distance >= 2) {
      // Wheel, touch, keys and the scrollbar pause follow before they move; a held
      // pointer is a text selection. Anything else is the engine restoring an older
      // position (macOS WebKit does this after programmatic jumps), so stay at the end.
      if (pointerHeld.current) pinned.current = false;
      else if (pinned.current) scroll.scrollTop = scroll.scrollHeight;
    } else if (scroll.scrollTop > lastScrollTop.current && distance < 2 && !pointerHeld.current) pinned.current = true;
    lastScrollTop.current = scroll.scrollTop;
    setScrolled(!pinned.current);
  }, []);
  const loadEarlier = () => {
    const scroll = scrollRef.current;
    if (scroll && s.messages.length) {
      const top = scroll.getBoundingClientRect().top;
      const node = [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > top);
      pauseFollow();
      if (node) prependAnchor.current = { firstId: s.messages[0].id, messageId: node.dataset.messageId!, offset: node.getBoundingClientRect().top - top, top: scroll.scrollTop, height: scroll.scrollHeight, applied: false };
    }
    void loadClaudeHistory(sessionId);
  };
  const copy = (message: ClaudeMessage) => { void clipboardWrite(shownMessageText(message.content)).then(() => { setCopied(message.id); setTimeout(() => setCopied(''), 1500); }); };
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const empty = !directoryIssue && !s.messages.length && !s.busy && !s.requests.length && (!s.ready || !s.error);
  const restoring = resumed && !s.ready && !s.error;
  const creatingWorktree = useWorktreePending(sessionId, s.ready || !!s.error);
  const restoringMark = <span className="claude-working-mark" aria-hidden="true"><img src={CLAUDE_WORKING_MARK} alt="" /></span>;
  const model = s.models.find(m => m.value === s.model) ?? s.models.find(m => m.resolvedModel === s.model);
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
    {hasBg && bgUrl && <div className="conversation-background">{bgType === 'video' ? <video src={bgUrl} autoPlay loop muted /> : <img src={bgUrl} alt="" />}</div>}
    <div className="claude-scroll" ref={scrollRef} onPointerDownCapture={event => { if (event.button === 0) pointerHeld.current = true; }} onContextMenu={conversationMenu.onContextMenu} onCopy={conversationMenu.onCopy} onScroll={onScroll} onWheelCapture={event => { if (event.deltaY < 0 && !event.ctrlKey) pauseFollow(); }} onTouchMoveCapture={pauseFollow} onKeyDownCapture={event => { if ((['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) && !(event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) pauseFollow(); }}>
      <div className={`claude-thread${empty ? ' is-empty' : ''}`}>
        {s.historyCursor > 0 && <button className="claude-expand" disabled={s.loadingHistory || !s.ready} onClick={loadEarlier}>{t(s.loadingHistory ? 'diff.loading' : 'claude.history_earlier')}</button>}
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {s.messages.slice(virtual.start, virtual.end).map((m, i) => { const fold = folds.owner.get(virtual.start + i), folded = !!fold && !folds.isOpen(fold), foldLead = fold?.start === virtual.start + i; return runs.follower.has(virtual.start + i) || (folded && !foldLead) ? <MeasuredRow key={m.renderKey ?? m.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>{null}</MeasuredRow> : <MeasuredRow key={m.renderKey ?? m.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          {new Date(m.timestamp).toDateString() !== new Date(s.messages[virtual.start + i - 1]?.timestamp ?? 0).toDateString() && <div className="claude-date">{new Date(m.timestamp).toLocaleDateString(language, { weekday: 'short', month: 'short', day: 'numeric' })}</div>}
          {fold && foldLead && <TurnFoldRow fold={fold} open={!folded} onToggle={() => folds.toggle(fold)} />}
          {!folded && <article data-message-id={m.id} className={`claude-row claude-row--${m.role} ${runs.lead.has(virtual.start + i) ? `claude-row--group claude-row--${toolRunStatus(s.messages.slice(virtual.start + i, runs.lead.get(virtual.start + i)! + 1))}` : m.toolStatus ? `claude-row--${m.interrupted ? 'interrupted' : m.toolStatus}` : ''} ${m.parentId ? 'claude-row--nested' : ''}`}>
            {m.role === 'user' ? <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><CollapsibleUserMessage sentAt={m.timestamp} text={m.content} expanded={!!expandedMessages[m.id]} onToggle={() => setExpandedMessages(old => ({ ...old, [m.id]: !old[m.id] }))}><MarkdownContent content={m.content} /></CollapsibleUserMessage></> : m.role === 'tool' ? (runs.lead.has(virtual.start + i) ? <ToolGroup messages={s.messages.slice(virtual.start + i, runs.lead.get(virtual.start + i)! + 1)} /> : <ClaudeTool message={m} />) : m.role === 'reasoning' ? <ClaudeThinking message={m} expanded={thinkingExpansion[m.id] ?? expandedThinking} tokens={s.thinkingTokens} onToggle={open => setThinkingExpansion(previous => (previous[m.id] ?? expandedThinking) === open ? previous : { ...previous, [m.id]: open })} /> : <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><MarkdownContent content={m.content} /></>}
            {(m.role === 'user' || m.role === 'assistant') && !m.partial && <MessageCopyButton copied={copied === m.id} onCopy={() => copy(m)} />}
            {folds.byReply.has(virtual.start + i) && <ChangedFilesCard files={folds.byReply.get(virtual.start + i)!} />}
            {m.turnStats && !(s.busy && virtual.start + i === s.messages.length - 1) && <TurnSummary stats={m.turnStats} sessionKey={s.nativeId} messageId={m.id} />}
          </article>}
        </MeasuredRow>; })}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(p => <Question key={p.id} id={sessionId} pending={p} />)}
        {s.coldReturn && <ClaudeColdReturn id={sessionId} idleMinutes={s.coldReturn.idleMinutes} tokens={s.coldReturn.tokens} />}
        {restoring && s.messages.length > 0 && <div className="claude-working" role="status">{restoringMark}<span className="claude-working-word">{t('conversation.restoring')}</span></div>}
        {s.ready && s.busy && !s.requests.length && <Working status={s.interruptRequested ? 'stopping' : s.status} startedAt={s.startedAt}
          title={turnTitle(s.messages, s.startedAt)} />}
        {s.interrupted && !s.busy && !s.error && <div className="claude-interrupted" role="status">{t('claude.interrupted')}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {s.error && (s.ready || !directoryIssue || s.errorKey === 'claude.error.settings_readback' || s.errorKey === 'claude.error.restart') && <div className="claude-session-error" role="alert">{s.errorKey ? t(s.errorKey, { detail: s.error }) : startErrorText(s.error, 'Claude Code', t)}</div>}
        {empty && <div className="claude-empty">
          <ToolSwarm tool="claude" isActive={isVisible} />
          <WelcomeGreeting />
          {(creatingWorktree || restoring) && <WelcomeRestoring labelClassName="claude-working-word" mark={restoringMark} label={creatingWorktree ? t('gambit.worktree_creating') : undefined} />}
          <WelcomeSessionMeta cwd={cwd} model={model?.resolvedModel || s.model} />
        </div>}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scrollRef} onJump={jumpToTurn} />}
    {scrolled && <button className="claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { prependAnchor.current = null; pinned.current = true; syncScroll(); setScrolled(false); }}>
      <ScrollLatestIcon working={s.ready && s.busy && !s.requests.length ? <span className="claude-working-mark" aria-hidden="true"><img src={CLAUDE_WORKING_MARK} alt="" /></span> : undefined} />
    </button>}
    {s.error && !s.ready && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" title={directoryError || s.error} onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('claude.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
