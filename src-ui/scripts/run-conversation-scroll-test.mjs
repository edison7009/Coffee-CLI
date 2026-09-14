/** Exercise the scroll-ownership decisions used by ConversationView. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function loadModule(path, exportsExpr, context = {}) {
  const file = new URL(path, import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const code = source.statements.filter(node => !ts.isImportDeclaration(node))
    .map(node => node.getText(source).replace(/^export /, '')).join('\n');
  return runInNewContext(
    `${ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText};
     (${exportsExpr});`,
    context,
  );
}

const { evaluateScrollEvent, shouldRestoreScrollPosition, planLayoutScrollTop } = loadModule(
  '../src/lib/conversation-scroll.ts',
  '{ evaluateScrollEvent, shouldRestoreScrollPosition, planLayoutScrollTop }',
);

const TALL = { clientHeight: 600, scrollHeight: 5000 };
const T0 = 100_000;
const event = (over) => evaluateScrollEvent({
  now: T0, lastUserInputAt: 0, ownedUntil: 0, previouslyPinned: false,
  previousScrollHeight: 5000, previousScrollTop: 2000, transcriptShrank: false,
  ...TALL, scrollTop: 2000, isTrusted: true, ...over,
});

// ── Single-event decisions ──────────────────────────────────────────────────

// A user wheel-scroll mid-conversation records the new position.
{
  const decision = event({ lastUserInputAt: T0 - 50, scrollTop: 2100 });
  assert.equal(decision.pinned, false);
  assert.equal(decision.owned, true);
  assert.equal(decision.record, true);
  assert.equal(decision.ownedUntil, T0 + 400);
  assert.equal(decision.autoLoadOlder, false);
}

// A transcript shrink that clamps onto the new bottom is a clamp even right
// after a wheel tick: never owned, never recorded, never extends the chain.
{
  const decision = event({
    lastUserInputAt: T0 - 50, ownedUntil: T0 + 100, transcriptShrank: true,
    previousScrollTop: 4000, scrollHeight: 3000, scrollTop: 2400,
  });
  assert.equal(decision.clamped, true);
  assert.equal(decision.pinned, true);
  assert.equal(decision.owned, false);
  assert.equal(decision.record, false);
  assert.equal(decision.ownedUntil, T0 + 100);
}

// The same geometry from row measurement (no transcript shrink) right after
// the user jumped to the bottom follows the user: owned, pins.
{
  const decision = event({
    lastUserInputAt: T0 - 50, previousScrollTop: 4000, scrollHeight: 3000, scrollTop: 2400,
  });
  assert.equal(decision.clamped, false);
  assert.equal(decision.owned, true);
  assert.equal(decision.pinned, true);
}

// Same geometry while genuinely pinned: the pin is real, so it records.
{
  const decision = event({
    previouslyPinned: true, transcriptShrank: true,
    previousScrollTop: 4400, scrollHeight: 3000, scrollTop: 2400,
  });
  assert.equal(decision.clamped, true);
  assert.equal(decision.record, true);
}

// Scrolling DOWN onto the bottom while content shrinks is not a clamp.
{
  const decision = event({
    lastUserInputAt: T0 - 20, transcriptShrank: true,
    previousScrollTop: 2000, scrollHeight: 3000, scrollTop: 2400,
  });
  assert.equal(decision.clamped, false);
  assert.equal(decision.owned, true);
}

// A shrink below one viewport inside the input window must not arm loadOlder.
{
  const decision = event({
    lastUserInputAt: T0 - 50, transcriptShrank: true,
    previousScrollTop: 4000, scrollHeight: 500, scrollTop: 0,
  });
  assert.equal(decision.clamped, true);
  assert.equal(decision.autoLoadOlder, false);
}

// A real user scroll to the top DOES arm the auto-loadOlder trigger.
assert.equal(event({ lastUserInputAt: T0 - 30, scrollTop: 100 }).autoLoadOlder, true);

// Momentum chain: owned without fresh input, dies 400ms after the last event.
{
  const first = event({ lastUserInputAt: T0 - 100, scrollTop: 2500 });
  const chained = event({
    now: T0 + 300, lastUserInputAt: T0 - 100, ownedUntil: first.ownedUntil,
    previousScrollTop: 2500, scrollTop: 1800,
  });
  assert.equal(chained.owned, true);
  const dead = event({
    now: T0 + 900, lastUserInputAt: T0 - 100, ownedUntil: chained.ownedUntil,
    previousScrollTop: 1800, scrollTop: 1200,
  });
  assert.equal(dead.owned, false);
  assert.equal(dead.record, false);
}

// Content that fits the viewport has no position worth recording.
assert.equal(event({ lastUserInputAt: T0 - 20, scrollHeight: 620, scrollTop: 0 }).record, false);

// Restore guard.
assert.equal(shouldRestoreScrollPosition({
  savedScrollTop: 3000, scrollTop: 0, clientHeight: 600, now: T0, lastUserInputAt: 0,
}), true);
assert.equal(shouldRestoreScrollPosition({
  savedScrollTop: 3000, scrollTop: 0, clientHeight: 600, now: T0, lastUserInputAt: T0 - 100,
}), false);
assert.equal(shouldRestoreScrollPosition({
  savedScrollTop: 900, scrollTop: 500, clientHeight: 600, now: T0, lastUserInputAt: 0,
}), false);

// ── Sequences ───────────────────────────────────────────────────────────────
// A fake scroller that clamps like the browser and coalesces one scroll event
// per frame, driven through the same glue ConversationView uses: the scroll
// handler (evaluateScrollEvent → pinned/record/loadOlder) and the layout
// effect (transcript-shrink flag, then planLayoutScrollTop). A transcript
// commit and a row-measurement height change both run the layout effect, but
// only the former may flag a shrink.

function createView({ scrollHeight = 5000, clientHeight = 600 } = {}) {
  const view = {
    scrollHeight, clientHeight, scrollTop: 0, dirty: false,
    pinned: true, saved: null, lastInputAt: 0, ownedUntil: 0,
    previous: { scrollHeight: 0, scrollTop: 0 }, olderLoads: 0,
    transcriptShrank: false, lastKnownHeight: 0, committed: false,
  };
  const setTop = (value) => {
    const next = Math.min(Math.max(0, view.scrollHeight - view.clientHeight), Math.max(0, value));
    if (next !== view.scrollTop) { view.scrollTop = next; view.dirty = true; }
  };
  const input = (now) => { view.lastInputAt = now; view.transcriptShrank = false; };
  const frame = (now) => {
    if (!view.dirty) return;
    view.dirty = false;
    const previous = view.previous;
    view.previous = { scrollHeight: view.scrollHeight, scrollTop: view.scrollTop };
    view.lastKnownHeight = view.scrollHeight;
    const transcriptShrank = view.transcriptShrank;
    view.transcriptShrank = false;
    const decision = evaluateScrollEvent({
      now, lastUserInputAt: view.lastInputAt, ownedUntil: view.ownedUntil,
      previouslyPinned: view.pinned,
      previousScrollHeight: previous.scrollHeight, previousScrollTop: previous.scrollTop,
      transcriptShrank,
      clientHeight: view.clientHeight, scrollHeight: view.scrollHeight,
      scrollTop: view.scrollTop, isTrusted: true,
    });
    view.ownedUntil = decision.ownedUntil;
    if (decision.owned) view.pinned = decision.pinned;
    if (decision.record) view.saved = { pinned: decision.pinned, scrollTop: view.scrollTop };
    if (decision.autoLoadOlder) view.olderLoads += 1;
  };
  const layout = (now, transcriptChanged) => {
    if (transcriptChanged) {
      view.transcriptShrank = view.committed && view.scrollHeight < view.lastKnownHeight;
      view.committed = true;
    }
    view.lastKnownHeight = view.scrollHeight;
    const target = planLayoutScrollTop({
      pinned: view.pinned, savedScrollTop: view.saved?.scrollTop ?? null,
      clientHeight: view.clientHeight, scrollHeight: view.scrollHeight,
      scrollTop: view.scrollTop, now, lastUserInputAt: view.lastInputAt,
    });
    if (target !== null) setTop(target);
  };
  return Object.assign(view, {
    /** Wheel/keyboard/scrollbar-drag input that moves the view. */
    scrollBy(now, delta) { input(now); setTop(view.scrollTop + delta); frame(now); },
    /** End key: input that jumps to the (estimated) bottom; no frame yet. */
    jumpToBottom(now) { input(now); setTop(view.scrollHeight); },
    /** A poll commit: content height changes (browser clamps), layout effect, frame. */
    commit(now, height) { view.scrollHeight = height; setTop(view.scrollTop); layout(now, true); frame(now); },
    /** Rows measured against their estimates: height changes, no transcript change. */
    measure(now, height, { frameNow = true } = {}) {
      view.scrollHeight = height; setTop(view.scrollTop); layout(now, false);
      if (frameNow) frame(now);
    },
    frame,
  });
}

