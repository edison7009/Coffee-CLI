import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { controlClaude, useClaudeSession } from '../../lib/claude-session';
import { ClaudeEffortControl } from './ClaudeEffortControl';
import { ContextUsage } from './ContextUsage';
import { object, number } from '../../lib/claude-protocol';
import { useT } from '../../i18n/useT';
import { claudeEffortLabel } from '../../lib/claude-i18n';
import './ClaudeComposerControls.css';

type Menu = 'commands' | 'model' | 'effort' | 'permissions' | 'context' | null;
export function ClaudeComposerControls({ sessionId, draft, onDraftChange, keyHandler, children }: {
  sessionId: string; draft: string; onDraftChange: (value: string) => void;
  keyHandler: MutableRefObject<((event: KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>;
  children?: ReactNode;
}) {
  const t = useT();
  const s = useClaudeSession(sessionId);
  const [menu, setMenu] = useState<Menu>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null);
  const anchors = useRef<Partial<Record<NonNullable<Menu>, HTMLButtonElement | null>>>({});
  const [position, setPosition] = useState<CSSProperties>({});
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const model = s.models.find(m => m.value === s.model) ?? s.models.find(m => m.resolvedModel === s.model) ?? s.models[0];
  const effort = s.ultracode ? 'ultracode' : s.effort;
  const contextPercent = s.contextWindow > 0 ? Math.max(0, Math.min(100, s.contextTokens / s.contextWindow * 100)) : 0;
  const contextSeverity = contextPercent >= 90 ? 'critical' : contextPercent >= 75 ? 'warning' : 'normal';
  const tokenKeys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
  const modelUsage = Object.values(s.modelUsage).map(object);
  const totalTokens = modelUsage.some(model => tokenKeys.some(key => typeof model[key] === 'number'))
    ? modelUsage.reduce((total, model) => total + tokenKeys.reduce((sum, key) => sum + number(model[key]), 0), 0) : undefined;
  const slash = /^\/[\w:-]*$/.test(draft) && dismissed !== draft;
  const shown = menu ?? (slash ? 'commands' : null);
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => {
      const rect = anchors.current[shown]?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(shown === 'context' ? 280 : shown === 'effort' ? 320 : 480, window.innerWidth - 16);
      const left = shown === 'model' || shown === 'effort' || shown === 'context' ? rect.right - width : rect.left;
      setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 6, width, maxHeight: Math.max(0, rect.top - 14) });
    };
    update();
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    const gambit = root.current?.closest('.gambit');
    if (gambit) observer.observe(gambit);
    window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [shown]);
  const close = () => { setMenu(null); setDismissed(draft); };
  const open = (value: Menu) => { setMenu(value); setSelected(0); };
  const commands = useMemo(() => {
    const local = [
      { name: 'model', description: t('claude.command.model'), action: 'model' },
      { name: 'permissions', description: t('claude.command.permissions'), action: 'permissions' },
      { name: 'plan', description: t('claude.command.plan'), action: 'plan' },
      { name: 'thinking', description: t('claude.command.thinking'), action: 'thinking' },
    ];
    const items = [...local, ...s.commands.filter(c => !local.some(l => l.name === c.name)).map(c => ({ ...c, action: 'send' }))];
    const query = slash ? draft.slice(1).toLowerCase() : '';
    return items.filter(c => c.name.toLowerCase().includes(query));
  }, [s.commands, draft, slash, t]);
  const change = async (request: Record<string, unknown>, keepOpen = false) => {
    if (pending) return;
    setPending(true);
    try { await controlClaude(sessionId, request); if (!keepOpen) close(); } catch { /* session error is visible in the conversation */ } finally { setPending(false); }
  };
  const chooseCommand = (index: number) => {
    const item = commands[index]; if (!item) return;
    if (item.action === 'model' || item.action === 'permissions') { onDraftChange(''); open(item.action); }
    else if (item.action === 'plan') { onDraftChange(''); void change({ subtype: 'set_permission_mode', mode: 'plan' }); }
    else if (item.action === 'thinking') { onDraftChange(''); void change({ subtype: 'apply_flag_settings', settings: { alwaysThinkingEnabled: !s.thinking } }); }
    else { onDraftChange(`/${item.name} `); close(); }
  };
  useEffect(() => {
    keyHandler.current = event => {
      if (!shown || event.nativeEvent.isComposing) return false;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return true; }
      if (shown !== 'commands' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setSelected(i => (i + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % Math.max(commands.length, 1)); return true; }
      if ((event.key === 'Enter' || event.key === 'Tab') && commands.length) { event.preventDefault(); chooseCommand(Math.min(selected, commands.length - 1)); return true; }
      return false;
    };
    return () => { keyHandler.current = undefined; };
  });
  useEffect(() => {
    if (!shown) return;
    const dismiss = () => { setMenu(null); setDismissed(draft); };
    // Gambit stops bubbling mouse events to keep terminal focus enforcement out.
    const dismissOutside = (e: Event) => { if (!root.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) dismiss(); };
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); dismiss(); anchors.current[shown]?.focus(); } };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismissOutside, true); document.removeEventListener('focusin', dismissOutside, true); document.removeEventListener('keydown', escape); };
  }, [shown, draft]);
  useEffect(() => { setMenu(null); setSelected(0); setDismissed(null); }, [sessionId]);
  const attach = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const paths = await open({ multiple: true, directory: false });
    if (paths) onDraftChange(`${latestDraft.current}${latestDraft.current ? '\n' : ''}${(Array.isArray(paths) ? paths : [paths]).map(p => `"${p}"`).join(' ')}`);
  };
  const modes = [
    { value: 'default', label: t('claude.permission.manual'), description: t('claude.permission.manual_description') },
    { value: 'plan', label: t('claude.permission.plan'), description: t('claude.permission.plan_description') },
    { value: 'acceptEdits', label: t('claude.permission.edit'), description: t('claude.permission.edit_description') },
    ...(model?.supportsAutoMode ? [{ value: 'auto', label: t('claude.permission.auto'), description: t('claude.permission.auto_description') }] : []),
    { value: 'bypassPermissions', label: t('claude.permission.bypass'), description: t('claude.permission.bypass_description') },
  ];
  return <div className="claude-composer-controls" ref={root}>
    <button className="claude-control-icon" aria-label={t('claude.attach')} onClick={() => void attach()}>＋</button>
    <button ref={el => { anchors.current.commands = el; }} className="claude-control-icon" aria-label={t('claude.commands')} aria-expanded={shown === 'commands'} onClick={() => shown === 'commands' ? close() : open('commands')}>/</button>
    <button ref={el => { anchors.current.permissions = el; }} className="claude-permission-control" disabled={!s.ready} onClick={() => shown === 'permissions' ? close() : open('permissions')} aria-expanded={shown === 'permissions'} aria-label={t('claude.permissions')}>{modes.find(m => m.value === s.permissionMode)?.label ?? s.permissionMode}</button>
    {children}
    <div className="claude-model-controls">
    <button ref={el => { anchors.current.model = el; }} className="claude-model-control" disabled={!s.ready} onClick={() => shown === 'model' ? close() : open('model')} aria-expanded={shown === 'model'} aria-label={t('claude.model')}>{model?.resolvedModel || s.model || 'Claude'}</button>
    {model?.supportsEffort && <button ref={el => { anchors.current.effort = el; }} className={`claude-effort-trigger${s.ultracode ? ' is-ultracode' : ''}`} disabled={!s.ready} onClick={() => shown === 'effort' ? close() : open('effort')} aria-expanded={shown === 'effort'} aria-label={t('claude.effort.title')}>{claudeEffortLabel(effort, t)}</button>}
    <button ref={el => { anchors.current.context = el; }} className="claude-context-control" data-severity={contextSeverity} aria-label={`${t('claude.context_used')}: ${Math.round(contextPercent)}%`} aria-haspopup="dialog" aria-expanded={shown === 'context'} onClick={() => shown === 'context' ? close() : open('context')}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle className="claude-context-track" cx="8" cy="8" r="6" /><circle className="claude-context-progress" cx="8" cy="8" r="6" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - contextPercent} /></svg>
    </button>
    </div>
    {shown && createPortal(<div className="claude-control-menu" ref={popup} role="dialog" aria-label={t(shown === 'context' ? 'claude.context_window' : shown === 'commands' ? 'claude.commands' : shown === 'model' ? 'claude.model' : shown === 'effort' ? 'claude.effort.title' : 'claude.permissions')} style={position} onMouseDown={e => e.stopPropagation()}>
      {shown === 'context' ? <ContextUsage used={s.contextTokens} capacity={s.contextWindow} total={totalTokens} /> : shown === 'commands' ? commands.length ? commands.map((c, i) => <button key={c.name} className={i === selected ? 'is-selected' : ''} onMouseEnter={() => setSelected(i)} onClick={() => chooseCommand(i)}><strong>/{c.name}</strong><small>{c.description}</small></button>) : <div className="claude-menu-empty">{t('claude.commands_empty')}</div> : shown === 'permissions' ? modes.map(m => <button key={m.value} disabled={pending} className={s.permissionMode === m.value ? 'is-selected' : ''} onClick={() => void change({ subtype: 'set_permission_mode', mode: m.value }, true)}><strong>{m.label}{s.permissionMode === m.value ? ' ✓' : ''}</strong><small>{m.description}</small></button>) : <>
        {shown === 'model' && s.models.map(m => <button key={m.value} disabled={pending} className={m.value === model?.value ? 'is-selected' : ''} onClick={() => void change({ subtype: 'set_model', model: m.value })}><strong>{m.displayName}{m.value === model?.value ? ' ✓' : ''}</strong><small>{m.description}</small></button>)}
        {shown === 'effort' && model?.supportsEffort && <ClaudeEffortControl key={`${sessionId}:${model.value}`} levels={[...(model.supportedEffortLevels ?? []), 'ultracode']} value={effort} disabled={pending} onClose={() => { close(); anchors.current.effort?.focus(); }} onCommit={level => change({ subtype: 'apply_flag_settings', settings: level === 'ultracode' ? { effortLevel: 'xhigh', ultracode: true } : { effortLevel: level, ultracode: false } }, true)} />}
        {shown === 'effort' && model?.supportsThinkingOff && <button className="claude-thinking-toggle" disabled={pending} onClick={() => void change({ subtype: 'apply_flag_settings', settings: { alwaysThinkingEnabled: !s.thinking } }, true)}><strong>{t('claude.thinking_extended')}</strong><span>{t(s.thinking ? 'settings.sound.on' : 'settings.sound.off')}</span></button>}
      </>}
    </div>, document.body)}
  </div>;
}
