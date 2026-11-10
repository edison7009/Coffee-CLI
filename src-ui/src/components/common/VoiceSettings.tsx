// Settings → Voice input: the master switch, which microphone to use, and a live microphone check.
import { useEffect, useRef, useState } from 'react';
import { commands, isTauri } from '../../tauri';
import { useT } from '../../i18n/useT';
import { ThemedSelect } from './ThemedSelect';
import { VoiceGlyph, VoiceWave } from '../center/VoiceInputButton';
import { chime } from '../../lib/voice-chime';
import { hideVoiceWave, pushVoiceLevel, showVoiceWave } from '../../lib/voice-wave';
import { setVoiceDevice, setVoiceEnabled, useVoiceDevice, useVoiceEnabled } from '../../lib/voice-settings';

const TEST_WAVE = 'settings-mic-test';

export function VoiceSettings() {
  const t = useT();
  const enabled = useVoiceEnabled();
  const device = useVoiceDevice();
  const [microphones, setMicrophones] = useState<{ devices: string[]; default: string | null } | null>(null);
  // The check behaves like dictation without the words: same mic button, chimes and waveform.
  const [testing, setTesting] = useState(false);
  const [listening, setListening] = useState(false);
  const [testError, setTestError] = useState(false);
  const readyAt = useRef(0);
  const heard = useRef(false);

  useEffect(() => {
    if (!isTauri) return;
    let live = true;
    const load = () => void commands.voiceInputDevices().then(list => { if (live) setMicrophones(list); }, () => {});
    load();
    // Plugging a headset in or out shows up the next time the window gets focus.
    window.addEventListener('focus', load);
    return () => { live = false; window.removeEventListener('focus', load); };
  }, []);

  // The check runs while switched on and restarts on the chosen microphone; it stops on leaving the page.
  useEffect(() => {
    if (!testing) return;
    let id: number | null = null, stopped = false;
    void commands.voiceMicTestStart(device, level => { if (!stopped) pushVoiceLevel(TEST_WAVE, level); }).then(started => {
      id = started;
      if (stopped) { void commands.voiceMicTestStop(started); return; }
      showVoiceWave(TEST_WAVE);
      readyAt.current = performance.now();
      // The chime plays once per test, not again when switching microphones.
      if (!heard.current) { heard.current = true; chime('start'); }
      setListening(true);
    }, () => { if (!stopped) { setTestError(true); setTesting(false); } });
    return () => {
      stopped = true;
      if (id != null) void commands.voiceMicTestStop(id);
      hideVoiceWave(TEST_WAVE);
    };
  }, [testing, device]);
  useEffect(() => () => hideVoiceWave(TEST_WAVE), []);

  const toggleTest = () => {
    if (!testing) { setTestError(false); setListening(false); heard.current = false; setTesting(true); return; }
    // Opening the microphone, or a double click right after it opened, is not a stop.
    if (!listening || performance.now() - readyAt.current < 300) return;
    chime('stop');
    heard.current = false;
    setListening(false);
    setTesting(false);
  };
  const phase = !testing ? 'idle' : listening ? 'recording' : 'connecting';

  const defaultLabel = microphones?.default ? t('settings.voice.default_named', { name: microphones.default }) : t('settings.voice.default');
  const options = [{ value: '', label: defaultLabel }, ...(microphones?.devices ?? []).map(name => ({ value: name, label: name }))];
  // A saved microphone that is unplugged stays listed so the choice is not silently lost.
  if (device && !options.some(option => option.value === device)) options.push({ value: device, label: t('settings.voice.missing', { name: device }) });

  return (
    <div className="settings-sound-list">
      <div className="settings-sound-item">
        <div className="settings-sound-row">
          <div className="settings-sound-title">{t('settings.voice.enabled')}<div className="settings-choice-hint">{t('settings.voice.enabled.sub')}</div></div>
          <button type="button" role="switch" className="settings-switch" aria-checked={enabled} aria-label={t('settings.voice.enabled')} onClick={() => setVoiceEnabled(!enabled)}><span /></button>
        </div>
      </div>
      <div className="settings-sound-item">
        <div className="settings-sound-row">
          <div className="settings-sound-title">{t('settings.voice.microphone')}</div>
          <ThemedSelect className="settings-voice-device" align="end" label={t('settings.voice.microphone')} value={device} options={options} onChange={setVoiceDevice} />
        </div>
      </div>
      <div className="settings-sound-item">
        <div className="settings-sound-row">
          <div className="settings-sound-title">{t('settings.voice.test')}<div className="settings-choice-hint">{t('settings.voice.test.sub')}</div></div>
          {/* Fixed-width room for the waveform so starting the check moves nothing. */}
          <span className="settings-voice-wave-room"><VoiceWave waveKey={TEST_WAVE} width={120} /></span>
          <button type="button" className={`gambit-voice${phase === 'idle' ? '' : ` is-${phase}`}`} aria-label={t(testing ? 'settings.voice.test.stop' : 'settings.voice.test.start')} aria-pressed={testing} aria-busy={phase === 'connecting'} onClick={toggleTest}>
            <VoiceGlyph busy={phase === 'connecting'} />
          </button>
        </div>
        {testError && <div className="settings-sound-failed" role="alert">{t('gambit.voice.no_microphone')}</div>}
      </div>
    </div>
  );
}
