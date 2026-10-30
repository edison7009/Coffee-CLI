import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { configureCodex, runCodexCommand, useCodexSession } from '../../lib/codex-session';
import { arr, obj, str, type Json } from '../../lib/codex-protocol';
import { clipboardWrite } from '../../lib/clipboard';
import { useAppState } from '../../store/app-state';
import { claudeEffortLabel } from '../../lib/claude-i18n';
import { ClaudeEffortControl } from './ClaudeEffortControl';
import { AttachIcon } from './ClaudeComposerControls';
import { ContextUsage } from './ContextUsage';
import { useT } from '../../i18n/useT';
import './ClaudeComposerControls.css';

type Menu = 'commands' | 'model' | 'effort' | 'permissions' | 'context' | 'skills' | 'mcp' | null;
export function CodexComposerControls({ sessionId, draft, onDraftChange, keyHandler, submitHandler, quota, children }: {
  sessionId: string; draft: string; onDraftChange: (value: string) => void;
  keyHandler: MutableRefObject<((event: KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>;
  submitHandler: MutableRefObject<((text: string) => boolean) | undefined>;
  quota?: ReactNode;
  children?: ReactNode;
}) {
  const s = useCodexSession(sessionId), t = useT();
  const { state, dispatch } = useAppState();
  const [catalog, setCatalog] = useState<Json[]>([]), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), anchor = useRef<HTMLButtonElement | null>(null);
  const commandsAnchor = useRef<HTMLButtonElement>(null);
  const model = s.models.find(m => m.model === s.model || m.id === s.model);
  const percent = s.contextWindow ? Math.min(100, s.contextTokens / s.contextWindow * 100) : 0;
  const slash = /^\/[\w:-]*$/.test(draft) && dismissed !== draft;
  const shown = menu ?? (slash ? 'commands' : null);
  const commands = [
    { name: 'model', description: t('claude.command.model'), target: 'model' as const },
    { name: 'permissions', description: t('claude.command.permissions'), target: 'permissions' as const },
    ...(model?.supportedReasoningEfforts.length ? [{ name: 'effort', description: t('claude.effort.title'), target: 'effort' as const }] : []),
    { name: 'status', description: t('claude.context_window'), target: 'context' as const },
    { name: 'new', description: t('codex.command.new'), target: 'new' as const },
    { name: 'compact', description: t('codex.command.compact'), target: 'compact' as const },
    { name: 'review', description: t('codex.command.review'), target: 'review' as const },
    { name: 'skills', description: t('codex.command.skills'), target: 'skills' as const },
    { name: 'mcp', description: t('codex.command.mcp'), target: 'mcp' as const },
    { name: 'copy', description: t('codex.command.copy'), target: 'copy' as const },
    { name: 'mention', description: t('codex.command.mention'), target: 'mention' as const },
  ].filter(command => !slash || command.name.includes(draft.slice(1).toLowerCase()));
  const disabled = (target: string) => {
    if (pending) return true;
    if (target === 'copy') return !s.messages.some(message => message.role === 'assistant' && !message.partial);
    if (['context', 'mention', 'new'].includes(target)) return false;
    return !s.ready || !['skills', 'mcp'].includes(target) && s.busy;
  };
  const close = () => { setMenu(null); setDismissed(draft); };
  const nativeCommand = async (command: 'compact' | 'review' | 'skills' | 'mcp') => {
    setPending(true); setError(''); setCatalog([]);
    const browse = command === 'skills' || command === 'mcp';
    if (browse) setMenu(command); else close();
    try {
      const result = await runCodexCommand(sessionId, command);
      if (command === 'skills') setCatalog(arr(result.data).flatMap(entry => arr(obj(entry).skills).map(obj)).filter(skill => skill.enabled === true));
      else if (command === 'mcp') setCatalog(arr(result.data).map(obj));
    } catch (error) { if (browse) setError(String(error)); }
    finally { setPending(false); }
  };
  const chooseCommand = (index: number) => {
    const command = commands[index]; if (!command || disabled(command.target)) return;
    if (/^\/[\w:-]*$/.test(draft)) onDraftChange('');
    anchor.current = commandsAnchor.current; setSelected(0);
    const target = command.target;
    if (target === 'compact' || target === 'review' || target === 'skills' || target === 'mcp') void nativeCommand(target);
    else if (target === 'new') { close(); dispatch({ type: 'ADD_TERMINAL', session: { id: crypto.randomUUID(), tool: 'codex', folderPath: state.terminals.find(tab => tab.id === sessionId)?.folderPath ?? null, codexMode: 'conversation', startedAt: Date.now() } }); }
    else if (target === 'copy') { const message = s.messages.findLast(message => message.role === 'assistant' && !message.partial); if (message) void clipboardWrite(message.content); close(); }
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
      if (!/^\/[\w:-]*$/.test(text)) return false;
      const index = commands.findIndex(command => `/${command.name}` === text);
      if (index >= 0) chooseCommand(index); else { setMenu('commands'); setDismissed(null); }
      return true;
    };
    return () => { keyHandler.current = undefined; submitHandler.current = undefined; };
  });
  const modes = [
    { type: 'readOnly', label: t('codex.read_only'), description: t('codex.read_only_description'), approvalPolicy: 'on-request' },
    { type: 'workspaceWrite', label: t('codex.workspace'), description: t('codex.workspace_description'), approvalPolicy: 'on-request' },
    { type: 'dangerFullAccess', label: t('codex.full_access'), description: t('codex.full_access_description'), approvalPolicy: 'never' },
  ];
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => { const r = (shown === 'commands' ? commandsAnchor.current : anchor.current)?.getBoundingClientRect(); if (!r) return; const width = Math.min(shown === 'effort' ? 320 : ['permissions', 'skills', 'mcp', 'commands'].includes(shown) ? 420 : shown === 'context' ? 280 : 300, innerWidth - 16); const left = ['permissions', 'commands', 'skills', 'mcp'].includes(shown) ? r.left : r.right - width; setPosition({ position: 'fixed', left: Math.max(8, Math.min(left, innerWidth - width - 8)), bottom: innerHeight - r.top + 6, width, maxHeight: Math.max(50, r.top - 16) }); };
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
  const permission = modes.find(mode => mode.type === str(s.sandbox.type))?.label ?? t('codex.permissions');
  return <div className="claude-composer-controls codex-composer-controls" ref={root}>
    <button type="button" className="claude-control-icon" aria-label={t('claude.attach')} onClick={() => { void attach(); }}><AttachIcon /></button>
    <button type="button" ref={commandsAnchor} className="claude-control-icon" aria-label={t('codex.command')} aria-expanded={shown === 'commands'} onClick={e => show('commands', e.currentTarget)}>/</button>
    <button type="button" className="claude-permission-control" disabled={!s.ready || s.busy} aria-label={t('codex.permissions')} aria-expanded={menu === 'permissions'} onClick={e => show('permissions', e.currentTarget)}>{permission}</button>
    {children}
    <div className="claude-model-controls">
      {quota}
      <button type="button" className="claude-model-control" disabled={!s.ready || s.busy} aria-label={t('codex.model')} aria-expanded={menu === 'model'} onClick={e => show('model', e.currentTarget)}>{model?.displayName || s.model || 'Codex'}</button>
      {!!model?.supportedReasoningEfforts.length && <button type="button" className={`claude-effort-trigger${(s.effort || model.defaultReasoningEffort) === 'ultra' ? ' is-ultracode' : ''}`} disabled={!s.ready || s.busy} aria-label={t('claude.effort.title')} aria-expanded={menu === 'effort'} onClick={e => show('effort', e.currentTarget)}>{claudeEffortLabel(s.effort || model.defaultReasoningEffort, t)}</button>}
      <button type="button" className="claude-context-control" data-severity={percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal'} aria-label={`${t('claude.context_used')}: ${Math.round(percent)}%`} aria-haspopup="dialog" aria-expanded={menu === 'context'} onClick={e => show('context', e.currentTarget)}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle className="claude-context-track" cx="8" cy="8" r="6" /><circle className="claude-context-progress" cx="8" cy="8" r="6" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - percent} /></svg></button>
    </div>
    {shown && createPortal(<div ref={popup} className="claude-control-menu codex-control-menu" role="dialog" aria-label={t(shown === 'commands' ? 'codex.command' : shown === 'model' ? 'codex.model' : shown === 'effort' ? 'claude.effort.title' : shown === 'context' ? 'claude.context_window' : shown === 'skills' ? 'codex.skills' : shown === 'mcp' ? 'codex.mcp' : 'codex.permissions')} style={position}>
      {shown === 'commands' ? commands.length ? commands.map((command, index) => <button type="button" key={command.name} className={index === selected ? 'is-selected' : ''} disabled={disabled(command.target)} onMouseEnter={() => setSelected(index)} onClick={() => chooseCommand(index)}><strong>/{command.name}</strong><small>{command.description}</small></button>) : <div className="claude-menu-empty">{t('claude.commands_empty')}</div> : shown === 'skills' || shown === 'mcp' ? <>
        {pending ? <div className="claude-menu-empty">{t('diff.loading')}</div> : error ? <div className="claude-tool-error" role="alert">{error}</div> : !catalog.length ? <div className="claude-menu-empty">{t('claude.commands_empty')}</div> : catalog.map(entry => shown === 'skills' ? <button type="button" className="codex-permission-option" key={str(entry.path)} onClick={() => { onDraftChange(`${draft}${draft ? '\n' : ''}$${str(entry.name)} `); close(); document.querySelector<HTMLTextAreaElement>('.gambit-textarea')?.focus(); }}><strong>{str(obj(entry.interface).displayName) || str(entry.name)}</strong><small>{str(obj(entry.interface).shortDescription) || str(entry.shortDescription) || str(entry.description)}</small></button> : <details className="codex-catalog-entry" key={str(entry.name)}><summary>{str(entry.name)} <span>{Object.keys(obj(entry.tools)).length}</span></summary>{str(entry.toolsError) && <div className="claude-tool-error">{str(entry.toolsError)}</div>}{Object.entries(obj(entry.tools)).map(([name, tool]) => <div className="codex-catalog-tool" key={name}><strong>{name}</strong><small>{str(obj(tool).description)}</small></div>)}</details>)}
      </> : shown === 'model' ? s.models.filter(m => !m.hidden || m.model === s.model).map(m => <button type="button" key={m.id} disabled={s.busy} className={m.model === s.model ? 'is-selected' : ''} onClick={() => { configureCodex(sessionId, { model: m.model }); close(); }}><strong>{m.displayName}</strong>{m.model === s.model && <span aria-hidden="true">✓</span>}</button>) : shown === 'effort' && model ? <ClaudeEffortControl key={`${sessionId}:${model.model}`} levels={model.supportedReasoningEfforts.map(e => e.reasoningEffort)} value={s.effort || model.defaultReasoningEffort} disabled={!s.ready || s.busy} onCommit={async effort => { configureCodex(sessionId, { effort }); }} onClose={() => { close(); anchor.current?.focus(); }} /> : shown === 'context' ? <ContextUsage used={s.contextTokens} capacity={s.contextWindow} total={s.totalTokens} /> : <>
        {modes.map(mode => <button type="button" key={mode.type} disabled={!s.ready || s.busy} className={`codex-permission-option${s.sandbox.type === mode.type ? ' is-selected' : ''}`} onClick={() => { configureCodex(sessionId, { sandbox: { type: mode.type }, approvalPolicy: mode.approvalPolicy }); setMenu(null); }}><strong>{mode.label}{s.sandbox.type === mode.type ? ' ✓' : ''}</strong><small>{mode.description}</small></button>)}
        <div className="codex-permission-note">{t('codex.permissions_next_turn')}</div>
      </>}
    </div>, document.body)}
  </div>;
}
