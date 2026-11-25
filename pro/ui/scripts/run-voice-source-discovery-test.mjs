import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const files = ['voice-settings.ts', 'voice-source-discovery.ts'];
const source = files.map(name => {
  const path = new URL(`../src/lib/${name}`, import.meta.url);
  const tree = ts.createSourceFile(name, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  return tree.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(tree).replace(/^export /, '')).join('\n');
}).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const channel = (id, extra = {}) => ({ id, name: id, accountId: `${id}-account`, ...extra });
const ready = (latencyMs, accountId = 'current-account') => ({ latencyMs, accountId });

function harness(initial = new Map()) {
  const storage = new Map(initial);
  const scans = [];
  const probes = [];
  const imports = [];
  const api = runInNewContext(ts.transpileModule(`${source};
    ({ initializeVoiceSources, matchFastestVoiceSource, scanVoiceSources, setVoiceSource, voiceSource, beginVoiceSourceSelection, setVoiceEnabled });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    isTauri: true,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    commands: {
      voiceInputSources: () => new Promise((resolve, reject) => scans.push({ resolve, reject })),
      voiceInputProbeSource: id => new Promise((resolve, reject) => probes.push({ id, resolve, reject })),
      voiceInputSelectSource: async id => {
        imports.push(id);
        if (id === 'doubao') throw Error('locked session');
      },
    },
  });
  return { api, storage, scans, probes, imports };
}

// A first launch discovers channels once, probes concurrently, and persists the fastest result.
const first = harness();
const startup = first.api.initializeVoiceSources();
assert.equal(first.api.initializeVoiceSources(), startup, 'StrictMode does not duplicate initialization');
assert.equal(first.scans.length, 1);
first.scans[0].resolve([channel('slow'), channel('fast', { token: 'private-fixture' }), channel('busy', { issue: 'busy' })]);
await tick();
assert.deepEqual(first.probes.map(probe => probe.id), ['slow', 'fast']);
first.probes[1].resolve(ready(20));
first.probes[0].resolve(ready(400));
await startup;
assert.equal(first.api.voiceSource(), 'fast');
assert.equal(JSON.parse(first.storage.get('cc-voice-sources'))[1].token, undefined);

// The next launch checks only the saved selection, even if another channel could be faster.
const next = harness(first.storage);
const cachedStartup = next.api.initializeVoiceSources();
assert.equal(next.scans.length, 0);
assert.deepEqual(next.probes.map(probe => probe.id), ['fast']);
next.probes[0].resolve(ready(900, 'new-native-account'));
await cachedStartup;
assert.equal(next.api.voiceSource(), 'fast');
assert.equal(next.scans.length, 0);
assert.equal(JSON.parse(next.storage.get('cc-voice-sources'))[1].accountId, 'new-native-account');

const oldIssue = harness(new Map([
  ['cc-voice-source', 'fast'],
  ['cc-voice-sources', JSON.stringify([channel('fast', { issue: 'busy' })])],
]));
const recheck = oldIssue.api.initializeVoiceSources();
oldIssue.probes[0].resolve(ready(15, null));
await recheck;
assert.equal(oldIssue.scans.length, 0, 'a stale cached issue still checks only the selected channel');
assert.equal(JSON.parse(oldIssue.storage.get('cc-voice-sources'))[0].issue, undefined);
assert.equal(JSON.parse(oldIssue.storage.get('cc-voice-sources'))[0].accountId, 'fast-account');

// An unusable cached choice triggers discovery and matching, skipping its failed connection.
const expired = harness(first.storage);
const fallback = expired.api.initializeVoiceSources();
expired.probes[0].resolve(null);
await tick();
assert.equal(expired.scans.length, 1);
expired.scans[0].resolve([channel('fast'), channel('working'), channel('down')]);
await tick();
assert.deepEqual(expired.probes.map(probe => probe.id), ['fast', 'working', 'down']);
expired.probes[1].resolve(ready(80));
expired.probes[2].reject(Error('offline'));
await fallback;
assert.equal(expired.api.voiceSource(), 'working');

// A manual choice made during the selected-channel check stops background matching.
const manual = harness(first.storage);
const pendingCheck = manual.api.initializeVoiceSources();
manual.api.setVoiceSource('manual-channel');
manual.probes[0].resolve(null);
await pendingCheck;
assert.equal(manual.api.voiceSource(), 'manual-channel');
assert.equal(manual.scans.length, 0);

// Manual account import may still be pending when startup finishes checking its saved choice.
const importing = harness(first.storage);
const pendingImport = importing.api.initializeVoiceSources();
importing.api.beginVoiceSourceSelection();
importing.probes[0].resolve(null);
await pendingImport;
assert.equal(importing.scans.length, 0);
assert.equal(importing.api.voiceSource(), 'fast');

// Choosing the same channel explicitly also takes precedence over a pending background scan.
const same = harness(first.storage);
const pendingScan = same.api.initializeVoiceSources();
same.probes[0].resolve(null);
await tick();
same.api.setVoiceSource('fast');
same.scans[0].resolve([channel('other')]);
await pendingScan;
assert.equal(same.api.voiceSource(), 'fast');
assert.equal(same.probes.length, 1);

// Manual and startup refreshes share their native scan. A failed Doubao import tries the next result.
const shared = harness();
const pendingMatch = shared.api.initializeVoiceSources();
const refresh = shared.api.scanVoiceSources();
assert.equal(shared.scans.length, 1);
shared.scans[0].resolve([channel('doubao'), channel('cursor')]);
await refresh;
await tick();
shared.probes[0].resolve(ready(5));
shared.probes[1].resolve(ready(40));
await pendingMatch;
assert.deepEqual(shared.imports, ['doubao']);
assert.equal(shared.api.voiceSource(), 'cursor');

// A refresh during validation keeps its newer metadata when the selected account is updated.
const refreshed = harness(first.storage);
const validating = refreshed.api.initializeVoiceSources();
const freshScan = refreshed.api.scanVoiceSources();
refreshed.scans[0].resolve([channel('fast'), channel('newly-installed')]);
await freshScan;
refreshed.probes[0].resolve(ready(10));
await validating;
assert.deepEqual(JSON.parse(refreshed.storage.get('cc-voice-sources')).map(source => source.id), ['fast', 'newly-installed']);

// Offline startup preserves a previous choice and its cached cards.
const offline = harness(first.storage);
const offlineStartup = offline.api.initializeVoiceSources();
offline.probes[0].reject(Error('network down'));
await tick();
offline.scans[0].reject(Error('scan failed'));
await offlineStartup;
assert.equal(offline.api.voiceSource(), 'fast');
assert.equal(offline.storage.get('cc-voice-sources'), first.storage.get('cc-voice-sources'));

const disabled = harness(new Map([['cc-voice-enabled', 'false']]));
await disabled.api.initializeVoiceSources();
assert.equal(disabled.scans.length, 0);
assert.equal(disabled.probes.length, 0);

const toggled = harness();
const matching = toggled.api.initializeVoiceSources();
toggled.scans[0].resolve([channel('cursor')]);
await tick();
toggled.api.setVoiceEnabled(false);
toggled.api.setVoiceEnabled(true);
toggled.probes[0].resolve(ready(1));
await matching;
assert.equal(toggled.api.voiceSource(), '', 'turning voice off cancels the pending match even after re-enabling');

console.log('voice discovery startup cache, parallel matching, manual overrides and offline recovery passed');
