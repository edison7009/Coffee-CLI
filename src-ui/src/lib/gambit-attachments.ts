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

/** The words the box shows, and the attached path tokens after the mark (quoted as they will be sent).
 *  Anything else that lands after the mark (a voice transcript, a skill appended to the end) joins the words. */
export function splitDraft(draft: string): { text: string; tokens: string[] } {
  const at = draft.indexOf(ATTACH_MARK);
  if (at < 0) return { text: draft, tokens: [] };
  const block = draft.slice(at + 1).split(ATTACH_MARK).join('');
  const items = gambitAttachments(block);
  const tokens = [...new Set(items.map(item => block.slice(item.start, item.end)))];
  let rest = block;
  for (const item of [...items].reverse()) rest = rest.slice(0, item.start) + rest.slice(item.end);
  rest = rest.trim();
  const words = draft.slice(0, at);
  return { text: rest ? words + (words && !/\s$/.test(words) ? '\n' : '') + rest : words, tokens };
}

export function joinDraft(text: string, tokens: string[]): string {
  return tokens.length ? text + ATTACH_MARK + tokens.join('\n') : text;
}

/** Attach files to a draft: added after the mark, once each, quoted when they contain spaces. */
export function attachToDraft(draft: string, paths: string[]): string {
  const { text, tokens } = splitDraft(draft);
  return joinDraft(text, [...new Set([...tokens, ...paths.map(path => /\s/.test(path) ? `"${path}"` : path)])]);
}

/** Drop one attached file wherever it sits: after the mark or typed into the words. */
export function detachFromDraft(draft: string, path: string): string {
  const { text, tokens } = splitDraft(removeGambitAttachment(draft, path));
  return joinDraft(text, tokens);
}

/** What actually goes out (and into history or pre-input): the words, then the attached paths. */
export function draftForSend(draft: string): string {
  const { text, tokens } = splitDraft(draft);
  if (!tokens.length) return text;
  return text.trimEnd() ? `${text.trimEnd()}\n${tokens.join(' ')}` : tokens.join(' ');
}
