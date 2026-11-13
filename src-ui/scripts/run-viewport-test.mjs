// Width classes: the boundaries every layout rule depends on.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/viewport.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, URLSearchParams, TextEncoder, TextDecoder });
const { widthClassFor, BREAKPOINTS } = module.exports;

assert.equal(JSON.stringify(BREAKPOINTS), JSON.stringify({ s: 600, m: 900, l: 1200 }));
const cases = [[320, 'xs'], [599, 'xs'], [600, 's'], [899, 's'], [900, 'm'], [1150, 'm'], [1199, 'm'], [1200, 'l'], [2560, 'l']];
for (const [width, expected] of cases) assert.equal(widthClassFor(width), expected, `${width}px`);
console.log('ok viewport width classes and boundaries');
