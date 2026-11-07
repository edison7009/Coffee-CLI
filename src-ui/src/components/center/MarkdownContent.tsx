import { memo, useContext, useEffect, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { tokenizeByLang, getShikiTheme, type LineTokens } from '../../lib/shiki';
import { useDataAttr } from '../../lib/use-data-attr';
import { commands } from '../../tauri';
import { ConversationDirectory, conversationLink, findPaths } from '../../lib/conversation-links';
import { wrapEmphasizedUrls } from '../../lib/markdown-emphasis-links';

function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const dataMode = useDataAttr('data-mode');
  const [tokens, setTokens] = useState<LineTokens[] | null>(null);

  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    tokenizeByLang(code, lang, getShikiTheme(dataMode)).then(value => {
      if (!cancelled) setTokens(value);
    });
    return () => { cancelled = true; };
  }, [code, lang, dataMode]);

  return (
    <pre className="md-code"><code>
      {tokens && lang
        ? tokens.map((line, i) => (
            <div key={i} className="md-code-line">
              {line.map((token, j) => <span key={j} style={{ color: token.color }}>{token.content}</span>)}
            </div>
          ))
        : code}
    </code></pre>
  );
}

/** Inline code that is exactly a file path shows it in the file manager. Clicking never runs it: the path may be a program. */
function InlineCode({ children, ...props }: ComponentProps<'code'>) {
  const cwd = useContext(ConversationDirectory);
  const text = String(children), [path] = findPaths(text);
  const link = path && path.start === 0 && path.end === text.length ? conversationLink(text, cwd) : null;
  if (!link?.local) return <code className="md-inline-code" {...props}>{children}</code>;
  return <code className="md-inline-code" {...props}><a href={link.target} data-conversation-target={link.target} data-conversation-local="true" onClick={event => {
    event.preventDefault(); event.stopPropagation();
    void commands.showInFolder(link.target).catch(error => console.warn('[Markdown] failed to reveal file', link.target, error));
  }}>{children}</a></code>;
}

function MarkdownLink({ children, href, ...props }: ComponentProps<'a'>) {
  const cwd = useContext(ConversationDirectory);
  const link = conversationLink(href ?? '', cwd);
  return (
    <a
      href={link?.target}
      data-conversation-target={link?.target}
      data-conversation-local={link?.local || undefined}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
      onClick={(event) => {
        event.preventDefault();
        if (!link) return;
        event.stopPropagation();
        void commands.openUrl(link.target).catch(error => {
          console.warn('[Markdown] failed to open link', link.target, error);
        });
      }}
    >
      {children}
    </a>
  );
}

// Stable component identities keep syntax-highlighted blocks mounted when a
// live transcript appends another message. Recreating this object per render
// makes ReactMarkdown remount every code block and repeat Shiki tokenization.
const MARKDOWN_COMPONENTS: Components = {
  code({ className, children, ...props }) {
    const fenced = /language-(\w+)/.exec(className || '');
    const text = String(children).replace(/\n$/, '');
    if (!fenced && !String(children).includes('\n')) {
      return <InlineCode {...props}>{children}</InlineCode>;
    }
    return <CodeBlock code={text} lang={fenced?.[1] ?? null} />;
  },
  a: MarkdownLink,
};

function MarkdownContentImpl({ content }: { content: string }) {
  const cwd = useContext(ConversationDirectory);
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MARKDOWN_COMPONENTS}
        urlTransform={url => conversationLink(url, cwd) ? url : ''}
      >
        {wrapEmphasizedUrls(content)}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentImpl);
