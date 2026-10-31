import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { sendDshMessage, setDshRoute, useDshSession } from '../../lib/dsh-session';
import { useAppState } from '../../store/app-state';
import { claudeEffortLabel } from '../../lib/claude-i18n';
import { ClaudeEffortControl } from './ClaudeEffortControl';
import { AttachIcon } from './ClaudeComposerControls';
import { ContextUsage } from './ContextUsage';
import { useT } from '../../i18n/useT';
import './ClaudeComposerControls.css';

type Menu = 'commands' | 'model' | 'effort' | 'permissions' | 'context' | null;
// The two presets DeepSeek Harness offers in its own composer.
const PRESETS = [
  { value: 'workspace-write', label: 'dsh.preset.workspace', description: 'dsh.preset.workspace_description' },
  { value: 'danger-full-access', label: 'dsh.preset.full', description: 'dsh.preset.full_description' },
] as const;

export function DshComposerControls({ sessionId, draft, onDraftChange, keyHandler, submitHandler, quota, children }: {
  sessionId: string; draft: string; onDraftChange: (value: string) => void;
  keyHandler: MutableRefObject<((event: KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>;
  submitHandler: MutableRefObject<((text: string) => boolean) | undefined>;
  quota?: ReactNode;
  children?: ReactNode;
}) {
  const s = useDshSession(sessionId), t = useT();
  const { state, dispatch } = useAppState();
  const [menu, setMenu] = useState<Menu>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement | null>(null);
  const commandsAnchor = useRef<HTMLButtonElement>(null);
  const model = s.models.find(m => m.provider === s.route.provider && m.model === s.route.model);
  const effort = s.route.effort || (model?.efforts.includes('high') ? 'high' : model?.efforts[0] ?? '');
  const percent = s.contextWindow ? Math.min(100, s.contextTokens / s.contextWindow * 100) : 0;
  // Route changes replace the runtime, so they wait for an idle Session.
  const locked = !s.ready || s.busy || !!s.restarting;
  const slash = /^\/[\w:-]*$/.test(draft) && dismissed !== draft;
  const shown = menu ?? (slash ? 'commands' : null);
  const commands = [
    { name: 'model', description: t('dsh.command.model'), target: 'model' as const },
    { name: 'permission', description: t('dsh.command.permission'), target: 'permissions' as const },
    ...(model?.efforts.length ? [{ name: 'effort', description: t('claude.effort.title'), target: 'effort' as const }] : []),
    { name: 'compact', description: t('dsh.command.compact'), target: 'compact' as const },
    { name: 'plan', description: t('dsh.command.plan'), target: 'plan' as const },
    { name: 'goal', description: t('dsh.command.goal'), target: 'goal' as const },
    { name: 'new', description: t('codex.command.new'), target: 'new' as const },
    { name: 'status', description: t('claude.context_window'), target: 'context' as const },
  ].filter(command => (s.commands || !['permissions', 'compact', 'plan', 'goal'].includes(command.target)) && (!slash || command.name.includes(draft.slice(1).toLowerCase())));
  const disabled = (target: string) => ['context', 'new', 'goal'].includes(target) ? false : locked;
  const close = () => { setMenu(null); setDismissed(draft); };
  const chooseCommand = (index: number) => {
    const command = commands[index]; if (!command || disabled(command.target)) return;
    if (/^\/[\w:-]*$/.test(draft)) onDraftChange('');
    anchor.current = commandsAnchor.current; setSelected(0);
    const target = command.target;
    if (target === 'compact' || target === 'plan') { close(); void sendDshMessage(sessionId, `/${target}`); }
    // A goal needs its objective, so it starts a command line instead of running.
    else if (target === 'goal') { close(); onDraftChange('/goal '); }
    else if (target === 'new') { close(); dispatch({ type: 'ADD_TERMINAL', session: { id: crypto.randomUUID(), tool: 'dsh', folderPath: state.terminals.find(tab => tab.id === sessionId)?.folderPath ?? null, startedAt: Date.now() } }); }
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
    // Bare picker names open their menu; native command lines (`/compact`, `/goal …`) are sent as typed.
    submitHandler.current = text => {
      if (!/^\/[\w:-]*$/.test(text) || /^\/(compact|plan|goal)$/.test(text)) return false;
      const index = commands.findIndex(command => `/${command.name}` === text);
      if (index >= 0) chooseCommand(index); else { setMenu('commands'); setDismissed(null); }
      return true;
    };
    return () => { keyHandler.current = undefined; submitHandler.current = undefined; };
  });
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => { const r = (shown === 'commands' ? commandsAnchor.current : anchor.current)?.getBoundingClientRect(); if (!r) return; const width = Math.min(shown === 'effort' ? 320 : ['permissions', 'commands'].includes(shown) ? 420 : shown === 'context' ? 280 : 320, innerWidth - 16); const left = ['permissions', 'commands'].includes(shown) ? r.left : r.right - width; setPosition({ position: 'fixed', left: Math.max(8, Math.min(left, innerWidth - width - 8)), bottom: innerHeight - r.top + 6, width, maxHeight: Math.max(50, r.top - 16) }); };
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
  const attach = async () => { const { open } = await import('@tauri-apps/plugin-dialog'); const paths = await open({ directory: false, multiple: true }); if (paths) onDraftChange(`${draft}${draft ? '\n' : ''}${(Array.isArray(paths) ? paths : [paths]).map(p => `"${p}"`).join(' ')}`); };
  const preset = PRESETS.find(p => p.value === s.preset);
  return <div className="claude-composer-controls codex-composer-controls" ref={root}>
    <button type="button" className="claude-control-icon" aria-label={t('claude.attach')} onClick={() => { void attach(); }}><AttachIcon /></button>
    <button type="button" ref={commandsAnchor} className="claude-control-icon" aria-label={t('claude.commands')} aria-expanded={shown === 'commands'} onClick={e => show('commands', e.currentTarget)}>/</button>
    <button type="button" className="claude-permission-control" disabled={locked || !s.commands} aria-label={t('dsh.command.permission')} aria-expanded={menu === 'permissions'} onClick={e => show('permissions', e.currentTarget)}>{preset ? t(preset.label) : s.preset || t('dsh.command.permission')}</button>
    {children}
    <div className="claude-model-controls">
      {quota}
      <button type="button" className="claude-model-control" disabled={locked} aria-label={t('dsh.command.model')} aria-expanded={menu === 'model'} onClick={e => show('model', e.currentTarget)}>{model?.name || s.route.model || 'DeepSeek'}</button>
      {!!model?.efforts.length && <button type="button" className="claude-effort-trigger" disabled={locked} aria-label={t('claude.effort.title')} aria-expanded={menu === 'effort'} onClick={e => show('effort', e.currentTarget)}>{claudeEffortLabel(effort, t)}</button>}
      <button type="button" className="claude-context-control" data-severity={percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'} aria-label={`${t('claude.context_used')}: ${Math.round(percent)}%`} aria-haspopup="dialog" aria-expanded={menu === 'context'} onClick={e => show('context', e.currentTarget)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle className="claude-context-track" cx="8" cy="8" r="6" /><circle className="claude-context-progress" cx="8" cy="8" r="6" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - percent} /></svg></button>
    </div>
    {shown && createPortal(<div className="claude-control-menu" ref={popup} role="dialog" style={position} onMouseDown={e => e.stopPropagation()}>
      {shown === 'commands' ? commands.length ? commands.map((c, i) => <button type="button" key={c.name} disabled={disabled(c.target)} className={i === selected ? 'is-selected' : ''} onMouseEnter={() => setSelected(i)} onClick={() => chooseCommand(i)}><strong>/{c.name}</strong><small>{c.description}</small></button>) : <div className="claude-menu-empty">{t('claude.commands_empty')}</div>
      : shown === 'permissions' ? PRESETS.map(p => <button type="button" key={p.value} disabled={locked} className={s.preset === p.value ? 'is-selected' : ''} onClick={() => { close(); if (s.preset !== p.value) void sendDshMessage(sessionId, `/permission ${p.value}`); }}><strong>{t(p.label)}{s.preset === p.value ? ' ✓' : ''}</strong><small>{t(p.description)}</small></button>)
      : shown === 'model' ? s.models.map(m => { const current = m.provider === s.route.provider && m.model === s.route.model; return <button type="button" key={`${m.provider}/${m.model}`} disabled={locked} className={current ? 'is-selected' : ''} onClick={() => { close(); if (!current) void setDshRoute(sessionId, { provider: m.provider, model: m.model, effort: m.efforts.includes(effort) ? effort : null }); }}><strong>{m.name}{current ? ' ✓' : ''}</strong><small>{m.provider}</small></button>; })
      : shown === 'effort' && model ? <ClaudeEffortControl key={`${sessionId}:${model.provider}/${model.model}`} levels={model.efforts} value={effort} disabled={locked} onCommit={async level => { await setDshRoute(sessionId, { ...s.route, effort: level }); }} onClose={() => { close(); anchor.current?.focus(); }} />
      : shown === 'context' ? <ContextUsage used={s.contextTokens} capacity={s.contextWindow} total={s.contextTokens} /> : null}
    </div>, document.body)}
  </div>;
}
