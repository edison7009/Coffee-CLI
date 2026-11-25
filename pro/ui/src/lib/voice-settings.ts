// Voice input preferences, kept on this machine: the master switch (on by default) and the chosen
// microphone by name ('' = the system default), plus the independent dictation source.
// Composers and Settings share them live. Account secrets stay in the native backend.
import { useMemo, useSyncExternalStore } from 'react';
import type { VoiceInputSource } from '../tauri';

const ENABLED = 'cc-voice-enabled';
const DEVICE = 'cc-voice-device';
const SOURCE = 'cc-voice-source';
const SOURCES = 'cc-voice-sources';
let sourceRevision = 0;
const listeners = new Set<() => void>();
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } listeners.forEach(l => l()); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key === null || event.key === ENABLED || event.key === DEVICE || event.key === SOURCE || event.key === SOURCES) listener(); };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
};

export const voiceEnabled = () => read(ENABLED) !== 'false';
export const voiceDevice = () => read(DEVICE) ?? '';
export const setVoiceEnabled = (on: boolean) => { sourceRevision++; write(ENABLED, String(on)); };
export const setVoiceDevice = (name: string) => write(DEVICE, name);
export const useVoiceEnabled = () => useSyncExternalStore(subscribe, voiceEnabled);
export const useVoiceDevice = () => useSyncExternalStore(subscribe, voiceDevice);
export const voiceSource = () => read(SOURCE) ?? '';
export const beginVoiceSourceSelection = () => { sourceRevision++; };
export const setVoiceSource = (source: string) => { beginVoiceSourceSelection(); write(SOURCE, source); };
export const voiceSourceRevision = () => sourceRevision;
export const useVoiceSource = () => useSyncExternalStore(subscribe, voiceSource);

export function readVoiceSources(): VoiceInputSource[] | null {
  return parseVoiceSources(read(SOURCES));
}

function parseVoiceSources(serialized: string | null): VoiceInputSource[] | null {
  try {
    const value: unknown = JSON.parse(serialized ?? 'null');
    if (!Array.isArray(value) || !value.every(item => item && typeof item.id === 'string' && typeof item.name === 'string' && (item.accountId == null || typeof item.accountId === 'string') && (item.issue == null || typeof item.issue === 'string') && (item.transcriptionMode == null || item.transcriptionMode === 'streaming' || item.transcriptionMode === 'batch'))) return null;
    return [...new Map(value.map(item => [item.id, item as VoiceInputSource])).values()];
  } catch { return null; }
}

export function useVoiceSources() {
  const serialized = useSyncExternalStore(subscribe, () => read(SOURCES));
  return useMemo(() => parseVoiceSources(serialized), [serialized]);
}

export function saveVoiceSources(sources: VoiceInputSource[]) {
  // Cache display metadata only; account credentials never reach the browser.
  write(SOURCES, JSON.stringify(sources.map(({ id, name, accountId, issue, transcriptionMode }) => ({ id, name, accountId, issue, transcriptionMode }))));
}
