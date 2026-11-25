/** Every message stays mounted: scrolling up must not drop the rows below or rebuild the ones above. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../src/components/center/conversation-virtualizer.ts', import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const code = source.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(source).replace(/^export /, '')).join('\n');
const frames = [];
const scroll = { scrollTop: 5000, clientHeight: 600, scrollTo(options) { this.scrollTop = options.top; } };
const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: 'user', content: `Message ${i}` }));
const context = {
  messages, scroll,
  useRef: current => ({ current }),
  useCallback: callback => callback,
  useMemo: factory => factory(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  window: { requestAnimationFrame: callback => { frames.push(callback); return frames.length; }, cancelAnimationFrame() {} },
};
runInNewContext(ts.transpileModule(`${code}; globalThis.render = () => useConversationVirtualizer(messages, {current: scroll});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);

let view = context.render();
assert.equal(view.start, 0, 'the oldest message is rendered');
assert.equal(view.end, messages.length, 'the newest message is rendered');
assert.equal(view.topSpacer + view.bottomSpacer, 0, 'no placeholder space stands in for unmounted rows');
scroll.scrollTop = 0;
view = context.render();
assert.deepEqual([view.start, view.end], [0, messages.length], 'scrolling to the top keeps the rows below');
view.scrollToIndex(50, 'instant');
assert.ok(scroll.scrollTop > 0, 'navigation still jumps to a message by its offset');
console.log('OK: whole transcript stays mounted while scrolling, navigation offsets intact');
