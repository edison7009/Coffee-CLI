import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';

export function CloseSessionGroupDialog({ error: initialError, onChoose, onClose }: { error?: string; onChoose: (keepChildren: boolean) => Promise<void>; onClose: () => void }) {
  const t = useT(), ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(initialError ?? '');
  useEffect(() => { ref.current?.showModal(); }, []);
  const choose = async (keepChildren: boolean) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await onChoose(keepChildren); onClose(); }
    catch (error) { setError(String(error)); setBusy(false); }
  };
  return <dialog ref={ref} className="tool-config-modal orchestration-close-dialog" aria-labelledby="close-group-title" aria-describedby="close-group-description" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="tool-config-header"><span id="close-group-title">{t('orchestration.close.title')}</span><button type="button" className="tool-config-close close-button" aria-label={t('tool_config.cancel')} disabled={busy} onClick={onClose}>×</button></div>
    <div className="tool-config-body"><p id="close-group-description">{t('orchestration.close.description')}</p>{error && <p role="alert">{error}</p>}</div>
    <div className="tool-config-buttons"><button type="button" autoFocus className="tool-config-btn tool-config-btn-subtle" disabled={busy} onClick={() => void choose(true)}>{t('orchestration.close.keep')}</button><button type="button" className="tool-config-btn tool-config-btn-primary" disabled={busy} onClick={() => void choose(false)}>{t('orchestration.close.end')}</button></div>
  </dialog>;
}
