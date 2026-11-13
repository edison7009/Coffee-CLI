import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { ModelPrice } from './ModelPrice';
import { createPortal } from 'react-dom';
import { compactPi, getPiThinkingLevels, setPiModel, setPiThinkingLevel, usePiSession } from '../../lib/pi-session';
import { cacheHitRate } from '../../lib/pi-protocol';
import { useAppState } from '../../store/app-state';
import { claudeEffortLabel } from '../../lib/claude-i18n';
import { ClaudeEffortControl } from './ClaudeEffortControl';
import { AttachIcon } from './ClaudeComposerControls';
import { ContextUsage } from './ContextUsage';
import { useT } from '../../i18n/useT';
import { sameFolder } from '../../lib/worktree-path';
import './ClaudeComposerControls.css';
import { pickFiles } from '../../lib/folder-picker';

type Menu = 'commands' | 'model' | 'thinking' | 'context' | null;

export function PiComposerControls({ sessionId, draft, onDraftChange, keyHandler: keyHandlerRef, submitHandler: submitHandlerRef, quota, children }: {
  sessionId: string; draft: string; onDraftChange: (value: string) => void;
  keyHandler: MutableRefObject<((event: KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>;
  submitHandler: MutableRefObject<((text: string) => boolean) | undefined>;
  quota?: ReactNode;
  children?: ReactNode;
}) {
  const s = usePiSession(sessionId), t = useT();
  const { state, dispatch } = useAppState();
  const [menu, setMenu] = useState<Menu>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [levels, setLevels] = useState<string[]>([]);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement | null>(null);
  const commandsAnchor = useRef<HTMLButtonElement>(null);
  const modelKey = s.model ? `${s.model.provider}/${s.model.id}` : '';
  // The selected model decides which thinking levels exist.
  useEffect(() => { if (!s.ready || !modelKey) { const clear = setTimeout(() => setLevels([])); return () => clearTimeout(clear); } let live = true; void getPiThinkingLevels(sessionId).then(list => { if (live) setLevels(list); }); return () => { live = false; }; }, [sessionId, s.ready, modelKey]);
  const contextWindow = s.stats.contextWindow || s.model?.contextWindow || 0;
  const contextTokens = s.stats.contextTokens ?? 0;
  const percent = contextWindow ? Math.min(100, contextTokens / contextWindow * 100) : 0;
  const hitRate = cacheHitRate(s.stats);
  const locked = !s.ready;
  const slash = /^\/[\w:-]*$/.test(draft) && dismissed !== draft;
  const shown = menu ?? (slash ? 'commands' : null);
  const commands = [
    { name: 'model', description: t('pi.command.model'), target: 'model' as const },
    ...(levels.length > 1 ? [{ name: 'thinking', description: t('claude.effort.title'), target: 'thinking' as const }] : []),
    { name: 'compact', description: t('pi.command.compact'), target: 'compact' as const },
    { name: 'new', description: t('codex.command.new'), target: 'new' as const },
    { name: 'status', description: t('claude.context_window'), target: 'context' as const },
  ].filter(command => !slash || command.name.includes(draft.slice(1).toLowerCase()));
  const disabled = (target: string) => target === 'compact' ? locked || s.busy : ['context', 'new'].includes(target) ? false : locked;
  const close = () => { setMenu(null); setDismissed(draft); };
  const attach = async () => { const paths = await pickFiles(); if (paths) onDraftChange(`${draft}${draft ? '\n' : ''}${(Array.isArray(paths) ? paths : [paths]).map(p => `"${p}"`).join(' ')}`); };
  const chooseCommand = (index: number) => {
    const command = commands[index]; if (!command || disabled(command.target)) return;
    if (/^\/[\w:-]*$/.test(draft)) onDraftChange('');
    anchor.current = commandsAnchor.current; setSelected(0);
    const target = command.target;
    if (target === 'compact') { close(); void compactPi(sessionId); }
    else if (target === 'new') { close(); dispatch({ type: 'ADD_TERMINAL', session: { id: crypto.randomUUID(), tool: 'pi', ...sameFolder(state.terminals.find(tab => tab.id === sessionId)), piMode: 'conversation', startedAt: Date.now() } }); }
    else setMenu(target);
  };
  useEffect(() => {
    keyHandlerRef.current = event => {
      if (!shown || event.nativeEvent.isComposing) return false;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
      if (shown !== 'commands' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSelected(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % Math.max(1, commands.length)); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseCommand(Math.min(selected, commands.length - 1)); return true; }
      return false;
    };
    // Coffee's own picker names open their menu; any other `/command` goes to Pi, which runs its
    // prompt templates, skills and extension commands.
    submitHandlerRef.current = text => {
      const index = commands.findIndex(command => `/${command.name}` === text.trim());
      if (index < 0) return false;
      chooseCommand(index);
      return true;
    };
    return () => { keyHandlerRef.current = undefined; submitHandlerRef.current = undefined; };
  });
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => { const r = (shown === 'commands' ? commandsAnchor.current : anchor.current)?.getBoundingClientRect(); if (!r) return; const width = Math.min(shown === 'thinking' ? 320 : shown === 'commands' ? 420 : shown === 'context' ? 280 : 340, innerWidth - 16); const left = shown === 'commands' ? r.left : r.right - width; setPosition({ position: 'fixed', left: Math.max(8, Math.min(left, innerWidth - width - 8)), bottom: innerHeight - r.top + 6, width, maxHeight: Math.max(50, r.top - 16) }); };
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
  return <div className="claude-composer-controls codex-composer-controls" ref={root}>
    <button type="button" className="claude-control-icon" aria-label={t('claude.attach')} onClick={() => { void attach(); }}><AttachIcon /></button>
    <button type="button" ref={commandsAnchor} className="claude-control-icon" aria-label={t('claude.commands')} aria-expanded={shown === 'commands'} onClick={e => show('commands', e.currentTarget)}>/</button>
    {children}
    <div className="claude-model-controls">
      {quota}
      <button type="button" className="claude-model-control" disabled={locked || !s.models.length} aria-label={t('pi.command.model')} aria-expanded={menu === 'model'} onClick={e => show('model', e.currentTarget)}>{s.model?.name || 'Pi'}</button>
      {levels.length > 1 && <button type="button" className="claude-effort-trigger" disabled={locked} aria-label={t('claude.effort.title')} aria-expanded={menu === 'thinking'} onClick={e => show('thinking', e.currentTarget)}>{claudeEffortLabel(s.thinkingLevel, t)}</button>}
      <button type="button" className="claude-context-control" data-severity={percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'} aria-label={`${t('claude.context_used')}: ${Math.round(percent)}%`} aria-haspopup="dialog" aria-expanded={menu === 'context'} onClick={e => show('context', e.currentTarget)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle className="claude-context-track" cx="8" cy="8" r="6" /><circle className="claude-context-progress" cx="8" cy="8" r="6" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - percent} /></svg></button>
    </div>
    {shown && createPortal(<div className="claude-control-menu" ref={popup} role="dialog" style={position} onMouseDown={e => e.stopPropagation()}>
      {shown === 'commands' ? commands.length ? commands.map((c, i) => <button type="button" key={c.name} disabled={disabled(c.target)} className={i === selected ? 'is-selected' : ''} onMouseEnter={() => setSelected(i)} onClick={() => chooseCommand(i)}><strong>/{c.name}</strong><small>{c.description}</small></button>) : <div className="claude-menu-empty">{t('claude.commands_empty')}</div>
      : shown === 'model' ? s.models.map(m => { const current = `${m.provider}/${m.id}` === modelKey; return <button type="button" key={`${m.provider}/${m.id}`} disabled={locked} className={current ? 'is-selected' : ''} onClick={() => { close(); if (!current) void setPiModel(sessionId, m); }}><strong>{m.name}{current ? ' ✓' : ''}</strong><small>{m.provider}<ModelPrice model={m.id} /></small></button>; })
      : shown === 'thinking' ? <ClaudeEffortControl key={`${sessionId}:${modelKey}`} levels={levels} value={s.thinkingLevel} disabled={locked} onCommit={level => setPiThinkingLevel(sessionId, level)} onClose={() => { close(); anchor.current?.focus(); }} />
      : shown === 'context' ? <>
        <ContextUsage used={contextTokens} capacity={contextWindow} total={contextTokens} />
        <div className="context-usage pi-cache-usage">
          <div className="claude-context-readout"><span>{t('pi.cache_hit_rate')}</span><strong>{hitRate === undefined ? '—' : `${Math.round(hitRate * 100)}%`}</strong></div>
          <div className="context-usage-count">{t('pi.cache_tokens', { read: s.stats.cacheRead.toLocaleString(), input: (s.stats.input + s.stats.cacheRead + s.stats.cacheWrite).toLocaleString() })}</div>
          {s.stats.cost > 0 && <div className="context-usage-count">{t('pi.cost', { cost: s.stats.cost.toFixed(4) })}</div>}
        </div>
      </> : null}
    </div>, document.body)}
  </div>;
}
