import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// shared/conversation is imported by the mobile app, so it must stay free of
// React, Tauri, the DOM and every desktop-only module.
const dir = new URL('../src/shared/conversation/', import.meta.url);
const files = (await readdir(dir)).filter(name => name.endsWith('.ts'));
assert.ok(files.length >= 7, 'shared conversation modules are present');
const forbiddenGlobal = /\b(window|document|localStorage|sessionStorage|navigator|requestAnimationFrame)\s*[.([]/;
for (const name of files) {
  const source = await readFile(new URL(name, dir), 'utf8');
  for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    assert.match(spec, /^\.\/[\w-]+$/, `${name} imports ${spec}; shared modules may only import siblings`);
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, forbiddenGlobal, `${name} touches a browser global`);
}
const result = await build({ entryPoints: [fileURLToPath(new URL('index.ts', dir))], bundle: true, platform: 'neutral', write: false, metafile: true, logLevel: 'silent' });
const inputs = Object.keys(result.metafile.inputs);
assert.ok(inputs.every(path => path.includes('src/shared/conversation/')), `bundle pulled outside modules: ${inputs.join(', ')}`);
console.log(`ok shared/conversation boundary (${files.length} modules)`);
