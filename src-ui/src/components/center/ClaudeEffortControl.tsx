import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
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

// A level is applied when its menu closes, which can outlive the menu. Until that switch finishes every
// effort slider is disabled, so a second choice can never race the first or land after a turn started.
let applying = 0;
const applyingListeners = new Set<() => void>();
const setApplying = (delta: number) => { applying += delta; applyingListeners.forEach(listener => listener()); };
const useApplying = () => useSyncExternalStore(listener => { applyingListeners.add(listener); return () => { applyingListeners.delete(listener); }; }, () => applying > 0);

export function ClaudeEffortControl({ levels, value, disabled, onCommit, onClose }: {
  levels: string[]; value: string; disabled: boolean; onCommit: (level: string) => Promise<unknown>; onClose: () => void;
}) {
  const busyApplying = useApplying();
  disabled = disabled || busyApplying;
  const t = useT();
  const [preview, setPreview] = useState<number | null>(null);
  const pointer = useRef(false);
  const draftIndex = useRef<number | null>(null);
  // Read live: a queued level must not be applied once the control is disabled (e.g. a turn started).
  const disabledRef = useRef(disabled);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  const applied = Math.max(0, levels.indexOf(value));
  const index = Math.min(preview ?? applied, levels.length - 1);
  const [motion, setMotion] = useState({ index, direction: 1 });
  if (motion.index !== index) setMotion({ index, direction: index > motion.index ? 1 : -1 });
  const level = levels[index] ?? value;
  const label = claudeEffortLabel(level, t);
  // Applied once, on close; ending where it started sends nothing.
  const commit = () => {
    const next = draftIndex.current;
    draftIndex.current = null;
    if (next === null || disabledRef.current || levels[next] === value) return;
    setApplying(1);
    // Released once, when the switch settles or after 15 s, so a request that never answers cannot leave every slider disabled.
    let released = false;
    const release = () => { if (released) return; released = true; clearTimeout(timer); setApplying(-1); if (draftIndex.current === null) setPreview(null); };
    const timer = setTimeout(release, 15000);
    void Promise.resolve().then(() => onCommit(levels[next])).catch(() => {}).finally(release);
  };
  const dragTo = (input: HTMLInputElement, clientX: number) => {
    const box = input.getBoundingClientRect(), last = levels.length - 1;
    const next = Math.round(Math.min(1, Math.max(0, (clientX - box.left - 9) / Math.max(1, box.width - 18))) * last);
    if (next === draftIndex.current || (draftIndex.current === null && next === index)) return;
    draftIndex.current = next;
    setPreview(next);
  };
  const cancel = () => { pointer.current = false; draftIndex.current = null; setPreview(null); };
  // Dragging and arrow keys only preview; the level is applied once, when the menu closes (a click elsewhere, the
  // chip again, or Send). Losing focus does not apply it: clicking a switch in the same menu must not disable that
  // switch mid-click. Escape closes without applying.
  const commitRef = useRef(commit);
  useEffect(() => { commitRef.current = commit; });
  // Unconditional: in WKWebView a click on a button or blank area does not blur the slider, and a release can be
  // missed, so closing the menu (unmount) is the one moment that always applies the previewed level.
  useEffect(() => () => { pointer.current = false; commitRef.current(); }, []);
  return <div className="claude-effort-control" style={{ '--effort-progress': `calc(9px + (100% - 18px) * ${index / Math.max(1, levels.length - 1)})`, '--effort-direction': motion.direction } as CSSProperties}>
    <div className="claude-effort-heading"><span>{t('claude.effort.title')}</span><span className="claude-effort-label-window"><span key={index} className={`claude-effort-label${index === levels.length - 1 ? ' is-max' : ''}`}><span>{label}</span>{[0.5, 1, 2].map(radius => <span className="claude-effort-label-glow" aria-hidden="true" key={radius} style={{ '--effort-blur': `${radius}px` } as CSSProperties}>{label}</span>)}</span></span></div>
    <div className="claude-effort-range">
      <div className="claude-effort-track" aria-hidden="true"><div className="claude-effort-fill" /><EffortEnergy active={index === levels.length - 1 && levels.length > 1} />{levels.map((item, stop) => <span className="claude-effort-stop" key={item} style={{ left: `calc(9px + (100% - 18px) * ${stop / Math.max(1, levels.length - 1)})` }} />)}</div>
      <input type="range" min={0} max={Math.max(0, levels.length - 1)} step={1} value={index} disabled={disabled || levels.length < 2} autoFocus aria-label={t('claude.effort.title')} aria-valuetext={label}
        onPointerDown={event => {
          // Dragging is ours, not the engine's: WKWebView (macOS) stops moving a captured native range thumb, so
          // only clicks landed there. The stop under the pointer is the thumb's centre track (9px insets).
          if (event.button !== 0 || event.currentTarget.disabled) return;
          event.preventDefault();
          const input = event.currentTarget;
                    input.focus();
          pointer.current = true;
          dragTo(input, event.clientX);
          try { input.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
        }}
        onPointerMove={event => { if (pointer.current) dragTo(event.currentTarget, event.clientX); }}
        onChange={event => { const next = Number(event.currentTarget.value); draftIndex.current = next; setPreview(next); }}
        onPointerUp={() => { pointer.current = false; }} onLostPointerCapture={() => { pointer.current = false; }} onPointerCancel={cancel}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); onClose(); } }}
        onBlur={() => { pointer.current = false; }} />
    </div>
    <div className="claude-effort-scale"><span>{t('claude.effort.faster')}</span><span>{t('claude.effort.smarter')}</span></div>
  </div>;
}
