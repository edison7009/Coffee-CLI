import { useT } from '../../i18n/useT';

/** The tab strip's "+": the same action as the sidebar's New session, where a browser user reaches for it. */
export function NewSessionTabButton() {
  const t = useT();
  return <button type="button" className="chrome-tab-add" aria-label={t('explorer.new_session')} onClick={() => window.dispatchEvent(new Event('coffee-new-session'))}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
  </button>;
}
