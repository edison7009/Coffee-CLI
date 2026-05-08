// shiki.ts — Singleton Shiki highlighter for the Diff panel.
// Lazy-loaded so the highlighter (and its grammar/theme bundles) only fetch
// when the user actually opens a diff. Languages load on demand the first
// time a file with that extension is highlighted; subsequent files of the
// same language hit the cache.

import type { Highlighter, ThemedToken } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // Dynamic import keeps Shiki out of the main bundle until first use.
    const { createHighlighter } = await import('shiki');
    highlighterPromise = createHighlighter({
      themes: ['github-dark-default', 'github-light-default'],
      langs: [],
    });
  }
  return highlighterPromise;
}

// File extension → Shiki language id. Covers the languages CLI users edit
// daily; unknown extensions fall through to plain text (no highlight, no
// crash). Add entries as needed.
const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rs: 'rust', go: 'go', java: 'java',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  c: 'c', h: 'c', hpp: 'cpp',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  html: 'html', xml: 'xml', svg: 'xml', vue: 'vue', svelte: 'svelte',
  json: 'json', md: 'markdown', mdx: 'mdx',
  yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  sql: 'sql', dockerfile: 'docker',
};

function detectLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? LANG_MAP[ext] ?? null : null;
}

export type LineTokens = ThemedToken[];

/** Theme for the syntax tokens, picked by the app's `data-theme` attribute.
 *  Coffee CLI has 9 ThemeColor values (dark/light/cappuccino/sakura/...)
 *  but only `light` is a true light palette; the rest are dark accent
 *  variants — so a binary light/dark split is the right mapping. */
export function getShikiTheme(dataTheme: string | null): 'github-light-default' | 'github-dark-default' {
  return dataTheme === 'light' ? 'github-light-default' : 'github-dark-default';
}

/** Tokenize `text` for syntax-highlighted rendering. Returns one
 *  ThemedToken[] per line. Resolves to `null` when the file's language
 *  isn't in LANG_MAP (caller should fall back to plain text) or when
 *  Shiki fails to load that grammar (rare — bundle missing). */
export async function tokenizeFile(
  text: string,
  filePath: string,
  theme: 'github-light-default' | 'github-dark-default',
): Promise<LineTokens[] | null> {
  const lang = detectLanguage(filePath);
  if (!lang) return null;
  return tokenizeAt(text, lang, theme);
}

/** Tokenize by explicit language id (Shiki name, e.g. `typescript`,
 *  `python`). For Markdown fenced code blocks where the user wrote
 *  ` ```js ` rather than a file path. Same null-fallback contract. */
export async function tokenizeByLang(
  text: string,
  langHint: string,
  theme: 'github-light-default' | 'github-dark-default',
): Promise<LineTokens[] | null> {
  const lang = LANG_MAP[langHint.toLowerCase()] ?? langHint.toLowerCase();
  return tokenizeAt(text, lang, theme);
}

async function tokenizeAt(
  text: string,
  lang: string,
  theme: 'github-light-default' | 'github-dark-default',
): Promise<LineTokens[] | null> {
  const highlighter = await getHighlighter();
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    try {
      await highlighter.loadLanguage(lang as any);
    } catch {
      return null;
    }
  }
  try {
    return highlighter.codeToTokens(text, { lang: lang as any, theme }).tokens;
  } catch {
    return null;
  }
}