// Reads mid-list; the session file shrinks (still taller than a viewport)
// with no input, then regrows: the view returns to the reading position.
{
  const view = createView();
  view.commit(0, 5000);
  view.scrollBy(1000, -400);
  assert.equal(view.scrollTop, 4000);
  assert.equal(view.pinned, false);
  view.commit(5000, 3000);
  assert.equal(view.scrollTop, 2400);
  assert.equal(view.pinned, false, 'clamp to the new bottom must not pin');
  assert.deepEqual(view.saved, { pinned: false, scrollTop: 4000 }, 'clamp must not overwrite');
  view.commit(6000, 5000);
  assert.equal(view.scrollTop, 4000, 'regrow restores the reading position');
}

// Same, but the shrink lands 200ms after the last wheel tick.
{
  const view = createView();
  view.commit(0, 5000);
  view.scrollBy(1000, -400);
  view.commit(1200, 3000);
  assert.equal(view.pinned, false);
  assert.deepEqual(view.saved, { pinned: false, scrollTop: 4000 });
  view.commit(2000, 5000);
  assert.equal(view.scrollTop, 4000);
}

// Shrinks below one viewport right after input: no loadOlder cascade.
{
  const view = createView();
  view.commit(0, 5000);
  view.scrollBy(1000, -400);
  view.commit(1100, 500);
  assert.equal(view.olderLoads, 0);
}

