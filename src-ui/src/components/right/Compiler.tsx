// RightPanel.tsx — Persistent task board and workspace review surfaces.
// .compiler-top wrapper styling lives in global.css (same selector,
// kept around because changing the wrapper class would touch every
// theme rule that scopes to it).

import { useEffect, useId, useState } from 'react';
import { useAppState, resolveDiffContext, type DiffSelection } from '../../store/app-state';
import { useGitStatus } from '../../lib/git-status';
import { useT } from '../../i18n/useT';
import { ChangesBoard } from './ChangesBoard';
import { TaskBoard } from './TaskBoard';

type RightView = 'tasks' | 'changes' | 'detail';
// The panel unmounts while hidden; remember which save already switched tabs so reopening keeps the user's tab.
let revealedPreInput = 0;

export function RightPanel() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const tabId = useId();
  const changes = useGitStatus();
  const [taskCount, setTaskCount] = useState(0);
  const selection = state.diffSelection;
  const [resting, setResting] = useState<{ view: RightView; selection: DiffSelection | null; mode: 'overlay' | 'tab' }>(() => {
    let view: RightView = 'changes';
    try {
      const saved = localStorage.getItem('cc-right-tab');
      if (saved === 'tasks' || (saved === null && localStorage.getItem('cc-left-tab') === 'tasks')) view = 'tasks';
    } catch { /* Storage unavailable. */ }
    return { view, selection, mode: state.diffMode };
  });
  useEffect(() => {
    try { localStorage.setItem('cc-right-tab', resting.view === 'tasks' ? 'tasks' : 'changes'); } catch { /* Storage unavailable. */ }
  }, [resting.view]);
  // Explicit tab visits keep their state; opening or moving a file right reveals detail.
  // Saving a draft as pre-input brings its tab forward.
  useEffect(() => {
    if (state.preInputReveal <= revealedPreInput) return;
    revealedPreInput = state.preInputReveal;
    setResting({ view: 'tasks', selection, mode: state.diffMode });
    // Only a new save switches tabs; later file selections still open their detail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.preInputReveal]);
  const view: RightView = state.diffMode === 'overlay' && selection && (selection !== resting.selection || state.diffMode !== resting.mode) ? 'detail'
    : resting.view === 'detail' && (!selection || state.diffMode !== 'overlay') ? 'changes' : resting.view;
  const selectView = (next: RightView) => {
    setResting({ view: next, selection, mode: state.diffMode });
    if (next === 'detail' && state.diffMode === 'tab') dispatch({ type: 'SET_DIFF_MODE', mode: 'overlay' });
  };
  const count = changes?.state === 'ok' ? changes.uncommitted.length + changes.untracked.length : 0;
  const tabs = [{ key: 'tasks', label: t('task.tab.tasks') }, { key: 'changes', label: t('task.tab.changes') }, { key: 'detail', label: t('changes.compare') }] as const;
  // Keep committed files from different commits distinct, matching ChangesBoard.
  const selectedPath = selection
    ? selection.kind === 'committed'
      ? `committed\x00${selection.commitHash ?? ''}\x00${selection.path}`
      : `${selection.kind}\x00${selection.path}`
    : null;
  return (
    <div className="compiler-top changes-board right-panel-workbench">
      <div className="changes-title" role="tablist" aria-label={t('changes.review')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const enabled = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
        const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + enabled.length) % enabled.length;
        event.preventDefault(); enabled[next]?.focus(); enabled[next]?.click();
      }}>
        {tabs.map(tab => <button type="button" role="tab" key={tab.key} id={`${tabId}-${tab.key}-tab`} aria-controls={`${tabId}-${tab.key}`} aria-selected={view === tab.key} tabIndex={view === tab.key ? 0 : -1} disabled={tab.key === 'detail' && !selection} onClick={() => selectView(tab.key)}><span className="right-tab-label">{tab.label}</span>{tab.key !== 'detail' && <span className="changes-title-count">{tab.key === 'tasks' ? taskCount : count}</span>}</button>)}
      </div>
      <div className="right-task-host" id={`${tabId}-tasks`} role="tabpanel" aria-labelledby={`${tabId}-tasks-tab`} hidden={view !== 'tasks'}><TaskBoard onCountChange={setTaskCount} /></div>
      <div className="right-review-host" hidden={view === 'tasks'}>
        <ChangesBoard key={resolveDiffContext(state.terminals.find(session => session.id === state.activeTerminalId))?.folderPath ?? ''} selectedPath={selectedPath} diffMode={state.diffMode} view={view === 'detail' ? 'detail' : 'changes'} active={view !== 'tasks'} idPrefix={tabId} />
      </div>
    </div>
  );
}
