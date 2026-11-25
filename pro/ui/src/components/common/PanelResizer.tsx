import { useEffect, useRef } from 'react';

export type PanelSide = 'left' | 'right';

export function PanelResizer({
  side,
  size,
  collapsed,
  onResize,
  onResizeEnd,
  onReset,
}: {
  side: PanelSide;
  size: number;
  collapsed: boolean;
  onResize: (side: PanelSide, size: number) => void;
  onResizeEnd: () => void;
  onReset: (side: PanelSide) => void;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || collapsed) return;
    event.preventDefault();

    const startX = event.clientX;
    const startSize = size;
    const body = document.body;
    body.classList.add('resizing-panels', `panel-resizing-${side}`);

    let finished = false;
    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      onResize(side, side === 'left' ? startSize + delta : startSize - delta);
    };
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleFinish);
      window.removeEventListener('pointercancel', handleFinish);
      window.removeEventListener('blur', handleFinish);
      body.classList.remove('resizing-panels', `panel-resizing-${side}`);
      cleanupRef.current = null;
      if (commit) onResizeEnd();
      else onResize(side, startSize);
    };
    const handleFinish = () => finish(true);

    cleanupRef.current = () => finish(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleFinish);
    window.addEventListener('pointercancel', handleFinish);
    window.addEventListener('blur', handleFinish);
  };

  return (
    <div
      className={`pane-resizer pane-resizer-${side}${collapsed ? ' is-collapsed' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize left panel' : 'Resize right panel'}
      aria-valuenow={Math.round(size)}
      onPointerDown={startResize}
      onDoubleClick={() => onReset(side)}
    >
      <span />
    </div>
  );
}
