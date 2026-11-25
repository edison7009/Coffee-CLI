import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { sameFolder } from '../../lib/worktree-path';
import { setAcpConfig, useAcpSession } from '../../lib/acp-session';
import { ContextUsage } from './ContextUsage';
import { AttachIcon } from './ClaudeComposerControls';
import { ClaudeEffortControl } from './ClaudeEffortControl';
import { claudeEffortLabel } from '../../lib/claude-i18n';
import { pickFiles } from '../../lib/folder-picker';
import { attachToDraft } from '../../lib/gambit-attachments';
import './ClaudeComposerControls.css';

export function AcpComposerControls({ sessionId, draft, onDraftChange, keyHandler: keyHandlerRef, submitHandler: submitHandlerRef, quota, children }: {
  sessionId: string; draft: string; onDraftChange: (text: string) => void;
  keyHandler: MutableRefObject<((e: KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>;
  submitHandler: MutableRefObject<((text: string) => boolean) | undefined>; quota?: ReactNode; children?: ReactNode;
}) {
  const s = useAcpSession(sessionId), t = useT(), { state, dispatch } = useAppState();
  const [menu, setMenu] = useState<string | null>(null), [dismissed, setDismissed] = useState<string | null>(null), [selected, setSelected] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement | null>(null), commandsAnchor = useRef<HTMLButtonElement>(null);
  const slash = /^\/[\w:-]*$/.test(draft) && draft !== dismissed;
  const shown = menu ?? (slash ? 'commands' : null), locked = !s.ready;
  const config = s.configOptions.find(c => c.id === shown);
  const commands = [
    ...s.configOptions.map(c => ({ name: c.category === 'mode' ? 'permissions' : c.category === 'thought_level' ? 'thinking' : c.id, description: c.name, target: c.id })),
    { name: 'new', description: t('codex.command.new'), target: 'new' },
    { name: 'status', description: t('claude.context_window'), target: 'context' },
    ...s.commands.map(c => ({ ...c, target: 'native' })),
  ].filter((c, i, all) => all.findIndex(x => x.name === c.name) === i).filter(c => !slash || c.name.includes(draft.slice(1).toLowerCase()));
  const close = () => { setMenu(null); setDismissed(draft); };
  const choose = (index: number) => {
    const c = commands[index]; if (!c || locked) return;
    if (c.target === 'native') return;
    if (/^\/[\w:-]*$/.test(draft)) onDraftChange('');
    anchor.current = commandsAnchor.current; setSelected(0);
    if (c.target === 'new') { close(); const tab = state.terminals.find(tab => tab.id === sessionId); dispatch({ type: 'ADD_TERMINAL', session: { id: crypto.randomUUID(), tool: tab?.tool ?? 'antigravity', ...sameFolder(tab), acpMode: 'conversation', startedAt: Date.now() } }); }
    else setMenu(c.target);
  };
  useEffect(() => {
    keyHandlerRef.current = e => {
      if (!shown || e.nativeEvent.isComposing) return false;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return true; }
      if (shown !== 'commands' || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setSelected(i => (i + (e.key === 'ArrowUp' ? -1 : 1) + commands.length) % Math.max(1, commands.length)); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { const c = commands[selected]; if (c?.target === 'native') { e.preventDefault(); onDraftChange(`/${c.name} `); close(); return true; } e.preventDefault(); choose(selected); return true; }
      return false;
    };
    submitHandlerRef.current = text => { const index = commands.findIndex(c => `/${c.name}` === text.trim() && c.target !== 'native'); if (index < 0) return false; choose(index); return true; };
    return () => { keyHandlerRef.current = undefined; submitHandlerRef.current = undefined; };
  });
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => { const r = (shown === 'commands' ? commandsAnchor.current : anchor.current)?.getBoundingClientRect(); if (!r) return; const width = Math.min(360, innerWidth - 16); setPosition({ position: 'fixed', left: Math.max(8, Math.min(r.right - width, innerWidth - width - 8)), bottom: innerHeight - r.top + 6, width, maxHeight: Math.max(50, r.top - 16) }); };
    update(); const observer = new ResizeObserver(update); if (root.current) observer.observe(root.current);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    const outside = (e: Event) => { if (!root.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) close(); };
    const key = (e: globalThis.KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input[type="range"]')) return;
      if ((e.target as HTMLElement).matches('textarea')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); anchor.current?.focus(); }
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) { const buttons = [...popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]; if (!buttons.length) return; e.preventDefault(); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus(); }
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
  });
  const show = (next: string, button: HTMLButtonElement) => { anchor.current = button; setSelected(0); if (shown === next) close(); else setMenu(next); };
  const percent = s.contextWindow ? Math.min(100, s.contextTokens / s.contextWindow * 100) : 0;
  return <div ref={root} className="claude-composer-controls codex-composer-controls">
    <button type="button" className="claude-control-icon" aria-label={t('claude.attach')} onClick={() => { void pickFiles().then(paths => { if (paths) onDraftChange(attachToDraft(draft, Array.isArray(paths) ? paths : [paths])); }); }}><AttachIcon /></button>
    <button type="button" ref={commandsAnchor} className="claude-control-icon" aria-label={t('claude.commands')} aria-expanded={shown === 'commands'} onClick={e => show('commands', e.currentTarget)}>/</button>
    {children}
    <div className="claude-model-controls">{quota}{s.configOptions.map(c => <button type="button" key={c.id} className={c.category === 'thought_level' ? 'claude-effort-trigger' : 'claude-model-control'} disabled={locked} aria-label={c.category === 'thought_level' ? t('claude.effort.title') : c.name} aria-expanded={shown === c.id} onClick={e => show(c.id, e.currentTarget)}>{c.category === 'thought_level' ? claudeEffortLabel(c.currentValue, t) : c.options.find(o => o.value === c.currentValue)?.name || c.name}</button>)}
      <button type="button" className="claude-context-control" aria-label={`${t('claude.context_used')}: ${Math.round(percent)}%`} aria-expanded={shown === 'context'} onClick={e => show('context', e.currentTarget)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle className="claude-context-track" cx="8" cy="8" r="6" /><circle className="claude-context-progress" cx="8" cy="8" r="6" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - percent} /></svg></button>
    </div>
    {shown && createPortal(<div ref={popup} className="claude-control-menu" role="dialog" style={position}>
      {shown === 'commands' ? commands.map((c, i) => <button type="button" key={c.name} disabled={locked} className={selected === i ? 'is-selected' : ''} onMouseEnter={() => setSelected(i)} onClick={() => { if (c.target === 'native') { onDraftChange(`/${c.name} `); close(); } else choose(i); }}><strong>/{c.name}</strong><small>{c.description}</small></button>)
        : shown === 'context' ? <ContextUsage used={s.contextTokens} capacity={s.contextWindow} total={s.contextTokens} />
        : config?.category === 'thought_level' ? <ClaudeEffortControl key={`${sessionId}:${config.id}`} levels={config.options.map(o => o.value)} value={config.currentValue} disabled={locked} onCommit={value => setAcpConfig(sessionId, config.id, value)} onClose={() => { close(); anchor.current?.focus(); }} />
        : config?.options.map(o => <button type="button" key={o.value} disabled={locked} className={o.value === config.currentValue ? 'is-selected' : ''} onClick={() => { close(); if (o.value !== config.currentValue) void setAcpConfig(sessionId, config.id, o.value); }}><strong>{o.name}{o.value === config.currentValue ? ' ✓' : ''}</strong>{o.description && <small>{o.description}</small>}</button>)}
    </div>, document.body)}
  </div>;
}
