import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { shownMessageText } from '../../lib/worker-prompt';
import { toolKind, toolResult, toolRuns, toolRunStatus, toolRunSummary, toolTarget, toolVerbKey } from '../../lib/tool-runs';
import { startErrorText } from '../../lib/start-error';
import { useWorktreePending } from '../../lib/worktree-pending';
import { diffLines } from 'diff';
import { useAppLanguage, useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { formatElapsed, formatTokens } from '../../lib/claude-i18n';
import { TurnSummary } from './TurnSummary';
import { orchestrationSearchLabel, orchestrationToolLabel } from '../../lib/orchestration-label';
import { clipboardWrite } from '../../lib/clipboard';
import { directoryFailure, directoryFailureMessage } from '../../lib/session-directory';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { tokenizeFile, getShikiTheme, type LineTokens } from '../../lib/shiki';
import { useDataAttr } from '../../lib/use-data-attr';
import { continueClaudeInNewConversation, controlClaude, loadClaudeHistory, respondClaude, retainClaudeSession, settleClaudeColdReturn, useClaudeSession } from '../../lib/claude-session';
import { object, list, text, resultText, type ClaudeMessage, type ClaudeRequest } from '../../lib/claude-protocol';
import { useConversationVirtualizer } from './conversation-virtualizer';
import { MarkdownContent } from './MarkdownContent';
import { WelcomeGreeting, WelcomeRestoring, WelcomeSessionMeta } from './WelcomeGreeting';
import { ConversationDirectory } from '../../lib/conversation-links';
import { useConversationMenu } from '../../lib/use-conversation-menu';
import { CollapsibleUserMessage, ConversationNavigation, MessageCopyButton, type ConversationNavigationItem, ColdReturnCard, Chevron } from './ConversationControls';
import { commands } from '../../tauri';
import CLAWD_SVG from '../../icons-inline/clawd.svg?raw';
import CLAUDE_WORKING_MARK from '../../icons-inline/claude-working-mark.webp';
import { turnTitle } from '../../lib/turn-title';
import { IS_MACOS } from '../../lib/platform';
import CLAUDE_WELCOME from '../../icons-inline/claude-welcome.webm';
import CLAUDE_WELCOME_HEVC from '../../icons-inline/claude-welcome.mov';
// The laptop clip keeps its transparency in an alpha channel, which each engine reads from a different codec:
// Chromium from VP9 WebM, macOS WebKit from HEVC QuickTime. Claude Desktop ships the same pair. Only macOS WebKit
// takes the HEVC clip: Linux WebKitGTK cannot count on an HEVC decoder, and Chromium's identifier may read HeadlessChrome.
const CLAUDE_WELCOME_CLIP = IS_MACOS && !/(Chrome|Chromium|Edg)\//.test(navigator.userAgent) ? CLAUDE_WELCOME_HEVC : CLAUDE_WELCOME;
import CLAUDE_WAVING from '../../icons-inline/claude-waving.gif';
import CLAUDE_JUMPING from '../../icons-inline/claude-jumping.gif';
import CLAUDE_WALKING from '../../icons-inline/claude-walking.gif';
import CLAUDE_LURKING from '../../icons-inline/claude-lurking.gif';
import CLAUDE_RACING from '../../icons-inline/claude-racing.gif';
import CLAUDE_CLOUD from '../../icons-inline/claude-cloud.gif';
import './ConversationView.css';
import './Gambit.css';
import './ClaudeConversation.css';
import { pasteImageIntoAnswer } from '../../lib/answer-image-paste';
import { ScrollLatestIcon } from './ScrollLatestIcon';

function useClock(active: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(timer); }, [active, ms]);
  return now;
}
const count = formatTokens, elapsed = formatElapsed;

