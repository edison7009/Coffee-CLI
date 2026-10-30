import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { diffLines } from 'diff';
import { useAppLanguage, useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import type { ClaudeTranslate } from '../../lib/claude-i18n';
import { orchestrationSearchLabel, orchestrationToolLabel } from '../../lib/orchestration-label';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { tokenizeFile, getShikiTheme, type LineTokens } from '../../lib/shiki';
import { useDataAttr } from '../../lib/use-data-attr';
import { controlClaude, loadClaudeHistory, respondClaude, retainClaudeSession, useClaudeSession } from '../../lib/claude-session';
import { object, list, text, number, resultText, type ClaudeMessage, type ClaudeRequest } from '../../lib/claude-protocol';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeSessionMeta } from './WelcomeGreeting';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { ConversationNavigation, MessageCopyButton, type ConversationNavigationItem } from './ConversationControls';
import { commands } from '../../tauri';
import CLAWD_SVG from '../../icons-inline/clawd.svg?raw';
import CLAUDE_WORKING_MARK from '../../icons-inline/claude-working-mark.webp';
import CLAUDE_WELCOME from '../../icons-inline/claude-welcome.webm';
import CLAUDE_WAVING from '../../icons-inline/claude-waving.gif';
import CLAUDE_JUMPING from '../../icons-inline/claude-jumping.gif';
import CLAUDE_WALKING from '../../icons-inline/claude-walking.gif';
import CLAUDE_LURKING from '../../icons-inline/claude-lurking.gif';
import CLAUDE_RACING from '../../icons-inline/claude-racing.gif';
import CLAUDE_CLOUD from '../../icons-inline/claude-cloud.gif';
import './ConversationView.css';
import './Gambit.css';
import './ClaudeConversation.css';

function useClock(active: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(timer); }, [active, ms]);
  return now;
}
function count(value: number) { return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)); }
function elapsed(ms: number, t: ClaudeTranslate) { const seconds = Math.max(0, Math.round(ms / 1000)); return seconds >= 60 ? t('claude.time.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 }) : t('claude.time.seconds', { seconds }); }

const CLAUDE_WELCOME_ICONS = [
  { id: 'laptop', src: CLAUDE_WELCOME },
  { id: 'waving', src: CLAUDE_WAVING },
  { id: 'jumping', src: CLAUDE_JUMPING },
  { id: 'walking', src: CLAUDE_WALKING },
  { id: 'lurking', src: CLAUDE_LURKING },
  { id: 'racing', src: CLAUDE_RACING },
  { id: 'cloud', src: CLAUDE_CLOUD },
];

function ClaudeWelcomeIcon({ isActive }: { isActive: boolean }) {
  const [icon] = useState(() => CLAUDE_WELCOME_ICONS[Math.floor(Math.random() * CLAUDE_WELCOME_ICONS.length)]);
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [motionAllowed, setMotionAllowed] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches && !document.hidden);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotionAllowed(!motion.matches && !document.hidden);
    motion.addEventListener('change', update); document.addEventListener('visibilitychange', update);
    return () => { motion.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!isActive || !motionAllowed) video.pause(); else void video.play().catch(() => {});
    return () => video.pause();
  }, [isActive, motionAllowed, failed]);
  return <span className={`claude-empty-icon is-${icon.id}${ready && !failed && isActive && motionAllowed ? ' is-animated' : ''}`} aria-hidden="true" data-welcome-icon={icon.id}>
    <span className="claude-empty-still" dangerouslySetInnerHTML={{ __html: CLAWD_SVG }} />
    {!failed && (icon.id === 'laptop'
      ? <video ref={ref} src={icon.src} autoPlay muted loop playsInline onLoadedData={() => setReady(true)} onError={() => setFailed(true)} />
      : isActive && motionAllowed && <img src={icon.src} alt="" onLoad={() => setReady(true)} onError={() => setFailed(true)} />)}
  </span>;
}

