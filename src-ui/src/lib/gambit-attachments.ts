export interface GambitAttachment {
  path: string;
  start: number;
  end: number;
  image: boolean;
}

// Quoted paths include spaces; bare paths must end in a file extension.
// Keep source ranges so removing a chip also removes its actual prompt token.
export function gambitAttachments(draft: string): GambitAttachment[] {
  const pattern = /"((?:[A-Za-z]:[\\/]|\/|\\\\)[^"\r\n]+)"|'((?:[A-Za-z]:[\\/]|\/|\\\\)[^'\r\n]+)'|(?:(?<!\w)[A-Za-z]:[\\/]|(?<![\w:/])\/|\\\\)[^\s<>"'`]+?\.[\w]+(?=$|[\s<>"'`])/g;
  return Array.from(draft.matchAll(pattern), match => {
    const path = match[1] ?? match[2] ?? match[0];
    return { path, start: match.index, end: match.index + match[0].length, image: /\.(png|jpe?g|gif|webp|bmp)$/i.test(path) };
  });
}

export function removeGambitAttachment(draft: string, path: string): string {
  for (const item of gambitAttachments(draft).reverse()) {
    if (item.path === path) draft = draft.slice(0, item.start) + draft.slice(item.end);
  }
  return draft;
}

// Attached files ride at the end of the draft, after this invisible mark, so the box shows only the words
// while the draft (saved per tab, sent, kept in pre-input) still carries every path. The mark never leaves
// the composer: draftForSend puts the paths back after the words as plain text.
export const ATTACH_MARK = '\u2063'; // INVISIBLE SEPARATOR

// One attachment per line after the mark: an absolute path at least two levels deep (quoted when it has spaces),
// to a file or to a folder written with a trailing separator. Any other line (a voice transcript, a skill appended to the end) belongs to the words.
const ABSOLUTE = String.raw`(?:[A-Za-z]:[\\/]|\/|\\\\)`;
const BLOCK_TOKEN = new RegExp(String.raw`^(?:"(${ABSOLUTE}[^"\r\n]+)"|'(${ABSOLUTE}[^'\r\n]+)'|(${ABSOLUTE}[^\s<>"'` + '`' + String.raw`]*[\\/][^\s<>"'` + '`' + String.raw`]*))$`);
const unquote = (token: string) => { const match = BLOCK_TOKEN.exec(token); return match ? match[1] ?? match[2] ?? match[3] : token; };
const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
export const isFolderPath = (path: string) => /[\\/]$/.test(path);

/** The words the box shows, and the attached path tokens after the mark (quoted as they will be sent). */
export function splitDraft(draft: string): { text: string; tokens: string[] } {
  const at = draft.indexOf(ATTACH_MARK);
  if (at < 0) return { text: draft, tokens: [] };
  const tokens: string[] = [], rest: string[] = [];
  for (const line of draft.slice(at + 1).split(ATTACH_MARK).join('').split('\n')) {
    const token = line.trim();
    if (!token) continue;
    if (BLOCK_TOKEN.test(token)) { if (!tokens.includes(token)) tokens.push(token); } else rest.push(line);
  }
  const words = draft.slice(0, at), extra = rest.join('\n').trim();
  return { text: extra ? words + (words && !/\s$/.test(words) ? '\n' : '') + extra : words, tokens };
}

export function joinDraft(text: string, tokens: string[]): string {
  return tokens.length ? text + ATTACH_MARK + tokens.join('\n') : text;
}

/** Attach files and folders to a draft: added after the mark, once each, quoted when they contain spaces.
 *  A folder is passed with a trailing separator, which is how it stays a folder in the draft. */
export function attachToDraft(draft: string, paths: string[]): string {
  const { text, tokens } = splitDraft(draft);
  return joinDraft(text, [...new Set([...tokens, ...paths.map(path => /\s/.test(path) ? `"${path}"` : path)])]);
}

/** Every attachment the composer shows: files typed into the words, then everything after the mark. */
export function draftAttachments(draft: string): { path: string; image: boolean; folder: boolean }[] {
  const { text, tokens } = splitDraft(draft);
  const paths = [...gambitAttachments(text).map(item => item.path), ...tokens.map(unquote)];
  return [...new Set(paths)].map(path => ({ path, image: isImage(path), folder: isFolderPath(path) }));
}

/** Drop one attachment wherever it sits: after the mark or typed into the words. */
export function detachFromDraft(draft: string, path: string): string {
  const { text, tokens } = splitDraft(draft);
  return joinDraft(removeGambitAttachment(text, path), tokens.filter(token => unquote(token) !== path));
}

/** What actually goes out (and into history or pre-input): the words, then the attached paths. */
export function draftForSend(draft: string): string {
  const { text, tokens } = splitDraft(draft);
  if (!tokens.length) return text;
  return text.trimEnd() ? `${text.trimEnd()}\n${tokens.join(' ')}` : tokens.join(' ');
}
