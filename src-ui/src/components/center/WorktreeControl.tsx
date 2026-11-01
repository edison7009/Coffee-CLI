import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppState, type TerminalSession } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { createWorktree, insideWorktrees, worktreeFromPath, mergeWorktree, removeWorktree, sweepWorktrees, worktreeAvailable, worktreeStatus, type Worktree, type WorktreeStatus } from '../../lib/worktree';

/** Projects swept for leftover worktrees in this run of the app. */
const swept = new Set<string>();

/**
 * The composer's worktree switch. Before a conversation starts it moves the tab into its own copy of the project on
 * a new branch, or back; once the conversation has started it shows the branch and merges it into the project.
 * Mounted per tab, so nothing it shows carries over to another tab.
 */
export function WorktreeControl({ tab, started, running }: { tab: TerminalSession; started: boolean; running: boolean }) {
  const t = useT(), dispatch = useAppDispatch(), { state } = useAppState();
  const [available, setAvailable] = useState(false), [pending, setPending] = useState(false);
  const [status, setStatus] = useState<WorktreeStatus | null>(null), [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const worktree = tab.worktree, locked = started || (!!tab.resumeToken && tab.resumeToken !== tab.ownToken);
  const cwd = tab.worktreeOrigin ?? tab.folderPath ?? '';
  // Creating a worktree takes a moment; the conversation may start meanwhile, which then keeps its folder.
  const live = useRef({ started, running });
  useEffect(() => { live.current = { started, running }; }, [started, running]);
  const revision = useRef(0);
  // Only a change in which worktrees are open matters: each check below runs git, and tabs update on every status frame.
  const inUse = state.terminals.flatMap(other => other.worktree ? [other.worktree.path] : []).join('\n');

  const refresh = useCallback((target: Worktree) => {
    const version = ++revision.current;
    void worktreeStatus(target).then(value => { if (version === revision.current) setStatus(value); }, () => { if (version === revision.current) setStatus(null); });
  }, []);

  useEffect(() => {
    if (worktree || locked || !cwd || insideWorktrees(cwd)) { setAvailable(false); return; }
    let current = true;
    void worktreeAvailable(cwd).then(value => {
      if (!current) return;
      setAvailable(value);
      if (value && !swept.has(cwd)) { swept.add(cwd); void sweepWorktrees(cwd, inUse ? inUse.split('\n') : []); }
    });
    return () => { current = false; };
  }, [worktree, locked, cwd, inUse]);

  // The branch is read again whenever a turn ends, as that is when the conversation leaves new work on it.
  useEffect(() => { if (worktree && locked && !running) refresh(worktree); }, [worktree, locked, running, refresh]);

  // A notice floats above the composer: a success fades on its own, a refusal stays until dismissed or replaced.
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!worktree && insideWorktrees(cwd)) return null;
  const bubble = notice && <span className="gambit-worktree-notice" data-error={notice.error || undefined} role="status" onClick={() => setNotice(null)}>{notice.text}</span>;
  const chip = (disabled: boolean, onClick?: () => void) => <button type="button" role="checkbox" className="gambit-worktree-toggle" aria-checked={!!worktree} disabled={disabled} onClick={onClick}>
    <span className="gambit-worktree-box" aria-hidden="true">{worktree && <CheckIcon />}</span>{t('gambit.worktree')}
  </button>;

  if (!locked) {
    const toggle = async () => {
      if (pending || running) return;
      setPending(true); setNotice(null);
      try {
        const newId = crypto.randomUUID();
        if (worktree) { dispatch({ type: 'SET_TERMINAL_WORKTREE', id: tab.id, newId, cwd, worktree: undefined }); return; }
        const created = await createWorktree(cwd, tab.tool ?? 'session');
        if (live.current.started || live.current.running) { void removeWorktree(created.worktree); return; }
        dispatch({ type: 'SET_TERMINAL_WORKTREE', id: tab.id, newId, cwd: created.cwd, worktree: created.worktree, origin: cwd });
      } catch (error) { setNotice({ text: t('gambit.worktree_failed', { error: String(error) }), error: true }); }
      finally { setPending(false); }
    };
    const disabled = pending || running || (!worktree && !available);
    return <span className="gambit-worktree" data-tip={notice ? undefined : !worktree && !available ? t('gambit.worktree_unavailable') : t('gambit.worktree_hint')}>
      {chip(disabled, () => { void toggle(); })}
      {bubble}
    </span>;
  }

  // Once the conversation has started, only a worktree conversation keeps its chip, locked.
  if (!worktree) return null;

  const merge = async () => {
    if (!worktree || pending || running) return;
    setPending(true); setNotice(null);
    try {
      const count = await mergeWorktree(worktree, `Coffee: ${tab.pinnedTitle || tab.toolTitle || worktree.branch}`);
      setNotice({ text: count ? t('gambit.worktree_merged', { count }) : t('gambit.worktree_nothing') });
    } catch (error) {
      const text = String(error);
      setNotice({ error: true, text: text.includes('COFFEE_MERGE:conflict') ? t('gambit.worktree_conflict') : text.includes('COFFEE_MERGE:local_changes') ? t('gambit.worktree_local_changes') : t('gambit.worktree_merge_failed', { error: text }) });
    } finally { refresh(worktree); setPending(false); }
  };
  const mergeable = !!status?.exists && (status.ahead > 0 || status.dirty);
  return <span className="gambit-worktree" data-locked="" data-tip={notice ? undefined : t('gambit.worktree_branch', { branch: worktree.branch })}>
    {chip(true)}
    {mergeable && !running && <button type="button" className="gambit-worktree-merge" disabled={pending} onClick={() => { void merge(); }}>{t('gambit.worktree_merge', { target: status!.target || 'HEAD' })}</button>}
    {bubble}
  </span>;
}

function CheckIcon() {
  return <svg className="gambit-worktree-check" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.25 3.25L13 5" /></svg>;
}

/** Removes a tab's worktree once no tab uses it, through git's safe removal. */
export function WorktreeJanitor() {
  const { state } = useAppState();
  const known = useRef(new Set<string>());
  // Only a change in which worktrees are open matters, not every status or title frame.
  const key = state.terminals.flatMap(tab => tab.worktree ? [tab.worktree.path] : []).sort().join('\n');
  useEffect(() => {
    const live = new Set(key ? key.split('\n') : []);
    for (const path of known.current) {
      if (live.has(path)) continue;
      known.current.delete(path);
      const worktree = worktreeFromPath(path);
      if (worktree) void removeWorktree(worktree);
    }
    for (const path of live) known.current.add(path);
  }, [key]);
  return null;
}
