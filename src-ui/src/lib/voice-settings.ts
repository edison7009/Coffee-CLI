// Voice input preferences, kept on this machine: the master switch (on by default) and the chosen
// microphone by name ('' = the system default). Composers and Settings share them live.
import { useSyncExternalStore } from 'react';

const ENABLED = 'cc-voice-enabled';
const DEVICE = 'cc-voice-device';
const listeners = new Set<() => void>();
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } listeners.forEach(l => l()); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key === ENABLED || event.key === DEVICE) listener(); };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
};

export const voiceEnabled = () => read(ENABLED) !== 'false';
export const voiceDevice = () => read(DEVICE) ?? '';
export const setVoiceEnabled = (on: boolean) => write(ENABLED, String(on));
export const setVoiceDevice = (name: string) => write(DEVICE, name);
export const useVoiceEnabled = () => useSyncExternalStore(subscribe, voiceEnabled);
export const useVoiceDevice = () => useSyncExternalStore(subscribe, voiceDevice);
