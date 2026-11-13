import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const parse = async path => ts.createSourceFile(path, await readFile(`${root}/${path}`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = await parse('src/App.tsx');
let selectedExpression, activeTabDeclaration;
function visitApp(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'activeTabId') activeTabDeclaration = node.getText(app);
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'CharacterBackground') {
    selectedExpression = node.attributes.properties.find(attribute => attribute.name?.getText(app) === 'selectedId')?.initializer.expression.getText(app);
  }
  ts.forEachChild(node, visitApp);
}
visitApp(app);
assert.ok(selectedExpression, 'exercise the actual selectedId passed by App');
const compiled = await build({
  stdin: { contents: `
    export { CharacterBackground } from './src/components/common/CharacterBackground';
    export { reducer } from './src/store/app-state';
    export const selectedTabId = state => {
      ${activeTabDeclaration ? `const ${activeTabDeclaration};` : ''}
      return ${selectedExpression};
    };
  `, resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  external: ['react', 'react/*'],
  plugins: [{ name: 'character-tab-fixture', setup(builder) {
    builder.onLoad({ filter: /[/\\]store[/\\]app-state\.tsx$/ }, async args => ({
      loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { reducer };`,
    }));
    builder.onLoad({ filter: /[/\\]character-renderer\.ts$/ }, () => ({
      loader: 'js', contents: 'export const createCharacterRenderer = canvas => globalThis.graphics.create(canvas);',
    }));
  } }],
});

const slots = [], effects = [], selections = [], attached = [];
let cursor = 0, creates = 0, disposals = 0;
const mockReact = {
  ...React,
  useRef(initial) { return slots[cursor++] ??= { current: initial }; },
  useState(initial) {
    const index = cursor++;
    slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slots[index].value, value => { slots[index].value = value; }];
  },
  useEffect(callback, dependencies) {
    const index = cursor++, previous = slots[index];
    if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
      slots[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
    }
  },
};
const preferences = new Map();
const bounds = { left: 10, top: 20, width: 1000, height: 600 };
const host = { appendChild: canvas => attached.push(canvas), getBoundingClientRect: () => bounds };
const tabs = ['terminal:a', 'terminal:b', 'diff', 'terminal:blank'].map((id, index) => ({
  dataset: { tabId: id }, visible: true,
  rect: { left: 210 + index * 150, top: 60, width: 100, height: 40 },
  getClientRects() { return this.visible ? [this.rect] : []; },
  getBoundingClientRect() { return this.rect; },
}));
const module = { exports: {} };
const context = {
  module, exports: module.exports,
  require: name => name === 'react' ? mockReact : require(name),
  document: {
    querySelector: selector => {
      assert.equal(selector, '.chrome-tab.active');
      return tabs.find(tab => tab.dataset.tabId === module.exports.selectedTabId(state));
    },
    createElement: () => {
      const canvas = { remove() { attached.splice(attached.indexOf(canvas), 1); } };
      return canvas;
    },
  },
  window: { matchMedia: query => {
    if (!preferences.has(query)) preferences.set(query, Object.assign(new EventTarget(), { matches: false }));
    return preferences.get(query);
  } },
  graphics: { create: () => {
    creates++;
    return { select: (id, origin) => selections.push({ id, origin }), dispose: () => { disposals++; } };
  } },
};
runInNewContext(compiled.outputFiles[0].text, context);
const { CharacterBackground, selectedTabId, reducer } = module.exports;
let state = {
  activeTerminalId: 'terminal:a', diffTabActive: false,
  terminals: [{ id: 'terminal:a', tool: 'codex' }, { id: 'terminal:b', tool: 'claude' }, { id: 'terminal:blank', tool: null }],
  tabOrder: ['terminal:a', 'terminal:b', 'terminal:blank'],
};
function render() {
  cursor = 0;
  const tree = CharacterBackground({ selectedId: selectedTabId(state) });
  tree.props.ref.current = host;
  while (effects.length) effects.shift()();
}
function dispatch(action) { state = reducer(state, action); render(); }
render();
const originalCanvas = attached[0];

// Exercise real state transitions, including returning to the same terminal.
for (const [action, expected] of [
  [{ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:b' }, 'terminal:b'],
  [{ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:a' }, 'terminal:a'],
  [{ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:b' }, 'terminal:b'],
  [{ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:blank' }, 'terminal:blank'],
  [{ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:a' }, 'terminal:a'],
  [{ type: 'SET_DIFF_TAB_ACTIVE', active: true }, 'diff'],
  [{ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:b' }, 'terminal:b'],
]) {
  const previousCount = selections.length;
  dispatch(action);
  assert.equal(selectedTabId(state), expected, `App must track the visible ${expected} tab`);
  assert.equal(selections.length, previousCount + 1, `switching to ${expected} must trigger interaction`);
  assert.equal(selections.at(-1).id, expected);
  const index = tabs.findIndex(tab => tab.dataset.tabId === expected);
  assert.ok(Math.abs(selections.at(-1).origin.x - (0.25 + index * 0.15)) < 1e-9);
  assert.equal(selections.at(-1).origin.y, 0.1, 'wave starts at the tab relative to the background');
  assert.equal(attached[0], originalCanvas);
  assert.equal(creates, 1); assert.equal(disposals, 0);
}
const count = selections.length;
dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:b' });
dispatch({ type: 'SET_AGENT_STATUS', id: 'terminal:b', status: 'working' });
assert.equal(selections.length, count, 'reselecting a tab and unrelated updates must not restart feedback');
for (let i = 0; i < 30; i++) dispatch({ type: 'SET_ACTIVE_TERMINAL', id: i % 2 ? 'terminal:b' : 'terminal:a' });
assert.equal(creates, 1); assert.equal(attached[0], originalCanvas);
console.log('OK: terminal/Diff transitions, repeat selection and rapid switching reuse one canvas');

tabs[0].visible = false;
dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:a' });
assert.deepEqual({ ...selections.at(-1).origin }, { x: 0.5, y: 0.5 });
tabs[0].visible = true;
tabs[1].rect.left = 2000;
dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'terminal:b' });
assert.equal(selections.at(-1).origin.x, 1, 'clipped tab origins stay within the background');
console.log('OK: missing tab fallback and clipped tab coordinates');

const preference = preferences.get('(prefers-reduced-motion: reduce)');
preference.matches = true; preference.dispatchEvent(new Event('change')); render();
const pausedCount = selections.length;
dispatch({ type: 'SET_DIFF_TAB_ACTIVE', active: true });
assert.equal(selections.length, pausedCount); assert.equal(attached.length, 0);
preference.matches = false; preference.dispatchEvent(new Event('change')); render();
assert.equal(selections.at(-1).id, 'diff');
assert.equal(creates, 2); assert.equal(disposals, 1);
for (const slot of slots) slot?.cleanup?.();
assert.equal(attached.length, 0); assert.equal(disposals, 2);
console.log('OK: reduced motion suppresses interaction, resumes at the current tab and cleans up on unmount');
