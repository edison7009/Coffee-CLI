import { useLayoutEffect, useRef, type ReactNode } from 'react';
import '../center/ToolSettingsPage.css';
import './SegmentedTabs.css';

/**
 * A choice shown as tabs in a track, with a highlight that slides to the chosen one, as at the top of the app
 * settings page. Arrow keys, Home and End move the choice.
 */
export function SegmentedTabs<T extends string>({ label, value, options, onChange, compact = false }: {
  label: string; value: T; options: { value: T; content: ReactNode }[]; onChange: (value: T) => void; compact?: boolean;
}) {
  const list = useRef<HTMLSpanElement>(null), indicator = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const track = list.current, mark = indicator.current;
    if (!track || !mark) return;
    const place = () => {
      const button = track.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!button) { mark.style.width = '0'; return; }
      mark.style.width = `${button.offsetWidth}px`;
      mark.style.transform = `translateX(${button.offsetLeft}px)`;
      // Slide only after the first placement, so it does not sweep in from the left on mount.
      requestAnimationFrame(() => mark.setAttribute('data-ready', ''));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(track);
    return () => observer.disconnect();
  }, [value, options.length]);
  const index = options.findIndex(option => option.value === value);
  return <span ref={list} className={`tool-settings-tabs segmented-tabs${compact ? ' segmented-tabs--compact' : ''}`} role="radiogroup" aria-label={label}>
    <span ref={indicator} className="tool-settings-indicator" aria-hidden="true" />
    {options.map((option, i) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} tabIndex={option.value === value || (index < 0 && i === 0) ? 0 : -1}
      onClick={() => onChange(option.value)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
        onChange(options[next].value);
        (event.currentTarget.parentElement?.children[next + 1] as HTMLElement | undefined)?.focus();
      }}>{option.content}</button>)}
  </span>;
}