function ThinkingTokens({ value }: { value?: number }) {
  const t = useT();
  const [display, setDisplay] = useState<number | undefined>(value);
  const current = useRef(display);
  const previousAt = useRef(0);
  useEffect(() => {
    const now = Date.now(), duration = previousAt.current ? Math.min(3000, Math.max(300, now - previousAt.current)) : 1200; previousAt.current = now;
    if (value === undefined) { current.current = undefined; return; }
    const from = Math.min(current.current ?? 0, value);
    const timer = setInterval(() => { const fraction = Math.min(1, (Date.now() - now) / duration); current.current = Math.floor(from + (value - from) * fraction); setDisplay(current.current); if (fraction === 1) clearInterval(timer); }, 100);
    return () => clearInterval(timer);
  }, [value]);
  return value === undefined || display === undefined ? null : <span className="claude-thinking-tokens"> · {t('claude.tokens', { count: count(display) })}</span>;
}

function ClaudeThinking({ message, expanded, onToggle, tokens }: { message: ClaudeMessage; expanded: boolean; onToggle: (open: boolean) => void; tokens?: number }) {
  const t = useT();
  const label = <>{message.partial ? t('conversation.thinking') : message.startedAt && message.endedAt ? t('claude.thought_for', { duration: elapsed(message.endedAt - message.startedAt, t) }) : t('claude.status.thinking')}{message.partial && <ThinkingTokens value={tokens} />}</>;
  if (!message.content.trim()) return <div className="claude-reasoning">{label}</div>;
  return <details className="claude-reasoning" open={expanded} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary>{label}</summary><MarkdownContent content={message.content} />
  </details>;
}

function Working({ status, startedAt }: { status: string; startedAt?: number }) {
  const t = useT();
  const now = useClock(true);
  const words = [t('claude.status.thinking'), t('claude.status.brewing'), t('claude.status.considering'), t('claude.status.working'), t('claude.status.crafting'), t('claude.status.pondering')];
  const age = now - (startedAt ?? now);
  const wordIndex = age < 2000 ? 0 : age < 5000 ? 1 : 2 + Math.floor((age - 5000) / 5000);
  const word = status === 'stopping' ? t('codex.stopping') : status === 'compacting' ? t('claude.status.compacting') : status === 'tool' ? t('claude.status.working') : status === 'starting' ? t('claude.status.connecting') : words[wordIndex % words.length];
  return <div className="claude-working" role="status"><span className="claude-working-mark" aria-hidden="true"><img src={CLAUDE_WORKING_MARK} alt="" /></span><span className="claude-working-word">{word}…</span>{startedAt && <span className="claude-elapsed">{elapsed(age, t)}</span>}</div>;
}

function Code({ content, path, className = '' }: { content: string; path: string; className?: string }) {
  const mode = useDataAttr('data-mode');
  const [tokens, setTokens] = useState<LineTokens[] | null>(null);
  useEffect(() => {
    let active = true;
    if (content.length <= 120000) void tokenizeFile(content, path, getShikiTheme(mode)).then(t => { if (active) setTokens(t); });
    return () => { active = false; };
  }, [content, path, mode]);
  return <pre className={`claude-code ${className}`}><code>{tokens ? tokens.map((line, i) => <div className="claude-code-line" key={i}>{line.map((token, j) => <span key={j} style={{ color: token.color }}>{token.content}</span>)}</div>) : content}</code></pre>;
}

