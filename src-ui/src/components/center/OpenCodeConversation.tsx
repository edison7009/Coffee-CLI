import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { startErrorText } from '../../lib/start-error';
import { TurnSummary } from './TurnSummary';
import { useWorktreePending } from '../../lib/worktree-pending';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { arr, obj, str, num, pretty, openCodeRows, type Json, type OpenCodeRow } from '../../lib/opencode-protocol';
import { interruptOpenCode, loadOpenCodeHistory, replyOpenCodeForm, replyOpenCodePermission, retainOpenCodeSession, useOpenCodeSession } from '../../lib/opencode-session';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeRestoring, WelcomeSessionMeta } from './WelcomeGreeting';
import { OpenCodeWelcomeLogo } from './OpenCodeWelcomeLogo';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem, Chevron } from './ConversationControls';
import './ConversationView.css';
import './ClaudeConversation.css';
import './CodexConversation.css';
import './OpenCodeConversation.css';
import { ScrollLatestIcon } from './ScrollLatestIcon';

function Measured({ id, measure, children }: { id: string; measure: (id: string, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const node = ref.current; if (!node) return; const update = () => measure(id, node.getBoundingClientRect().height); update(); const observer = new ResizeObserver(update); observer.observe(node); return () => observer.disconnect(); }, [id, measure]);
  return <div ref={ref}>{children}</div>;
}
function title(row: OpenCodeRow): string {
  if (row.role === 'reasoning') return row.content.split('\n').find(line => line.trim())?.trim() ?? '';
  return [row.toolName, row.title].filter(Boolean).join(' · ');
}
function PermissionCard({ sessionId, request }: { sessionId: string; request: Json }) {
  const t = useT(), [pending, setPending] = useState(false), [error, setError] = useState('');
  const reply = async (decision: 'once' | 'always' | 'reject') => {
    if (pending) return; setPending(true); setError('');
    try { await replyOpenCodePermission(sessionId, str(request.id), decision); } catch (error) { setError(String(error)); setPending(false); }
  };
  const resources = arr(request.resources).map(str).filter(Boolean);
  return <section className="claude-approval codex-request" aria-label={t('codex.approval')}>
    <strong>{t('codex.approval')}</strong>
    {!!request.message && <p>{str(request.message)}</p>}
    <pre className="codex-request-details">{[str(request.action), ...resources].filter(Boolean).join('\n')}</pre>
    {error && <p role="alert">{error}</p>}
    <div className="claude-approval-actions">
      <button type="button" disabled={pending} onClick={() => { void reply('reject'); }}>{t('codex.decline')}</button>
      {arr(request.save).length > 0 && <button type="button" disabled={pending} onClick={() => { void reply('always'); }}>{t('opencode.allow_always')}</button>}
      <button type="button" disabled={pending} onClick={() => { void reply('once'); }}>{t('codex.allow')}</button>
    </div>
  </section>;
}
type Answer = string | number | boolean | string[];
/** A field is active while every `when` condition holds against the answers so far. */
function active(field: Json, answers: Record<string, Answer>): boolean {
  return arr(field.when).map(obj).every(rule => {
    const value = answers[str(rule.key)];
    if (value === undefined || value === '') return false;
    const matches = Array.isArray(value) ? value.includes(String(rule.value)) : value === rule.value;
    return rule.op === 'neq' ? !matches : matches;
  });
}
function FormCard({ sessionId, form }: { sessionId: string; form: Json }) {
  const t = useT(), [pending, setPending] = useState(false), [error, setError] = useState('');
  const fields = arr(form.fields).map(obj).filter(field => field.hidden !== true);
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => Object.fromEntries(fields.filter(f => f.default !== undefined).map(f => [str(f.key), f.default as Answer])));
  const shown = fields.filter(field => active(field, answers));
  const missing = shown.some(field => field.type !== 'external' && field.type !== 'boolean' && (field.required !== false) && (answers[str(field.key)] === undefined || answers[str(field.key)] === '' || (Array.isArray(answers[str(field.key)]) && !(answers[str(field.key)] as string[]).length)));
  const set = (key: string, value: Answer) => setAnswers(old => ({ ...old, [key]: value }));
  const submit = async (cancel = false) => {
    if (pending || (!cancel && missing)) return; setPending(true); setError('');
    const answer = Object.fromEntries(shown.filter(f => f.type !== 'external' && answers[str(f.key)] !== undefined).map(f => [str(f.key), answers[str(f.key)]]));
    try { await replyOpenCodeForm(sessionId, str(form.id), cancel ? null : answer); } catch (error) { setError(String(error)); setPending(false); }
  };
  return <section className="claude-approval codex-request" aria-label={t('codex.question')}>
    <strong>{str(form.title) && form.title !== 'Questions' ? str(form.title) : t('codex.question')}</strong>
    {shown.map(field => {
      const key = str(field.key), value = answers[key], options = arr(field.options).map(obj), label = str(field.title) || key;
      return <fieldset key={key} disabled={pending}>
        <legend>{label}</legend>
        {!!field.description && field.description !== field.title && <MarkdownContent content={str(field.description)} />}
        {field.type === 'boolean' ? <label><input type="checkbox" checked={value === true} onChange={e => set(key, e.target.checked)} /><span>{label}</span></label>
          : field.type === 'external' ? <p className="codex-request-details">{str(field.url)}</p>
          : field.type === 'number' || field.type === 'integer' ? <input className="claude-custom-answer" type="number" aria-label={label} value={typeof value === 'number' ? value : ''} onChange={e => set(key, field.type === 'integer' ? Math.trunc(Number(e.target.value)) : Number(e.target.value))} />
          : <>
            {options.map(option => {
              const multi = field.type === 'multiselect', picked = multi ? (Array.isArray(value) && value.includes(str(option.value))) : value === option.value;
              return <label key={str(option.value)}><input type={multi ? 'checkbox' : 'radio'} name={`${str(form.id)}-${key}`} checked={picked} onChange={() => set(key, multi ? (picked ? (value as string[]).filter(v => v !== option.value) : [...(Array.isArray(value) ? value : []), str(option.value)]) : str(option.value))} /><span>{str(option.label)}<small>{str(option.description)}</small></span></label>;
            })}
            {(!options.length || field.custom === true) && field.type !== 'multiselect' && <input className="claude-custom-answer" type="text" aria-label={label} placeholder={str(field.placeholder)} value={typeof value === 'string' && !options.some(o => o.value === value) ? value : ''} onChange={e => set(key, e.target.value)} onKeyDown={e => {
              if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              e.preventDefault(); if (!e.repeat) void submit();
            }} />}
          </>}
      </fieldset>;
    })}
    {error && <p role="alert">{error}</p>}
    <div className="claude-approval-actions">
      <button type="button" disabled={pending} onClick={() => { void submit(true); }}>{t('codex.decline')}</button>
      <button type="button" disabled={pending || missing} onClick={() => { void submit(); }}>{t('codex.submit')}</button>
    </div>
  </section>;
}
type Row = OpenCodeRow & { members?: OpenCodeRow[] };
export function OpenCodeConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, hasBg, bgUrl, bgType }: { sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; hasBg?: boolean; bgUrl?: string; bgType?: string }) {
  const s = useOpenCodeSession(sessionId), t = useT(), { dispatch } = useAppState();
  const creatingWorktree = useWorktreePending(sessionId, s.ready || !!s.error);
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const scroll = useRef<HTMLDivElement>(null), pinned = useRef(true), pointerHeld = useRef(false), lastTop = useRef(0);
  const conversationMenu = useConversationMenu(scroll, sessionId, isActive);
  const viewport = useRef({ width: 0, height: 0 });
  const anchor = useRef<{ firstId: string; messageId: string; offset: number; top: number; height: number; applied: boolean } | null>(null);
  const [scrolled, setScrolled] = useState(false), [expanded, setExpanded] = useState<Record<string, boolean>>({}), [copied, setCopied] = useState('');
  const initialToken = useRef(resumeToken);
  // Captured at mount like initialToken; state, not a ref, because the welcome screen renders from it.
  const [resumed] = useState(() => !!resumeToken);
  useEffect(() => retainOpenCodeSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  // OpenCode's placeholder until it names the session ("New session - <ISO time>") is not a title.
  const openCodeTitle = /^(New|Child) session - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(s.title.trim()) ? '' : s.title.trim();
  useEffect(() => { if (s.nativeId) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.nativeId }); }, [s.nativeId, sessionId, dispatch]);
  // The conversation's own title names the tab, as a terminal tab takes the tool's OSC title.
  useEffect(() => { if (openCodeTitle) dispatch({ type: 'SET_TAB_TITLE', id: sessionId, title: openCodeTitle }); }, [openCodeTitle, sessionId, dispatch]);
  const waiting = s.permissions.length + s.forms.length;
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: waiting ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [waiting, s.busy, sessionId, dispatch]);
  const messages = useMemo(() => openCodeRows(s.native), [s.native]);
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];
    for (const message of messages) {
      const activity = (message.role === 'tool' || message.role === 'reasoning') && !message.kind;
      const previous = result.at(-1);
      if (activity && previous?.members && previous.turn === message.turn) {
        previous.members.push(message); previous.partial ||= message.partial; previous.content += `\n${title(message)}`;
      } else result.push(activity ? { ...message, id: `group:${message.id}`, content: title(message), members: [message] } : message);
    }
    return result;
  }, [messages]);
  const virtual = useConversationVirtualizer(rows, scroll);
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => rows.flatMap((row, messageIndex) => row.role === 'user' ? [{
    id: row.id, sourceMessageId: row.id, content: row.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null,
  }] : []), [rows, virtual.offsets]);
  const firstId = rows[0]?.id ?? '';
  const sync = useCallback(() => {
    const node = scroll.current; if (!node || !isVisible || !node.clientHeight) return;
    const resized = viewport.current.width !== node.clientWidth || viewport.current.height !== node.clientHeight;
    if (pointerHeld.current && !resized && node.scrollTop < lastTop.current && node.scrollHeight - node.scrollTop - node.clientHeight > 2) pinned.current = false;
    viewport.current = { width: node.clientWidth, height: node.clientHeight };
    const saved = anchor.current;
    if (saved?.applied) {
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
  useLayoutEffect(() => {
    const node = scroll.current, saved = anchor.current;
    if (!node || !isVisible || !node.clientHeight) return;
    if (saved && !saved.applied && firstId !== saved.firstId) { node.scrollTop = saved.top + node.scrollHeight - saved.height; saved.applied = true; }
    sync();
  }, [rows, s.permissions, s.forms, firstId, virtual.total, virtual.start, virtual.end, isVisible, sync]);
  useEffect(() => { const node = scroll.current; if (!node) return; const observer = new ResizeObserver(sync); observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild); return () => observer.disconnect(); }, [sync]);
  useEffect(() => {
    if (!isActive) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented && s.busy && !(e.target as HTMLElement)?.closest('[role="dialog"]')) { e.preventDefault(); void interruptOpenCode(sessionId); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [isActive, s.busy, sessionId]);
  const pause = () => { anchor.current = null; pinned.current = false; setScrolled(true); };
  const jumpToTurn = (item: ConversationNavigationItem) => {
    pause();
    virtual.scrollToIndex(item.messageIndex, 'instant');
    const node = scroll.current;
    if (node) { anchor.current = { firstId, messageId: item.id, offset: 24, top: node.scrollTop, height: node.scrollHeight, applied: true }; sync(); }
  };
  const loadEarlier = () => {
    const node = scroll.current;
    pause();
    if (node && rows.length) {
      const top = node.getBoundingClientRect().top;
      const target = [...node.querySelectorAll<HTMLElement>('[data-message-id]')].find(el => el.getBoundingClientRect().bottom > top);
      if (target) anchor.current = { firstId, messageId: target.dataset.messageId!, offset: target.getBoundingClientRect().top - top, top: node.scrollTop, height: node.scrollHeight, applied: false };
    }
    void loadOpenCodeHistory(sessionId);
  };
  const toggle = (id: string) => setExpanded(old => ({ ...old, [id]: !old[id] }));
  const copy = (id: string, content: string) => { void clipboardWrite(content).then(() => { setCopied(id); setTimeout(() => setCopied(''), 1500); }); };
  const tool = (message: OpenCodeRow) => {
    const body = message.role === 'reasoning' ? message.content : [message.input !== undefined && Object.keys(obj(message.input)).length ? pretty(message.input) : typeof message.input === 'string' ? message.input : '', message.content].filter(Boolean).join('\n\n');
    return <div className={`codex-tool is-${message.toolStatus ?? 'reasoning'}`} key={message.id}>
      <div className="codex-tool-heading"><button type="button" className="claude-tool-heading" aria-expanded={!!expanded[message.id]} onClick={() => toggle(message.id)}><span className="codex-chevron" aria-hidden="true"><Chevron open={expanded[message.id]} /></span><strong>{message.role === 'reasoning' ? t('conversation.reasoning') : message.toolName}</strong><span>{message.role === 'reasoning' ? title(message) : message.title}</span></button><MessageCopyButton copied={copied === message.id} onCopy={() => copy(message.id, [title(message), body].join('\n'))} /></div>
      {expanded[message.id] && (message.role === 'reasoning' ? <MarkdownContent content={message.content} /> : <pre className="codex-tool-body">{body}</pre>)}
    </div>;
  };
  const turnStatus = (row: Row) => {
    if (row.kind === 'idle') {
      const label = t(row.outcome === 'interrupted' ? 'claude.interrupted' : row.outcome === 'failed' ? 'codex.failed' : 'codex.completed');
      return row.turnStats ? <TurnSummary stats={row.turnStats} sessionKey={s.nativeId} messageId={row.id} prefix={label} />
        : <div className="claude-turn-summary" role="status">{label}{num(row.durationMs) >= 1000 && ` · ${Math.round(num(row.durationMs) / 1000)}s`}</div>;
    }
    if (row.outcome?.startsWith('compaction:')) return <div className="claude-turn-summary" role="status">{t(row.outcome === 'compaction:running' ? 'opencode.compacting' : row.outcome === 'compaction:failed' ? 'opencode.compaction_failed' : 'opencode.compacted')}</div>;
    return <div className="claude-session-error" role="alert">{row.content}</div>;
  };
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation codex-conversation opencode-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
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
        {s.cursor && <button className="claude-expand" disabled={s.loadingHistory} onClick={loadEarlier}>{t(s.loadingHistory ? 'diff.loading' : 'claude.history_earlier')}</button>}
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {rows.slice(virtual.start, virtual.end).map((row, i) => <Measured key={row.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          <article className={`claude-row claude-row--${row.kind === 'idle' ? (row.outcome === 'succeeded' ? 'completed' : row.outcome) : row.partial && row.role !== 'user' ? 'running' : row.role} codex-row`} data-message-id={row.id}>
            {row.members ? <>
              <button type="button" className="codex-group-heading" aria-expanded={!!expanded[row.id]} onClick={() => toggle(row.id)}><span aria-hidden="true"><Chevron open={expanded[row.id]} /></span><span>{t('codex.activity', { count: row.members.length })}</span>{row.partial && <span className="codex-spinner" aria-hidden="true" />}<small>{title(row.members.at(-1)!)}</small></button>
              {expanded[row.id] && <div className="codex-activity-list">{row.members.map(tool)}</div>}
            </> : row.kind ? turnStatus(row) : <>
              {row.role === 'user'
                ? <CollapsibleUserMessage sentAt={row.timestamp} expanded={!!expanded[row.id]} onToggle={() => toggle(row.id)}><MarkdownContent content={row.content} />{!!row.files?.length && <div className="opencode-files">{row.files.map(file => <span key={file}>{file.split(/[\\/]/).pop()}</span>)}</div>}</CollapsibleUserMessage>
                : <div><MarkdownContent content={row.content} /></div>}
              <MessageCopyButton copied={copied === row.id} onCopy={() => copy(row.id, row.content)} />
            </>}
          </article>
        </Measured>)}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.permissions.map(request => <PermissionCard key={str(request.id)} sessionId={sessionId} request={request} />)}
        {s.forms.map(form => <FormCard key={str(form.id)} sessionId={sessionId} form={form} />)}
        {s.ready && s.busy && <div className="codex-working" role="status"><span className="codex-spinner" aria-hidden="true" />{t(s.interrupting ? 'codex.stopping' : waiting ? 'codex.waiting' : 'claude.status.working')}…</div>}
        {s.error && !directoryIssue && <div className="claude-session-error" role="alert">{startErrorText(s.error, 'OpenCode', t)}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {!directoryIssue && !rows.length && <div className="claude-empty"><OpenCodeWelcomeLogo isActive={isVisible} /><WelcomeGreeting />{(creatingWorktree || resumed && !s.ready && !s.error) && <WelcomeRestoring label={creatingWorktree ? t('gambit.worktree_creating') : undefined} className="codex-working" mark={<span className="codex-spinner" aria-hidden="true" />} />}<WelcomeSessionMeta cwd={cwd} model={s.models.find(m => m.id === s.model?.id && m.providerID === s.model?.providerID)?.name ?? s.model?.id ?? ''} /></div>}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scroll} onJump={jumpToTurn} />}
    {scrolled && <button type="button" className="claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { anchor.current = null; pinned.current = true; lastTop.current = scroll.current?.scrollTop ?? 0; sync(); }}>
      <ScrollLatestIcon working={s.ready && s.busy && !waiting ? <span className="codex-spinner" aria-hidden="true" /> : undefined} />
    </button>}
    {s.error && !s.ready && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('opencode.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
