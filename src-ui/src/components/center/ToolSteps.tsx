// The step pieces every tool's conversation shares: a call's full card (command and output, a file's diff), a call or
// a thought as a step on the thin line, a run of them as that line, and a thought on its own.
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { diffLines } from 'diff';
import { useT } from '../../i18n/useT';
import { formatElapsed, formatTokens } from '../../lib/claude-i18n';
import { toolFailure, toolKind, toolResult, toolTarget, toolVerbKey } from '../../lib/tool-runs';
import { changedFiles } from '../../lib/turn-work';
import { useOpenChangedFile } from '../../lib/use-turn-work';
import { orchestrationSearchLabel, orchestrationToolLabel } from '../../lib/orchestration-label';
import { clipboardWrite } from '../../lib/clipboard';
import { tokenizeFile, getShikiTheme, type LineTokens } from '../../lib/shiki';
import { useDataAttr } from '../../lib/use-data-attr';
import { text, type ClaudeMessage } from '../../lib/claude-protocol';
import { commands } from '../../tauri';
import { MarkdownContent } from './MarkdownContent';
import { MessageCopyButton, Chevron } from './ConversationControls';
import './ClaudeConversation.css';
import './TurnWork.css';

const count = formatTokens, elapsed = formatElapsed;

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

export function Code({ content, path, className = '' }: { content: string; path: string; className?: string }) {
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

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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
  const openFile = useOpenChangedFile();
  return <ToolExpansionKey.Provider value={`${message.id}:${name}`}><section className={`claude-tool claude-tool--${message.toolStatus ?? 'running'}`}>
    <div className="claude-tool-heading">
      <button onClick={() => setBodyOpen(v => !v)} aria-expanded={showBody}><strong>{search?.title ?? orchestrationToolLabel(name, t) ?? name}</strong></button>
      {path ? <button className="claude-file-path" onClick={() => EDIT_TOOLS.has(name) && message.toolStatus === 'done' ? openFile(path) : void commands.showInFolder(path)}>{description}</button> : <span>{description}</span>}
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
  think: <><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></>,
  failed: <path d="M18 6 6 18M6 6l12 12" />,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
};
const stepIcon = (key: string) => <svg className="claude-step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{STEP_ICONS[key] ?? STEP_ICONS.other}</svg>;

const firstLine = (value: string) => value.split('\n').map(line => line.trim()).find(Boolean) ?? '';
const stepToggle = (key: string, set: (update: (open: boolean) => boolean) => void) => set(value => { if (value) openToolGroups.delete(key); else openToolGroups.add(key); return !value; });

/** One call as one step on the line: its icon as the node, what it did to what, a short result; opens into the full
 *  call. A changed file is a link of its own to its diff. The step under way pulses and is not a toggle yet. */
