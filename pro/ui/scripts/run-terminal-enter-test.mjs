import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/terminal-enter.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
const { createTerminalEnterEncoder } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const key = overrides => ({ type: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, getModifierState: () => false, ...overrides });
function fixture(tool = 'terminal') {
  const handlers = new Map();
  const register = (id, callback) => { const k = JSON.stringify(id); handlers.set(k, callback); return { dispose: () => handlers.delete(k) }; };
  const term = { buffer: { active: { type: 'normal' } }, parser: { registerCsiHandler: register, registerEscHandler: register } };
  const encoder = createTerminalEnterEncoder(term, tool);
  return { ...encoder, handlers, term, csi: (prefix, final, params) => handlers.get(JSON.stringify({ prefix, final }))?.(params),
    esc: final => handlers.get(JSON.stringify({ final }))?.(), softReset: () => handlers.get(JSON.stringify({ intermediates: '!', final: 'p' }))?.() };
}
for (const tool of ['claude', 'codex', 'opencode', 'mimocode', 'kilo', 'pi', 'omp']) {
  const f = fixture(tool);
  assert.equal(f.encode(key({ shiftKey: true })), '\x1b[13;2u');
  assert.equal(f.encode(key({ ctrlKey: true })), '\x1b[13;5u');
  assert.equal(f.encode(key({ shiftKey: true, ctrlKey: true })), '\x1b[13;6u');
  assert.equal(f.encode(key({})), null, 'plain Enter stays native');
  f.csi('?', 'h', [9001]);
  assert.equal(f.encode(key({ shiftKey: true })), tool === 'codex'
    ? '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_' : '\x1b[13;2u', 'native console and byte-stream consumers keep distinct encodings');
}
for (const tool of ['terminal', 'remote', 'grok', 'aider', null]) {
  const f = fixture(tool);
  assert.equal(f.encode(key({ shiftKey: true })), null, 'unverified consumers retain native handling without an explicit mode');
  f.csi('>', 'm', [4, 2]);
  assert.equal(f.encode(key({ shiftKey: true })), '\x1b[27;2;13~');
  assert.equal(f.encode(key({ ctrlKey: true })), '\x1b[27;5;13~');
  for (const reset of [[4, 0], [4]]) {
    f.csi('>', 'm', reset); assert.equal(f.encode(key({ shiftKey: true })), null);
  }
  f.csi('>', 'u', [7]);
  assert.equal(f.encode(key({ shiftKey: true })), '\x1b[13;2u');
  f.csi('>', 'u', [0]);
  assert.equal(f.encode(key({ ctrlKey: true })), null);
  f.csi('<', 'u', [1]);
  assert.equal(f.encode(key({ ctrlKey: true })), '\x1b[13;5u', 'nested pop restores the prior mode');
  f.term.buffer.active.type = 'alternate';
  assert.equal(f.encode(key({ shiftKey: true })), null, 'alternate screens have an independent stack');
  f.csi('=', 'u', [1]); f.csi('=', 'u', [2, 2]); f.csi('=', 'u', [1, 3]);
  assert.equal(f.encode(key({ shiftKey: true })), '\x1b[13;2u');
  f.term.buffer.active.type = 'normal'; f.csi('<', 'u', [100]);
  assert.equal(f.encode(key({ shiftKey: true })), null, 'an excessive pop restores legacy mode');
  f.csi('>', 'm', [4, 2]); f.esc('c');
  assert.equal(f.encode(key({ shiftKey: true })), null);
  f.csi('>', 'u', [1]); f.softReset();
  assert.equal(f.encode(key({ shiftKey: true })), null);
  f.dispose(); assert.equal(f.handlers.size, 0);
}
{
  const f = fixture(); f.csi('?', 'h', [9001]);
  assert.equal(f.encode(key({ shiftKey: true })), '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_');
  assert.equal(f.encode(key({ ctrlKey: true })), '\x1b[13;28;10;1;8;1_\x1b[13;28;10;0;8;1_');
  assert.equal(f.encode(key({ shiftKey: true, code: 'NumpadEnter' })), '\x1b[13;28;13;1;272;1_\x1b[13;28;13;0;272;1_');
  for (const overrides of [{}, { shiftKey: true, altKey: true }, { shiftKey: true, metaKey: true },
    { shiftKey: true, isComposing: true }, { ctrlKey: true, keyCode: 229 }, { shiftKey: true, type: 'keyup' }, { ctrlKey: true, key: 'c' }]) {
    assert.equal(f.encode(key(overrides)), null, 'plain keys, keyup, IME and other shortcuts are untouched');
  }
  f.csi('?', 'l', [9001]);
  assert.equal(f.encode(key({ shiftKey: true })), null);
  assert.equal(f.handlers.has(JSON.stringify({ prefix: '?', final: 'u' })), false, 'partial Enter compatibility does not advertise a full keyboard protocol');
}
{
  const f = fixture(); f.csi('?', 'h', [9001]); f.csi('>', 'm', [4, 2]);
  assert.equal(f.encode(key({ shiftKey: true })), '\x1b[27;2;13~', 'explicit VT modes survive the console transport');
  f.csi('>', 'u', [7]);
  assert.equal(f.encode(key({ ctrlKey: true })), '\x1b[13;5u');
}
console.log('OK: modified Enter bytes, native console modifiers, opt-in modes, consumer isolation, nested/screen state, resets, IME and default shortcuts');
