// Settings → Voice input: local account sources, microphone choice and a live microphone check.
import { useEffect, useRef, useState } from 'react';
import { commands, isTauri } from '../../tauri';
import { useT } from '../../i18n/useT';
import { ThemedSelect } from './ThemedSelect';
import { VoiceGlyph, VoiceWave } from '../center/VoiceInputButton';
import { chime } from '../../lib/voice-chime';
import { hideVoiceWave, pushVoiceLevel, showVoiceWave } from '../../lib/voice-wave';
import { beginVoiceSourceSelection, setVoiceDevice, setVoiceEnabled, setVoiceSource, useVoiceDevice, useVoiceEnabled, useVoiceSource, useVoiceSources, voiceEnabled, voiceSourceRevision } from '../../lib/voice-settings';
import { matchFastestVoiceSource, scanVoiceSources } from '../../lib/voice-source-discovery';

const TEST_WAVE = 'settings-mic-test';
const BATCH_SOURCE_NAMES: Record<string,string> = { 'minimax:cn':'MiniMax', 'minimax:global':'MiniMax (Global)', kilo:'Kilo', antigravity:'Antigravity', grokbot:'Grok Bot', dumate:'DuMate', devin:'Devin', codearts:'CodeArts', qoder:'Qoder', qodercn:'Qoder CN', qwenwork:'QwenWork', qwenworkcn:'QwenWork CN', trae:'TRAE', traecn:'TRAE CN', workbuddyai:'WorkBuddy AI' };
const SOURCE_NAMES: Record<string,string> = { claude:'Claude Code', codex:'Codex / ChatGPT', doubao:'Doubao', doubaowork:'Doubao Work', workbuddy:'WorkBuddy', cursor:'Cursor', macos:'macOS', ...BATCH_SOURCE_NAMES };