// Pinned, dragging the scrollbar thumb up in slow steps (pauses > 400ms)
// while streaming: every drag move is input, so streaming does not snap back.
{
  const view = createView();
  view.commit(0, 5000);
  assert.equal(view.pinned, true);
  view.scrollBy(2000, -1400);
  view.scrollBy(3000, -1500);
  assert.equal(view.pinned, false);
  view.commit(3320, 5100);
  assert.equal(view.scrollTop, 1500);
  view.commit(4000, 5200);
  assert.equal(view.scrollTop, 1500, 'no snap back, no yank to a stale position');
  view.scrollBy(5000, -1400);
  assert.equal(view.olderLoads, 1, 'dragging to the top loads older history');
}

// Reading mid-list, End jumps to the estimated bottom; rows scrolled into view
// then measure shorter than estimated, clamping the view twice more. Those
// clamps follow the user's jump: the view must end up pinned and follow new
// messages (seen in the real app with the End key).
{
  const view = createView();
  view.commit(0, 5000);
  view.scrollBy(1000, -2400);
  assert.equal(view.pinned, false);
  view.jumpToBottom(5000);
  view.measure(5010, 5300, { frameNow: false });
  view.frame(5016);
  assert.equal(view.pinned, false, 'first frame lands short of the grown bottom');
  view.measure(5030, 4900);
  view.measure(5050, 4800);
  assert.equal(view.pinned, true, 'measurement clamps after End must pin');
  view.commit(6000, 5200);
  assert.equal(view.scrollTop, 4600, 'pinned view follows new content');
}

// ── Scrollbar wiring ────────────────────────────────────────────────────────
// The rail lives under <body>, so its drags must report through onDrag.
{
  const fakeNode = () => ({
    style: {}, classList: { add() {}, remove() {} },
    listeners: {}, setAttribute() {}, append() {}, remove() {},
    addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {},
  });
  const slider = fakeNode();
  const docListeners = {};
  const created = [fakeNode(), slider];
  const element = Object.assign(fakeNode(), {
    scrollHeight: 5000, clientHeight: 600, scrollTop: 4400,
    getBoundingClientRect: () => ({ top: 0, bottom: 600, right: 800, width: 800 }),
  });
  let rafCallback = null;
  const { bindAutoHideScrollbar } = loadModule('../src/lib/auto-hide-scrollbar.ts', '{ bindAutoHideScrollbar }', {
    document: {
      createElement: () => created.shift(),
      body: { append() {} },
      addEventListener(type, fn) { docListeners[type] = fn; },
      removeEventListener() {},
    },
    window: {
      innerWidth: 800, innerHeight: 600,
      requestAnimationFrame: (fn) => { rafCallback = fn; return 1; },
      cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {},
      addEventListener() {}, removeEventListener() {},
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    Math,
  });
  let drags = 0;
  bindAutoHideScrollbar(element, { slim: true, onDrag: () => { drags += 1; } });
  rafCallback();
  slider.listeners.pointerdown({ button: 0, clientY: 500, preventDefault() {} });
  docListeners.pointermove({ clientY: 300 });
  assert.equal(drags, 2);
  assert.ok(element.scrollTop < 4400);

  const view = readFileSync(new URL('../src/components/center/ConversationView.tsx', import.meta.url), 'utf8');
  assert.match(view, /bindAutoHideScrollbar\(element, \{\s*slim: true,\s*onDrag:/);
}

console.log('conversation-scroll ownership decisions OK');
