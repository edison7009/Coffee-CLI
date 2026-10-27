import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';

export function RemoveWorkerDialog({ title, error: initialError, onRemove, onClose }: { title: string; error?: string; onRemove: () => Promise<void>; onClose: () => void }) {
  const t = useT(), ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(initialError ?? '');
  useEffect(() => { ref.current?.showModal(); }, []);
  const remove = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await onRemove(); onClose(); }
    catch (error) { setError(String(error)); setBusy(false); }
  };
  return <dialog ref={ref} className="tool-config-modal orchestration-close-dialog" aria-labelledby="remove-worker-title" aria-describedby="remove-worker-description" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="tool-config-header"><span id="remove-worker-title">{t('orchestration.remove.title')}</span><button type="button" className="tool-config-close close-button" aria-label={t('tool_config.cancel')} disabled={busy} onClick={onClose}>×</button></div>
    <div className="tool-config-body"><p id="remove-worker-description">{t('orchestration.remove.description', { title })}</p>{error && <p role="alert">{error}</p>}</div>
    <div className="tool-config-buttons"><button type="button" autoFocus className="tool-config-btn tool-config-btn-subtle" disabled={busy} onClick={onClose}>{t('tool_config.cancel')}</button><button type="button" className="tool-config-btn tool-config-btn-primary" disabled={busy} onClick={() => void remove()}>{t('orchestration.remove.confirm')}</button></div>
  </dialog>;
}
