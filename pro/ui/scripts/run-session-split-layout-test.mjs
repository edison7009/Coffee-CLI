import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../src/lib/session-split-layout.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { splitSessionIds, insertSessionSplit, removeSessionSplit, replaceSplitSession, sessionSplitRects, setSessionSplitRatio } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const first = insertSessionSplit(null, '', 'terminal-existing', 'right');
assert.deepEqual(splitSessionIds(null), []);
assert.deepEqual(sessionSplitRects(null), { leaves: [], dividers: [] });
assert.deepEqual(sessionSplitRects(first).leaves, [{ id: 'terminal-existing', left: 0, top: 0, width: 100, height: 100 }]);

const pair = insertSessionSplit(first, 'terminal-existing', 'claude-existing', 'right');
const triple = insertSessionSplit(pair, 'claude-existing', 'codex-existing', 'bottom');
assert.deepEqual(sessionSplitRects(triple), {
  leaves: [
    { id: 'terminal-existing', left: 0, top: 0, width: 50, height: 100 },
    { id: 'claude-existing', left: 50, top: 0, width: 50, height: 50 },
    { id: 'codex-existing', left: 50, top: 50, width: 50, height: 50 },
  ],
  dividers: [
    { path: '', direction: 'horizontal', ratio: 0.5, left: 50, top: 0, width: 0, height: 100 },
    { path: '1', direction: 'vertical', ratio: 0.5, left: 50, top: 50, width: 50, height: 0 },
  ],
});
const quad = insertSessionSplit(triple, 'terminal-existing', 'terminal-other', 'top');
assert.deepEqual(splitSessionIds(quad), ['terminal-other', 'terminal-existing', 'claude-existing', 'codex-existing']);
assert.deepEqual(sessionSplitRects(quad).dividers.map(divider => divider.path), ['', '0', '1']);
assert.equal(insertSessionSplit(quad, 'terminal-other', 'fifth', 'left'), quad, 'the fifth pane is rejected');

const left = insertSessionSplit(first, 'terminal-existing', 'new-left', 'left');
assert.deepEqual(splitSessionIds(left), ['new-left', 'terminal-existing']);
for (const edge of ['left', 'right', 'top', 'bottom']) {
  const layout = insertSessionSplit(first, 'terminal-existing', 'added', edge);
  assert.deepEqual(splitSessionIds(layout), edge === 'left' || edge === 'top' ? ['added', 'terminal-existing'] : ['terminal-existing', 'added']);
  assert.equal(layout.direction, edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical');
}
assert.equal(insertSessionSplit(triple, 'claude-existing', 'terminal-existing', 'left'), triple, 'joining an existing ID does not clone it');
assert.equal(insertSessionSplit(triple, 'missing', 'new', 'left'), triple);
assert.equal(insertSessionSplit(first, 'terminal-existing', '', 'left'), first);
assert.equal(insertSessionSplit(first, 'terminal-existing', 'new', 'diagonal'), first);

const removed = removeSessionSplit(quad, 'terminal-other');
assert.equal(removed.first, first, 'removal promotes only the target sibling');
assert.equal(removed.second, quad.second, 'unrelated subtree is preserved');
assert.deepEqual(sessionSplitRects(removed), sessionSplitRects(triple));
assert.equal(removeSessionSplit(quad, 'missing'), quad);
assert.equal(removeSessionSplit(first, 'terminal-existing'), null);
assert.equal(removeSessionSplit(null, 'missing'), null);

const resized = setSessionSplitRatio(quad, '1', 0.25);
assert.equal(resized.first, quad.first, 'resize leaves the other split untouched');
assert.deepEqual(sessionSplitRects(resized).leaves.slice(2), [
  { id: 'claude-existing', left: 50, top: 0, width: 50, height: 25 },
  { id: 'codex-existing', left: 50, top: 25, width: 50, height: 75 },
]);
assert.deepEqual(splitSessionIds(resized), splitSessionIds(quad), 'resize never changes session IDs');
assert.equal(setSessionSplitRatio(quad, '', -1).ratio, 0.2);
assert.equal(setSessionSplitRatio(quad, '', 2).ratio, 0.8);
assert.equal(setSessionSplitRatio(quad, '0', 0.8).first.ratio, 0.8);
for (const path of ['2', 'left', '00', '110']) assert.equal(setSessionSplitRatio(quad, path, 0.3), quad);
for (const ratio of [NaN, Infinity, -Infinity]) assert.equal(setSessionSplitRatio(quad, '', ratio), quad);
assert.equal(setSessionSplitRatio(quad, '', 0.5), quad);

const restarted = replaceSplitSession(quad, 'codex-existing', 'codex-restarted');
assert.deepEqual(splitSessionIds(restarted), ['terminal-other', 'terminal-existing', 'claude-existing', 'codex-restarted']);
assert.equal(restarted.first, quad.first);
assert.equal(replaceSplitSession(quad, 'codex-existing', 'claude-existing'), quad, 'restart cannot duplicate a session');
assert.equal(replaceSplitSession(quad, 'missing', 'new'), quad);
assert.equal(replaceSplitSession(quad, 'codex-existing', ''), quad);
assert.deepEqual(splitSessionIds(quad), ['terminal-other', 'terminal-existing', 'claude-existing', 'codex-existing'], 'all operations preserve their input tree');
console.log('OK: directional nested splits, stable IDs, four-pane bound, targeted collapse, ratio geometry and restart');
