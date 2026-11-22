import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppLanguage } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { BUNDLED_VERSION, RELEASE_NOTES_SEEN, cachedReleaseNotes, loadReleaseNotes, notesForLocale, shouldShowReleaseNotes } from '../../lib/release-notes';
import { MarkdownContent } from '../center/MarkdownContent';
import './Changelog.css';

export function Changelog({ className = 'titlebar-btn changelog-trigger' }: { className?: string } = {}) {
  const t = useT(), language = useAppLanguage(), titleId = useId();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(BUNDLED_VERSION);
  const [release, setRelease] = useState(() => ({ version: BUNDLED_VERSION, notes: cachedReleaseNotes(BUNDLED_VERSION) }));
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const notes = release.version === version ? release.notes : cachedReleaseNotes(version);
  const content = notesForLocale(notes, language);

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    loadReleaseNotes(version, controller.signal).then(notes => {
      if (!controller.signal.aborted) { setRelease({ version, notes }); setFailed(false); }
    }).catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => window.clearTimeout(timeout));
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); };
  }, [open, version, retry]);

  useEffect(() => {
    if (!open || !content) return;
    try {
      if (shouldShowReleaseNotes(version, localStorage.getItem(RELEASE_NOTES_SEEN))) localStorage.setItem(RELEASE_NOTES_SEEN, version);
    } catch { /* Optional version preference. */ }
  }, [open, content, version]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);

  return <>
    <button type="button" className={className} aria-label={t('changelog.title')} aria-expanded={open} onClick={() => { setFailed(false); setOpen(true); }}>
      {t('changelog.title')}
    </button>
    {open && createPortal(<div className="settings-overlay changelog-overlay" onMouseDown={event => {
      event.stopPropagation();
      if (event.target === event.currentTarget) setOpen(false);
    }} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
      if (event.key !== 'Tab') return;
      const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button, a[href]')];
      const first = controls[0], last = controls.at(-1);
      if (document.activeElement === dialog.current) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div ref={dialog} className="settings-modal changelog-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="settings-header">
          <span id={titleId} className="settings-header-title">{t('changelog.title')} <span className="changelog-version">v{version}</span></span>
          <button type="button" className="settings-close close-button" aria-label="Close" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>
        <div className="changelog-body">
          {content ? <MarkdownContent content={content} /> : <div className="changelog-status" role="status">
            <p>{failed ? t('changelog.error') : t('diff.loading')}</p>
            {failed && <button type="button" className="settings-close changelog-retry" onClick={() => { setFailed(false); setRetry(value => value + 1); }}>{t('changelog.retry')}</button>}
          </div>}
        </div>
      </div>
    </div>, document.body)}
  </>;
}
