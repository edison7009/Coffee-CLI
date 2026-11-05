import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// lib/update-manifest.ts: update check and release-notes sources — the CNB
// and GitCode mirrors first, the website last; the newest version any of
// them reports wins, and a dead or slow source never blocks the others.
const source = readFileSync(new URL('../src/lib/update-manifest.ts', import.meta.url), 'utf8');
let respond;
const calls = [];
const context = {
  exports: {}, setTimeout, clearTimeout, AbortController, DOMException,
  fetch: (url, options) => { calls.push(url); return respond(url, options); },
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
const { MANIFEST_SOURCES, isNewerVersion, fetchLatestManifest, fetchNotesForVersion } = context.exports;

assert.ok(MANIFEST_SOURCES[0].includes('cnb.cool') && MANIFEST_SOURCES[1].includes('gitcode.com') && MANIFEST_SOURCES[2] === 'https://coffeecli.com/version.json', 'mirrors first, website last');

for (const [r, l, expected] of [['3.9.2', '3.9.1', true], ['3.10.0', '3.9.9', true], ['3.9.1', '3.9.1', false], ['3.9.0', '3.9.1', false], ['4.0.0', '3.99.99', true]]) {
  assert.equal(isNewerVersion(r, l), expected, `${r} vs ${l}`);
}

const ok = body => Promise.resolve({ ok: true, json: async () => body });
const by = map => url => { const key = url.includes('cnb.cool') ? 'cnb' : url.includes('gitcode.com') ? 'gitcode' : 'site'; return map[key](); };

// Newest wins, whichever source has it.
respond = by({ cnb: () => ok({ version: '3.9.1' }), gitcode: () => ok({ version: '3.9.2', releaseNotes: 'n' }), site: () => ok({ version: '3.9.1' }) });
let m = await fetchLatestManifest();
assert.equal(m.version, '3.9.2');
assert.equal(m.releaseNotes, 'n');
assert.equal(calls.length, 3, 'all three sources are asked at once');

// A lagging mirror cannot hide a release published on the website.
respond = by({ cnb: () => ok({ version: '3.9.1' }), gitcode: () => ok({ version: '3.9.1' }), site: () => ok({ version: '3.9.2', releaseDate: 'd' }) });
m = await fetchLatestManifest();
assert.equal(m.version, '3.9.2');
assert.equal(m.releaseDate, 'd');

// Mirror manifests use publishedAt; it becomes releaseDate.
respond = by({ cnb: () => ok({ version: '3.9.3', publishedAt: '2026-11-05T00:00:00Z', files: {} }), gitcode: () => Promise.reject(new Error('down')), site: () => ok({ version: '3.9.1' }) });
m = await fetchLatestManifest();
assert.equal(m.version, '3.9.3');
assert.equal(m.releaseDate, '2026-11-05T00:00:00Z');

// Broken sources are ignored: HTTP errors, bad JSON, wrong shapes, bad versions.
respond = by({
  cnb: () => Promise.resolve({ ok: false, json: async () => ({ version: '9.9.9' }) }),
  gitcode: () => Promise.resolve({ ok: true, json: async () => { throw new Error('not json'); } }),
  site: () => ok({ version: 'latest' }),
});
assert.equal(await fetchLatestManifest(), null, 'nothing usable reports no update');
respond = by({ cnb: () => ok(null), gitcode: () => ok({ version: 3 }), site: () => ok({ version: '3.9.1' }) });
assert.equal((await fetchLatestManifest()).version, '3.9.1');

// A hanging source times out instead of blocking the check.
calls.length = 0;
const started = Date.now();
respond = (url, options) => url.includes('cnb.cool')
  ? new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  : by({ gitcode: () => ok({ version: '3.9.2' }), site: () => ok({ version: '3.9.1' }) })(url);
assert.equal((await fetchLatestManifest(undefined, 150)).version, '3.9.2');
assert.ok(Date.now() - started < 2000, 'timeout bounds the slowest source');

// Release notes: exact version, first source with non-empty notes, in order.
calls.length = 0;
respond = by({ cnb: () => ok({ version: '3.9.1', releaseNotes: '' }), gitcode: () => ok({ version: '3.9.2', releaseNotes: 'newer' }), site: () => ok({ version: '3.9.1', releaseNotes: 'site notes' }) });
assert.equal(await fetchNotesForVersion('3.9.1', new AbortController().signal), 'site notes');
assert.equal(calls.length, 3);
calls.length = 0;
respond = by({ cnb: () => ok({ version: '3.9.1', releaseNotes: 'cnb notes' }), gitcode: () => ok({}), site: () => ok({}) });
assert.equal(await fetchNotesForVersion('3.9.1', new AbortController().signal), 'cnb notes');
assert.equal(calls.length, 1, 'stops at the first source with notes');
respond = by({ cnb: () => ok({}), gitcode: () => ok({}), site: () => ok({}) });
assert.equal(await fetchNotesForVersion('3.9.1', new AbortController().signal), '');

// Cancellation surfaces as an abort.
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(fetchNotesForVersion('3.9.1', cancelled.signal));
await assert.rejects(fetchLatestManifest(cancelled.signal));

console.log('PASS: update manifest source order, newest-wins, lagging/dead/slow sources, notes per exact version, cancellation');
