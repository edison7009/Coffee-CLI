import { useT } from '../../i18n/useT';
import { useSelfUpdate } from '../../lib/use-self-update';
import { IS_WINDOWS } from '../../lib/platform';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';

/** The app's own update, wherever it sits: Code's sidebar footer or Work's icon rail (`rail`). It checks once for
 *  a newer version and shows nothing until there is one. The first click downloads; the step that installs (the
 *  second click on Windows, the first elsewhere, where the download opens the installer) first shows the new
 *  version's notes with 开始更新. See lib/use-self-update.ts. */
export function AppUpdateButton({ rail = false, tip }: { rail?: boolean; tip?: (label: string) => Record<string, unknown> }) {
  const t = useT();
  const selfUpdate = useSelfUpdate();
  const updateVersion = selfUpdate.version, installed = selfUpdate.installed;
  const installPhase = selfUpdate.progress?.status ?? null;
  const installPct = selfUpdate.progress?.percent ?? 0;
  const installing = installPhase !== null;

  // The update download sits in the sidebar's bottom row, left of settings, where most desktop apps keep it.
  // Windows installs silently and relaunches, so "launching" means restarting;
  // macOS / Linux only open the DMG or folder, so keep showing 100%.
  const restarting = IS_WINDOWS && installPhase === 'launching';
  const readyToInstall = selfUpdate.ready && !installing;
  const updateLabel = !installing
    ? t(readyToInstall ? 'self_update.install' : 'self_update.download', { version: updateVersion ?? '' })
    : installPhase === 'speed_test'
      ? t('self_update.connecting')
      : restarting
        ? t('self_update.restarting')
        : t('self_update.downloading', { percent: Math.max(0, Math.min(100, installPct)) });
  return <>
    {updateVersion ? (
    <button
      className={`${rail ? 'icon-rail-button icon-rail-update' : 'sidebar-footer-button'} update-check-btn update-available${installing ? ' is-installing' : ''}${readyToInstall ? ' is-ready' : ''}`}
      onClick={() => void selfUpdate.activate()}
      disabled={installing}
      aria-label={updateLabel}
      aria-busy={installing}
      data-tip={rail ? undefined : updateLabel}
      {...(rail && tip ? tip(updateLabel) : {})}
    >
      {restarting ? (
        /* Lucide rotate-cw; license in /icons/LICENSE-lucide.txt. */
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
      ) : installing ? (
        <svg
          aria-hidden="true"
          className={`update-ring${installPhase === 'speed_test' ? ' spin' : ''}`}
          width="15"
          height="15"
          viewBox="0 0 24 24"
        >
          <circle className="update-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.6" />
          <circle
            className="update-ring-progress"
            cx="12"
            cy="12"
            r="9"
            fill="none"
            strokeWidth="2.6"
            strokeLinecap="round"
            transform="rotate(-90 12 12)"
            strokeDasharray={
              installPhase === 'speed_test'
                ? `${2 * Math.PI * 9 * 0.25} ${2 * Math.PI * 9}`
                : 2 * Math.PI * 9
            }
            strokeDashoffset={
              installPhase === 'speed_test'
                ? 0
                : 2 * Math.PI * 9 * (1 - installPct / 100)
            }
          />
        </svg>
      ) : readyToInstall ? (
        /* Downloaded and waiting: an icon like the rest of the row, its tip says 安装更新 (Lucide package-check;
           license in /icons/LICENSE-lucide.txt). */
        <svg width={rail ? 18 : 15} height={rail ? 18 : 15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={rail ? 1.75 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m16 16 2 2 4-4" /><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14" /><path d="m7.5 4.27 9 5.15" /><path d="M3.29 7 12 12l8.71-5" /><path d="M12 22V12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      )}
    </button>
  ) : null}
    {/* The step that installs waits for this: the new version's notes, then 开始更新. */}
    {selfUpdate.confirming && updateVersion && <ReleaseNotesDialog version={updateVersion} onClose={selfUpdate.cancel}
      update={{ from: installed, to: updateVersion, starting: selfUpdate.starting, onStart: () => void selfUpdate.confirm() }} />}
  </>;
}
