/** Test the actual TierTerminal renderer lifecycle without requiring a GPU. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../src/components/center/TierTerminal.tsx', import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set([
  'MAX_WEBGL_RECOVERY_ATTEMPTS', 'MAX_HIDDEN_WEBGL_RENDERERS', 'hiddenWebglRenderers',
  'attachWebglRenderer', 'detachWebglRenderer', 'suspendWebglRenderer',
]);
const declarations = source.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return names.has(node.name?.text);
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(decl => names.has(decl.name.getText(source)));
  return false;
});
assert.equal(declarations.length, names.size, 'extract every lifecycle declaration from production code');
let creates = 0;
class Renderer {
  disposals = 0;
  constructor() { creates++; }
  onContextLoss(callback) { this.lose = callback; }
  dispose() { this.disposals++; }
}
const lifecycle = runInNewContext(ts.transpileModule(`
  let webglDisabled = false;
  ${declarations.map(node => node.getText(source)).join('\n')}
  ({attach: attachWebglRenderer, hide: suspendWebglRenderer, close: detachWebglRenderer});
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 }}).outputText, {
  WebglAddon: Renderer, probeWebglOnce: () => true,
  console: { warn() {}, error() {} },
});
const terminal = () => ({ rows: 30, refreshes: 0, loadAddon() {}, refresh() { this.refreshes++; } });
const a = { current: null }, b = { current: null }, c = { current: null };
const attempts = { current: 0 };
for (const ref of [a, b, c]) lifecycle.attach(terminal(), ref, attempts);
assert.equal(creates, 3);
const originalA = a.current, originalB = b.current, originalC = c.current;
lifecycle.hide(a); lifecycle.hide(b);
assert.equal(originalA.disposals, 0, 'keep recent hidden renderers warm');
lifecycle.attach(terminal(), a, attempts);
assert.equal(creates, 3, 'switching back reuses the existing renderer');
lifecycle.hide(c);
assert.equal(originalB.disposals, 0, 'a visible renderer no longer consumes hidden capacity');
lifecycle.hide(b); // Duplicate observer notification must not change recency.
lifecycle.hide(a);
assert.equal(originalB.disposals, 1, 'evict the oldest hidden renderer above the cap');
assert.equal(b.current, null);
assert.equal(a.current, originalA);
assert.equal(c.current, originalC);
lifecycle.close(c); lifecycle.close(c);
assert.equal(originalC.disposals, 1, 'unmount releases exactly once and removes the cache entry');
lifecycle.attach(terminal(), b, attempts); lifecycle.hide(b);
assert.equal(originalA.disposals, 0, 'closed entries do not evict a remaining cached renderer');
const lost = b.current;
lost.lose();
assert.equal(lost.disposals, 1);
assert.equal(b.current, null);
assert.equal(attempts.current, 1, 'real context loss retains the recovery accounting');
lifecycle.attach(terminal(), b, attempts);
assert.notEqual(b.current, lost, 'lost contexts are recreated on reveal');
const replacement = b.current;
lost.lose();
assert.equal(b.current, replacement, 'late loss from a disposed renderer cannot clear its replacement');
assert.equal(attempts.current, 1, 'late callbacks do not consume the recovery budget');
lifecycle.close(a); lifecycle.close(b);
console.log('OK: renderer reuse, hidden-cache bound, eviction, unmount, and context recovery');

// Exercise the production tab-activation effect and measurement callback.
// Rendering an old grid must not unmask a tab before its new grid is fitted.
let activationEffect, measureCallback;
function visit(node) {
  if (ts.isCallExpression(node)) {
    if (node.expression.getText(source) === 'useLayoutEffect'
      && node.arguments[1]?.getText(source) === '[isActive, sessionId]') {
      activationEffect = node.arguments[0];
    }
    if (node.expression.getText(source) === 'createTerminalSizeSync') {
      measureCallback = node.arguments[0];
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(activationEffect && measureCallback, 'extract the actual activation and measurement code');

function activationFixture() {
  let frame, fallback, render;
  let masked = false;
  const refreshRows = [];
  const term = {
    cols: 80, rows: 24, focus() {},
    onRender(callback) { render = callback; return { dispose() { render = undefined; } }; },
    refresh(_start, end) { refreshRows.push(end + 1); },
  };
  const afterFitRef = { current: null };
  const context = {
    isActive: true, sessionId: 'test', terminalOpened: true, term,
    termRef: { current: { offsetParent: {}, clientWidth: 1000, clientHeight: 600 } },
    xtermRef: { current: term }, webglRef: { current: null }, contextLossAttemptsRef: { current: 0 },
    afterFitRef, sizeSyncRef: { current: { schedule() {} } },
    fit: {
      proposeDimensions: () => ({ cols: 100, rows: 30 }),
      fit() { term.cols = 100; term.rows = 30; },
    },
    setCanvasHidden(value) { masked = value; },
    attachWebglRenderer() {}, suspendWebglRenderer() {},
    requestAnimationFrame(callback) { frame = callback; return 1; },
    cancelAnimationFrame() { frame = undefined; },
    setTimeout(callback) { fallback = callback; return 2; },
    clearTimeout() { fallback = undefined; },
  };
  const evaluate = node => runInNewContext(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const cleanup = evaluate(activationEffect)();
  const measure = evaluate(measureCallback);
  return {
    cleanup, measure, afterFitRef, refreshRows,
    frame: () => frame?.(), render: () => render?.(), fallback: () => fallback?.(),
    masked: () => masked,
  };
}

const activation = activationFixture();
activation.frame();
activation.render();
assert.equal(activation.masked(), true, 'old-grid render cannot reveal the tab');
assert.deepEqual(activation.refreshRows, [], 'refresh waits for successful fitting');
activation.measure();
assert.deepEqual(activation.refreshRows, [30], 'refresh uses the newly fitted rows');
assert.equal(activation.masked(), true, 'fitting alone does not reveal an unpainted frame');
activation.render();
assert.equal(activation.masked(), false, 'new-grid render reveals the tab');
activation.cleanup();

const timedOut = activationFixture();
timedOut.frame(); timedOut.fallback();
assert.equal(timedOut.masked(), false, 'missing measurement/render cannot strand the mask');
assert.equal(timedOut.afterFitRef.current, null, 'fallback cancels the pending reveal callback');
timedOut.measure();
assert.deepEqual(timedOut.refreshRows, [], 'late fit does not restart a completed reveal');
timedOut.cleanup();

const cancelled = activationFixture();
cancelled.frame(); cancelled.cleanup(); cancelled.measure();
assert.equal(cancelled.afterFitRef.current, null, 'switch-away cancels pending reveal work');
assert.deepEqual(cancelled.refreshRows, [], 'late fit cannot refresh a cancelled activation');
console.log('OK: activation waits for fitted render, fallback, and switch-away cleanup');
