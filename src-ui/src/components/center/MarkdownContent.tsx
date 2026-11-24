import { memo, useContext, useEffect, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { tokenizeByLang, getShikiTheme, type LineTokens } from '../../lib/shiki';
import { useDataAttr } from '../../lib/use-data-attr';
import { commands } from '../../tauri';
import { ConversationDirectory, conversationLink, findPaths } from '../../lib/conversation-links';
import { wrapEmphasizedUrls } from '../../lib/markdown-emphasis-links';
import { useHoverTip } from '../common/HoverTip';
import './MarkdownContent.css';

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

const FILE_ICON = <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>;
const FOLDER_ICON = <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />;
/** A path split before its own name (with any `:line` after it): `src/lib/a.ts:41` → `src/lib/` + `a.ts:41`. */
function splitPath(text: string): { dir: string; name: string; folder: boolean } {
  const trimmed = text.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
  const name = trimmed.slice(cut) || trimmed;
  return { dir: trimmed.slice(0, cut), name: name + text.slice(trimmed.length), folder: text !== trimmed || !/\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)*$/.test(name) };
}

/** Inline code that is exactly a file path reads as a file link: its icon and name, the full path on hover.
 *  Clicking shows it in the file manager and never runs it: the path may be a program. */
function InlineCode({ children, ...props }: ComponentProps<'code'>) {
  const cwd = useContext(ConversationDirectory);
  const { tipFor, tip } = useHoverTip('hover-tip--wide');
  const text = String(children), [path] = findPaths(text);
  const link = path && path.start === 0 && path.end === text.length ? conversationLink(text, cwd) : null;
  if (!link?.local) return <code className="md-inline-code" {...props}>{children}</code>;
  // The folder part stays in the text, out of sight, so a selection copies the whole path.
  const { dir, name, folder } = splitPath(text);
  return <><a className="md-file-link" aria-label={text} href={link.target} data-conversation-target={link.target} data-conversation-local="true" {...tipFor(link.target)} onClick={event => {
    event.preventDefault(); event.stopPropagation();
    void commands.showInFolder(link.target).catch(error => console.warn('[Markdown] failed to reveal file', link.target, error));
  }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{folder ? FOLDER_ICON : FILE_ICON}</svg>{dir && <span className="md-file-dir">{dir}</span>}<span className="md-file-name">{name}</span></a>{tip}</>;
}

function MarkdownLink({ children, href, ...props }: ComponentProps<'a'>) {
  const cwd = useContext(ConversationDirectory);
  const link = conversationLink(href ?? '', cwd);
  // A link that leads nowhere here (another app's own address, such as `#local_…` for one of its sessions) reads as
  // its words: blue text that does nothing on a click looked broken.
  if (!link) return <span className="md-link-inert">{children}</span>;
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
