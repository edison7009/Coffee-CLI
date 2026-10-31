import { createContext } from 'react';

export const ConversationDirectory = createContext<string | null>(null);
export interface ConversationLink { target: string; local: boolean }

export function conversationLink(href: string, cwd: string | null): ConversationLink | null {
  if (!href || href.startsWith('#')) return null;
  if (/^(https?:\/\/|mailto:)/i.test(href)) return { target: href, local: false };
  let path = href;
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      path = url.host ? `//${url.host}${url.pathname}` : url.pathname.replace(/^\/([a-z]:\/)/i, '$1');
    } else if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
    path = decodeURIComponent(path.replace(/#.*$/, '')).replace(/:(\d+)(:\d+)?$/, '').replace(/\\/g, '/');
  } catch { return null; }
  if (!path || path.includes('\0')) return null;
  if (!/^(?:[a-z]:\/|\/)/i.test(path)) {
    if (!cwd) return null;
    path = `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`;
  }
  const prefix = path.startsWith('//') ? '//' : path.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop(); }
    else parts.push(part);
  }
  const target = prefix + parts.join('/');
  return { target: /^[a-z]:$/i.test(target) ? `${target}/` : target, local: true };
}

export interface PathMatch { start: number; end: number; text: string }
const TOKEN = /[^\s"'`<>|*?()[\]{}，。；、：！？（）「」《》]+/g;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)*$/;
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|\/[^\\/]+\/)/;
const DRIVE = /^[A-Za-z]:[\\/]/;

/** File paths in plain text, which unlike links carry no markup. Relative ones must look like a file (`src/app.ts`),
 * so `and/or` or a date stay text. A Windows path may hold spaces: it extends only until a word ends in an extension. */
export function findPaths(text: string): PathMatch[] {
  const found: PathMatch[] = [];
  let from = 0;
  for (;;) {
    TOKEN.lastIndex = from;
    const token = TOKEN.exec(text);
    if (!token) return found;
    from = TOKEN.lastIndex;
    if (token[0].includes('://')) continue;
    const start = token.index;
    let path = token[0].replace(/[.,;:!]+$/, '');
    if (!ABSOLUTE.test(path) && !(/[\\/]/.test(path) && EXTENSION.test(path) && !/^[\\/]/.test(path))) continue;
    if (DRIVE.test(path) && !EXTENSION.test(path)) {
      let cursor = start + token[0].length;
      for (let words = 0; words < 3 && text[cursor] === ' '; words++) {
        TOKEN.lastIndex = cursor;
        const next = TOKEN.exec(text);
        if (!next || next.index !== cursor + 1 || next[0].includes('://') || DRIVE.test(next[0])) break;
        cursor = next.index + next[0].length;
        const word = next[0].replace(/[.,;:!]+$/, '');
        if (EXTENSION.test(word)) { path = text.slice(start, next.index + word.length); from = cursor; break; }
      }
    }
    // A sentence can run straight on after a file name in languages without spaces.
    path = path.replace(/^(.*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)*)[\u3400-\u9fff].*$/, '$1');
    found.push({ start, end: start + path.length, text: path });
  }
}

/** The local file link at a character offset of `text`, if any. */
export function pathLinkAt(text: string, index: number, cwd: string | null): ConversationLink | null {
  const match = findPaths(text).find(path => index >= path.start && index <= path.end);
  const link = match ? conversationLink(match.text, cwd) : null;
  return link?.local ? link : null;
}

