import type { ClipboardEvent } from 'react';
import { commands } from '../tauri';

// Question answers are text all the way to the tool, so a pasted image is saved
// like a terminal/Gambit paste and its path goes into the answer. The agent opens
// the file with its own tools.

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Insert `paths` at the selection with spaces around them, as Gambit does. */
export function insertPaths(value: string, start: number, end: number, paths: string[]): string {
  const before = value.slice(0, start), after = value.slice(end);
  const quoted = paths.map(path => /\s/.test(path) ? `"${path}"` : path).join(' ');
  return before + (before && !/\s$/.test(before) ? ' ' : '') + quoted + (after && !/^\s/.test(after) ? ' ' : '') + after;
}

/** Handles an image paste into an answer field; text pastes pass through untouched. */
export function pasteImageIntoAnswer(e: ClipboardEvent<HTMLInputElement>, onChange: (value: string) => void): void {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const files: { file: File; ext: string }[] = [];
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push({ file, ext: (item.type.split('/')[1] || 'png').toLowerCase() });
  }
  if (!files.length) return;
  e.preventDefault();
  const input = e.currentTarget, start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
  void (async () => {
    const paths: string[] = [];
    for (const { file, ext } of files) {
      try { paths.push(await commands.saveClipboardImage(await fileToBase64(file), ext)); }
      catch (error) { console.error('[answer] save image failed', error); }
    }
    // Read the field again: the user may have kept typing while the image saved.
    if (paths.length) onChange(insertPaths(input.value, Math.min(start, input.value.length), Math.min(end, input.value.length), paths));
  })();
}
