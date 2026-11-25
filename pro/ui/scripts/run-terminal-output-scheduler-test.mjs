/** Exercise the production scheduler with controlled parser completions and real xterm. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/terminal-output-scheduler.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const api = {};
  runInNewContext(compiled, {
    exports: api, console,
    performance: { now: () => now },
    setTimeout(fn, delay = 0) {
      const id = ++timerId;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  function tick() {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return false;
    timers.delete(next[0]);
    now = next[1].at;
    next[1].fn();
    return true;
  }
  const terminals = [];
  function terminal(id, active = false, synchronous = false) {
    const writes = [];
    const pending = [];
    let maxPending = 0;
    const term = {
      write(data, callback) {
        writes.push(data);
        if (synchronous) callback?.();
        else {
          pending.push(callback);
          maxPending = Math.max(maxPending, pending.length);
        }
      },
    };
    api.registerSession(id, term);
    api.setActive(id, active);
    const record = {
      id, term, writes, pending,
      get maxPending() { return maxPending; },
      finish() { pending.shift()?.(); },
    };
    terminals.push(record);
    return record;
  }
  function settle() {
    for (let i = 0; i < 10000; i++) {
      for (const t of terminals) t.finish();
      const ran = tick();
      if (!ran && terminals.every(t => t.pending.length === 0)) return;
    }
    assert.fail('scheduler did not settle');
  }
  return { api, tick, terminal, settle, timers, elapse(ms) { now += ms; } };
}

const tests = [
  ['bounds large writes and waits for parse completion', () => {
    const f = fixture();
    const t = f.terminal('a', true);
    const input = 'x'.repeat(256 * 1024);
    f.api.enqueue('a', input);
    assert.equal(t.writes.length, 1, 'idle visible terminal starts immediately');
    assert.ok(t.writes[0].length <= 64 * 1024, 'one large IPC chunk must be sliced');
    f.api.enqueue('a', 'tail');
    for (let i = 0; i < 10; i++) f.tick();
    assert.equal(t.writes.length, 1, 'no additional write before the parser acknowledges');
    f.settle();
    assert.equal(t.writes.join(''), input + 'tail');
    assert.equal(t.maxPending, 1);
    assert.equal(f.timers.size, 0);
  }],
  ['background work is bounded across 1/4/8/16 sessions', () => {
    for (const count of [1, 4, 8, 16]) {
      const f = fixture();
      const list = Array.from({ length: count }, (_, i) => f.terminal(String(i)));
      for (const t of list) f.api.enqueue(t.id, 'z'.repeat(128 * 1024));
      f.tick();
      assert.ok(list.reduce((n, t) => n + t.writes.length, 0) <= 2, 'global writes per tick');
      f.settle();
      for (const t of list) {
        assert.equal(t.writes.join(''), 'z'.repeat(128 * 1024));
        assert.equal(t.maxPending, 1);
        assert.ok(t.writes.every(s => s.length <= 64 * 1024));
      }
    }
  }],
  ['activation preserves FIFO instead of dumping the backlog', () => {
    const f = fixture();
    const t = f.terminal('a');
    const before = 'before'.repeat(50000);
    f.api.enqueue('a', before);
    f.tick();
    f.api.setActive('a', true);
    f.api.enqueue('a', 'new-output');
    f.api.setActive('a', false);
    f.api.setActive('a', true);
    assert.equal(t.writes.length, 1, 'switches do not bypass in-flight work');
    f.settle();
    assert.equal(t.writes.join(''), before + 'new-output');
    assert.equal(t.maxPending, 1);
  }],
  ['four visible panes cannot starve a background pane', () => {
    const f = fixture();
    const visible = Array.from({ length: 4 }, (_, i) => f.terminal(`fg${i}`, true));
    const bg = f.terminal('bg');
    f.api.enqueue('bg', 'background');
    for (const t of visible) f.api.enqueue(t.id, 'x'.repeat(512 * 1024));
    for (let i = 0; i < 32 && bg.writes.length === 0; i++) {
      for (const t of visible) t.finish();
      f.tick();
    }
    assert.equal(bg.writes.join(''), 'background');
    f.settle();
    assert.ok(visible.every(t => t.writes.join('').length === 512 * 1024));
  }],
  ['a missing parse callback cannot block other sessions or poll forever', () => {
    const f = fixture();
    const stalled = f.terminal('stalled');
    const healthy = f.terminal('healthy');
    f.api.enqueue('stalled', 's'.repeat(128 * 1024));
    f.api.enqueue('healthy', 'healthy');
    for (let i = 0; i < 10; i++) { f.tick(); healthy.finish(); }
    assert.equal(healthy.writes.join(''), 'healthy');
    assert.equal(stalled.writes.length, 1);
    assert.equal(f.timers.size, 0, 'a blocked parser does not cause polling');
    f.api.unregisterSession('stalled');
    stalled.finish();
    assert.equal(f.timers.size, 0);
  }],
  ['a costly synchronous visible write cannot exhaust every background turn', () => {
    const f = fixture();
    const visible = f.terminal('visible', true);
    const originalWrite = visible.term.write;
    visible.term.write = (data, cb) => { originalWrite(data, cb); f.elapse(9); };
    const hidden = f.terminal('hidden');
    f.api.enqueue('visible', 'x'.repeat(2 * 1024 * 1024));
    f.api.enqueue('hidden', 'status');
    for (let i = 0; i < 8 && hidden.writes.length === 0; i++) {
      visible.finish(); f.tick();
    }
    assert.equal(hidden.writes.join(''), 'status', 'background must advance before visible flood finishes');
    f.settle();
  }],
  ['late and duplicate callbacks cannot affect a replacement session', () => {
    const f = fixture();
    const old = f.terminal('same', true);
    f.api.enqueue('same', 'old'.repeat(50000));
    const late = old.pending[0];
    f.api.unregisterSession('same');
    const replacement = f.terminal('same', true);
    f.api.enqueue('same', 'new'.repeat(50000));
    late?.(); late?.();
    f.tick();
    assert.equal(replacement.writes.length, 1);
    const done = replacement.pending.shift();
    done?.();
    f.tick();
    done?.();
    assert.equal(replacement.pending.length, 1, 'duplicate cannot release the next write');
    f.api.unregisterSession('same');
    replacement.finish();
    assert.equal(f.timers.size, 0);
    assert.equal(old.writes.length, 1);
  }],
  ['synchronous parse callbacks yield without recursive writes', () => {
    const f = fixture();
    const t = f.terminal('sync', true, true);
    f.api.enqueue('sync', 'x'.repeat(1024 * 1024));
    assert.equal(t.writes.length, 1, 'the callback must not synchronously drain everything');
    f.settle();
    assert.equal(t.writes.join('').length, 1024 * 1024);
  }],
  ['background overflow counts in-flight data and keeps one ordered warning', () => {
    const f = fixture();
    const t = f.terminal('a');
    const accepted = 'a'.repeat(2 * 1024 * 1024);
    f.api.enqueue('a', accepted);
    f.tick();
    f.api.enqueue('a', 'DROP-ONE');
    f.api.enqueue('a', 'DROP-TWO');
    f.settle();
    const result = t.writes.join('');
    assert.ok(result.startsWith(accepted));
    assert.equal(result.split('[Coffee CLI:').length - 1, 1);
    assert.ok(!result.includes('DROP-'));
    f.api.enqueue('a', 'after-drain');
    f.settle();
    assert.ok(t.writes.join('').endsWith('after-drain'));
  }],
  ['small chunks coalesce and surrogate pairs survive a slice boundary', () => {
    const f = fixture();
    const t = f.terminal('a');
    const input = 'a'.repeat(64 * 1024 - 1) + '😀中文\x1b[31m红色\x1b[0m';
    f.api.enqueue('a', input);
    for (let i = 0; i < 200; i++) f.api.enqueue('a', '.');
    f.settle();
    assert.equal(t.writes.join(''), input + '.'.repeat(200));
    assert.ok(t.writes.every(s => !/[\uD800-\uDBFF]$/.test(s)));
    assert.ok(t.writes.length < 10, 'small IPC chunks are coalesced');
  }],
  ['a rejected write is isolated and unregister cancels queued work', () => {
    const f = fixture();
    const bad = f.terminal('bad');
    let attempts = 0;
    bad.term.write = () => { attempts++; throw new Error('disposed'); };
    const good = f.terminal('good');
    f.api.enqueue('bad', 'x'.repeat(256 * 1024));
    f.api.enqueue('good', 'good');
    f.settle();
    assert.equal(attempts, 1, 'a dead terminal is not repeatedly written');
    assert.equal(good.writes.join(''), 'good');
    f.api.enqueue('good', 'cancelled');
    f.api.unregisterSession('good');
    assert.equal(f.timers.size, 0);
  }],
];

for (const [name, run] of tests) {
  run();
  console.log(`  ok  ${name}`);
}

// Actual installed xterm parser: test buffer semantics, not just string concatenation.
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');
const api = {};
runInNewContext(compiled, { exports: api, console, performance, setTimeout, clearTimeout });
const baseline = new Terminal({ cols: 80, rows: 24, scrollback: 5000 });
const candidate = new Terminal({ cols: 80, rows: 24, scrollback: 5000 });
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
function snapshot(term) {
  const b = term.buffer.active;
  return {
    type: b.type, x: b.cursorX, y: b.cursorY, baseY: b.baseY,
    lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString(true)),
  };
}
try {
  api.registerSession('real', candidate);
  api.setActive('real', false);
  const input = ('\x1b[32m中文😀 hello\x1b[0m\r\n').repeat(4500)
    + '\x1b[?1049h\x1b[2J\x1b[H\x1b[31m选择一个选项 😀\x1b[0m\r\n> continue\x1b]0;agent\x07';
  const parsed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('real parser did not finish')), 10000);
    candidate.onTitleChange(title => {
      if (title === 'done') { clearTimeout(timer); resolve(); }
    });
  });
  await write(baseline, input);
  api.enqueue('real', input);
  api.setActive('real', true);
  api.enqueue('real', '\x1b]0;done\x07');
  await parsed;
  assert.deepEqual(snapshot(candidate), snapshot(baseline));
  // Returning to normal buffer must also preserve the hidden scrollback.
  await write(baseline, '\x1b[?1049l');
  await write(candidate, '\x1b[?1049l');
  assert.deepEqual(snapshot(candidate), snapshot(baseline));
  console.log('  ok  real xterm Unicode, ANSI, alternate screen, cursor and scrollback');
} finally {
  api.unregisterSession('real');
  candidate.dispose(); baseline.dispose();
}
console.log(`terminal-output-scheduler: ${tests.length + 1} passed`);
