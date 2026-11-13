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
import { commands } from '../tauri';
import { REMOTE } from '../remote/bridge';

/** Write text to the system clipboard. Silently swallows failures
 *  because clipboard writes are always best-effort UX glue — we never
 *  want a rejected promise to break the caller. */
export function clipboardWrite(text: string): Promise<void> {
  // Web 端: the desktop's clipboard is not this device's; use the browser's own.
  if (REMOTE) return webClipboardWrite(text);
  return writeText(text).catch(() => {});
}

/** Read text from the system clipboard. Returns empty string on any
 *  failure (empty clipboard, permission denied, etc.) so callers can
 *  do a simple `if (text)` check without try/catch boilerplate. */
export function clipboardRead(): Promise<string> {
  // Reading needs a secure context; over http://<LAN address> there is no way to read.
  if (REMOTE) return navigator.clipboard?.readText().catch(() => '') ?? Promise.resolve('');
  return readText().then(t => t ?? '').catch(() => '');
}

/** Read an image from the OS clipboard and persist it as a PNG temp file,
 *  returning the absolute path. Returns null when the clipboard holds no
 *  image (or the clipboard is temporarily locked) — callers fall back to
 *  `clipboardRead()` for the text-paste path. Goes through the Tauri
 *  backend (arboard), so unlike `navigator.clipboard.read()` it never
 *  triggers a WebView2 permission prompt. */
export function clipboardReadImage(): Promise<string | null> {
  return commands.readClipboardImage().catch(() => null);
}

/** Over http://<LAN address> a browser has no navigator.clipboard; copying then
 *  goes through a hidden selection, which every browser still allows on a click. */
function webClipboardWrite(text: string): Promise<void> {
  if (navigator.clipboard) return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  legacyCopy(text);
  return Promise.resolve();
}
function legacyCopy(text: string) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch { /* nothing more to try */ }
  area.remove();
}
