// GFM's bare-URL autolinks run on to the next space, so emphasis written right around a URL (**https://…**, common in
// model replies, often followed by CJK punctuation) becomes part of the link and the emphasis is left unmatched. An
// angle-bracket autolink ends where its bracket does, so wrapping such a URL in <…> keeps the emphasis intact.
// Fenced and inline code are left as written.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const EMPHASIZED_URL = /(\*\*|__|\*|_)(https?:\/\/[^\s<>*_`]+?)\1/g;

function wrapLine(line: string): string {
  // Odd-numbered pieces are inside inline code spans.
  return line.split(/(`+[^`]*`+)/).map((piece, index) => index % 2 ? piece : piece.replace(EMPHASIZED_URL, '$1<$2>$1')).join('');
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
