// Voice input for any composer: the selected local account (or the current tool's account) streams the microphone
// to their own speech-to-text service (src/voice_input.rs); the words appear in the draft as they are
// heard, and the service's final text replaces them when the recording ends.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { commands, isTauri, type VoiceInputEvent } from '../../tauri';
import { useT } from '../../i18n/useT';
import { useAppLanguage } from '../../store/app-state';
import './VoiceInput.css';
import { chime } from '../../lib/voice-chime';
import { beginVoiceSourceSelection, useVoiceEnabled, useVoiceSource, voiceDevice, voiceSource } from '../../lib/voice-settings';
import { hideVoiceWave, pushVoiceLevel, showVoiceWave, useVoiceWaveVisible, voiceLevel } from '../../lib/voice-wave';

type Phase = 'idle' | 'connecting' | 'recording' | 'finishing';


/** Text spoken after existing Latin text needs a space; CJK text does not. */
function joinDraft(before: string, spoken: string): string {
  if (!before || !spoken || /\s$/.test(before)) return before + spoken;
  const wide = (c: string) => c.codePointAt(0)! >= 0x2e80;
  return before + (wide(before.slice(-1)) || wide(spoken[0]) ? '' : ' ') + spoken;
}

export function VoiceInputButton({ tool, cwd, waveKey, draft, onDraftChange }: { tool: string; cwd?: string; waveKey: string; draft: string; onDraftChange: (text: string) => void }) {
  const t = useT();
  const appLanguage = useAppLanguage();
  const language = appLanguage.split('-')[0];
  const enabled = useVoiceEnabled();
  const source = useVoiceSource();
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const draftRef = useRef(draft);
  const changeRef = useRef(onDraftChange);
  useLayoutEffect(() => { draftRef.current = draft; changeRef.current = onDraftChange; });
  // The recording in progress: its native id once known, and the draft it started from.
  const readyAt = useRef(0);
  const session = useRef<{ id: number | null; before: string; cancelled: boolean } | null>(null);

  useEffect(() => {
    let live = true;
    let generation = 0;
    const check = () => { const request = ++generation; if (isTauri) void commands.voiceInputAvailable(tool, cwd, source || undefined).then(ok => { if (live && request === generation) setAvailable(ok); }, () => { if (live && request === generation) setAvailable(false); }); };
    check();
    // Signing in or out, or switching to a relay, happens in the tool itself; look again when the window comes back.
    window.addEventListener('focus', check);
    return () => { live = false; window.removeEventListener('focus', check); };
  }, [tool, cwd, source]);

  useEffect(() => {
    setPhase('idle');
    setError('');
    return () => {
      const current = session.current;
      session.current = null;
      if (current?.id != null) void commands.voiceInputCancel(current.id);
      else if (current) current.cancelled = true;
    };
  }, [source, tool, cwd]);

  // The waveform shows while listening and until the final text is back.
  useEffect(() => { if (phase === 'idle' || phase === 'connecting') hideVoiceWave(waveKey); }, [phase, waveKey]);
  useEffect(() => () => hideVoiceWave(waveKey), [waveKey]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 4000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const start = async () => {
    beginVoiceSourceSelection();
    setError('');
    const current = { id: null as number | null, before: draftRef.current, cancelled: false };
    session.current = current;
    setPhase('connecting');
    const onEvent = (event: VoiceInputEvent) => {
      if (session.current !== current || voiceSource() !== source) return;
      if (event.kind === 'level') { pushVoiceLevel(waveKey, event.level); return; }
      if (event.kind === 'ready') { showVoiceWave(waveKey); chime('start'); readyAt.current = performance.now(); setPhase('recording'); return; }
      if (event.kind === 'processing') { setPhase('finishing'); return; }
      if (event.kind === 'text') {
        changeRef.current(joinDraft(current.before, event.text));
        if (event.done) { session.current = null; setPhase('idle'); }
        return;
      }
      session.current = null;
      setPhase('idle');
      if (event.message === 'speech_permission') { setError(t('gambit.voice.permission')); return; }
      if (event.message.startsWith('http_402')) { setError(t('gambit.voice.unavailable')); return; }
      const rejected = event.message.startsWith('http_401') || event.message.startsWith('http_403');
      if (rejected) setAvailable(false);
      setError(t(rejected ? source ? 'settings.voice.source.missing' : 'gambit.voice.signed_out' : 'gambit.voice.failed'));
    };
    try {
      const id = await commands.voiceInputStart(tool, cwd, source === 'macos' ? appLanguage : language, voiceDevice(), onEvent, source || undefined);
      current.id = id;
      if (current.cancelled) void commands.voiceInputCancel(id);
    } catch (reason) {
      if (session.current !== current) return;
      session.current = null;
      setPhase('idle');
      const message = String(reason);
      if (message.includes('signed_out')) setAvailable(false);
      setError(t(message.includes('microphone') ? 'gambit.voice.no_microphone' : message.includes('signed_out') ? source ? 'settings.voice.source.missing' : 'gambit.voice.signed_out' : 'gambit.voice.failed'));
    }
  };

  const finish = () => {
    const current = session.current;
    if (!current) return;
    chime('stop');
    if (current.id == null) { cancel(); return; }
    setPhase('finishing');
    void commands.voiceInputFinish(current.id);
  };

  const cancel = () => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    if (current.id != null) void commands.voiceInputCancel(current.id); else current.cancelled = true;
    changeRef.current(current.before);
    setPhase('idle');
  };

  // Problems show in a bubble above the mic, like the footer's other notices, so nothing in the row shifts.
  const bubble = error && <span className="gambit-voice-notice" role="status" onClick={() => setError('')}>{error}</span>;
  // Turning voice input off in Settings removes the button; a recording in progress finishes first.
  if (!available || (!enabled && phase === 'idle')) return bubble ? <span className="gambit-voice-anchor">{bubble}</span> : null;
  const active = phase !== 'idle';
  return (
    <span className="gambit-voice-anchor" data-tip={error ? undefined : t(active ? 'gambit.voice.finish' : 'gambit.voice.start')}>
      {bubble}
      <button
        type="button"
        className={`gambit-voice${active ? ` is-${phase}` : ''}`}
        aria-label={t(active ? 'gambit.voice.finish' : 'gambit.voice.start')}
        aria-pressed={active}
        aria-busy={phase === 'connecting' || phase === 'finishing'}
        onClick={() => {
          // Clicks while connecting or wrapping up, or right after listening starts, are taken as a double click and ignored.
          if (phase === 'idle') void start();
          else if (phase === 'recording' && performance.now() - readyAt.current > 300) finish();
        }}
      >
        <VoiceGlyph busy={phase === 'connecting' || phase === 'finishing'} />
      </button>
    </span>
  );
}

