import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/prompt-link.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  // Clipboard and toast are app plumbing; this test checks the links.
  plugins: [{ name: 'stub', setup(b) { b.onResolve({ filter: /\.\/(clipboard|toast)$/ }, () => ({ path: 'stub', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const clipboardWrite = async () => {}; export const showToast = () => {};' })); } }] });
const { buildPromptLink, canSharePrompt, stripHiddenChars, MAX_PROMPT_LINK_CHARS, PROMPT_LINK_PAGE } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const inflate = async packed => {
  const bytes = Buffer.from(packed, 'base64url');
  return new TextDecoder().decode(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
};
const fragment = link => new URLSearchParams(new URL(link).hash.slice(1));

// The prompt rides compressed in the fragment (never sent to the server), and only the prompt.
const prompt = '修一下构建 & run `npm test` + 100%\n第二行 #标签 ?query=1';
const link = await buildPromptLink(prompt);
assert.ok(link.startsWith(`${PROMPT_LINK_PAGE}#z=`));
assert.equal(new URL(link).search, '', 'nothing in the query string');
assert.deepEqual([...fragment(link).keys()], ['z']);
assert.match(fragment(link).get('z'), /^[A-Za-z0-9_-]+$/, 'base64url, no padding');
assert.equal(await inflate(fragment(link).get('z')), prompt);
console.log('ok the prompt round-trips through a compressed fragment');

// Compression makes long Chinese prompts several times shorter than plain encoding.
const long = '你是一名资深前端工程师。请帮我检查这个项目的构建配置，找出导致打包体积过大的依赖，给出具体的优化方案。'.repeat(4);
const packedLength = fragment(await buildPromptLink(long)).get('z').length;
assert.ok(packedLength * 3 < encodeURIComponent(long).length, `compressed ${packedLength} vs plain ${encodeURIComponent(long).length}`);
console.log(`ok compressed ${packedLength} chars vs ${encodeURIComponent(long).length} plain`);

// Without CompressionStream the fragment carries the plain text instead.
const saved = globalThis.CompressionStream;
globalThis.CompressionStream = undefined;
const plain = await buildPromptLink(prompt);
globalThis.CompressionStream = saved;
assert.equal(fragment(plain).get('t'), prompt);
console.log('ok falls back to #t= without compression');

// Empty, whitespace-only and over-long drafts can't be shared; the limit counts characters, not UTF-16 units.
for (const draft of ['', ' \n\t', '\u200B\u200B', 'a'.repeat(MAX_PROMPT_LINK_CHARS + 1)]) {
  assert.equal(canSharePrompt(draft), false);
  assert.equal(await buildPromptLink(draft), null);
}
assert.ok(canSharePrompt('😀'.repeat(MAX_PROMPT_LINK_CHARS)));
console.log('ok empty and over-long drafts have no link');

// Hidden characters are removed and reported; emoji joiners, variation selectors, tabs and newlines stay.
assert.deepEqual(stripHiddenChars('a\u200Bb\u202Ec\u{E0041}d\u0007e\r\nf'), { text: 'abcde\nf', hidden: true });
assert.deepEqual(stripHiddenChars('👨\u200D👩 ❤\uFE0F 👍🏽\ttab\r\nline'), { text: '👨\u200D👩 ❤\uFE0F 👍🏽\ttab\nline', hidden: false });
assert.equal(await inflate(fragment(await buildPromptLink('run\u200Bthis')).get('z')), 'runthis');
console.log('ok hidden characters stripped, emoji kept');

// The website page and the desktop parser use the same rule as this module.
const page = await readFile(new URL('../../../Web-Home/p.html', import.meta.url), 'utf8');
const rustText = await readFile(new URL('../../../src/launch.rs', import.meta.url), 'utf8');
function rustSource() { return rustText; }
const lib = await readFile(new URL('../src/lib/prompt-link.ts', import.meta.url), 'utf8');
const pattern = source => source.match(/HIDDEN = (\/\[.*?\]\/gu);/)[1];
assert.equal(pattern(page), pattern(lib), 'Web-Home/p.html hidden-character rule matches prompt-link.ts');
assert.ok(page.includes("'coffeecli://new?z=' + found.packed"), 'page hands the packed prompt to the desktop');
assert.ok(page.includes("new DecompressionStream('deflate-raw')"), 'page inflates raw deflate');
assert.ok(page.includes('MAX_INFLATED = 64 * 1024') && rustSource().includes('MAX_INFLATED_BYTES: u64 = 64 * 1024'), 'page and desktop share the inflate cap');
assert.ok(!/params\.get\('tool'\)/.test(page), 'page ignores any tool parameter');
assert.ok(page.includes('> 8000'), 'page enforces the same length limit');
const rust = rustSource();
assert.ok(rust.includes(`pub const MAX_PROMPT_CHARS: usize = ${MAX_PROMPT_LINK_CHARS};`), 'launch.rs uses the same limit');
console.log('ok page, desktop and composer agree on the rules');
