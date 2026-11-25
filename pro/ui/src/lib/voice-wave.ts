// Live microphone loudness for the composer's voice waveform. Only showing and hiding go through
// React; the level itself is read by the waveform's animation loop, so nothing re-renders per update.
import { useSyncExternalStore } from 'react';

const levels = new Map<string, number>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function showVoiceWave(key: string) { if (!levels.has(key)) { levels.set(key, 0); notify(); } }
export function hideVoiceWave(key: string) { if (levels.delete(key)) notify(); }
export function pushVoiceLevel(key: string, level: number) { if (levels.has(key)) levels.set(key, Math.max(0, Math.min(1, level))); }
export function voiceLevel(key: string): number { return levels.get(key) ?? 0; }
export function useVoiceWaveVisible(key: string): boolean { return useSyncExternalStore(subscribe, () => levels.has(key)); }