// Waveform geometry: dots 2px wide on a 4px step drifting left at a constant 40px/s; each new dot
// takes the current loudness, so speech raises the dots and silence leaves a dotted line.
const WAVE_MIN_WIDTH = 46, WAVE_HEIGHT = 16, WAVE_STEP = 4, WAVE_DOT = 2, WAVE_SPEED = 40;

/** Mic at rest and while listening; a spinner while connecting or wrapping up. */
export function VoiceGlyph({ busy }: { busy: boolean }) {
  return busy ? (
          <svg className="gambit-voice-spinner" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.6" opacity="0.3" />
            <path d="M8 2.5 A5.5 5.5 0 0 1 13.5 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.5" y="1.75" width="5" height="8.5" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M3.25 7.5 a4.75 4.75 0 0 0 9.5 0 M8 12.25 V14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        );
}

export function VoiceWave({ waveKey, width }: { waveKey: string; width: number }) {
  const t = useT();
  const visible = useVoiceWaveVisible(waveKey);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!visible || !element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    element.height = WAVE_HEIGHT * ratio;
    // The canvas takes the usage meter's width, which can change with the window.
    let width = 0;
    const dots: number[] = [];
    let offset = 0, smoothed = 0, last = performance.now(), frame = 0;
    const draw = (now: number) => {
      const elapsed = Math.min(now - last, 100) / 1000;
      last = now;
      // Ease toward the latest level so a 100 ms update does not snap.
      smoothed += (voiceLevel(waveKey) - smoothed) * Math.min(1, elapsed * 12);
      offset += elapsed * WAVE_SPEED;
      const current = Math.max(WAVE_MIN_WIDTH, element.clientWidth);
      if (current !== width) {
        width = current;
        element.width = width * ratio;
        const count = Math.ceil(width / WAVE_STEP) + 1;
        while (dots.length < count) dots.unshift(0);
        dots.splice(0, dots.length - count);
      }
      while (offset >= WAVE_STEP) { offset -= WAVE_STEP; dots.shift(); dots.push(smoothed); }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, WAVE_HEIGHT);
      context.fillStyle = getComputedStyle(element).color;
      dots.forEach((level, index) => {
        const height = WAVE_DOT + level * (WAVE_HEIGHT - WAVE_DOT);
        const x = index * WAVE_STEP - offset;
        context.beginPath();
        context.roundRect(x, (WAVE_HEIGHT - height) / 2, WAVE_DOT, height, WAVE_DOT / 2);
        context.fill();
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [visible, waveKey]);
  if (!visible) return null;
  return <canvas ref={canvas} className="gambit-voice-wave" style={{ width: Math.max(WAVE_MIN_WIDTH, width) }} role="status" aria-label={t('gambit.voice.listening')} />;
}

/** The usage meter's slot: while listening the waveform takes the meter's place and width, so a narrow
 *  footer never squeezes it and nothing else in the row moves; the meter comes back when the text is in. */
export function VoiceUsageSlot({ waveKey, children }: { waveKey: string; children: ReactNode }) {
  const listening = useVoiceWaveVisible(waveKey);
  const slot = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = slot.current;
    if (!element || listening) return;
    // The slot itself has no box (display: contents); the meter's own pieces give its width.
    const measure = () => {
      const rects = [...element.children].map(child => child.getBoundingClientRect()).filter(rect => rect.width > 0);
      setWidth(rects.length ? Math.max(...rects.map(r => r.right)) - Math.min(...rects.map(r => r.left)) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [listening]);
  if (listening) return <VoiceWave waveKey={waveKey} width={width} />;
  return <span ref={slot} className="gambit-voice-slot">{children}</span>;
}
