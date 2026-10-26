import type { GitProjectStatus } from '../../tauri';
import { useT } from '../../i18n/useT';

/** One small resting mark; the live working spinner takes priority in a session row. */
export function HistoryGitMark({ status }: { status: GitProjectStatus | null | undefined }) {
  const t = useT();
  if (!status?.pull_request) return null;
  const pr = status.pull_request;
  const state = pr.state;
  const label = `${t('history.git.current_branch')}: ${status.branch} · #${pr.number} ${t(`history.git.${pr.state}`)}${pr.ci ? ` · CI: ${t(`history.git.ci_${pr.ci}`)}` : ''}`;
  return <span className={`history-git-mark is-${state}`} role="img" aria-label={label} title={label}>
    {/* Lucide git-* icons; license: /icons/LICENSE-lucide.txt. */}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />{state === 'merged' ? <path d="M6 21V9a9 9 0 0 0 9 9" />
          : state === 'closed' ? <><path d="m15.5 3.5 5 5m0-5-5 5M18 11.62V15M6 9v12" /></>
            : <><path d="M6 9v12" />{state === 'draft' ? <path d="M18 6V5m0 6v-1" /> : <path d="M13 6h3a2 2 0 0 1 2 2v7" />}</>}
    </svg>
    {pr.ci && <span className={`history-git-ci is-${pr.ci}`} aria-hidden="true">{pr.ci === 'success' ? '✓' : pr.ci === 'failure' ? '×' : '·'}</span>}
  </span>;
}
