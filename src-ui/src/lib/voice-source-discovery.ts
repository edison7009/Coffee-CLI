import { commands, isTauri, type VoiceInputSource } from '../tauri';
import { readVoiceSources, saveVoiceSources, setVoiceSource, voiceEnabled, voiceSource, voiceSourceRevision } from './voice-settings';

let startup: Promise<void> | undefined;
let scan: Promise<VoiceInputSource[]> | undefined;

// Startup and a manual refresh share any scan already in progress.
export function scanVoiceSources(): Promise<VoiceInputSource[]> {
  if (!scan) {
    scan = commands.voiceInputSources().then(sources => {
      saveVoiceSources(sources);
      return sources;
    }).finally(() => { scan = undefined; });
  }
  return scan;
}

async function probe(source: string) {
  try { return await commands.voiceInputProbeSource(source); }
  catch { return null; }
}

async function matchVoiceSource(checkSaved: boolean): Promise<void> {
  const selected = voiceSource();
  const revision = voiceSourceRevision();
  const unchanged = () => voiceEnabled() && voiceSource() === selected && voiceSourceRevision() === revision;
  const cached = readVoiceSources();
  let unavailable: string | undefined;
  if (checkSaved && selected && cached?.some(source => source.id === selected)) {
    const ready = await probe(selected);
    if (!unchanged()) return;
    if (ready) {
      const current = readVoiceSources() ?? cached;
      saveVoiceSources(current.map(source => source.id === selected ? { ...source, accountId: ready.accountId ?? source.accountId, issue: undefined } : source));
      return;
    }
    unavailable = selected;
  }
  if (!unchanged()) return;
  const sources = await scanVoiceSources();
  if (!unchanged()) return;
  const candidates = await Promise.all(sources.filter(source => !source.issue && source.id !== unavailable).map(async source => {
    const ready = await probe(source.id);
    return ready ? { source, ...ready } : null;
  }));
  if (!unchanged()) return;
  const available = candidates.filter(candidate => candidate !== null).sort((left, right) => left.latencyMs - right.latencyMs);
  for (const candidate of available) {
    // Doubao's selected session is kept in Coffee's existing encrypted store.
    if (candidate.source.id === 'doubao' || candidate.source.id === 'doubaowork') {
      try { await commands.voiceInputSelectSource(candidate.source.id); }
      catch { continue; }
      if (!unchanged()) return;
    }
    const current = readVoiceSources() ?? sources;
    saveVoiceSources(current.map(source => source.id === candidate.source.id ? { ...source, accountId: candidate.accountId ?? source.accountId, issue: undefined } : source));
    setVoiceSource(candidate.source.id);
    return;
  }
}

export function initializeVoiceSources(): Promise<void> {
  if (!isTauri || !voiceEnabled()) return Promise.resolve();
  startup ??= matchVoiceSource(true).catch(() => { /* Keep the cached selection while offline. */ });
  return startup;
}

export function matchFastestVoiceSource(): Promise<void> {
  return matchVoiceSource(false);
}
