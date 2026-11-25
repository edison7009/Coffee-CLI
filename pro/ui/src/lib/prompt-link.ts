// Prompt links — a shareable https link that opens Coffee CLI with a prompt
// ready to send. Share copies the link; the website page at /p decodes its fragment and offers `coffeecli://new?z=…`, which
// the desktop parses in src/launch.rs. A link only ever fills a draft: it never
// sends, and it can't pick a tool, folder or mode.

import { clipboardWrite } from './clipboard';
import { showToast } from './toast';

export const PROMPT_LINK_PAGE = 'https://coffeecli.com/p';
/** Same limit as src/launch.rs `MAX_PROMPT_CHARS`, counted in characters. */
export const MAX_PROMPT_LINK_CHARS = 8000;

// Mirrors src/launch.rs `is_hidden_char`: zero-width, bidi, invisible
// operators, tag characters and stray controls. The emoji joiner and
// variation selectors stay because emoji need them.
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const HIDDEN = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF0-\uFFFB\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/** Remove characters a reader can't see. `hidden` tells whether any were there. */
export function stripHiddenChars(text: string): { text: string; hidden: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  const clean = normalized.replace(HIDDEN, '');
  return { text: clean, hidden: clean !== normalized };
}

/** Whether a draft can be shared: some visible text, within the link limit. */
export function canSharePrompt(draft: string): boolean {
  const { text } = stripHiddenChars(draft);
  return !!text.trim() && [...text].length <= MAX_PROMPT_LINK_CHARS;
}

/** base64url without padding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The prompt deflated (raw) and base64url-encoded, or null where CompressionStream is missing. */
export async function compressPrompt(text: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** The share link for a draft, or null when it can't be shared. The prompt rides in the
 *  fragment (`#z=` compressed, `#t=` plain where compression is unavailable), which browsers
 *  never send to the server: the site only decodes it in the page and stores nothing.
 *  Links carry only the text: whoever opens one picks their own tool. */
export async function buildPromptLink(draft: string): Promise<string | null> {
  if (!canSharePrompt(draft)) return null;
  const text = stripHiddenChars(draft).text.trim();
  const packed = await compressPrompt(text).catch(() => null);
  return `${PROMPT_LINK_PAGE}#${packed ? `z=${packed}` : `t=${encodeURIComponent(text)}`}`;
}

/** Share: copy the prompt's link and confirm with the app toast. Only the link, so it also
 *  works pasted straight into a browser's address bar; the page shows the prompt. */
export async function sharePrompt(draft: string, copiedLabel: string): Promise<void> {
  const link = await buildPromptLink(draft);
  if (!link) return;
  await clipboardWrite(link);
  showToast(copiedLabel);
}
