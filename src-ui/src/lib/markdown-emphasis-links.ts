// GFM's bare-URL autolinks run on to the next space, so emphasis written right around a URL (**https://…**, common in
// model replies, often followed by CJK punctuation) becomes part of the link and the emphasis is left unmatched. An
// angle-bracket autolink ends where its bracket does, so wrapping such a URL in <…> keeps the emphasis intact.
// Bare URLs run on through CJK and Arabic punctuation too (「http://a.dev/x，总览」 linked the whole sentence): an ASCII
// URL followed by such punctuation is wrapped the same way, so it ends before it. A URL with non-ASCII in it (a wiki
// page's Chinese title) is left to GFM. Fenced and inline code are left as written.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const EMPHASIZED_URL = /(\*\*|__|\*|_)(https?:\/\/[^\s<>*_`]+?)\1/g;
// CJK symbols and punctuation, full-width forms' punctuation, the CJK quotes, dashes and ellipsis, Arabic punctuation.
const STOP = '\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65\u2014\u2018\u2019\u201C\u201D\u2026\u060C\u061B\u061F\u06D4';
// Not right after `<` (already bracketed), `(` (a link's destination) or `[` (a link's text), nor inside a word.
const URL_BEFORE_STOP = new RegExp(`(^|[^<(\\[\\w/])(https?:\\/\\/[\\x21-\\x3B\\x3D\\x3F-\\x7E]+?)(?=[${STOP}])`, 'g');

function wrapLine(line: string): string {
  // Odd-numbered pieces are inside inline code spans.
  return line.split(/(`+[^`]*`+)/).map((piece, index) => index % 2 ? piece : piece.replace(EMPHASIZED_URL, '$1<$2>$1').replace(URL_BEFORE_STOP, '$1<$2>')).join('');
}

export function wrapEmphasizedUrls(markdown: string): string {
  if (!markdown.includes('://')) return markdown;
  let fence = '';
  return markdown.split('\n').map(line => {
    const open = FENCE.exec(line)?.[1];
    if (fence) { if (open && open[0] === fence[0] && open.length >= fence.length) fence = ''; return line; }
    if (open) { fence = open; return line; }
    return wrapLine(line);
  }).join('\n');
}
