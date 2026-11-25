import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { splitSessionIds, type SplitEdge } from './session-split-layout';
import { useAppStateRef } from '../store/app-state';
import { useT } from '../i18n/useT';

export interface SessionSplitPlacement { targetId: string; edge: SplitEdge }

// WebView2 consumes HTML dragstart for native file drops; pointer events also
// let Escape/outside drops cancel without opening the history row underneath.
export function useSessionSplitDrag() {
  const stateRef = useAppStateRef(), t = useT();
  const cancelRef = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);
  const begin = (event: ReactPointerEvent<HTMLElement>, sourceId: string | undefined, onDrop: (placement: SessionSplitPlacement) => void) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button,input,textarea,[contenteditable="true"]')) return;
    cancelRef.current?.();
    suppressClick.current = false;
    const start = { x: event.clientX, y: event.clientY }, pointerId = event.pointerId;
    let moved = false, placement: SessionSplitPlacement | null = null;
    const cleanup = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      document.body.classList.remove('session-split-dragging');
      setPreview(null); cancelRef.current = null;
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!moved && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 6) return;
      moved = true; suppressClick.current = true;
      next.preventDefault(); document.body.classList.add('session-split-dragging');
      const target = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>('[data-split-eligible="true"]');
      const targetId = target?.dataset.sessionId;
      const ids = splitSessionIds(stateRef.current.sessionSplit);
      if (!target || !targetId || sourceId === targetId || (ids.includes(targetId) && ids.length >= 4 && (!sourceId || !ids.includes(sourceId)))) {
        placement = null; setPreview(null); return;
      }
      const rect = target.getBoundingClientRect(), x = (next.clientX - rect.left) / rect.width, y = (next.clientY - rect.top) / rect.height;
      const distances = [x, 1 - x, y, 1 - y];
      const edge = (['left', 'right', 'top', 'bottom'] as const)[distances.indexOf(Math.min(...distances))];
      placement = { targetId, edge };
      const horizontal = edge === 'left' || edge === 'right';
      setPreview({ left: rect.left + (edge === 'right' ? rect.width / 2 : 0), top: rect.top + (edge === 'bottom' ? rect.height / 2 : 0), width: rect.width / (horizontal ? 2 : 1), height: rect.height / (horizontal ? 1 : 2) });
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const drop = placement; cleanup();
      if (moved && drop) onDrop(drop);
    };
    const cancel = () => cleanup();
    const key = (next: KeyboardEvent) => { if (next.key === 'Escape') { next.preventDefault(); next.stopImmediatePropagation(); cleanup(); } };
    cancelRef.current = cleanup;
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
  };
  return { begin, suppressClick, overlay: preview && createPortal(<div className="session-split-drop-target" style={preview}><span>{t('split.drop')}</span></div>, document.body) };
}
