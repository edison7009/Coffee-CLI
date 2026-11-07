/** Terminal URL matching with `node scripts/run-terminal-links-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/terminal-theme.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, navigator: { userAgent: '' }, window: {}, document: {} });
const { LINK_RE, trimLink } = module.exports;
const urls = text => [...text.matchAll(LINK_RE)].map(match => trimLink(match[0]));
assert.deepEqual(urls('打开是 **http://127.0.0.1:5199/web-demo/showcase.html**。我在'), ['http://127.0.0.1:5199/web-demo/showcase.html'], 'bold markers around a URL stay out of it');
assert.deepEqual(urls('see _https://example.com/a_ and (https://example.com/b), then https://example.com/c.'), ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
assert.deepEqual(urls('https://example.com/a*b'), ['https://example.com/a*b'], 'an asterisk inside a URL stays');
console.log('OK: terminal URLs leave out trailing punctuation and Markdown emphasis');
