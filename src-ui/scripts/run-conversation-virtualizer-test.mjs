/** Exercise hidden/revealed viewport changes using the actual virtualizer hook. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../src/components/center/conversation-virtualizer.ts', import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const code = source.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(source).replace(/^export /, '')).join('\n');
const frames = [];
const state = [];
const listeners = new Map();
const scroll = {
  scrollTop: 5000, clientHeight: 600,
  addEventListener: (name, listener) => listeners.set(name, listener),
  removeEventListener: name => listeners.delete(name),
};
const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: 'user', content: `Message ${i}` }));
let resize;
runInNewContext(ts.transpileModule(`${code}; useConversationVirtualizer(messages, {current: scroll});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, {
  messages, scroll,
  useRef: current => ({ current }),
  useCallback: callback => callback,
  useMemo: factory => factory(),
  useState: initial => {
    const index = state.length;
    state.push(typeof initial === 'function' ? initial() : initial);
    return [state[index], update => { state[index] = typeof update === 'function' ? update(state[index]) : update; }];
  },
  useEffect: effect => effect(),
  ResizeObserver: class {
    constructor(callback) { resize = callback; }
    observe() {}
    disconnect() {}
  },
  window: {
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
  },
});
const flush = () => { while (frames.length) frames.shift()(); };
flush();
const visibleRange = state[1];
assert.ok(visibleRange.start > 0 && visibleRange.end > visibleRange.start);
scroll.clientHeight = 0;
scroll.scrollTop = 0;
resize(); flush();
assert.equal(state[1], visibleRange, 'hiding a tab preserves its rendered message range');
scroll.clientHeight = 600;
scroll.scrollTop = 5000;
resize(); flush();
assert.equal(state[1], visibleRange, 'revealing at the same position does not rebuild the rows');
scroll.scrollTop = 6000;
listeners.get('scroll')(); flush();
assert.ok(state[1].start > visibleRange.start, 'visible scrolling still updates the message range');
console.log('OK: hidden conversation range, reveal reuse, and visible scrolling');
