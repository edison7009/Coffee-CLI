import { useRef } from 'react';
import { sessionSplitRects, type SessionSplitLayout } from '../../lib/session-split-layout';
import { useAppDispatch } from '../../store/app-state';
import { useT } from '../../i18n/useT';

export function SessionSplitDividers({ layout }: { layout: SessionSplitLayout }) {
  const dispatch = useAppDispatch();
  const t = useT();
  const drag = useRef<{ path: string; start: number; size: number; ratio: number } | null>(null);
  return sessionSplitRects(layout).dividers.map(divider => (
    <div key={divider.path} className={`session-split-divider is-${divider.direction}`}
      role="separator" tabIndex={0} aria-label={t('split.resize')}
      aria-orientation={divider.direction === 'horizontal' ? 'vertical' : 'horizontal'}
      aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(divider.ratio * 100)}
      style={{ left: `${divider.left}%`, top: `${divider.top}%`, width: `${divider.width}%`, height: `${divider.height}%` }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const container = event.currentTarget.parentElement!.getBoundingClientRect();
        let node = layout, size = divider.direction === 'horizontal' ? container.width : container.height;
        for (const part of divider.path) {
          if (node.type !== 'branch') return;
          if (node.direction === divider.direction) size *= part === '0' ? node.ratio : 1 - node.ratio;
          node = part === '0' ? node.first : node.second;
        }
        drag.current = { path: divider.path, start: divider.direction === 'horizontal' ? event.clientX : event.clientY, size, ratio: divider.ratio };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current || current.path !== divider.path || !current.size) return;
        const point = divider.direction === 'horizontal' ? event.clientX : event.clientY;
        dispatch({ type: 'RESIZE_SESSION_SPLIT', path: divider.path, ratio: current.ratio + (point - current.start) / current.size });
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => dispatch({ type: 'RESIZE_SESSION_SPLIT', path: divider.path, ratio: 0.5 })}
      onKeyDown={event => {
        const keys = divider.direction === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        dispatch({ type: 'RESIZE_SESSION_SPLIT', path: divider.path, ratio: divider.ratio + (event.key === keys[0] ? -0.05 : 0.05) });
      }}
    />
  ));
}
