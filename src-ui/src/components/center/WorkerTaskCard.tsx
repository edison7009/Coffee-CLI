import { useState } from 'react';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { useOrchestration, workerState } from '../../lib/orchestration';
import { getToolDisplayName } from '../../lib/tool-info';
import type { WorkerPrompt } from '../../lib/worker-prompt';
import { MarkdownContent } from './MarkdownContent';
import './WorkerTaskCard.css';

/** 方案 A: a sub-task opens with a quiet card — who assigned it, the task itself in full, its tool and state — and
 *  keeps Coffee CLI's English instructions to the AI one click away instead of posing as the user's message. */
export function WorkerTaskCard({ prompt }: { prompt: WorkerPrompt }) {
  const t = useT();
  const { state, dispatch } = useAppState();
  const orchestration = useOrchestration();
  const [open, setOpen] = useState(false);
  const task = orchestration.tasks.find(item => item.id === prompt.id);
  const parent = task ? state.terminals.find(tab => tab.id === task.parentId) : undefined;
  const child = task ? state.terminals.find(tab => tab.id === task.sessionId) : undefined;
  const status = task ? workerState(task, child) : null;
  const parentTitle = parent ? parent.pinnedTitle || parent.toolTitle || getToolDisplayName(parent.tool ?? '') : null;
  const [before, after = ''] = t('worker.from').split('{parent}');
  // article / p, not div: the material shapes clear every div inside the centre panel, which would take the card's
  // own ground and hairlines with it (global.css, the Glass / Carbon rule).
  return <article className="worker-card" data-tool={task?.tool}>
    <p className="worker-card-top">
      {/* Lucide corner-down-right; license in /icons/LICENSE-lucide.txt. */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 10 5 5-5 5" /><path d="M4 4v7a4 4 0 0 0 4 4h12" /></svg>
      {parent && parentTitle
        ? <span className="worker-card-from">{before}<button type="button" className="worker-card-parent" onClick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: parent.id })}>{parentTitle}</button>{after}</span>
        : <span className="worker-card-from">{t(task?.parentTool === 'device' ? 'worker.from_device' : 'worker.label')}</span>}
      {status && <span className="worker-card-state" data-state={status}>{(status === 'working' || status === 'starting') && <span className="worker-card-spin" aria-hidden="true" />}{t(`orchestration.${status}`)}</span>}
    </p>
    <div className="worker-card-task"><MarkdownContent content={prompt.task} /></div>
    <p className="worker-card-foot">
      {task && <span>{getToolDisplayName(task.tool)}</span>}
      <span className="worker-card-id">{prompt.id}</span>
      <button type="button" className="worker-card-more" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {t(open ? 'worker.instructions_hide' : 'worker.instructions')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={open ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'} /></svg>
      </button>
    </p>
    {open && <pre className="worker-card-instructions">{prompt.instructions}</pre>}
  </article>;
}
