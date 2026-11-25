import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import { useHoverOpen } from '../../lib/use-hover-open';
import './ClaudeComposerControls.css';

export interface SubTask { id: string; description: string }

/** The composer's running sub-task chip and its list, opened on hover or click, as in the Claude composer. */
export function SubTasksControl({ tasks, fallback }: { tasks: SubTask[]; fallback: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement>(null);
  const hover = useHoverOpen(() => setOpen(true), () => setOpen(false), open);
  const shown = open && tasks.length > 0;
  useLayoutEffect(() => {
    if (!shown) return;
    const update = () => { const r = button.current?.getBoundingClientRect(); if (!r) return; const width = Math.min(280, innerWidth - 16); setPosition({ position: 'fixed', left: Math.max(8, Math.min(r.right - width, innerWidth - width - 8)), bottom: innerHeight - r.top + 6, width, maxHeight: Math.max(50, r.top - 16) }); };
    update(); addEventListener('resize', update); return () => removeEventListener('resize', update);
  }, [shown]);
  if (!tasks.length) return null;
  const label = t('claude.status.background_count', { count: tasks.length });
  return <>
    <button type="button" ref={button} className="claude-tasks-control" aria-label={label} aria-expanded={shown} {...hover.trigger} onClick={() => setOpen(true)}>{t('claude.status.background_short', { count: tasks.length })}</button>
    {shown && createPortal(<div className="claude-control-menu" role="dialog" aria-label={label} style={position} {...hover.popover}>
      <div className="claude-tasks-heading">{label}</div>
      {tasks.map(task => <div key={task.id} className="claude-tasks-item"><span className="claude-tasks-dot" aria-hidden="true" /><span>{task.description || fallback}</span></div>)}
    </div>, document.body)}
  </>;
}
