import { useRef, useState, type CSSProperties } from 'react';
import './SettingsSlider.css';

interface SettingsSliderProps {
  id?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  commitOnRelease?: boolean;
  onChange: (value: number) => void;
  onPreview?: (value: number | null) => void;
  ticks?: readonly number[];
  marks?: readonly number[];
}

export function SettingsSlider({ id, label, value, min, max, step, disabled, commitOnRelease = false, onChange, onPreview, ticks = [], marks = [] }: SettingsSliderProps) {
  const [draft, setDraft] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  const lastEmitted = useRef(value);
  const percent = draft ?? value;
  const snap = (next: number) => Math.max(min, Math.min(max, min + Math.round((next - min) / step) * step));
  const finish = () => {
    if (drag.current === null) return;
    drag.current = null;
    setDraft(null);
    onPreview?.(null);
  };

  return (
    <div className="settings-range-control" aria-disabled={disabled}>
      <input
        id={id}
        className="settings-range"
        type="range" min={min} max={max} step="any"
        value={percent} disabled={disabled}
        aria-label={label} aria-valuetext={`${snap(percent)}%`}
        style={{ '--range-progress': `${(percent - min) / (max - min) * 100}%` } as CSSProperties}
        onChange={event => {
          const next = Number(event.target.value);
          if (drag.current !== null) {
            drag.current = next;
            setDraft(next);
            const snapped = snap(next);
            if (snapped !== lastEmitted.current) {
              lastEmitted.current = snapped;
              onPreview?.(snapped);
              if (!commitOnRelease) onChange(snapped);
            }
          } else onChange(snap(next));
        }}
        onKeyDown={event => {
          const page = Math.max(step, (max - min) / 10);
          const values: Record<string, number> = { ArrowRight: value + step, ArrowUp: value + step, PageUp: value + page, ArrowLeft: value - step, ArrowDown: value - step, PageDown: value - page, Home: min, End: max };
          if (!(event.key in values)) return;
          event.preventDefault();
          const next = snap(values[event.key]);
          if (drag.current === null && next !== value) onChange(next);
        }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          // Keep the native thumb continuous; only notify the parent when a setting step changes.
          drag.current = value;
          lastEmitted.current = value;
          setDraft(value);
          onPreview?.(value);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={() => {
          if (commitOnRelease && drag.current !== null && snap(drag.current) !== value) onChange(snap(drag.current));
          finish();
        }}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
      {ticks.length > 0 && <div className="settings-range-ticks" aria-hidden="true">
        {ticks.map(tick => <span key={tick} className={marks.includes(tick) ? 'major' : ''} style={{ left: `${(tick - min) / (max - min) * 100}%` }} />)}
      </div>}
      {marks.length > 0 && <div className="settings-range-labels" aria-hidden="true">
        {marks.map(mark => <span key={mark} style={{ left: `${(mark - min) / (max - min) * 100}%`, transform: mark === min ? 'none' : mark === max ? 'translateX(-100%)' : 'translateX(-50%)' }}>{mark}%</span>)}
      </div>}
    </div>
  );
}
