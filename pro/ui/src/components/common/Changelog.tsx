import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../i18n/useT';
import { BUNDLED_VERSION, RELEASE_NOTES_SEEN, shouldShowReleaseNotes } from '../../lib/release-notes';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';
import './Changelog.css';

/** Settings' 更新日志 link, and the once-after-each-update notes of the installed version. */
export function Changelog({ className = 'titlebar-btn changelog-trigger' }: { className?: string } = {}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(BUNDLED_VERSION);

  useEffect(() => {
    let cancelled = false;
    import('@tauri-apps/api/app').then(api => api.getVersion()).then(installed => {
      if (cancelled) return;
      setVersion(installed);
      try { if (shouldShowReleaseNotes(installed, localStorage.getItem(RELEASE_NOTES_SEEN))) setOpen(true); }
      catch { /* Automatic display needs a saved baseline; manual access remains available. */ }
    }).catch(() => { /* Native version is unavailable in a browser preview. */ });
    return () => { cancelled = true; };
  }, []);

  // Seen once its notes are actually on screen (not merely opened offline): the next start doesn't show them again.
  const markSeen = useCallback(() => {
    try { if (shouldShowReleaseNotes(version, localStorage.getItem(RELEASE_NOTES_SEEN))) localStorage.setItem(RELEASE_NOTES_SEEN, version); }
    catch { /* Optional version preference. */ }
  }, [version]);

  return <>
    <button type="button" className={className} aria-label={t('changelog.title')} aria-expanded={open} onClick={() => setOpen(true)}>
      {t('changelog.title')}
    </button>
    {open && <ReleaseNotesDialog version={version} onClose={() => setOpen(false)} onShown={markSeen} />}
  </>;
}
