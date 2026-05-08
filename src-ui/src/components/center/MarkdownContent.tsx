// MarkdownContent.tsx — render an AI / user message as Markdown.
//
// react-markdown renders the parsed AST as a real React tree (no
// dangerouslySetInnerHTML), so each node can be overridden. Here we
// override fenced code blocks to use our existing Shiki tokenizer
// (lib/shiki.ts) — same path that powers the Diff panel — so a
// ```js block highlights with the same theme as a .js diff.
//
// Inline code (`x`) keeps the default <code> rendering.

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { tokenizeByLang, getShikiTheme, type LineTokens } from '../../lib/shiki';
import { useDataAttr } from '../../lib/use-data-attr';

interface CodeBlockProps {
  code: string;
  lang: string | null;
}

function CodeBlock({ code, lang }: CodeBlockProps) {
  const dataTheme = useDataAttr('data-theme');
  const [tokens, setTokens] = useState<LineTokens[] | null>(null);

  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    tokenizeByLang(code, lang, getShikiTheme(dataTheme)).then(t => {
      if (!cancelled) setTokens(t);
    });
    return () => { cancelled = true; };
  }, [code, lang, dataTheme]);

  return (
    <pre className="md-code">
      <code>
        {tokens
          ? tokens.map((line, i) => (
              <div key={i} className="md-code-line">
                {line.map((tok, j) => (
                  <span key={j} style={{ color: tok.color }}>{tok.content}</span>
                ))}
              </div>
            ))
          : code}
      </code>
    </pre>
  );
}

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children }: any) {
            // react-markdown distinguishes inline `code` from fenced
            // ```code``` via the `inline` prop. Fenced blocks carry a
            // language hint in className like `language-js`.
            if (inline) {
              return <code className="md-inline-code">{children}</code>;
            }
            const langMatch = /language-(\w+)/.exec(className || '');
            const lang = langMatch ? langMatch[1] : null;
            const text = String(children).replace(/\n$/, '');
            return <CodeBlock code={text} lang={lang} />;
          },
          a({ children, href, ...props }: any) {
            // External links open in a new tab; protects users from
            // accidentally navigating away from the desktop app.
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
