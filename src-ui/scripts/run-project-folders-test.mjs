import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/project-folders.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let stored = JSON.stringify(['D:/Coffee-CLI', '/projects/App']);
const localStorage = {
  getItem: key => key === 'coffee:recent-folders' ? stored : null,
  setItem: (key, value) => { assert.equal(key, 'coffee:recent-folders'); stored = value; },
};
const exports = {};
vm.runInNewContext(compiled, { exports, localStorage });

const folders = () => Array.from(exports.getProjectFoldersSnapshot());
assert.deepEqual(folders(), ['D:/Coffee-CLI', '/projects/App']);
let notifications = 0;
const unsubscribe = exports.subscribeProjectFolders(() => { notifications++; });
exports.addProjectFolder('D:/EchoBird');
assert.deepEqual(folders(), ['D:/EchoBird', 'D:/Coffee-CLI', '/projects/App']);
exports.addProjectFolder('D:/Coffee-CLI');
assert.deepEqual(folders(), ['D:/Coffee-CLI', 'D:/EchoBird', '/projects/App'], 'selecting an existing folder moves it to the front without duplicating it');
exports.removeProjectFolder('D:/EchoBird');
assert.deepEqual(folders(), ['D:/Coffee-CLI', '/projects/App']);
assert.deepEqual(JSON.parse(stored), folders());
assert.equal(notifications, 3, 'both views are notified about every actual add, reorder and remove');
exports.removeProjectFolder('D:/missing');
assert.equal(notifications, 3, 'removing an absent folder does not notify or rewrite storage');
unsubscribe();
exports.addProjectFolder('/after-unsubscribe');
assert.equal(notifications, 3, 'unmounted views stop receiving updates');

for (let index = 0; index < 10; index++) exports.addProjectFolder(`/project/${index}`);
assert.equal(folders().length, 8, 'the existing recent-folder limit remains unchanged');
assert.equal(folders()[0], '/project/9');

console.log('OK: shared project folders load, persist, deduplicate, notify and remove without changing their existing limit');
