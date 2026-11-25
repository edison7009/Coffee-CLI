/** Run universal observation against installed xterm and controlled parser acknowledgements. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  stdin: {
    contents: 'export * from "./src/lib/terminal-observer"; export * from "./src/lib/terminal-output-scheduler";',
    resolveDir: root,
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'warning',
});
function load(timers = { setTimeout, clearTimeout, performance }) {
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, console, Date,
    crypto: { randomUUID }, ...timers,
  });
  return module.exports;
}
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');
const api = load();
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`  ok  ${name}`);
}
function attach(id, term) {
  api.registerSession(id, term);
  const unregister = api.registerTerminalObserver(id, term);
  return {
    observer: api.getTerminalObserver(id),
    async output(data) {
      api.enqueue(id, data);
      assert.equal(await api.flushSession(id, term, 10000), 'flushed');
    },
    dispose() { unregister(); api.unregisterSession(id); term.dispose(); },
  };
}
function screenText(term, start) {
  return Array.from({ length: term.rows }, (_, row) =>
    term.buffer.active.getLine(start + row)?.translateToString(true, 0, term.cols) ?? '');
}

await test('complete live screen preserves more than 60 rows, blanks, Chinese and physical wraps', async () => {
  const term = new Terminal({ cols: 12, rows: 90, scrollback: 5000 });
  const f = attach('unknown-cli', term);
  try {
    await f.output('第一行😀\r\nABCDEFGHIJKLMN\r\n\r\n' + 'row\r\n'.repeat(68));
    const s = await f.observer.readScreen();
    assert.equal(s.lines.length, 90);
    assert.equal(s.lines[0].text, '第一行😀');
    assert.equal(s.lines[1].text, 'ABCDEFGHIJKL');
    assert.equal(s.lines[2].text, 'MN');
    assert.equal(s.lines[2].isWrapped, true);
    assert.equal(s.lines[3].text, '');
    assert.equal(s.lines[89].text, '');
    assert.deepEqual(Array.from(s.lines, line => line.text), screenText(term, term.buffer.active.baseY));
    assert.equal(s.cols, term.cols);
    assert.equal(s.cursor.x, term.buffer.active.cursorX);
    assert.equal(s.cursor.y, term.buffer.active.cursorY);
    assert.equal(s.freshness.flushState, 'flushed');
    assert.equal(s.freshness.pendingChars, 0);
    assert.ok(s.freshness.receivedSequence > 0);
    assert.ok(s.freshness.parsedRevision > 0);
    assert.ok(s.freshness.lastReceivedAt !== null);
    assert.ok(s.freshness.lastParsedAt !== null);
  } finally { f.dispose(); }
});

await test('live bottom and user viewport are distinct without changing the user scroll', async () => {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 5000 });
  const f = attach('hidden::pane-2', term);
  try {
    api.setActive('hidden::pane-2', false);
    await f.output(Array.from({ length: 15 }, (_, i) => `row-${i}`).join('\r\n'));
    term.scrollToTop();
    const viewport = term.buffer.active.viewportY;
    const live = await f.observer.readScreen();
    const user = await f.observer.readScreen('viewport');
    assert.ok(live.startRow > user.startRow);
    assert.equal(user.lines[0].text, 'row-0');
    assert.deepEqual(Array.from(live.lines, line => line.text), screenText(term, term.buffer.active.baseY));
    assert.equal(term.buffer.active.viewportY, viewport);
    assert.ok(api.listTerminalObservers().some(item => item.sessionId === 'hidden::pane-2'));
  } finally { f.dispose(); }
});

await test('alternate UI is current screen; retained normal history remains separate and paginated', async () => {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 5000 });
  const f = attach('alternate', term);
  try {
    await f.output(Array.from({ length: 20 }, (_, i) => `history-${i}`).join('\r\n'));
    const normal = await f.observer.readScrollback(0, 3);
    assert.equal(normal.lines.length, 3);
    assert.equal(normal.hasMore, true);
    assert.equal(normal.lines[0].text, 'history-0');
    assert.equal(normal.lines[2].bufferRow, 2);
    await f.output('\x1b[?1049h\x1b[2J\x1b[H选择菜单\r\n> 项目 A');
    const s = await f.observer.readScreen();
    assert.equal(s.bufferType, 'alternate');
    assert.equal(s.lines[0].text, '选择菜单');
    const history = await f.observer.readScrollback(0, 3);
    assert.equal(history.bufferType, 'normal');
    assert.equal(history.activeBufferType, 'alternate');
    assert.equal(history.lines[0].text, 'history-0');
    const tail = await f.observer.readScrollback();
    assert.equal(tail.endRow, tail.availableRows);
    assert.ok(Array.from(tail.lines).every(line => !line.text.includes('选择菜单')));
    await f.output('\x1b[?1049l');
    assert.equal((await f.observer.readScreen()).bufferType, 'normal');
  } finally { f.dispose(); }
});

await test('normal history is capped and reads are bounded after retention rolls over', async () => {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 5000 });
  const f = attach('history', term);
  try {
    await f.output('line\r\n'.repeat(5100));
    const history = await f.observer.readScrollback(0, 20000);
    assert.equal(history.availableRows, 5000);
    assert.equal(history.lines.length, 5000);
    assert.equal(history.hasMore, false);
    assert.equal((await f.observer.readScrollback(-5, 2)).startRow, 0);
    assert.equal((await f.observer.readScrollback(6000, 2)).lines.length, 0);
  } finally { f.dispose(); }
});

function controlledFixture() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const controlled = load({
    performance: { now: () => now },
    setTimeout(fn, delay = 0) {
      const id = ++timerId;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  }
  function terminal(id) {
    const pending = [];
    const parsedListeners = new Set();
    const line = { translateToString: () => 'visible', isWrapped: false };
    const buffer = {
      type: 'normal', baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0,
      length: 2, getLine: () => line,
    };
    const listen = set => listener => {
      set.add(listener);
      return { dispose() { set.delete(listener); } };
    };
    const term = {
      cols: 10, rows: 2,
      buffer: { active: buffer, normal: buffer, onBufferChange: listen(new Set()) },
      onWriteParsed: listen(parsedListeners), onResize: listen(new Set()), onScroll: listen(new Set()),
      write(_data, callback) { pending.push(callback); },
    };
    controlled.registerSession(id, term);
    const unregister = controlled.registerTerminalObserver(id, term);
    return {
      term, unregister, pending,
      finish() { pending.shift()?.(); parsedListeners.forEach(listener => listener()); },
      get observer() { return controlled.getTerminalObserver(id); },
    };
  }
  return { api: controlled, terminal, advance };
}

await test('bounded barrier waits for already received output and reports stalled parsing truthfully', async () => {
  const f = controlledFixture();
  const t = f.terminal('stalled');
  f.api.enqueue('stalled', 'before');
  const reading = t.observer.readScreen();
  f.advance(250);
  const s = await reading;
  assert.equal(s.freshness.flushState, 'timeout');
  assert.equal(s.freshness.pendingChars, 6);
  assert.equal(s.freshness.inFlightChars, 6);
  assert.equal(s.freshness.parsedRevision, 0);
  t.finish();
  const ready = await t.observer.readScreen();
  assert.equal(ready.freshness.flushState, 'flushed');
  assert.equal(ready.freshness.pendingChars, 0);
  assert.ok(ready.screenRevision > s.screenRevision);
  t.unregister(); f.api.unregisterSession('stalled');
});

await test('new output does not extend a previously captured barrier', async () => {
  const f = controlledFixture();
  const t = f.terminal('growing');
  f.api.enqueue('growing', 'before');
  const reading = t.observer.readScreen();
  f.api.enqueue('growing', 'after');
  t.finish();
  const s = await reading;
  assert.equal(s.freshness.flushState, 'flushed');
  assert.equal(s.freshness.pendingChars, 5);
  assert.equal(s.freshness.receivedSequence, 2);
  t.unregister(); f.api.unregisterSession('growing');
});

await test('overflow gap remains visible after parsing catches up and resets only on remount', async () => {
  const f = controlledFixture();
  const t = f.terminal('overflow');
  f.api.setActive('overflow', false);
  f.api.enqueue('overflow', 'x'.repeat(2 * 1024 * 1024));
  f.api.enqueue('overflow', 'dropped');
  const reading = t.observer.readScreen();
  for (let i = 0; i < 40; i++) { f.advance(16); t.finish(); }
  const s = await reading;
  assert.equal(s.freshness.gap, true);
  assert.equal((await t.observer.readScreen()).freshness.gap, true);
  const newer = f.terminal('overflow');
  assert.equal((await newer.observer.readScreen()).freshness.gap, false);
  t.unregister(); newer.unregister(); f.api.unregisterSession('overflow');
});

await test('replacement rejects old in-flight reads and old unregister cannot remove the new generation', async () => {
  const f = controlledFixture();
  const old = f.terminal('same');
  const oldApi = old.observer;
  f.api.enqueue('same', 'old');
  const rejected = assert.rejects(oldApi.readScreen(), /no longer active/);
  const newer = f.terminal('same');
  await rejected;
  assert.notEqual(newer.observer.generation, oldApi.generation);
  old.unregister(); old.finish();
  assert.equal(f.api.getTerminalObserver('same'), newer.observer);
  await assert.rejects(oldApi.readScrollback(), /no longer active/);
  assert.equal((await newer.observer.readScreen()).freshness.receivedSequence, 0);
  newer.unregister(); f.api.unregisterSession('same');
});

await test('failed write exposes unavailable parsing and an irreversible gap', async () => {
  const f = controlledFixture();
  const t = f.terminal('failed');
  t.term.write = () => { throw new Error('disposed'); };
  f.api.enqueue('failed', 'lost');
  const s = await t.observer.readScreen();
  assert.equal(s.freshness.flushState, 'unavailable');
  assert.equal(s.freshness.failed, true);
  assert.equal(s.freshness.gap, true);
  t.unregister(); f.api.unregisterSession('failed');
});

assert.equal(api.listTerminalObservers().length, 0);
console.log(`terminal-observer: ${passed} passed`);
