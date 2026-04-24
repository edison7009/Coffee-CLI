// clipboard.ts — unified clipboard I/O for the entire UI.
//
// All clipboard reads/writes MUST go through these helpers. Direct
// `navigator.clipboard.*` and `document.execCommand('copy'|'paste')`
// calls are banned in this codebase because WebView2 shows a native
// "tauri.localhost wants to read the clipboard" permission prompt on
// every invocation, which destroys UX — especially on right-click
// paste. Tauri's clipboard-manager plugin bypasses that prompt.
//
// If you need a new context menu or keyboard shortcut that touches
// the clipboard, import from here. Do not re-derive.

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

/** Write text to the system clipboard. Silently swallows failures
 *  because clipboard writes are always best-effort UX glue — we never
 *  want a rejected promise to break the caller. */
export function clipboardWrite(text: string): Promise<void> {
  return writeText(text).catch(() => {});
}

/** Read text from the system clipboard. Returns empty string on any
 *  failure (empty clipboard, permission denied, etc.) so callers can
 *  do a simple `if (text)` check without try/catch boilerplate. */
export function clipboardRead(): Promise<string> {
  return readText().then(t => t ?? '').catch(() => '');
}
