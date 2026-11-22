// The note Coffee CLI adds to a prompt when its tab works in one remote computer window
// (src/window_control.rs `note`): read by the model, never shown as the user's words.
const NOTE = /\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/;

/** A prompt block that is the note alone. */
export function isWindowNote(text: string): boolean {
  return text.trimStart().startsWith('<system-reminder>');
}

/** A prompt with the note added after the user's words, without it. */
export function withoutWindowNote(text: string): string {
  return text.replace(NOTE, '');
}
