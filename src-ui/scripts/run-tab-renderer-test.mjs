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
lifecycle.close(a); lifecycle.close(b);
console.log('OK: renderer reuse, hidden-cache bound, eviction, unmount, and context recovery');
