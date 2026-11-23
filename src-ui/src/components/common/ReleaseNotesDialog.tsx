import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppLanguage } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { commands } from '../../tauri';
import { cachedReleaseNotes, loadReleaseNotes, notesForLocale } from '../../lib/release-notes';
import { MarkdownContent } from '../center/MarkdownContent';
import './Changelog.css';

/** One version's release notes (as EchoBird shows them). Plain: the changelog, closed with 我知道了. With `update`:
 *  the notes of the version about to be installed, titled 从 vX 更新到 vY, and 开始更新 goes on. Either way the footer
 *  offers feedback (GitHub; GitCode too in Chinese), which used to be a page in Settings. */
export function ReleaseNotesDialog({ version, onClose, update }: {
  version: string; onClose: () => void;
  update?: { from: string; to: string; starting: boolean; onStart: () => void };
}) {
  const t = useT(), language = useAppLanguage(), titleId = useId();
  const [notes, setNotes] = useState(() => cachedReleaseNotes(version));
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const content = notesForLocale(notes, language);
  const starting = update?.starting ?? false;
  const close = () => { if (!starting) onClose(); };

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    loadReleaseNotes(version, controller.signal).then(loaded => { if (!controller.signal.aborted) { setNotes(loaded); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [version, retry]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  const open = (url: string) => { void commands.openUrl(url).catch(() => {}); };
  const title = update ? t('changelog.update_title', { from: `v${update.from}`, to: `v${update.to}` }) : t('changelog.title');
  return createPortal(<div className="settings-overlay changelog-overlay" onMouseDown={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget) close();
  }} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
    const first = controls[0], last = controls.at(-1);
    if (document.activeElement === dialog.current) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div ref={dialog} className="settings-modal changelog-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="settings-header">
        <span id={titleId} className="settings-header-title">{title}{!update && <span className="changelog-version">v{version}</span>}</span>
        <button type="button" className="settings-close close-button" aria-label={t('changelog.close')} disabled={starting} onClick={close}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </header>
      <div className="changelog-body">
        {content ? <MarkdownContent content={content} /> : <div className="changelog-status" role="status">
          <p>{failed ? t('changelog.error') : t('diff.loading')}</p>
          {failed && <button type="button" className="settings-close changelog-retry" onClick={() => { setFailed(false); setRetry(value => value + 1); }}>{t('changelog.retry')}</button>}
        </div>}
      </div>
      <footer className="changelog-footer">
        <a href="https://github.com/edison7009/Coffee-CLI/issues" onClick={event => { event.preventDefault(); open(event.currentTarget.href); }}>{t('changelog.feedback')}</a>
        {language === 'zh-CN' && <a href="https://gitcode.com/edison7009/Coffee-CLI/issues" onClick={event => { event.preventDefault(); open(event.currentTarget.href); }}>国内反馈</a>}
        <button type="button" className="changelog-primary" disabled={starting} aria-busy={starting} onClick={update ? update.onStart : close}>
          {starting && <span className="changelog-spinner" aria-hidden="true" />}
          {t(update ? 'changelog.start_update' : 'changelog.got_it')}
        </button>
      </footer>
    </div>
  </div>, document.body);
}
