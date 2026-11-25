// Start and stop chimes for voice input (Claude desktop's voice-mode sounds), shared by the composer and Settings.
const sounds: Record<'start' | 'stop', HTMLAudioElement | null> = { start: null, stop: null };
export function chime(which: 'start' | 'stop') {
  if (typeof Audio === 'undefined') return;
  const audio = sounds[which] ??= Object.assign(new Audio(`/sounds/voice-${which}.mp3`), { volume: 0.3 });
  audio.currentTime = 0;
  void audio.play().catch(() => {});
}
