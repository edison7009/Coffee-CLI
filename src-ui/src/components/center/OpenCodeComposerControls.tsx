import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { configureOpenCode, runOpenCodeCommand, useOpenCodeSession } from '../../lib/opencode-session';
import { openCodeRows } from '../../lib/opencode-protocol';
import { clipboardWrite } from '../../lib/clipboard';
import { useAppState } from '../../store/app-state';
import { claudeEffortLabel } from '../../lib/claude-i18n';
import { ClaudeEffortControl } from './ClaudeEffortControl';
import { AttachIcon } from './ClaudeComposerControls';
import { ContextUsage } from './ContextUsage';
import { useT } from '../../i18n/useT';
import './ClaudeComposerControls.css';

type Menu = 'commands' | 'model' | 'variant' | 'agent' | 'context' | null;
type Command = { name: string; description: string; target: 'model' | 'variant' | 'agent' | 'context' | 'new' | 'compact' | 'copy' | 'mention' | 'native' };
export function OpenCodeComposerControls({ sessionId, draft, onDraftChange, keyHandler, submitHandler, quota, children }: {
  sessionId: string; draft: string; onDraftChange: (value: string) => void;
  keyHandler: MutableRefObject<((event: KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>;
  submitHandler: MutableRefObject<((text: string) => boolean) | undefined>;
  quota?: ReactNode;
  children?: ReactNode;
}) {
  const s = useOpenCodeSession(sessionId), t = useT();
  const { state, dispatch } = useAppState();
  const [menu, setMenu] = useState<Menu>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement | null>(null);
  const commandsAnchor = useRef<HTMLButtonElement>(null);
  const model = s.models.find(m => m.id === s.model?.id && m.providerID === s.model?.providerID);
  const agents = s.agents.filter(a => a.mode !== 'subagent' && !a.hidden);
  const agent = agents.find(a => a.id === s.agent) ?? agents[0];
  const percent = model?.context ? Math.min(100, s.contextTokens / model.context * 100) : 0;
  const slash = /^\/[\w:-]*$/.test(draft) && dismissed !== draft;
  const shown = menu ?? (slash ? 'commands' : null);
  const variantLabel = (variant?: string) => claudeEffortLabel(variant ?? 'default', t);
  const commands: Command[] = [
    { name: 'model', description: t('claude.command.model'), target: 'model' as const },
    ...(agents.length > 1 ? [{ name: 'agent', description: t('opencode.command.agent'), target: 'agent' as const }] : []),
    ...(model?.variants.length ? [{ name: 'effort', description: t('claude.effort.title'), target: 'variant' as const }] : []),
    { name: 'status', description: t('claude.context_window'), target: 'context' as const },
    { name: 'new', description: t('codex.command.new'), target: 'new' as const },
    { name: 'compact', description: t('codex.command.compact'), target: 'compact' as const },
    // Commands OpenCode itself defines (init, review, goal and the user's own).
    ...s.commands.filter(c => !['model', 'agent', 'effort', 'status', 'new', 'compact', 'copy', 'mention'].includes(c.name)).map(c => ({ name: c.name, description: c.description ?? '', target: 'native' as const })),
    { name: 'copy', description: t('codex.command.copy'), target: 'copy' as const },
    { name: 'mention', description: t('codex.command.mention'), target: 'mention' as const },
  ].filter(command => !slash || command.name.includes(draft.slice(1).toLowerCase()));
  const lastReply = () => openCodeRows(s.native).findLast(row => row.role === 'assistant' && !row.kind && !row.partial);
  const disabled = (target: Command['target']) => {
    if (target === 'copy') return !lastReply();
    if (['context', 'mention', 'new'].includes(target)) return false;
    if (target === 'compact' || target === 'native') return !s.ready || s.busy;
    return !s.ready;
  };
  const close = () => { setMenu(null); setDismissed(draft); };
  const chooseCommand = (index: number) => {
    const command = commands[index]; if (!command || disabled(command.target)) return;
    if (/^\/[\w:-]*$/.test(draft)) onDraftChange('');
    anchor.current = commandsAnchor.current; setSelected(0);
    const target = command.target;
    if (target === 'compact' || target === 'native') { close(); void runOpenCodeCommand(sessionId, target === 'compact' ? 'compact' : { name: command.name }).catch(() => {}); }
    else if (target === 'new') { close(); dispatch({ type: 'ADD_TERMINAL', session: { id: crypto.randomUUID(), tool: 'opencode', folderPath: state.terminals.find(tab => tab.id === sessionId)?.folderPath ?? null, opencodeMode: 'conversation', startedAt: Date.now() } }); }
    else if (target === 'copy') { const reply = lastReply(); if (reply) void clipboardWrite(reply.content); close(); }
    else if (target === 'mention') { close(); void attach(/^\/[\w:-]*$/.test(draft) ? '' : draft); }
    else setMenu(target);
  };
  useEffect(() => {
    keyHandler.current = event => {
      if (!shown || event.nativeEvent.isComposing) return false;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
      if (shown !== 'commands' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % Math.max(1, commands.length)); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseCommand(Math.min(selected, commands.length - 1)); return true; }
      return false;
    };
    submitHandler.current = text => {
      const withText = /^\/([\w:-]+)\s+(\S[\s\S]*)$/.exec(text);
      if (withText && commands.some(command => command.target === 'native' && command.name === withText[1])) {
        if (!disabled('native')) { onDraftChange(''); close(); void runOpenCodeCommand(sessionId, { name: withText[1], text: withText[2].trim() }).catch(() => {}); }
        return true;
      }
      if (!/^\/[\w:-]*$/.test(text)) return false;
      const index = commands.findIndex(command => `/${command.name}` === text);
      if (index >= 0) chooseCommand(index); else { setMenu('commands'); setDismissed(null); }
      return true;
    };
    return () => { keyHandler.current = undefined; submitHandler.current = undefined; };
  });
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => { const r = (shown === 'commands' ? commandsAnchor.current : anchor.current)?.getBoundingClientRect(); if (!r) return; const width = Math.min(['agent', 'commands'].includes(shown) ? 420 : shown === 'variant' ? 320 : shown === 'context' ? 280 : 300, innerWidth - 16); const left = ['agent', 'commands'].includes(shown) ? r.left : r.right - width; setPosition({ position: 'fixed', left: Math.max(8, Math.min(left, innerWidth - width - 8)), bottom: innerHeight - r.top + 6, width, maxHeight: Math.max(50, r.top - 16) }); };
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    const gambit = root.current?.closest('.gambit'); if (gambit) observer.observe(gambit);
    update(); window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const outside = (e: Event) => { if (!root.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) { setMenu(null); setDismissed(draft); } };
    const key = (e: globalThis.KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches('input[type="range"]')) return;
      if (shown === 'commands' && (e.target as HTMLElement)?.matches('textarea')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(null); setDismissed(draft); (shown === 'commands' ? commandsAnchor.current : anchor.current)?.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        const buttons = [...(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]; if (!buttons.length) return;
        e.preventDefault(); const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
  }, [shown, draft]);
  const show = (next: Menu, button: HTMLButtonElement) => { anchor.current = button; setSelected(0); if (shown === next) close(); else setMenu(next); };
  const attach = async (text = draft) => { const { open } = await import('@tauri-apps/plugin-dialog'); const paths = await open({ directory: false, multiple: true }); if (paths) onDraftChange(`${text}${text ? '\n' : ''}${(Array.isArray(paths) ? paths : [paths]).map(p => `"${p}"`).join(' ')}`); };
  return <div className="claude-composer-controls codex-composer-controls" ref={root}>
    <button type="button" className="claude-control-icon" aria-label={t('claude.attach')} onClick={() => { void attach(); }}><AttachIcon /></button>
    <button type="button" ref={commandsAnchor} className="claude-control-icon" aria-label={t('codex.command')} aria-expanded={shown === 'commands'} onClick={e => show('commands', e.currentTarget)}>/</button>
    {agents.length > 1 && <button type="button" className="claude-permission-control" disabled={!s.ready} aria-label={t('opencode.agent')} aria-expanded={menu === 'agent'} onClick={e => show('agent', e.currentTarget)}>{agent?.name ?? s.agent}</button>}
    {children}
    <div className="claude-model-controls">
      {quota}
      <button type="button" className="claude-model-control" disabled={!s.ready} aria-label={t('opencode.model')} aria-expanded={menu === 'model'} onClick={e => show('model', e.currentTarget)}>{model?.name || s.model?.id || 'OpenCode'}</button>
      {!!model?.variants.length && <button type="button" className={`claude-effort-trigger${s.model?.variant && s.model.variant === model.variants.at(-1) ? ' is-ultracode' : ''}`} disabled={!s.ready} aria-label={t('claude.effort.title')} aria-expanded={menu === 'variant'} onClick={e => show('variant', e.currentTarget)}>{variantLabel(s.model?.variant)}</button>}
      <button type="button" className="claude-context-control" data-severity={percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'} aria-label={`${t('claude.context_used')}: ${Math.round(percent)}%`} aria-haspopup="dialog" aria-expanded={menu === 'context'} onClick={e => show('context', e.currentTarget)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle className="claude-context-track" cx="8" cy="8" r="6" /><circle className="claude-context-progress" cx="8" cy="8" r="6" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - percent} /></svg></button>
    </div>
    {shown && createPortal(<div ref={popup} className="claude-control-menu codex-control-menu" role="dialog" aria-label={t(shown === 'commands' ? 'codex.command' : shown === 'model' ? 'opencode.model' : shown === 'variant' ? 'claude.effort.title' : shown === 'context' ? 'claude.context_window' : 'opencode.agent')} style={position}>
      {shown === 'commands' ? commands.length ? commands.map((command, index) => <button type="button" key={command.name} className={index === selected ? 'is-selected' : ''} disabled={disabled(command.target)} onMouseEnter={() => setSelected(index)} onClick={() => chooseCommand(index)}><strong>/{command.name}</strong><small>{command.description}</small></button>) : <div className="claude-menu-empty">{t('claude.commands_empty')}</div>
        : shown === 'model' ? s.models.map(m => { const current = m.id === s.model?.id && m.providerID === s.model?.providerID; return <button type="button" key={`${m.providerID}/${m.id}`} className={current ? 'is-selected' : ''} onClick={() => { void configureOpenCode(sessionId, { model: { id: m.id, providerID: m.providerID, ...(s.model?.variant && m.variants.includes(s.model.variant) ? { variant: s.model.variant } : {}) } }); close(); }}><strong>{m.name}</strong><small>{m.providerID}</small>{current && <span aria-hidden="true">✓</span>}</button>; })
        : shown === 'variant' && model ? <ClaudeEffortControl key={`${sessionId}:${model.providerID}/${model.id}`} levels={['default', ...model.variants]} value={s.model?.variant ?? 'default'} disabled={!s.ready} onCommit={async level => { if (s.model) await configureOpenCode(sessionId, { model: { id: s.model.id, providerID: s.model.providerID, ...(level !== 'default' ? { variant: level } : {}) } }); }} onClose={() => { close(); anchor.current?.focus(); }} />
        : shown === 'context' ? <ContextUsage used={s.contextTokens} capacity={model?.context ?? 0} total={s.totalTokens} />
        : <>
          {agents.map(a => <button type="button" key={a.id} className={`codex-permission-option${a.id === agent?.id ? ' is-selected' : ''}`} onClick={() => { void configureOpenCode(sessionId, { agent: a.id }); setMenu(null); }}><strong>{a.name}{a.id === agent?.id ? ' ✓' : ''}</strong><small>{a.description}</small></button>)}
          <div className="codex-permission-note">{t('codex.permissions_next_turn')}</div>
        </>}
    </div>, document.body)}
  </div>;
}