const CLAUDE_WELCOME_ICONS = [
  { id: 'laptop', src: CLAUDE_WELCOME_CLIP },
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

export function ClaudeThinking({ message, expanded, onToggle, tokens }: { message: ClaudeMessage; expanded: boolean; onToggle: (open: boolean) => void; tokens?: number }) {
  const t = useT();
  const label = <>{message.partial ? t('conversation.thinking') : message.startedAt && message.endedAt ? t('claude.thought_for', { duration: elapsed(message.endedAt - message.startedAt, t) }) : t('claude.status.thinking')}{message.partial && <ThinkingTokens value={tokens} />}</>;
  if (!message.content.trim()) return <div className="claude-reasoning">{label}</div>;
  return <details className="claude-reasoning" open={expanded} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary>{label}</summary><MarkdownContent content={message.content} />
  </details>;
}

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

function Working({ status, startedAt, title, tool }: { status: string; startedAt?: number; title?: string; tool?: string }) {
  const t = useT();
  const now = useClock(true);
  const words = [t('claude.status.thinking'), t('claude.status.brewing'), t('claude.status.considering'), t('claude.status.working'), t('claude.status.crafting'), t('claude.status.pondering')];
  const age = now - (startedAt ?? now);
  const wordIndex = age < 2000 ? 0 : age < 5000 ? 1 : 2 + Math.floor((age - 5000) / 5000);
  // Claude Code's own description of the current step titles the turn; the rotating words fill in until it gives one.
  const word = status === 'stopping' ? t('codex.stopping') : status === 'compacting' ? t('claude.status.compacting') : status === 'starting' ? t('claude.status.connecting') : title ?? (status === 'tool' ? t('claude.status.working') : words[wordIndex % words.length]);
  return <div className="claude-working" role="status"><span className="claude-working-mark" aria-hidden="true"><img src={CLAUDE_WORKING_MARK} alt="" /></span><MorphText faceClassName="claude-working-word" text={`${word}…`} />
    {tool && status === 'tool' && <span className="conversation-working-detail" title={tool}>{orchestrationToolLabel(tool, t) ?? tool}</span>}
    {startedAt && <span className="claude-elapsed">{elapsed(age, t)}</span>}</div>;
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

const RESIZE_ICON = (expanded: boolean) => expanded ? 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7' : 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7';

/** Copy plus, for a long block, the same expand / collapse toggle the bottom tab offers, so either end works. */
function ToolCopy({ content, expanded = false, onToggle }: { content: string; expanded?: boolean; onToggle?: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return <div className="claude-tool-actions">
    <MessageCopyButton copied={copied} onCopy={() => { void clipboardWrite(content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }} />
    {onToggle && <button type="button" className="claude-tool-resize" aria-label={t(expanded ? 'claude.collapse' : 'claude.expand')} aria-expanded={expanded} onClick={onToggle}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={RESIZE_ICON(expanded)} /></svg>
    </button>}
  </div>;
}

/** Expand / collapse along the block's own bottom edge, inside its frame: collapsed, the last lines fade into the
 *  block's fill under "展开 ⌄"; open, a "收起 ⌃" strip there, so collapsing never needs a scroll back up. */
function ExpandTab({ expanded, onToggle, inline = false }: { expanded: boolean; onToggle: () => void; inline?: boolean }) {
  const t = useT();
  return <button type="button" className={`claude-expand-tab${inline ? ' is-inline' : ''}`} aria-expanded={expanded} onClick={onToggle}>
    <span>{t(expanded ? 'claude.collapse' : 'claude.expand_tab')}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={expanded ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} /></svg>
  </button>;
}

function useOverflow(previewHeight: number, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setOverflow((node.firstElementChild?.scrollHeight ?? node.scrollHeight) > previewHeight + 1);
    update();
    const observer = new ResizeObserver(update); observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewHeight, ...deps]);
  return [ref, overflow] as const;
}

function ToolBody({ content, path, plain, previewHeight, expanded, bodyRef, onToggle }: { content: string; path: string; plain: boolean; previewHeight: number; expanded: boolean; bodyRef: RefObject<HTMLDivElement | null>; onToggle?: () => void }) {
  return <div className="claude-tool-content">
    <ToolCopy content={content} expanded={expanded} onToggle={onToggle} />
    <div className="claude-tool-content-scroll" ref={bodyRef} style={{ maxHeight: expanded ? 'none' : previewHeight }}>
      {plain ? <pre className="claude-code">{content}</pre> : <Code content={content} path={path} />}
    </div>
  </div>;
}

/** Expansion outlives the row: a row that remounts (a reload, a replaced message) must not collapse it. */
const toolExpansion = new Map<string, boolean>();
const ToolExpansionKey = createContext('');
function useToolExpanded(): [boolean, () => void] {
  const key = useContext(ToolExpansionKey);
  const [expanded, setExpanded] = useState(() => toolExpansion.get(key) ?? false);
  const toggle = useCallback(() => setExpanded(value => { if (key) { if (value) toolExpansion.delete(key); else toolExpansion.set(key, true); } return !value; }), [key]);
  return [expanded, toggle];
}

function ToolContent({ content, path, plain = false, previewHeight = 95 }: { content: string; path: string; plain?: boolean; previewHeight?: number }) {
  const [expanded, toggle] = useToolExpanded();
  const [ref, overflow] = useOverflow(previewHeight, [content]);
  return <div className={`claude-expandable${overflow ? ' has-tab' : ''}${overflow && expanded ? ' is-open' : ''}`}>
    <ToolBody content={content} path={path} plain={plain} previewHeight={previewHeight} expanded={expanded} bodyRef={ref} onToggle={overflow ? toggle : undefined} />
    {overflow && <ExpandTab expanded={expanded} onToggle={toggle} />}
  </div>;
}

/** Bash input and output share one frame, so one tab under it opens both. */
function BashIO({ command, output, failed }: { command: string; output?: string; failed: string }) {
  const t = useT();
  const [expanded, toggle] = useToolExpanded();
  const [inRef, inOverflow] = useOverflow(180, [command]);
  const [outRef, outOverflow] = useOverflow(180, [output]);
  const overflow = inOverflow || (output !== undefined && outOverflow);
  // The fade belongs over the row that is cut off. When only the command is (its output short), a fade at the
  // bottom would hide the output instead: the strip becomes the frame's own last row, over nothing.
  const bottomClipped = output !== undefined ? outOverflow : inOverflow;
  const inline = overflow && !bottomClipped;
  return <div className={`claude-expandable${overflow ? ' has-tab' : ''}${overflow && expanded && !inline ? ' is-open' : ''}`}>
    <div className="claude-io">
      <div className="claude-io-row"><span>{t('claude.input')}</span><ToolBody content={command} path="command.sh" plain={false} previewHeight={180} expanded={expanded} bodyRef={inRef} onToggle={inOverflow ? toggle : undefined} /></div>
      {output !== undefined && <div className={`claude-io-row ${failed}`}><span>{t('claude.output')}</span><ToolBody content={output} path="output.txt" plain previewHeight={180} expanded={expanded} bodyRef={outRef} onToggle={outOverflow ? toggle : undefined} /></div>}
      {inline && <ExpandTab expanded={expanded} onToggle={toggle} inline />}
    </div>
    {overflow && !inline && <ExpandTab expanded={expanded} onToggle={toggle} />}
  </div>;
}

function EditDiff({ before, after, path }: { before: string; after: string; path: string }) {
  const [expanded, toggle] = useToolExpanded();
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
  const long = rows.length > 6 || before.length + after.length > 800;
  return <div className={`claude-expandable${long ? ' has-tab' : ''}${long && expanded ? ' is-open' : ''}`}><div className={`claude-diff ${expanded ? 'is-expanded' : ''}`}>
    <ToolCopy content={after} expanded={expanded} onToggle={long ? toggle : undefined} />
    <div className="claude-diff-scroll">{rows.length ? rows.map((r, i) => <div className="claude-diff-row" key={i}>
      <div className={`${r.changed ? r.old !== undefined ? 'is-removed' : 'is-gap' : ''}`}><span className="claude-line-number">{r.oldLine}</span><code>{render(r.old, r.oldLine, 0)}</code></div>
      <div className={`${r.changed ? r.next !== undefined ? 'is-added' : 'is-gap' : ''}`}><span className="claude-line-number">{r.nextLine}</span><code>{render(r.next, r.nextLine, 1)}</code></div>
    </div>) : <Code content={after} path={path} />}</div>
  </div>{long && <ExpandTab expanded={expanded} onToggle={toggle} />}</div>;
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
  return <ToolExpansionKey.Provider value={`${message.id}:${name}`}><section className={`claude-tool claude-tool--${message.toolStatus ?? 'running'}`}>
    <div className="claude-tool-heading">
      <button onClick={() => setBodyOpen(v => !v)} aria-expanded={showBody}><strong>{search?.title ?? orchestrationToolLabel(name, t) ?? name}</strong></button>
      {path ? <button className="claude-file-path" onClick={() => void commands.showInFolder(path)}>{description}</button> : <span>{description}</span>}
      {!bash && !edit && !write && <button className="claude-chevron" aria-label={t('claude.tool_details')} onClick={() => setBodyOpen(v => !v)}><Chevron open={bodyOpen} /></button>}
    </div>
    {edit && <div className="claude-tool-subtitle">{removed || added ? [removed ? t('claude.lines_removed', { count: removed }) : '', added ? t('claude.lines_added', { count: added }) : ''].filter(Boolean).join(' · ') : t('claude.modified')}</div>}
    {write && typeof input.content === 'string' && <div className="claude-tool-subtitle">{t('claude.lines', { count: input.content.split('\n').length })}</div>}
    {showBody && <div className="claude-tool-body">
      {edit ? <EditDiff before={before} after={after} path={path} /> : write ? message.toolStatus === 'running' && input.content === undefined ? <span className="claude-tool-pending">{t('diff.loading')}</span> : <ToolContent content={text(input.content)} path={path} /> : bash ? <BashIO command={text(input.command)} output={message.output !== undefined ? output || t('claude.no_output') : undefined} failed={message.toolStatus === 'failed' && !message.interrupted ? 'is-error' : ''} /> : <><ToolContent content={JSON.stringify(input, null, 2)} path="input.json" />{message.output !== undefined && <ToolContent content={output || t('claude.no_output')} path="output.txt" plain />}</>}
      {edit || write ? message.toolStatus === 'failed' && <pre className={message.interrupted ? 'claude-interrupted' : 'claude-tool-error'}>{output}</pre> : null}
    </div>}
  </section></ToolExpansionKey.Provider>;
});

// Which tool groups (and which calls inside them) are open, kept outside the rows so a remounted row keeps them.
const openToolGroups = new Set<string>();

const STEP_ICONS: Record<string, ReactNode> = {
  read: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  edit: <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />,
  run: <path d="m4 17 6-6-6-6M12 19h8" />,
  web: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>,
  remote: <><rect x="2" y="4" width="13" height="9" rx="2" /><rect x="9" y="11" width="13" height="9" rx="2" /></>,
  team: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
  other: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
  group: <><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>,
  done: <path d="M20 6 9 17l-5-5" />,
};
const stepIcon = (key: string) => <svg className="claude-step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{STEP_ICONS[key] ?? STEP_ICONS.other}</svg>;

/** One call as one line: what it did, to what, and what came back; opens into the full call. */
function ToolStep({ message }: { message: ClaudeMessage }) {
  const t = useT();
  const [open, setOpen] = useState(() => openToolGroups.has(`step:${message.id}`));
  const input = message.input ?? {}, name = message.toolName;
  const kind = toolKind(name);
  const label = orchestrationToolLabel(name ?? '', t);
  const target = label ? '' : toolTarget(name, input);
  const before = text(input.old_string), after = text(input.new_string);
  const changes = name === 'Edit' ? diffLines(before, after, { timeout: 100 }) ?? [] : [];
  const added = changes.filter(c => c.added).reduce((n, c) => n + c.count, 0), removed = changes.filter(c => c.removed).reduce((n, c) => n + c.count, 0);
  const result = toolResult(name, message.output);
  const toggle = () => setOpen(value => { const key = `step:${message.id}`; if (value) openToolGroups.delete(key); else openToolGroups.add(key); return !value; });
  return <div className={`claude-step claude-step--${message.toolStatus ?? 'running'}`}>
    <button type="button" className="claude-step-line" aria-expanded={open} onClick={toggle}>
      {stepIcon(kind)}
      <span className="claude-step-verb">{label ?? t(toolVerbKey(name))}</span>
      {target && <span className="claude-step-target">{target}</span>}
      {(added > 0 || removed > 0) && <span className="claude-step-diff"><i className="is-add">+{added}</i> <i className="is-del">−{removed}</i></span>}
      {result && <span className="claude-step-result">{name === 'Grep' || name === 'Glob' ? t('tools.result.found', { count: result }) : `→ ${result}`}</span>}
    </button>
    {open && <div className="claude-step-detail"><ClaudeTool message={message} /></div>}
  </div>;
}

/** Tool calls in a row as one quiet card (toolcalls 方案 B): a sentence that sums them up, a check once
 *  done, and inside, one line per call. While running it names the step under way and its time. */
export const ToolGroup = memo(function ToolGroup({ messages, extra }: { messages: ClaudeMessage[]; extra?: ReactNode }) {
  const t = useT();
  const key = messages[0].id;
  const [open, setOpen] = useState(() => openToolGroups.has(key));
  const status = toolRunStatus(messages);
  const running = status === 'running' ? messages.find(message => message.toolStatus === 'running' || !message.toolStatus) : undefined;
  const now = useClock(!!running);
  const toggle = () => setOpen(value => { if (value) openToolGroups.delete(key); else openToolGroups.add(key); return !value; });
  const step = running && (orchestrationToolLabel(running.toolName ?? '', t) ?? t(toolVerbKey(running.toolName)));
  const stepTarget = running && toolTarget(running.toolName, running.input ?? {});
  return <section className={`claude-tool-group claude-tool-group--${status}`}>
    <button type="button" className="claude-tool-group-head" aria-expanded={open} onClick={toggle}>
      {running ? <span className="claude-step-spinner" aria-hidden="true" /> : stepIcon('group')}
      <span className="claude-tool-group-title">{running ? <>{t('tools.running', { step: step || '' })}{stepTarget && <span className="claude-tool-group-target">{stepTarget}</span>}</> : toolRunSummary(messages, t)}</span>
      {running && <span className="claude-tool-group-time">{elapsed(Math.max(0, now - running.timestamp), t)}</span>}
      {status === 'done' && <span className="claude-tool-group-done">{stepIcon('done')}</span>}
      <Chevron open={open} />
    </button>
    {open && <div className="claude-tool-group-list">{extra}{messages.map(message => <ToolStep key={message.id} message={message} />)}</div>}
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
        {s.messages.slice(virtual.start, virtual.end).map((m, i) => runs.follower.has(virtual.start + i) ? <MeasuredRow key={m.renderKey ?? m.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>{null}</MeasuredRow> : <MeasuredRow key={m.renderKey ?? m.id} id={virtual.measurementKeys[virtual.start + i]} measure={virtual.measureRow}>
          {new Date(m.timestamp).toDateString() !== new Date(s.messages[virtual.start + i - 1]?.timestamp ?? 0).toDateString() && <div className="claude-date">{new Date(m.timestamp).toLocaleDateString(language, { weekday: 'short', month: 'short', day: 'numeric' })}</div>}
          <article data-message-id={m.id} className={`claude-row claude-row--${m.role} ${runs.lead.has(virtual.start + i) ? `claude-row--group claude-row--${toolRunStatus(s.messages.slice(virtual.start + i, runs.lead.get(virtual.start + i)! + 1))}` : m.toolStatus ? `claude-row--${m.interrupted ? 'interrupted' : m.toolStatus}` : ''} ${m.parentId ? 'claude-row--nested' : ''}`}>
            {m.role === 'user' ? <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><CollapsibleUserMessage sentAt={m.timestamp} text={m.content} expanded={!!expandedMessages[m.id]} onToggle={() => setExpandedMessages(old => ({ ...old, [m.id]: !old[m.id] }))}><MarkdownContent content={m.content} /></CollapsibleUserMessage></> : m.role === 'tool' ? (runs.lead.has(virtual.start + i) ? <ToolGroup messages={s.messages.slice(virtual.start + i, runs.lead.get(virtual.start + i)! + 1)} /> : <ClaudeTool message={m} />) : m.role === 'reasoning' ? <ClaudeThinking message={m} expanded={thinkingExpansion[m.id] ?? expandedThinking} tokens={s.thinkingTokens} onToggle={open => setThinkingExpansion(previous => (previous[m.id] ?? expandedThinking) === open ? previous : { ...previous, [m.id]: open })} /> : <><time>{new Date(m.timestamp).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' })}</time><MarkdownContent content={m.content} /></>}
            {(m.role === 'user' || m.role === 'assistant') && !m.partial && <MessageCopyButton copied={copied === m.id} onCopy={() => copy(m)} />}
            {m.turnStats && !(s.busy && virtual.start + i === s.messages.length - 1) && <TurnSummary stats={m.turnStats} sessionKey={s.nativeId} messageId={m.id} />}
          </article>
        </MeasuredRow>)}
        <div style={{ height: virtual.bottomSpacer }} aria-hidden="true" />
        {s.requests.map(p => <Question key={p.id} id={sessionId} pending={p} />)}
        {s.coldReturn && <ClaudeColdReturn id={sessionId} idleMinutes={s.coldReturn.idleMinutes} tokens={s.coldReturn.tokens} />}
        {restoring && s.messages.length > 0 && <div className="claude-working" role="status">{restoringMark}<span className="claude-working-word">{t('conversation.restoring')}</span></div>}
        {s.ready && s.busy && !s.requests.length && <Working status={s.interruptRequested ? 'stopping' : s.status} startedAt={s.startedAt}
          title={turnTitle(s.messages, s.startedAt)}
          tool={s.messages.findLast(message => message.toolStatus === 'running' && !message.parentId)?.toolName} />}
        {s.interrupted && !s.busy && !s.error && <div className="claude-interrupted" role="status">{t('claude.interrupted')}</div>}
        {directoryIssue && <div className="claude-session-error" role="alert">{directoryError}</div>}
        {s.error && (s.ready || !directoryIssue || s.errorKey === 'claude.error.settings_readback' || s.errorKey === 'claude.error.restart') && <div className="claude-session-error" role="alert">{s.errorKey ? t(s.errorKey, { detail: s.error }) : startErrorText(s.error, 'Claude Code', t)}</div>}
        {empty && <div className="claude-empty">
          <ClaudeWelcomeIcon isActive={isVisible} />
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
