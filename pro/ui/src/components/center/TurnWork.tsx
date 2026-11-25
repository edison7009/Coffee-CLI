import { useContext, useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { formatElapsed } from '../../lib/claude-i18n';
import { ConversationDirectory } from '../../lib/conversation-links';
import { absoluteToolPath, type ChangedFile, type TurnFold } from '../../lib/turn-work';
import { useOpenChangedFile } from '../../lib/use-turn-work';
import { useHoverTip } from '../common/HoverTip';
import { Chevron } from './ConversationControls';
import { ThemedIcon } from '../common/ThemedIcon';
import { getFileIconSrc } from '../../lib/file-icons';
import { useAppState } from '../../store/app-state';
import './TurnWork.css';

const elapsed = formatElapsed;
const ICONS: Record<string, ReactNode> = {
  failed: <path d="M18 6 6 18M6 6l12 12" />,
  eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
  file: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
};
const stepIcon = (key: string) => <svg className="claude-step-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[key]}</svg>;

/** A finished turn's thinking and calls as one quiet line: 「7 步 · 45 秒」, a dot per step (blue a changed file, red a
 *  failure) and, after a failure, whether the turn recovered. Opens into the steps. */
export function TurnFoldRow({ fold, open, onToggle }: { fold: TurnFold; open: boolean; onToggle: () => void }) {
  const t = useT();
  const failures = fold.steps.filter(step => step === 'fail').length;
  const label = [fold.stopped && t('turn.stopped_plain'), t('turn.steps', { count: fold.steps.length }), fold.durationMs !== undefined && elapsed(fold.durationMs, t)].filter(Boolean).join(' · ');
  const dots = fold.steps.length > MAX_DOTS ? fold.steps.slice(-MAX_DOTS) : fold.steps;
  return <button type="button" className={`turn-fold${open ? ' is-open' : ''}`} aria-expanded={open} onClick={onToggle}>
    <Chevron open={open} />
    <span className="turn-fold-label">{label}</span>
    <span className="turn-fold-dots" aria-hidden="true">{fold.steps.length > MAX_DOTS && <span className="turn-fold-more">…</span>}{dots.map((step, i) => <i key={i} className={`is-${step}`} />)}</span>
    {failures > 0 && <span className="turn-fold-warn">{fold.steps.at(-1) === 'fail' ? t('turn.last_failed') : t('turn.fixed_after', { count: failures })}</span>}
  </button>;
}
const MAX_DOTS = 24;

const relativeTo = (path: string, cwd: string | null) => {
  const absolute = absoluteToolPath(path, cwd), base = cwd ? `${absoluteToolPath(cwd, null).replace(/\/$/, '')}/` : '';
  return base && absolute.toLowerCase().startsWith(base.toLowerCase()) ? absolute.slice(base.length) : absolute;
};

/** The files a turn changed, after its reply: a badge for written or edited, the name in link blue and its folder
 *  muted; each row opens that file's diff and the heading's button the first. Past eight, six and 「还有 N 个文件」. */
export function ChangedFilesCard({ files }: { files: ChangedFile[] }) {
  const t = useT();
  const cwd = useContext(ConversationDirectory);
  const openFile = useOpenChangedFile();
  const { state: { iconTheme } } = useAppState();
  const [all, setAll] = useState(false);
  const { tipFor, tip } = useHoverTip('hover-tip--wide');
  const added = files.reduce((n, file) => n + file.added, 0), removed = files.reduce((n, file) => n + file.removed, 0);
  const shown = all || files.length <= 8 ? files : files.slice(0, 6);
  const stat = (a: number, r: number) => <span className="turn-files-stat"><i className="is-add">+{a}</i><i className="is-del">−{r}</i></span>;
  return <section className="turn-files" aria-label={t('turn.files_changed', { count: files.length })}>
    <div className="turn-files-head">
      <span className="turn-files-title">{t('turn.files_changed', { count: files.length })}</span>{stat(added, removed)}
      <button type="button" className="turn-files-view" onClick={() => openFile(files[0].path)}>{stepIcon('eye')}{t('turn.view_changes')}</button>
    </div>
    <ul className="turn-files-list">{shown.map(file => {
      const relative = relativeTo(file.path, cwd), cut = relative.lastIndexOf('/') + 1;
      return <li key={file.path}>
        <button type="button" className="turn-file" onClick={() => openFile(file.path)} {...tipFor(absoluteToolPath(file.path, cwd))}>
          {/* The file's type, drawn as in the file tree and the changes list (the +/− counts say added or edited). */}
          <span className="turn-file-icon" aria-hidden="true"><ThemedIcon src={getFileIconSrc(relative.slice(cut).split('.').pop() || '', iconTheme)} alt="" /></span>
          <span className="turn-file-name">{relative.slice(cut)}</span><span className="turn-file-dir">{relative.slice(0, cut)}</span>{stat(file.added, file.removed)}
        </button>
      </li>;
    })}</ul>
    {shown.length < files.length && <button type="button" className="turn-file turn-files-more" onClick={() => setAll(true)}>{t('turn.more_files', { count: files.length - shown.length })}<Chevron open={false} /></button>}
    {tip}
  </section>;
}

/** The turn's one timer, under its steps, for every tool alike: the tool's own small mark, a word, the time so far.
 *  The step under way is on the line above, so this line never repeats it. */
export function StepWorking({ mark, label, startedAt, className = '' }: { mark: ReactNode; label: string; startedAt?: number; className?: string }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <div className={`claude-working step-working ${className}`} role="status">
    <span className="step-working-mark" aria-hidden="true">{mark}</span>
    <span className="step-working-word">{label}</span>
    {startedAt !== undefined && <span className="claude-elapsed">{elapsed(Math.max(0, now - startedAt), t)}</span>}
  </div>;
}
