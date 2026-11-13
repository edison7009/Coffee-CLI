// Browser mirror of the desktop's terminals: the tab strip follows the desktop's list.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  stdin: { contents: `export { reducer } from './src/store/app-state'; export { diffState, applyPatch } from './src/lib/session-mirror'; export { isMirroredKey } from './src/lib/storage-mirror';`, resolveDir: root },
  bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', external: ['react', 'react/*', 'react-dom', '@tauri-apps/*'],
  plugins: [{ name: 'expose-reducer', setup(builder) {
    builder.onLoad({ filter: /[/\\]store[/\\]app-state\.tsx$/ }, async args => ({ loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { reducer };` }));
  } }],
});
// Written beside node_modules so the bundle's bare imports (react) resolve.
const out = `${root}node_modules/.cache/remote-mirror-test.mjs`;
await mkdir(`${root}node_modules/.cache`, { recursive: true });
await writeFile(out, compiled.outputFiles[0].text);
const { reducer, diffState, applyPatch, isMirroredKey } = await import(out);

const tab = (id, extra = {}) => ({ id, tool: 'claude', cwd: '/p', title: id, claudeMode: (extra.tool ?? 'claude') === 'claude' ? 'conversation' : undefined, ...extra });
let state = { terminals: [{ id: 'blank', tool: null, folderPath: null }], tabOrder: ['blank'], activeTerminalId: 'blank' };
const sync = tabs => { state = reducer(state, { type: 'SYNC_MIRROR_TABS', tabs }); };

// Opening the page: the desktop's terminals appear and the first one is shown instead of the launch page.
sync([tab('a'), tab('b', { tool: 'codex' })]);
assert.deepEqual(state.tabOrder, ['a', 'b', 'blank'], 'the desktop order, then what only this screen has');
assert.equal(state.activeTerminalId, 'a');
const a = state.terminals.find(t => t.id === 'a'), b = state.terminals.find(t => t.id === 'b');
assert.equal(a.mirror, true); assert.equal(a.claudeMode, 'conversation', 'the desktop decides the view'); assert.equal(b.codexMode, undefined); assert.equal(a.toolTitle, 'a');

// The desktop reordered its tabs: so does this screen.
sync([tab('b', { tool: 'codex' }), tab('a')]);
assert.deepEqual(state.tabOrder, ['b', 'a', 'blank']);
assert.deepEqual(state.terminals.map(t => t.id), ['b', 'a', 'blank']);
sync([tab('a'), tab('b', { tool: 'codex' })]);

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
sync([tab('a', { title: 'renamed', cwd: '/q', status: 'working' })]);
assert.deepEqual(state.tabOrder, ['a', 'blank', 'own']);
assert.equal(state.terminals.find(t => t.id === 'a').agentStatus, 'working', 'the desktop tab status shows here');
assert.equal(state.terminals.find(t => t.id === 'a').toolTitle, 'renamed');
assert.equal(state.terminals.find(t => t.id === 'a').folderPath, '/q');
assert.equal(state.activeTerminalId, 'a', 'the shown tab closed on the desktop: show another terminal');

// Everything closed on the desktop: the browser's own tab is shown; with none left, a launch page.
sync([]);
assert.deepEqual(state.terminals.map(t => t.id), ['blank', 'own']);
state = { terminals: [{ id: 'm', tool: 'claude', folderPath: null, mirror: true }], tabOrder: ['m'], activeTerminalId: 'm' };
sync([]);
assert.equal(state.terminals.length, 1); assert.equal(state.terminals[0].tool, null); assert.equal(state.activeTerminalId, state.terminals[0].id);
// Conversation patches: only what changed travels, and applying it rebuilds the same state.
const m1 = { role: 'user', content: 'hi' }, m2 = { role: 'assistant', content: 'he' };
const before1 = { busy: true, title: 'x', messages: [m1, m2], gone: 1 };
const after1 = { busy: false, title: 'x', messages: [m1, { ...m2, content: 'hello' }, { role: 'user', content: 'next' }] };
const patch = diffState(before1, after1);
assert.deepEqual(Object.keys(patch.set), ['busy']);
assert.deepEqual(Object.keys(patch.arrays.messages.items), ['1', '2'], 'the unchanged first message is not sent');
assert.deepEqual(patch.unset, ['gone']);
assert.deepEqual(applyPatch(before1, { v: 1, ...patch }), after1);
assert.equal(diffState(after1, after1), null);
// A shorter list (a rewound conversation) still comes out right.
assert.deepEqual(applyPatch(after1, { v: 2, ...diffState(after1, { ...after1, messages: [m1] }) }).messages, [m1]);

// Drafts: the desktop's unsent text shows in the matching desktop tab; tabs of this screen keep theirs.
state = { terminals: [{ id: 'd', tool: 'claude', folderPath: null, mirror: true, gambitDraft: 'old' }, { id: 'own', tool: null, folderPath: null, gambitDraft: 'mine' }], tabOrder: ['d', 'own'], activeTerminalId: 'd' };
state = reducer(state, { type: 'MIRROR_DRAFTS', drafts: { d: 'typed on the desktop', own: 'no' } });
assert.equal(state.terminals[0].gambitDraft, 'typed on the desktop');
assert.equal(state.terminals[1].gambitDraft, 'mine');
const quiet = state; assert.equal(reducer(state, { type: 'MIRROR_DRAFTS', drafts: { d: 'typed on the desktop' } }), quiet, 'nothing new: no re-render');

// Settings mirror: the desktop's values win; anything outside the list is ignored.
state = { ...state, currentTheme: 'sakura', settingsOpen: false };
state = reducer(state, { type: 'MIRROR_SETTINGS', settings: { currentTheme: 'ocean', currentLang: 'en', settingsOpen: true, terminals: [] } });
assert.equal(state.currentTheme, 'ocean'); assert.equal(state.currentLang, 'en');
assert.equal(state.settingsOpen, false); assert.equal(state.terminals.length, 2, 'tabs are not settings');
const same = state; assert.equal(reducer(state, { type: 'MIRROR_SETTINGS', settings: { currentTheme: 'ocean' } }), same);
// Saved records: the desktop's, except screen layout, per-device caches and remote-terminal profiles.
for (const key of ['coffee:recent-folders', 'coffee:last-folder-by-tool', 'coffee:claude-launch-mode', 'coffee_pinned_items', 'cc-gambit-history', 'cc-automations']) assert.ok(isMirroredKey(key), key);
for (const key of ['cc-left-hidden', 'cc-panel-widths', 'cc-ui-scale', 'cc-history-cache-v1', 'coffee_remote_cfg', 'coffee.remote.pairing.v0', 'remote_terminal_history', 'other']) assert.ok(!isMirroredKey(key), key);
console.log('ok remote mirror: desktop tabs appear, follow the desktop and leave when closed; conversation patches round-trip; settings follow the desktop');
