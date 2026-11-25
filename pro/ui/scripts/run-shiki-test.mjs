/** Run with `node scripts/run-shiki-test.mjs` from src-ui/. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const source = fileURLToPath(new URL('../src/lib/shiki.ts', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'coffee-shiki-test-'));
const outFile = join(temp, 'test.mjs');

try {
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(source)}; export { stats } from 'shiki';`,
      resolveDir: dirname(source),
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [{
      name: 'highlighter-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^shiki$/ }, () => ({ path: 'shiki', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `
            export const stats = { creates: 0, failures: 0 };
            export async function createHighlighter() {
              stats.creates++;
              if (stats.failures > 0) { stats.failures--; throw new Error('initialization failed'); }
              const languages = new Set();
              return {
                getLoadedLanguages: () => [...languages],
                loadLanguage: async lang => {
                  if (lang === 'unknown-language') throw new Error('unknown language');
                  languages.add(lang);
                },
                codeToTokens: text => {
                  if (text === 'invalid-tokenization') throw new Error('tokenization failed');
                  return { tokens: [[{ content: text }]] };
                },
              };
            }
          `,
        }));
      },
    }],
  });
  writeFileSync(outFile, result.outputFiles[0].text);
  const concurrent = await import(`${pathToFileURL(outFile)}?concurrent`);
  const blocks = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    concurrent.tokenizeByLang(`const x = ${i}`, 'ts', 'github-dark-default')));
  assert.equal(concurrent.stats.creates, 1, 'concurrent blocks must share initialization');
  blocks.forEach((tokens, i) => assert.equal(tokens[0][0].content, `const x = ${i}`));

  const retry = await import(`${pathToFileURL(outFile)}?retry`);
  retry.stats.failures = 1;
  const failed = await Promise.all(Array.from({ length: 4 }, () =>
    retry.tokenizeByLang('const x = 1', 'ts', 'github-dark-default')));
  assert.deepEqual(failed, [null, null, null, null], 'failed initialization falls back to plain text');
  assert.equal(retry.stats.creates, 1, 'failed concurrent initialization is also shared');
  assert.notEqual(await retry.tokenizeByLang('retry', 'ts', 'github-dark-default'), null);
  assert.equal(retry.stats.creates, 2, 'a later call retries failed initialization');
  assert.equal(await retry.tokenizeByLang('text', 'unknown-language', 'github-dark-default'), null);
  assert.equal(await retry.tokenizeByLang('invalid-tokenization', 'ts', 'github-dark-default'), null);
  assert.equal(retry.stats.creates, 2, 'grammar/tokenization failure does not recreate the highlighter');
  console.log('OK: Shiki concurrency, initialization retry, and plain-text fallback pass');
} finally {
  assert.equal(dirname(resolve(temp)), resolve(tmpdir()));
  assert.ok(basename(temp).startsWith('coffee-shiki-test-'));
  rmSync(temp, { recursive: true, force: true });
}