function ToolStep({ message }: { message: ClaudeMessage }) {
  const t = useT();
  const [open, setOpen] = useState(() => openToolGroups.has(`step:${message.id}`));
  const openFile = useOpenChangedFile();
  const input = message.input ?? {}, name = message.toolName;
  const kind = toolKind(name);
  const label = orchestrationToolLabel(name ?? '', t);
  const target = label ? '' : toolTarget(name, input);
  const [{ added, removed } = { added: 0, removed: 0 }] = changedFiles([{ ...message, toolStatus: 'done' }]);
  const changedPath = EDIT_TOOLS.has(name ?? '') && message.toolStatus === 'done' ? text(input.file_path) || text(input.notebook_path) : '';
  const failed = message.toolStatus === 'failed' && !message.interrupted;
  const now = !message.toolStatus || message.toolStatus === 'running';
  const result = failed || now ? '' : toolResult(name, message.output);
  const failure = failed ? toolFailure(message.output) : {};
  const failureNote = !failed ? '' : failure.exit !== undefined ? `exit ${failure.exit}` : failure.errors !== undefined ? t('turn.errors', { count: failure.errors }) : t('codex.failed');
  const error = failed ? firstLine(message.output ?? '') : '';
  const toggle = () => { if (!now) stepToggle(`step:${message.id}`, setOpen); };
  return <div className={`claude-step claude-step-kind-${kind} claude-step--${message.interrupted ? 'interrupted' : message.toolStatus ?? 'running'}${now ? ' is-now' : ''}`}>
    <div className="claude-step-line" onClick={event => { if (!(event.target as HTMLElement).closest('.claude-step-file')) toggle(); }}>
      <button type="button" className="claude-step-toggle" disabled={now} aria-expanded={now ? undefined : open} aria-label={failed ? `${label ?? t(toolVerbKey(name))} ${target} — ${t('turn.tool_failed')}` : undefined} onClick={event => { event.stopPropagation(); toggle(); }}>
        <span className="claude-step-node">{now ? <i className="claude-step-pulse" /> : stepIcon(kind)}</span><span className="claude-step-verb">{label ?? t(toolVerbKey(name))}</span>
      </button>
      {target && (changedPath ? <button type="button" className="claude-step-target claude-step-file" onClick={() => openFile(changedPath)}>{target}</button> : <span className="claude-step-target">{target}</span>)}
      {(added > 0 || removed > 0) && <span className="claude-step-diff"><i className="is-add">+{added}</i> <i className="is-del">−{removed}</i></span>}
      {failureNote && <span className="claude-step-result is-failed">{failureNote}</span>}
      {result && <span className="claude-step-result">{name === 'Grep' || name === 'Glob' ? t('tools.result.found', { count: result }) : result}</span>}
      {!now && <Chevron open={open} />}
    </div>
    {error && <div className="claude-step-error">{error}</div>}
    {open && <div className="claude-step-detail"><ClaudeTool message={message} /></div>}
  </div>;
}

/** A thought as a step on the same line: its first sentence, quiet and slanted; opens into the whole thought. */
function ThinkStep({ message }: { message: ClaudeMessage }) {
  const t = useT();
  const [open, setOpen] = useState(() => openToolGroups.has(`step:${message.id}`));
  const now = !!message.partial;
  const line = firstLine(message.content).replace(/^[#>*\-\s]+/, '') || t(now ? 'conversation.thinking' : 'claude.status.thinking');
  const canOpen = !now && !!message.content.trim();
  const toggle = () => { if (canOpen) stepToggle(`step:${message.id}`, setOpen); };
  return <div className={`claude-step claude-step-kind-think${now ? ' is-now' : ''}`}>
    <div className="claude-step-line" onClick={toggle}>
      <button type="button" className="claude-step-toggle claude-step-thought" disabled={!canOpen} aria-expanded={canOpen ? open : undefined} onClick={event => { event.stopPropagation(); toggle(); }}>
        <span className="claude-step-node">{now ? <i className="claude-step-pulse" /> : stepIcon('think')}</span><span className="claude-step-verb">{line}</span>
      </button>
      {canOpen && <Chevron open={open} />}
    </div>
    {open && <div className="claude-step-detail claude-step-detail--thought"><MarkdownContent content={message.content} /></div>}
  </div>;
}

/** Calls and thoughts in a row as steps on one thin line, each icon a node on it. While the turn runs the line grows
 *  at its newest step, and past five steps the earlier ones wait behind 「已完成 N 步」. The turn's one timer is the
 *  working line under the conversation. */
export const ToolGroup = memo(function ToolGroup({ messages, extra }: { messages: ClaudeMessage[]; extra?: ReactNode }) {
  const t = useT();
  const key = messages[0].id;
  const [showAll, setShowAll] = useState(() => openToolGroups.has(key));
  const live = messages.some(message => message.role === 'tool' ? !message.toolStatus || message.toolStatus === 'running' : !!message.partial);
  const hidden = live && !showAll && messages.length > 5 ? messages.length - 4 : 0;
  return <section className={`claude-tool-group claude-rail${live ? ' is-live' : ''}`}>
    {extra}
    {hidden > 0 && <button type="button" className="turn-fold claude-rail-more" aria-expanded={false} onClick={() => stepToggle(key, setShowAll)}><Chevron open={false} /><span>{t('turn.steps_done', { count: hidden })}</span></button>}
    {messages.slice(hidden).map(message => message.role === 'reasoning' ? <ThinkStep key={message.id} message={message} /> : <ToolStep key={message.id} message={message} />)}
  </section>;
});

