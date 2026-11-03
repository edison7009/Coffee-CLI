import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createReasoningEnergyRenderer } from '../../lib/claude-effort-energy';
import { useT } from '../../i18n/useT';
import { claudeEffortLabel } from '../../lib/claude-i18n';
import './ClaudeEffortControl.css';

function EffortEnergy({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<ReturnType<typeof createReasoningEnergyRenderer>>(null);
  const activeRef = useRef(active);
  const [started, setStarted] = useState(active);
  if (active && !started) setStarted(true);
  useEffect(() => { activeRef.current = active; renderer.current?.setActive(active); }, [active]);
  useEffect(() => {
    const element = host.current;
    if (!started || !element) return;
    const preferences = ['(prefers-reduced-motion: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].map(query => matchMedia(query));
    let canvas: HTMLCanvasElement | undefined;
    const destroy = () => {
      canvas?.removeEventListener('webglcontextlost', lost);
      canvas?.remove(); canvas = undefined;
      renderer.current?.dispose(); renderer.current = null;
      element.dataset.available = 'false';
    };
    const lost = (event: Event) => { event.preventDefault(); destroy(); };
    const update = () => {
      if (document.hidden || preferences.some(preference => preference.matches)) { destroy(); return; }
      if (renderer.current) return;
      canvas = document.createElement('canvas');
      canvas.className = 'claude-effort-energy-canvas';
      element.appendChild(canvas);
      renderer.current = createReasoningEnergyRenderer(canvas);
      if (!renderer.current) { canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); destroy(); return; }
      canvas.addEventListener('webglcontextlost', lost);
      element.dataset.available = 'true';
      renderer.current.setActive(activeRef.current);
    };
    preferences.forEach(preference => preference.addEventListener('change', update));
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      preferences.forEach(preference => preference.removeEventListener('change', update));
      document.removeEventListener('visibilitychange', update);
      destroy();
    };
  }, [started]);
  return <div ref={host} className="claude-effort-energy" data-active={active || undefined} aria-hidden="true"><div className="claude-effort-energy-base" /></div>;
}

export function ClaudeEffortControl({ levels, value, disabled, onCommit, onClose }: {
  levels: string[]; value: string; disabled: boolean; onCommit: (level: string) => Promise<unknown>; onClose: () => void;
}) {
  const t = useT();
  const [preview, setPreview] = useState<number | null>(null);
  const pointer = useRef(false);
  const committing = useRef(false);
  const draftIndex = useRef<number | null>(null);
  const applied = Math.max(0, levels.indexOf(value));
  const index = Math.min(preview ?? applied, levels.length - 1);
  const [motion, setMotion] = useState({ index, direction: 1 });
  if (motion.index !== index) setMotion({ index, direction: index > motion.index ? 1 : -1 });
  const level = levels[index] ?? value;
  const label = claudeEffortLabel(level, t);
  // A level chosen while an earlier one is still being applied is kept and applied next;
  // only the latest choice counts, and the control never falls back to the earlier one.
  const commit = async () => {
    if (draftIndex.current === null || disabled || committing.current) return;
    committing.current = true;
    let current = value;
    try {
      for (let next: number | null = draftIndex.current; next !== null; next = draftIndex.current) {
        draftIndex.current = null;
        if (levels[next] === current) continue;
        await onCommit(levels[next]);
        current = levels[next];
      }
    } finally { committing.current = false; setPreview(null); }
  };
  const cancel = () => { pointer.current = false; draftIndex.current = null; setPreview(null); };
  return <div className="claude-effort-control" style={{ '--effort-progress': `calc(9px + (100% - 18px) * ${index / Math.max(1, levels.length - 1)})`, '--effort-direction': motion.direction } as CSSProperties}>
    <div className="claude-effort-heading"><span>{t('claude.effort.title')}</span><span className="claude-effort-label-window"><span key={index} className={`claude-effort-label${index === levels.length - 1 ? ' is-max' : ''}`}><span>{label}</span>{[0.5, 1, 2].map(radius => <span className="claude-effort-label-glow" aria-hidden="true" key={radius} style={{ '--effort-blur': `${radius}px` } as CSSProperties}>{label}</span>)}</span></span></div>
    <div className="claude-effort-range">
      <div className="claude-effort-track" aria-hidden="true"><div className="claude-effort-fill" /><EffortEnergy active={index === levels.length - 1 && levels.length > 1} />{levels.map((item, stop) => <span className="claude-effort-stop" key={item} style={{ left: `calc(9px + (100% - 18px) * ${stop / Math.max(1, levels.length - 1)})` }} />)}</div>
      <input type="range" min={0} max={Math.max(0, levels.length - 1)} step={1} value={index} disabled={disabled || levels.length < 2} autoFocus aria-label={t('claude.effort.title')} aria-valuetext={label}
        onPointerDown={event => { pointer.current = true; event.currentTarget.setPointerCapture(event.pointerId); }}
        onChange={event => { const next = Number(event.currentTarget.value); draftIndex.current = next; setPreview(next); }}
        onPointerUp={() => { pointer.current = false; void commit(); }} onPointerCancel={cancel}
        onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void commit(); }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); onClose(); } }}
        onBlur={() => { if (pointer.current) cancel(); else void commit(); }} />
    </div>
    <div className="claude-effort-scale"><span>{t('claude.effort.faster')}</span><span>{t('claude.effort.smarter')}</span></div>
  </div>;
}
