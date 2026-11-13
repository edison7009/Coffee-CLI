/** Shared launchpad folders with `node scripts/run-project-folders-test.mjs`. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/project-folders.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let stored = JSON.stringify(['D:/Coffee-CLI', '/projects/App', 7, '']);
const localStorage = { getItem: key => key === 'coffee:recent-folders' ? stored : null, setItem: (key, value) => { assert.equal(key, 'coffee:recent-folders'); stored = value; } };
const exports = {};
// Desktop: the remote bridge reports that this is not a browser.
const desktopBridge = { REMOTE: false, onRemoteStatus: () => () => {}, remoteRequest: () => Promise.reject(new Error('desktop')), remoteStatus: () => 'unpaired' };
vm.runInNewContext(compiled, { exports, localStorage, JSON, require: () => desktopBridge });
const folders = () => Array.from(exports.getProjectFolders());

assert.deepEqual(folders(), ['D:/Coffee-CLI', '/projects/App'], 'only folder paths load from storage');
let notified = 0;
const stop = exports.subscribeProjectFolders(() => { notified++; });
exports.addProjectFolder('D:/EchoBird');
exports.addProjectFolder('D:/Coffee-CLI');
assert.deepEqual(folders(), ['D:/Coffee-CLI', 'D:/EchoBird', '/projects/App'], 'a used folder moves first without a duplicate');
exports.removeProjectFolder('D:/EchoBird');
assert.deepEqual(JSON.parse(stored), ['D:/Coffee-CLI', '/projects/App'], 'every change is saved');
assert.equal(notified, 3);
exports.removeProjectFolder('D:/missing');
exports.addProjectFolder('D:/Coffee-CLI');
assert.equal(notified, 3, 'a change that changes nothing notifies nobody');
stop();
for (let i = 0; i < 10; i++) exports.addProjectFolder(`/p/${i}`);
assert.equal(folders().length, 8, 'the launchpad keeps its eight recent folders');
assert.equal(notified, 3, 'an unsubscribed view hears nothing');

// Web 端: the list is the desktop's, read when the connection comes up; nothing is written to the browser.
let statusListener = null, writes = 0, requests = 0;
const webStorage = { getItem: () => JSON.stringify(['/browser/own']), setItem: () => { writes++; } };
const webBridge = {
  REMOTE: true, remoteStatus: () => 'connected',
  onRemoteStatus: listener => { statusListener = listener; return () => {}; },
  remoteRequest: method => { requests++; assert.equal(method, 'ui.projects'); return Promise.resolve({ folders: ['C:\\work\\app', '/Users/me/site', '', 3] }); },
};
const web = {};
vm.runInNewContext(compiled, { exports: web, localStorage: webStorage, JSON, require: () => webBridge, document: undefined });
assert.deepEqual(Array.from(web.getProjectFolders()), [], 'a browser does not show its own stored folders');
statusListener('connected');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(requests, 1);
assert.deepEqual(Array.from(web.getProjectFolders()), ['C:\\work\\app', '/Users/me/site'], 'the desktop list arrives, Windows and POSIX paths unchanged');
web.addProjectFolder('/Users/me/other');
assert.equal(writes, 0, 'a browser never writes the list to its own storage');
console.log('OK: launchpad folders are shared, deduplicated, saved and limited; a browser uses the desktop list');
