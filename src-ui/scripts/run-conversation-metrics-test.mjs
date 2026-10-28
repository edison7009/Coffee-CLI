import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../src/components/center/conversation-virtualizer.ts', import.meta.url);
const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const code = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source).replace(/^export /, '')).join('\n');
let reads = 0;
const content = 'long output '.repeat(200);
const messages = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), role: 'assistant', get content() { reads++; return content; } }));
const context = {
  messages, performance,
  useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect() {},
};
runInNewContext(ts.transpileModule(`${code}; globalThis.measure = () => useConversationVirtualizer(messages, {current:null});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
context.measure();
reads = 0;
context.measure();
const repeatedContentReads = reads;
if (!process.argv.includes('--baseline')) {
  assert.equal(reads, 0, 'unchanged historical messages must reuse their layout estimate');
  messages[messages.length - 1] = { id: '1999', role: 'assistant', get content() { reads++; return 'updated output'; } };
  const updated = context.measure();
  assert.ok(reads > 0 && reads < 100, 'streaming recalculates only the replaced message');
  assert.equal(updated.measurementKeys.length, 2000);
  assert.match(updated.measurementKeys.at(-1), /updated output/);
}
messages.splice(0, messages.length, ...Array.from({ length: 2000 }, (_, i) => ({ id: String(i), role: 'assistant', content })));
const coldAt = performance.now(); context.measure(); const coldMs = performance.now() - coldAt;
const warmAt = performance.now(); for (let i = 0; i < 20; i++) context.measure(); const warmMs = (performance.now() - warmAt) / 20;
console.log(JSON.stringify({ messages: messages.length, coldMs, warmMs, repeatedContentReads }));
