// Read-only review of the active workspace: pending files and session commits.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, resolveDiffContext, type DiffSelection } from '../../store/app-state';
import { useGitStatus, useGitPollingGate } from '../../lib/git-status';
import { gitFolderKey, useProjectGitStatuses } from '../../lib/project-git-status';
import { commands, type GitFileEntry } from '../../tauri';
import { useT } from '../../i18n/useT';
import { ScrollPanel } from '../common/ScrollPanel';
import { ContextMenu, ThemedIcon, type CtxMenuState } from '../left/Explorer';
import { getFileIconSrc } from '../../lib/file-icons';
import { beginExplorerDrag } from '../../lib/explorer-drag';
import { HistoryGitMark } from './HistoryGitMark';
import { DiffPanel } from './DiffPanel';
import { ChangesScopePicker, type ChangeScope } from './ChangesScopePicker';
import './ChangesBoard.css';

interface ChangesBoardProps { selectedPath: string | null; diffMode: 'overlay' | 'tab'; view: 'changes' | 'detail'; active: boolean; idPrefix: string; }
type FileItem = { type: 'file'; key: string; entry: GitFileEntry; kind: 'uncommitted' | 'untracked' | 'committed'; commitHash?: string };
type RenderItem = FileItem | { type: 'header'; key: string; label: string; count: number } | { type: 'commit'; key: string; hash: string; message: string };
function Chevron({ open }: { open: boolean }) {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} /></svg>;
}

