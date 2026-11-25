// The note Coffee CLI adds to a prompt when a tab works in one remote computer window (src/window_control.rs)
// reaches the model but never shows as the user's words, in every conversation that can carry it.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
async function load(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/lib/${file}`, import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, Date, JSON, WeakMap });
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const note = '<system-reminder>The user set this conversation to work in the Coffee CLI window "EB" (window id eb). Do the task there.</system-reminder>';
const words = 'Make a web page';

const { withoutWindowNote, isWindowNote } = await load('window-note.ts');
assert.equal(withoutWindowNote(`${words}\n\n${note}`), words);
assert.equal(withoutWindowNote(words), words);
assert.equal(withoutWindowNote(`${words}\n\n<system-reminder>quoted by the user</system-reminder> and more`), `${words}\n\n<system-reminder>quoted by the user</system-reminder> and more`, 'only a note at the very end is taken out');
assert.ok(isWindowNote(note) && !isWindowNote(words));

const codex = await load('codex-protocol.ts');
let s = { ...codex.emptyCodexState(), nativeId: 'main' };
s = codex.reduceCodexEvent(s, { method: 'item/completed', params: { threadId: 'main', turnId: 't1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: words }, { type: 'text', text: note }] } } });
assert.deepEqual(plain(s.messages.filter(m => m.role === 'user').map(m => m.content)), [words], 'Codex');

const opencode = await load('opencode-protocol.ts');
const rows = opencode.openCodeRows([{ id: 'u', type: 'user', text: `${words}\n\n${note}`, time: { created: 1000 } }]);
assert.deepEqual(plain(rows.filter(r => r.role === 'user').map(r => r.content)), [words], 'OpenCode');

const dsh = await load('dsh-protocol.ts');
const log = [{ type: 'session', version: 4, id: 'session-1', cwd: '/repo' }, { type: 'user/message', seq: 1, time: 100, data: { content: [{ type: 'text', text: words }, { type: 'text', text: note }], source: { kind: 'user' }, role: 'user', id: 'u1' } }];
assert.deepEqual(plain(dsh.restoreDshLog(log).messages.filter(m => m.role === 'user').map(m => m.content)), [words], 'DeepSeek Harness');
console.log('ok window notes stay out of Codex, OpenCode and DeepSeek Harness bubbles');
