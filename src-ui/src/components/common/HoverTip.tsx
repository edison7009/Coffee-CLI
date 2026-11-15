// Our own hover tip (never the native title= tooltip), in the heatmap tip's look: a small
// themed card that sits just under the pointer and follows it. Rendered in a portal so a
// clipping parent (a pill with overflow:hidden, a scrolling list) can't cut it off. Keyboard
// focus shows it under the element instead. Gone on scroll, resize or leaving the window.
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './HoverTip.css';

type Tip = { label: string; x: number; y: number };
type Handlers = {
  onMouseEnter: (e: MouseEvent<HTMLElement>) => void; onMouseMove: (e: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void; onFocus: (e: FocusEvent<HTMLElement>) => void; onBlur: () => void;
};
/** Gap between the pointer's hotspot and the tip, clear of the cursor arrow. */
const BELOW_POINTER = 20;

export function useHoverTip(): { tipFor: (label: string) => Handlers; tip: ReactNode } {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Centered on the pointer, then nudged by its real size so it stays 8px inside the window
  // (flipping above the pointer when there is no room below).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return;
    const half = el.offsetWidth / 2;
    el.style.left = `${Math.max(half + 8, Math.min(tip.x, window.innerWidth - half - 8))}px`;
    const below = tip.y + BELOW_POINTER;
    el.style.top = `${below + el.offsetHeight + 8 <= window.innerHeight ? below : tip.y - 8 - el.offsetHeight}px`;
  }, [tip]);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); window.removeEventListener('blur', hide); };
  }, [tip]);
  const hide = () => setTip(null);
  return {
    tipFor: label => ({
      onMouseEnter: e => setTip({ label, x: e.clientX, y: e.clientY }),
      onMouseMove: e => setTip({ label, x: e.clientX, y: e.clientY }),
      onMouseLeave: hide,
      onFocus: e => { const r = e.currentTarget.getBoundingClientRect(); setTip({ label, x: r.left + r.width / 2, y: r.bottom - BELOW_POINTER + 8 }); },
      onBlur: hide,
    }),
    tip: tip && createPortal(<span ref={ref} className="hover-tip" role="tooltip" style={{ left: tip.x, top: tip.y + BELOW_POINTER }}>{tip.label}</span>, document.body),
  };
}