export function ChangesBoard({ selectedPath, diffMode, view, active, idPrefix }: ChangesBoardProps) {
  const t = useT();
  const { state, dispatch } = useAppState();
  const activeSession = state.terminals.find(session => session.id === state.activeTerminalId);
  const folder = resolveDiffContext(activeSession)?.folderPath ?? '';
  const changes = useGitStatus();
  useGitPollingGate(active);
  const ready = changes?.state === 'ok';
  const repoRoot = ready ? changes.repo_root : '';
  const statuses = useProjectGitStatuses(active && ready && folder ? [{ folder }] : []);
  const project = statuses.get(gitFolderKey(folder)), pr = project?.pull_request;
  const [scope, setScope] = useState<ChangeScope>('all');
  const [query, setQuery] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set());
  const [commitFiles, setCommitFiles] = useState<Map<string, GitFileEntry[]>>(new Map());
  const [commitErrors, setCommitErrors] = useState<Set<string>>(new Set());
  const pendingCommits = useRef(new Set<string>());
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const showDetail = active && view === 'detail';
  const toggleGroup = (key: string) => setCollapsed(previous => {
    const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next;
  });
  const needle = query.trim().toLocaleLowerCase();
  const items = useMemo<RenderItem[]>(() => {
    if (!ready) return [];
    const out: RenderItem[] = [];
    const append = (kind: 'uncommitted' | 'untracked', entries: GitFileEntry[]) => {
      const filtered = entries.filter(entry => !needle || entry.rel.toLocaleLowerCase().includes(needle));
      if (!filtered.length) return;
      out.push({ type: 'header', key: kind, label: t(`changes.${kind}`), count: filtered.length });
      if (!collapsed.has(kind)) filtered.forEach(entry => out.push({ type: 'file', key: `${kind}\x00${entry.path}`, entry, kind }));
    };
    if (scope !== 'committed') { append('uncommitted', changes.uncommitted); append('untracked', changes.untracked); }
    if (scope !== 'working' && changes.session_commits.length) {
      out.push({ type: 'header', key: 'committed', label: t('changes.session_commits'), count: changes.session_commits.length });
      if (!collapsed.has('committed')) for (const commit of changes.session_commits) {
        out.push({ type: 'commit', key: `commit-${commit.hash}`, hash: commit.hash, message: commit.message });
        if (expandedCommits.has(commit.hash)) for (const entry of commitFiles.get(commit.hash) ?? []) {
          if (!needle || entry.rel.toLocaleLowerCase().includes(needle)) out.push({ type: 'file', key: `committed\x00${commit.hash}\x00${entry.path}`, entry, kind: 'committed', commitHash: commit.hash });
        }
      }
    }
    return out;
  }, [ready, changes, scope, needle, collapsed, expandedCommits, commitFiles, t]);

  // Navigation follows the current filtered scope, including collapsed groups.
  const navigationFiles = useMemo<FileItem[]>(() => {
    if (!ready) return [];
    const out: FileItem[] = [];
    const add = (kind: FileItem['kind'], entries: GitFileEntry[], commitHash?: string) => {
      for (const entry of entries) if (!needle || entry.rel.toLocaleLowerCase().includes(needle)) out.push({ type: 'file', key: commitHash ? `committed\x00${commitHash}\x00${entry.path}` : `${kind}\x00${entry.path}`, entry, kind, commitHash });
    };
    if (scope !== 'committed') { add('uncommitted', changes.uncommitted); add('untracked', changes.untracked); }
    if (scope !== 'working') for (const commit of changes.session_commits) add('committed', commitFiles.get(commit.hash) ?? [], commit.hash);
    return out;
  }, [ready, changes, scope, needle, commitFiles]);
  const selectedIndex = navigationFiles.findIndex(file => file.key === selectedPath && repoRoot === state.diffSelection?.repoRoot);
  const selectFile = (file: FileItem) => {
    const selection: DiffSelection = { repoRoot, folderPath: folder, path: file.entry.path, rel: file.entry.rel, kind: file.kind, commitHash: file.commitHash, added: file.entry.added, deleted: file.entry.deleted };
    dispatch({ type: 'SET_DIFF_SELECTION', selection });
  };
  const navigation = selectedIndex < 0 ? undefined : {
    position: selectedIndex + 1, total: navigationFiles.length,
    onPrevious: () => selectFile(navigationFiles[(selectedIndex - 1 + navigationFiles.length) % navigationFiles.length]),
    onNext: () => selectFile(navigationFiles[(selectedIndex + 1) % navigationFiles.length]),
  };
  const toggleCommit = async (hash: string) => {
    if (expandedCommits.has(hash) && !commitErrors.has(hash)) {
      setExpandedCommits(previous => { const next = new Set(previous); next.delete(hash); return next; }); return;
    }
    setExpandedCommits(previous => new Set(previous).add(hash));
    if (commitFiles.has(hash) || pendingCommits.current.has(hash)) return;
    pendingCommits.current.add(hash);
    setCommitErrors(previous => { const next = new Set(previous); next.delete(hash); return next; });
    try { const files = await commands.gitCommitFiles(repoRoot, hash); setCommitFiles(previous => new Map(previous).set(hash, files)); }
    catch { setCommitErrors(previous => new Set(previous).add(hash)); }
    finally { pendingCommits.current.delete(hash); }
  };
  // Preserve progressive loading for large working trees.
  const [visibleCount, setVisibleCount] = useState(80);
  useEffect(() => { setVisibleCount(80); }, [items.length, query, scope]);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current; if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setVisibleCount(count => Math.min(items.length, count + 80)); }, { rootMargin: '300px' });
    observer.observe(sentinel); return () => observer.disconnect();
  }, [items.length, visibleCount]);
  const pending = ready ? [...changes.uncommitted, ...changes.untracked] : [];
  const count = pending.length;
  const totalAdded = pending.reduce((sum, entry) => sum + entry.added, 0), totalDeleted = pending.reduce((sum, entry) => sum + entry.deleted, 0);
  const emptyKey = !folder ? 'changes.choose_workspace' : !changes ? 'diff.loading' : changes.state === 'error' ? 'diff.error' : changes.state === 'no_git' ? 'changes.no_git' : changes.state === 'not_repo' ? 'changes.no_history' : needle ? 'changes.no_matches' : scope === 'committed' ? 'changes.empty' : 'changes.clean';
  return <div className="changes-fullview">
    <div className="changes-list-view" id={`${idPrefix}-changes`} role="tabpanel" aria-labelledby={`${idPrefix}-changes-tab`} hidden={showDetail}>
    {ready && <>
      <div className="changes-branch-header"><span className="changes-branch" title={changes.branch}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 3v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM15 6a9 9 0 0 0-9 9" /></svg><span className="changes-branch-name">{changes.branch}</span></span><span className="changes-baseline">{scope === 'committed' ? t('changes.session_commits') : 'HEAD → ' + t('changes.working_tree')}</span></div>
      {pr && <div className="changes-pr-row"><button type="button" className={`changes-pr-link is-${pr.state}`} onClick={() => { void commands.openUrl(pr.url).catch(console.error); }}><HistoryGitMark status={project} /><span>PR #{pr.number}</span><span className="changes-pr-state">{t(`history.git.${pr.state}`)}</span></button>{pr.ci && <span className={`changes-ci is-${pr.ci}`}>{t(`history.git.ci_${pr.ci}`)}</span>}</div>}
      <div className="changes-summary"><ChangesScopePicker value={scope} onChange={setScope} /><span className="changes-branch-stats">{scope === 'committed' ? <span>{t('changes.commit_count', { count: changes.session_commits.length })}</span> : <><span>{t('changes.file_count', { count })}</span><span className="diff-add">+{totalAdded}</span><span className="diff-del">−{totalDeleted}</span></>}</span></div>
      <div className="changes-search" role="search" aria-label={t('changes.filter')}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></svg><input ref={searchInput} type="text" role="searchbox" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('changes.filter')} aria-label={t('changes.filter')} />{query && <button type="button" className="changes-search-clear" aria-label={t('changes.clear_filter')} onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(''); searchInput.current?.focus(); }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></button>}</div>
    </>}
    <ScrollPanel className="changes-scroll"><div className="changes-list">
      {items.length === 0 && <div className="changes-empty" role="status">{t(emptyKey)}</div>}
      {items.slice(0, visibleCount).map(item => {
        if (item.type === 'header') return <button type="button" className="changes-group-header" key={item.key} aria-expanded={!collapsed.has(item.key)} onClick={() => toggleGroup(item.key)}><Chevron open={!collapsed.has(item.key)} /><span>{item.label}</span><span className="changes-group-count">{item.count}</span></button>;
        if (item.type === 'commit') return <div key={item.key}><button type="button" className="changes-commit-row" aria-expanded={expandedCommits.has(item.hash)} onClick={() => { void toggleCommit(item.hash); }}><Chevron open={expandedCommits.has(item.hash)} /><span className="changes-commit-subject" title={item.message}>{item.message}</span><span className="changes-commit-hash">{item.hash}</span></button>{expandedCommits.has(item.hash) && !commitFiles.has(item.hash) && <span className="changes-commit-loading">{t(commitErrors.has(item.hash) ? 'diff.error' : 'diff.loading')}</span>}</div>;
        const { entry } = item, basename = entry.rel.split('/').pop() || entry.rel, dir = entry.rel.slice(0, -basename.length).replace(/\/$/, '');
        const selected = selectedPath === item.key && repoRoot === state.diffSelection?.repoRoot;
        return <button type="button" key={item.key} className={`changes-row${selected ? ' selected' : ''}`} aria-pressed={selected} title={entry.rel} onClick={() => selectFile(item)} onMouseDown={event => beginExplorerDrag(entry.path, event)} onContextMenu={event => { event.preventDefault(); setCtxMenu({ x: event.clientX, y: event.clientY, absolutePath: entry.path, relativePath: entry.rel, isDir: false, compact: true }); }}>
          <span className="changes-file-icon" aria-hidden="true"><ThemedIcon src={getFileIconSrc(basename.split('.').pop() || '', state.iconTheme)} alt="" /></span><span className="changes-file-label"><span className="changes-name">{basename}</span>{dir && <span className="changes-path">{dir}</span>}</span><span className="changes-stats"><span className="diff-add">+{entry.added}</span><span className="diff-del">−{entry.deleted}</span></span><span className={`changes-status changes-status-${entry.status === '?' ? 'untracked' : entry.status.toLowerCase()}`}>{entry.status}</span>
        </button>;
      })}
      {visibleCount < items.length && <div ref={sentinelRef} className="changes-sentinel" aria-hidden="true" />}
    </div></ScrollPanel>
    {diffMode === 'tab' && navigation && <div className="changes-tab-navigation"><span>{navigation.position} / {navigation.total}</span><button type="button" onClick={navigation.onPrevious} aria-label={t('changes.previous_file')}>‹</button><button type="button" onClick={navigation.onNext} aria-label={t('changes.next_file')}>›</button></div>}
    <div className="changes-footer"><span className={`changes-footer-dot${ready ? ' is-ready' : ''}`} aria-hidden="true" /><span>{t(ready ? 'changes.auto_update' : 'changes.review')}</span></div>
    </div>
    <div className="changes-detail-pane" id={`${idPrefix}-detail`} role="tabpanel" aria-labelledby={`${idPrefix}-detail-tab`} hidden={!showDetail}>
      {diffMode === 'overlay' && state.diffSelection && <DiffPanel mode="overlay" {...state.diffSelection} isActive={showDetail} navigation={navigation} onClose={() => dispatch({ type: 'CLEAR_DIFF' })} onToggleExpanded={() => dispatch({ type: 'SET_DIFF_MODE', mode: 'tab' })} />}
    </div>
    {ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
  </div>;
}