export function VoiceSettings() {
  const t = useT();
  const enabled = useVoiceEnabled();
  const device = useVoiceDevice();
  const source = useVoiceSource();
  const sources = useVoiceSources();
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(false);
  const scanLive = useRef(true);
  const scanBusy = useRef(false);
  useEffect(() => { scanLive.current = true; return () => { scanLive.current = false; }; }, []);
  const scan = async () => {
    if (!enabled || scanBusy.current) return;
    scanBusy.current = true;
    setScanning(true);
    setScanError(false);
    try {
      await scanVoiceSources();
    } catch { if (scanLive.current) setScanError(true); }
    finally { scanBusy.current = false; if (scanLive.current) setScanning(false); }
  };
  const chooseSource = async (next: string) => {
    if (!enabled || scanBusy.current) return;
    beginVoiceSourceSelection();
    if (!next) {
      setVoiceSource('');
      scanBusy.current = true; setScanning(true); setScanError(false);
      try { await matchFastestVoiceSource(); }
      catch { if (scanLive.current) setScanError(true); }
      finally { scanBusy.current = false; if (scanLive.current) setScanning(false); }
      return;
    }
    if (next !== 'doubao' && next !== 'doubaowork') { setVoiceSource(next); return; }
    const revision = voiceSourceRevision();
    scanBusy.current = true; setScanning(true); setScanError(false);
    try {
      await commands.voiceInputSelectSource(next);
      if (scanLive.current && voiceEnabled() && voiceSourceRevision() === revision) setVoiceSource(next);
    } catch { if (scanLive.current) setScanError(true); }
    finally { scanBusy.current = false; if (scanLive.current) setScanning(false); }
  };
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
    if (!testing || !enabled) return;
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
      if (!voiceEnabled()) {
        heard.current = false;
        setTesting(false);
        setListening(false);
      }
    };
  }, [testing, device, enabled]);
  useEffect(() => () => hideVoiceWave(TEST_WAVE), []);

  const toggleTest = () => {
    if (!enabled) return;
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
  const usableSources = sources?.filter(item => !item.issue);
  const sourceCards = [...(sources ?? [])];
  if (source && !sourceCards.some(item => item.id === source)) sourceCards.push({ id:source, name:SOURCE_NAMES[source] ?? source, issue:sources ? 'unavailable' : 'saved', transcriptionMode:BATCH_SOURCE_NAMES[source] ? 'batch' : 'streaming' });

  return (
    <>
      <div className="settings-sound-list">
        <div className="settings-sound-item">
          <div className="settings-sound-row">
            <div className="settings-sound-title">{t('settings.voice.enabled')}<div className="settings-choice-hint">{t('settings.voice.enabled.sub')}</div></div>
            <button type="button" role="switch" className="settings-switch" aria-checked={enabled} aria-label={t('settings.voice.enabled')} onClick={() => setVoiceEnabled(!enabled)}><span /></button>
          </div>
        </div>
        <div className="settings-sound-item settings-voice-controls" aria-disabled={!enabled}>
          <div className="settings-sound-row">
            <div className="settings-sound-title">{t('settings.voice.microphone')}</div>
            <ThemedSelect key={String(enabled)} disabled={!enabled} className="settings-voice-device" align="end" label={t('settings.voice.microphone')} value={device} options={options} onChange={setVoiceDevice} />
          </div>
        </div>
        <div className="settings-sound-item settings-voice-controls" aria-disabled={!enabled}>
          <div className="settings-sound-row">
            <div className="settings-sound-title">{t('settings.voice.test')}<div className="settings-choice-hint">{t('settings.voice.test.sub')}</div></div>
            {/* Fixed-width room for the waveform so starting the check moves nothing. */}
            <span className="settings-voice-wave-room"><VoiceWave waveKey={TEST_WAVE} width={120} /></span>
            <button type="button" disabled={!enabled} className={`gambit-voice${phase === 'idle' ? '' : ` is-${phase}`}`} aria-label={t(testing ? 'settings.voice.test.stop' : 'settings.voice.test.start')} aria-pressed={testing} aria-busy={phase === 'connecting'} onClick={toggleTest}>
              <VoiceGlyph busy={phase === 'connecting'} />
            </button>
          </div>
          {testError && <div className="settings-sound-failed" role="alert">{t('gambit.voice.no_microphone')}</div>}
        </div>
      </div>
      <section className="settings-voice-channels" aria-disabled={!enabled}>
        <div className="settings-sound-row">
          <div className="settings-sound-title">{t('settings.voice.source')}<div className="settings-choice-hint">{t('settings.voice.source.sub')}</div></div>
          <button type="button" className="settings-voice-scan" disabled={!enabled || scanning || !isTauri} aria-busy={scanning} aria-label={t(scanning ? 'settings.voice.source.scanning' : 'settings.voice.source.scan')} onClick={() => void scan()}>
            <span className="settings-voice-scan-label" aria-hidden={scanning}>{t('settings.voice.source.scan')}</span>
            {scanning && <span className="settings-voice-scan-progress" aria-hidden="true"><VoiceGlyph busy /></span>}
          </button>
        </div>
        <div className="settings-voice-sources" role="group" aria-label={t('settings.voice.source')}>
          <button type="button" className="settings-voice-source-card" aria-pressed={source === ''} disabled={!enabled || scanning} onClick={() => void chooseSource('')}>
            <span className="settings-voice-source-heading"><span className="settings-voice-source-name">{t('settings.voice.source.auto')}</span></span>
            <span className="settings-voice-source-account">{t('settings.voice.source.account')}</span>
          </button>
          {sourceCards.map(item => <button type="button" key={item.id} className="settings-voice-source-card" aria-pressed={source === item.id} disabled={!enabled || scanning || !!item.issue} onClick={() => void chooseSource(item.id)}>
            <span className="settings-voice-source-heading"><span className="settings-voice-source-name">{item.id === 'macos' ? t('settings.voice.source.macos') : item.name}</span><span className="settings-voice-source-mode">{t((item.transcriptionMode ?? (BATCH_SOURCE_NAMES[item.id] ? 'batch' : 'streaming')) === 'batch' ? 'settings.voice.source.batch' : 'settings.voice.source.streaming')}</span></span>
            <span className="settings-voice-source-account">{item.id === 'macos' && !item.issue ? t('settings.voice.source.system') : item.accountId ? t('settings.voice.source.account_id', { id:item.accountId }) : t(item.issue === 'saved' ? 'settings.voice.source.saved' : item.issue === 'expired' ? 'settings.voice.source.expired' : item.issue ? 'settings.voice.source.missing' : 'settings.voice.source.id_missing')}</span>
          </button>)}
        </div>
        {scanError && <div className="settings-sound-failed" role="alert">{t('settings.voice.source.failed')}</div>}
        {sources && usableSources?.length === 0 && <div className="settings-choice-hint settings-voice-source-status" role="status">{t('settings.voice.source.empty')}</div>}
        {sources?.filter(item => item.issue === 'busy' || item.issue === 'expired').map(item => <div key={item.id} className="settings-choice-hint settings-voice-source-status" role="status">{t(item.issue === 'expired' ? 'settings.voice.source.expired_hint' : 'settings.voice.source.busy', { name:item.name })}</div>)}
      </section>
    </>
  );
}
