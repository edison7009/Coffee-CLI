import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { receiveOrchestration, useOrchestration } from '../../lib/orchestration';
import './ClaudeComposerControls.css';

const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', dsh: 'DeepSeek Harness', pi: 'Pi' };
const name = (tool: string) => NAMES[tool] ?? tool;

/** The composer's orchestration chip: lets one conversation leave the choice of worker to the AI or narrow it to some assistants. */
export function OrchestrationPicker({ sessionId }: { sessionId: string }) {
  const t = useT();
  const { agents = [], picks = {} } = useOrchestration();
  // A pick naming only assistants turned off since counts as automatic, the same as the backend.
  const pick = (picks[sessionId] ?? []).filter(tool => agents.includes(tool));
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(220, window.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 6, width, maxHeight: Math.max(0, rect.top - 14) });
    };
    update(); window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!anchor.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [sessionId]);
  const save = async (tools: string[]) => {
    setPending(true);
    try { receiveOrchestration(await commands.orchestrationSetPick(sessionId, tools)); }
    catch (error) { console.warn('[orchestration] pick not saved:', error); }
    finally { setPending(false); }
  };
  // One preferred assistant, or the AI's own choice among the enabled ones.
  const current = pick.length === 1 ? pick[0] : null;
  // A pick of several (saved by an earlier build) still limits the backend, so the label names them all.
  const label = pick.length ? pick.map(name).join('、') : t('orchestration.role.auto');
  const options: { tool: string | null; text: string }[] = [{ tool: null, text: t('orchestration.role.auto') }, ...agents.map(tool => ({ tool, text: name(tool) }))];
  return <>
    <button ref={anchor} type="button" className="gambit-capability is-orchestration is-picker" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t('orchestration.pick.prefix', { name: label })}
    </button>
    {open && createPortal(<div className="claude-control-menu orchestration-pick-menu" ref={popup} role="dialog" aria-label={t('tools.tab.orchestration')} style={position} onMouseDown={e => e.stopPropagation()}>
      {options.map(option => <button key={option.tool ?? 'auto'} type="button" role="menuitemradio" aria-checked={current === option.tool} disabled={pending} className={current === option.tool ? 'is-selected' : ''} onClick={() => { void save(option.tool ? [option.tool] : []); setOpen(false); }}>
        <span>{option.text}</span>
        {/* A fixed slot, so the mark appearing never shifts the row. */}
        <span className="orchestration-pick-check" aria-hidden="true">{current === option.tool ? '✓' : ''}</span>
      </button>)}
    </div>, document.body)}
  </>;
}
