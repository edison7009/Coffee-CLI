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
vm.runInNewContext(compiled, { exports, localStorage, JSON });
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
console.log('OK: launchpad folders are shared, deduplicated, saved and limited');
