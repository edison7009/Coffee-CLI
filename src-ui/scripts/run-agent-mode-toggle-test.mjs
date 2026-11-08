import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export { AgentWorkModesSection } from './src/components/agent/AgentPages';", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'qrcode'], loader: { '.css': 'empty' },
  plugins: [{ name: 'mode-toggle-fixtures', setup(builder) {
    builder.onLoad({ filter: /[/\\]AgentPages\.tsx$/ }, async args => ({ loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { AgentWorkModesSection };` }));
    builder.onLoad({ filter: /[/\\]store[/\\]app-state\.tsx$/ }, () => ({ loader: 'js', contents: 'export function useAppState() { return { state: globalThis.__appState }; }' }));
    builder.onLoad({ filter: /[/\\]i18n[/\\]useT\.ts$/ }, () => ({ loader: 'js', contents: 'export const useT = () => key => key;' }));
    builder.onLoad({ filter: /[/\\]tauri\.ts$/ }, () => ({ loader: 'js', contents: 'export const invoke = (...args) => globalThis.__invoke(...args); export const commands = {}; export const isTauri = true;' }));
    builder.onLoad({ filter: /[/\\]Gambit\.tsx$/ }, () => ({ loader: 'js', contents: 'export const Gambit = () => null;' }));
    builder.onLoad({ filter: /[/\\]MarkdownContent\.tsx$/ }, () => ({ loader: 'js', contents: 'export const MarkdownContent = () => null;' }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'export const listen = async () => () => {};' }));
  } }],
});

const hooks = []; let cursor = 0; const effects = [];
const mockReact = {
  ...React,
  useState(initial) {
    const index = cursor++;
    hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[index].value, value => { hooks[index].value = typeof value === 'function' ? value(hooks[index].value) : value; }];
  },
  useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
  useEffect(callback, dependencies) {
    const index = cursor++; const previous = hooks[index];
    if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
      hooks[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { hooks[index].cleanup?.(); hooks[index].cleanup = callback(); });
    }
  },
};
const reads = []; let saved = false;
const module = { exports: {} };
const context = {
  module, exports: module.exports, __appState: { settingsOpen: true, settingsSection: 'agent' },
  __invoke(name, args) {
    if (name === 'agent_get_english_delegation') return new Promise(resolve => reads.push(resolve));
    if (name === 'agent_set_english_delegation') { saved = args.enabled; return Promise.resolve(); }
    if (name === 'agent_get_work_modes') return Promise.resolve({ sentinel: false, projectManager: false, expertConfig: false });
    throw new Error(`Unexpected invoke: ${name}`);
  },
  require: name => name === 'react' ? mockReact : require(name),
};
runInNewContext(compiled.outputFiles[0].text, context);
const render = () => { cursor = 0; return module.exports.AgentWorkModesSection(); };
const flushEffects = () => { while (effects.length) effects.shift()(); };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const englishRow = tree => tree.props.children[1].props.children[0];

render(); flushEffects(); reads.shift()(false); await settle();
assert.equal(englishRow(render()).props.enabled, false);
context.__appState.settingsSection = 'general'; render(); flushEffects();
context.__appState.settingsSection = 'agent'; const reopened = render(); flushEffects();
englishRow(reopened).props.onToggle(); await settle();
assert.equal(saved, true); assert.equal(englishRow(render()).props.enabled, true);
reads.shift()(false); await settle();
assert.equal(englishRow(render()).props.enabled, true, 'A delayed settings read must not revert a successfully saved English toggle');
console.log('OK: delayed English preference reload preserves the newer saved toggle');