function ToolActions({ content, expanded, onToggle }: { content: string; expanded: boolean; onToggle?: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return <div className="claude-tool-actions">
    <MessageCopyButton copied={copied} onCopy={() => { void clipboardWrite(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} />
    {onToggle && <button type="button" className="claude-tool-resize" aria-label={t(expanded ? 'claude.collapse' : 'claude.expand')} aria-expanded={expanded} onClick={onToggle}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={expanded ? 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7' : 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7'} />
      </svg>
    </button>}
  </div>;
}

function ToolContent({ content, path, plain = false, previewHeight = 95 }: { content: string; path: string; plain?: boolean; previewHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setOverflow(node.scrollHeight > previewHeight + 1);
    update();
    const observer = new ResizeObserver(update); observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [content, previewHeight]);
  return <div className="claude-tool-content">
    <ToolActions content={content} expanded={expanded} onToggle={overflow ? () => setExpanded(value => !value) : undefined} />
    <div className="claude-tool-content-scroll" ref={ref} style={{ maxHeight: expanded ? 600 : previewHeight }}>
      {plain ? <pre className="claude-code">{content}</pre> : <Code content={content} path={path} />}
    </div>
  </div>;
}

function EditDiff({ before, after, path }: { before: string; after: string; path: string }) {
  const [expanded, setExpanded] = useState(false);
  const mode = useDataAttr('data-mode');
  const [tokens, setTokens] = useState<[LineTokens[] | null, LineTokens[] | null]>([null, null]);
  const rows = useMemo(() => {
    const changes = diffLines(before, after, { timeout: 200 });
    if (!changes) return [];
    const out: Array<{ old?: string; next?: string; oldLine?: number; nextLine?: number; changed: boolean }> = [];
    let oldLine = 1, nextLine = 1;
    const lines = (s: string) => s.replace(/\n$/, '').split('\n');
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i];
      if (change.removed) {
        const left = lines(change.value), right = changes[i + 1]?.added ? lines(changes[++i].value) : [];
        for (let n = 0; n < Math.max(left.length, right.length); n++) out.push({ old: left[n], next: right[n], oldLine: n < left.length ? oldLine++ : undefined, nextLine: n < right.length ? nextLine++ : undefined, changed: true });
      } else for (const line of lines(change.value)) out.push(change.added ? { next: line, nextLine: nextLine++, changed: true } : { old: line, next: line, oldLine: oldLine++, nextLine: nextLine++, changed: false });
    }
    return out;
  }, [before, after]);
  useEffect(() => {
    let active = true;
    if (before.length + after.length <= 120000) void Promise.all([tokenizeFile(before, path, getShikiTheme(mode)), tokenizeFile(after, path, getShikiTheme(mode))]).then(t => { if (active) setTokens(t); });
    return () => { active = false; };
  }, [before, after, path, mode]);
  const render = (value: string | undefined, index: number | undefined, side: 0 | 1) => index && tokens[side]?.[index - 1] ? tokens[side]![index - 1].map((t, i) => <span key={i} style={{ color: t.color }}>{t.content}</span>) : value;
  return <div className={`claude-diff ${expanded ? 'is-expanded' : ''}`}>
    <ToolActions content={after} expanded={expanded} onToggle={rows.length > 6 || before.length + after.length > 800 ? () => setExpanded(value => !value) : undefined} />
    <div className="claude-diff-scroll">{rows.length ? rows.map((r, i) => <div className="claude-diff-row" key={i}>
      <div className={`${r.changed ? r.old !== undefined ? 'is-removed' : 'is-gap' : ''}`}><span className="claude-line-number">{r.oldLine}</span><code>{render(r.old, r.oldLine, 0)}</code></div>
      <div className={`${r.changed ? r.next !== undefined ? 'is-added' : 'is-gap' : ''}`}><span className="claude-line-number">{r.nextLine}</span><code>{render(r.next, r.nextLine, 1)}</code></div>
    </div>) : <Code content={after} path={path} />}</div>
  </div>;
}

export const ClaudeTool = memo(function ClaudeTool({ message }: { message: ClaudeMessage }) {
  const t = useT();
  const [bodyOpen, setBodyOpen] = useState(() => ['Bash', 'Edit', 'Write'].includes(message.toolName ?? ''));
  const input = message.input ?? {}, name = message.toolName ?? t('claude.tool'), path = text(input.file_path) || text(input.path);
  const before = text(input.old_string), after = text(input.new_string);
  const edit = name === 'Edit', write = name === 'Write', bash = name === 'Bash';
  const search = orchestrationSearchLabel(name, text(input.query), t);
  const description = search?.description ?? (text(input.description) || path || text(input.pattern) || text(input.query) || text(input.skill));
  const changes = edit ? diffLines(before, after, { timeout: 100 }) ?? [] : [];
  const removed = changes.filter(c => c.removed).reduce((n, c) => n + c.count, 0), added = changes.filter(c => c.added).reduce((n, c) => n + c.count, 0);
  const showBody = bodyOpen;
  const output = message.output ?? '';
  return <section className={`claude-tool claude-tool--${message.toolStatus ?? 'running'}`}>
    <div className="claude-tool-heading">
      <button onClick={() => setBodyOpen(v => !v)} aria-expanded={showBody}><strong>{search?.title ?? orchestrationToolLabel(name, t) ?? name}</strong></button>
      {path ? <button className="claude-file-path" onClick={() => void commands.showInFolder(path)}>{description}</button> : <span>{description}</span>}
      {!bash && !edit && !write && <button className="claude-chevron" aria-label={t('claude.tool_details')} onClick={() => setBodyOpen(v => !v)}>{bodyOpen ? '⌄' : '›'}</button>}
    </div>
    {edit && <div className="claude-tool-subtitle">{removed || added ? [removed ? t('claude.lines_removed', { count: removed }) : '', added ? t('claude.lines_added', { count: added }) : ''].filter(Boolean).join(' · ') : t('claude.modified')}</div>}
    {write && typeof input.content === 'string' && <div className="claude-tool-subtitle">{t('claude.lines', { count: input.content.split('\n').length })}</div>}
    {showBody && <div className="claude-tool-body">
      {edit ? <EditDiff before={before} after={after} path={path} /> : write ? message.toolStatus === 'running' && input.content === undefined ? <span className="claude-tool-pending">{t('diff.loading')}</span> : <ToolContent content={text(input.content)} path={path} /> : bash ? <div className="claude-io">
        <div className="claude-io-row"><span>{t('claude.input')}</span><ToolContent content={text(input.command)} path="command.sh" previewHeight={180} /></div>
        {message.output !== undefined && <div className={`claude-io-row ${message.toolStatus === 'failed' && !message.interrupted ? 'is-error' : ''}`}><span>{t('claude.output')}</span><ToolContent content={output || t('claude.no_output')} path="output.txt" plain previewHeight={180} /></div>}
      </div> : <><ToolContent content={JSON.stringify(input, null, 2)} path="input.json" />{message.output !== undefined && <ToolContent content={output || t('claude.no_output')} path="output.txt" plain />}</>}
      {edit || write ? message.toolStatus === 'failed' && <pre className={message.interrupted ? 'claude-interrupted' : 'claude-tool-error'}>{output}</pre> : null}
    </div>}
  </section>;
});

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
      return <fieldset key={i}><legend>{key}</legend>{list(q.options).map((v, j) => { const option = object(v), label = text(option.label); return <label key={j}><input type={q.multiSelect ? 'checkbox' : 'radio'} name={key} checked={values.includes(label)} onChange={() => setAnswers(a => ({ ...a, [key]: q.multiSelect ? values.includes(label) ? values.filter(v => v !== label) : [...values, label] : [label] }))} /><span>{label}{!!option.description && <small>{text(option.description)}</small>}</span></label>; })}<input className="claude-custom-answer" placeholder={t('interaction.custom_placeholder')} value={custom[key] ?? ''} onChange={e => setCustom(a => ({ ...a, [key]: e.target.value }))} onKeyDown={e => {
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

export function ClaudeConversation({ sessionId, cwd, resumeToken, isActive, isVisible = isActive, bgUrl, bgType, hasBg }: {
  sessionId: string; cwd: string | null; resumeToken?: string; isActive: boolean; isVisible?: boolean; bgUrl?: string; bgType?: string; hasBg?: boolean;
}) {
  const t = useT();
  const language = useAppLanguage();
  const { dispatch } = useAppState();
  const s = useClaudeSession(sessionId);
  const initialToken = useRef(resumeToken);
  const scrollRef = useRef<HTMLDivElement>(null);
  const conversationMenu = useConversationMenu(scrollRef, sessionId, isActive);
  const pinned = useRef(true);
  const lastScrollTop = useRef(0);
  const prependAnchor = useRef<{ firstId: string; messageId: string; offset: number; top: number; height: number; applied: boolean } | null>(null);
  const [copied, setCopied] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState(false);
  const [thinkingExpansion, setThinkingExpansion] = useState<Record<string, boolean>>({});
  const virtual = useConversationVirtualizer(s.messages, scrollRef);
  const navigationItems = useMemo<ConversationNavigationItem[]>(() => s.messages.flatMap((message, messageIndex) => message.role === 'user' ? [{ id: message.id, sourceMessageId: message.id, content: message.content, messageIndex, top: (virtual.offsets[messageIndex] ?? 0) + 32, cursor: null }] : []), [s.messages, virtual.offsets]);
  useEffect(() => retainClaudeSession(sessionId, cwd, initialToken.current), [sessionId, cwd]);
  useEffect(() => { dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: s.requests.length ? 'wait_input' : s.busy ? 'working' : 'idle' }); }, [sessionId, s.busy, s.requests.length, dispatch]);
  useEffect(() => { if (s.nativeId) dispatch({ type: 'SET_SESSION_TOKEN', id: sessionId, token: s.nativeId }); }, [sessionId, s.nativeId, dispatch]);
  useEffect(() => { const scroll = scrollRef.current; if (!scroll) return; return bindAutoHideScrollbar(scroll, { wide: true }); }, []);
  const syncScroll = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !isVisible || !scroll.clientHeight) return;
    if (scroll.scrollTop < lastScrollTop.current && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 2) pinned.current = false;
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
    if (scroll.scrollTop < lastScrollTop.current && distance >= 2) pinned.current = false;
    else if (scroll.scrollTop > lastScrollTop.current && distance < 2) pinned.current = true;
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
  const copy = (message: ClaudeMessage) => { void clipboardWrite(message.content).then(() => { setCopied(message.id); setTimeout(() => setCopied(''), 1500); }); };
  const used = number(s.usage.input_tokens) + number(s.usage.output_tokens) + number(s.usage.cache_read_input_tokens) + number(s.usage.cache_creation_input_tokens);
  const directoryIssue = !s.ready ? directoryFailure(s.error) : undefined;
  const directoryError = directoryFailureMessage(s.error, t);
  const empty = !directoryIssue && !s.messages.length && !s.busy && !s.requests.length && (!s.ready || !s.error);
  const model = s.models.find(m => m.value === s.model) ?? s.models.find(m => m.resolvedModel === s.model);
  const summary = !empty && !s.busy && s.endedAt && <div className="claude-turn-summary">{t('claude.worked_for', { duration: elapsed(s.endedAt - (s.startedAt ?? s.endedAt), t) })}{used > 0 && <> · {t('claude.tokens', { count: count(used) })}</>}{s.totalCost !== undefined && s.totalCost > 0 && <> · ~${s.totalCost.toFixed(4)}</>}</div>;
  return <ConversationDirectory.Provider value={cwd}><div className={`claude-conversation${hasBg && bgUrl ? ' has-background' : ''}${navigationItems.length > 1 ? ' has-navigation' : ''}`}>
    {hasBg && bgUrl && <div className="conversation-background">{bgType === 'video' ? <video src={bgUrl} autoPlay loop muted /> : <img src={bgUrl} alt="" />}</div>}
    <div className="claude-scroll" ref={scrollRef} onContextMenu={conversationMenu.onContextMenu} onCopy={conversationMenu.onCopy} onScroll={onScroll} onWheelCapture={event => { if (event.deltaY < 0 && !event.ctrlKey) pauseFollow(); }} onTouchMoveCapture={pauseFollow} onKeyDownCapture={event => { if ((['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) && !(event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) pauseFollow(); }}>
      <div className={`claude-thread${empty ? ' is-empty' : ''}`}>
        {s.historyCursor > 0 && <button className="claude-expand" disabled={s.loadingHistory} onClick={loadEarlier}>{t(s.loadingHistory ? 'diff.loading' : 'claude.history_earlier')}</button>}
        <div style={{ height: virtual.topSpacer }} aria-hidden="true" />
        {s.messages.slice(virtual.start, virtual.end).map((m, i) => <MeasuredRow key={m.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          {new Date(m.timestamp).toDateString() !== new Date(s.messages[virtual.start + i - 1]?.timestamp ?? 0).toDateString() && <div className="claude-date">{new Date(m.timestamp).toLocaleDateString(language, { weekday: 'short', month: 'short', day: 'numeric' })}</div>}
          <article data-message-id={m.id} className={`claude-row claude-row--${m.role} ${m.toolStatus ? `claude-row--${m.interrupted ? 'interrupted' : m.toolStatus}` : ''} ${m.parentId ? 'claude-row--nested' : ''}`}>
            {m.role === 'user' ? <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><div className="claude-user-content"><MarkdownContent content={m.content} /></div></> : m.role === 'tool' ? <ClaudeTool message={m} /> : m.role === 'reasoning' ? <ClaudeThinking message={m} expanded={thinkingExpansion[m.id] ?? expandedThinking} tokens={s.thinkingTokens} onToggle={open => setThinkingExpansion(previous => (previous[m.id] ?? expandedThinking) === open ? previous : { ...previous, [m.id]: open })} /> : <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><MarkdownContent content={m.content} /></>}
            {(m.role === 'user' || m.role === 'assistant') && !m.partial && <MessageCopyButton copied={copied === m.id} onCopy={() => copy(m)} />}
            {virtual.start + i === s.messages.length - 1 && summary}
          </article>
        </MeasuredRow>)}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(p => <Question key={p.id} id={sessionId} pending={p} />)}
        {s.ready && s.busy && !s.requests.length && <Working status={s.interruptRequested ? 'stopping' : s.status} startedAt={s.startedAt} />}
        {s.interrupted && !s.busy && !s.error && <div className="claude-interrupted" role="status">{t('claude.interrupted')}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {s.error && (s.ready || s.errorKey === 'claude.error.settings_readback' || s.errorKey === 'claude.error.restart') && <div className="claude-session-error" role="alert">{s.errorKey ? t(s.errorKey, { detail: s.error }) : s.error}</div>}
        {empty && <div className="claude-empty">
          <ClaudeWelcomeIcon isActive={isVisible} />
          <WelcomeGreeting />
          <WelcomeSessionMeta cwd={cwd} model={model?.resolvedModel || s.model} />
        </div>}
        {!s.messages.length && summary}
      </div>
    </div>
    {navigationItems.length > 1 && isActive && <ConversationNavigation items={navigationItems} scrollRef={scrollRef} onJump={jumpToTurn} />}
    {scrolled && <button className="gambit-send claude-scroll-bottom" aria-label={t('claude.scroll_latest')} onClick={() => { prependAnchor.current = null; pinned.current = true; syncScroll(); setScrolled(false); }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v11M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>}
    {s.error && !s.ready && (!directoryIssue || directoryIssue.status === 'unavailable') && <button type="button" className="claude-expand claude-reconnect" title={directoryError || s.error} onClick={() => dispatch({ type: 'RESTART_TERMINAL', id: sessionId, newId: crypto.randomUUID() })}>{t('claude.reconnect')}</button>}
    {conversationMenu.menu}
  </div></ConversationDirectory.Provider>;
}
