/** Emphasized bare URLs in Markdown with `node scripts/run-markdown-emphasis-links-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/markdown-emphasis-links.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { wrapEmphasizedUrls: wrap } = module.exports;
assert.equal(wrap('打开 **http://127.0.0.1:5199/web-demo/showcase.html**，开发服'), '打开 **<http://127.0.0.1:5199/web-demo/showcase.html>**，开发服');
assert.equal(wrap('see *https://a.dev/x* and __https://b.dev__.'), 'see *<https://a.dev/x>* and __<https://b.dev>__.');
assert.equal(wrap('plain https://a.dev/x stays'), 'plain https://a.dev/x stays');
assert.equal(wrap('`**https://a.dev**` in code'), '`**https://a.dev**` in code', 'inline code is left as written');
assert.equal(wrap('```\n**https://a.dev**\n```\n**https://b.dev**'), '```\n**https://a.dev**\n```\n**<https://b.dev>**', 'fenced code is left as written');
assert.equal(wrap('**bold** and https://a.dev'), '**bold** and https://a.dev');
console.log('OK: emphasis around a bare URL stays emphasis, code untouched');
