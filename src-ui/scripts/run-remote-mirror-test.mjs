// Browser mirror of the desktop's terminals: the tab strip follows the desktop's list.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  stdin: { contents: `export { reducer } from './src/store/app-state';`, resolveDir: root },
  bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', external: ['react', 'react/*', 'react-dom', '@tauri-apps/*'],
  plugins: [{ name: 'expose-reducer', setup(builder) {
    builder.onLoad({ filter: /[/\\]store[/\\]app-state\.tsx$/ }, async args => ({ loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { reducer };` }));
  } }],
});
// Written beside node_modules so the bundle's bare imports (react) resolve.
const out = `${root}node_modules/.cache/remote-mirror-test.mjs`;
await mkdir(`${root}node_modules/.cache`, { recursive: true });
await writeFile(out, compiled.outputFiles[0].text);
const { reducer } = await import(out);

const tab = (id, extra = {}) => ({ id, tool: 'claude', cwd: '/p', title: id, claudeMode: (extra.tool ?? 'claude') === 'claude' ? 'conversation' : undefined, ...extra });
let state = { terminals: [{ id: 'blank', tool: null, folderPath: null }], tabOrder: ['blank'], activeTerminalId: 'blank' };
const sync = tabs => { state = reducer(state, { type: 'SYNC_MIRROR_TABS', tabs }); };

// Opening the page: the desktop's terminals appear and the first one is shown instead of the launch page.
sync([tab('a'), tab('b', { tool: 'codex' })]);
assert.deepEqual(state.tabOrder, ['blank', 'a', 'b']);
assert.equal(state.activeTerminalId, 'a');
const a = state.terminals.find(t => t.id === 'a'), b = state.terminals.find(t => t.id === 'b');
assert.equal(a.mirror, true); assert.equal(a.claudeMode, 'conversation', 'the desktop decides the view'); assert.equal(b.codexMode, undefined); assert.equal(a.toolTitle, 'a');

// Nothing changed: the same state object, so nothing re-renders.
const before = state; sync([tab('a'), tab('b', { tool: 'codex' })]); assert.equal(state, before);

// A blank launch page whose tool the desktop just opened becomes that desktop tab.
state = { ...state, terminals: [...state.terminals, { id: 'picked', tool: null, folderPath: '/p' }], tabOrder: [...state.tabOrder, 'picked'], activeTerminalId: 'picked' };
sync([tab('a'), tab('b', { tool: 'codex' }), tab('picked')]);
assert.equal(state.terminals.find(t => t.id === 'picked').mirror, true);
assert.equal(state.activeTerminalId, 'picked', 'the page that asked keeps showing it');
sync([tab('a'), tab('b', { tool: 'codex' })]);

// The browser's own tab stays; titles and folders follow; a tab closed on the desktop goes.
state = { ...state, terminals: [...state.terminals, { id: 'own', tool: 'claude', folderPath: '/x' }], tabOrder: [...state.tabOrder, 'own'], activeTerminalId: 'b' };
sync([tab('a', { title: 'renamed', cwd: '/q' })]);
assert.deepEqual(state.tabOrder, ['blank', 'a', 'own']);
assert.equal(state.terminals.find(t => t.id === 'a').toolTitle, 'renamed');
assert.equal(state.terminals.find(t => t.id === 'a').folderPath, '/q');
assert.equal(state.activeTerminalId, 'a', 'the shown tab closed on the desktop: show another terminal');

// Everything closed on the desktop: the browser's own tab is shown; with none left, a launch page.
sync([]);
assert.deepEqual(state.terminals.map(t => t.id), ['blank', 'own']);
state = { terminals: [{ id: 'm', tool: 'claude', folderPath: null, mirror: true }], tabOrder: ['m'], activeTerminalId: 'm' };
sync([]);
assert.equal(state.terminals.length, 1); assert.equal(state.terminals[0].tool, null); assert.equal(state.activeTerminalId, state.terminals[0].id);
console.log('ok remote mirror: desktop terminals appear, follow titles and folders, leave when closed, browser tabs untouched');
