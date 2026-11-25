import { useEffect, useRef } from 'react';

/**
 * Hover-to-open for a small popover: entering the trigger opens it, and leaving both the trigger and the popover
 * closes it after a short grace period, so the pointer can cross the gap between them.
 */
export function useHoverOpen(open: () => void, close: () => void, isOpen: boolean, graceMs = 200) {
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ open, close, isOpen });
  useEffect(() => { latest.current = { open, close, isOpen }; });
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const enter = () => { window.clearTimeout(timer.current); if (!latest.current.isOpen) latest.current.open(); };
  const leave = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => { if (latest.current.isOpen) latest.current.close(); }, graceMs); };
  const stay = () => window.clearTimeout(timer.current);
  return { trigger: { onMouseEnter: enter, onMouseLeave: leave }, popover: { onMouseEnter: stay, onMouseLeave: leave } };
}
