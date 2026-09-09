/** Exercise OMP's production title callback, submission handling and reducer. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import ts from 'typescript';

const bundle = await build({
  stdin: {
    contents: `
      export { parseOmpTerminalTitle } from './src/lib/omp-terminal-title';
      export { supportsAgentStatus } from './src/store/app-state';
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
});
const production = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const tierSource = readFileSync(new URL('../src/components/center/TierTerminal.tsx', import.meta.url), 'utf8');
const stateSource = ts.createSourceFile('app-state.tsx', readFileSync(new URL('../src/store/app-state.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const reducer = stateSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'reducer').getText(stateSource);
const statusBlock = tierSource.slice(tierSource.indexOf('    const usesAgentStatus ='), tierSource.indexOf('    const fit = new FitAddon();'));
const titleBlock = tierSource.slice(tierSource.indexOf('    let lastTabTitle:'), tierSource.indexOf('    // Debug: track when cursor moves'));
assert.ok(statusBlock && titleBlock, 'extract the production status and title handlers');
const code = ts.transpileModule(`${reducer}\n${statusBlock}\n${titleBlock}\n({ reducer, submit: markAgentSubmission });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(tool = 'omp') {
  let listener;
  let state = { terminals: [{ id: 'test', tool, agentStatus: 'idle' }] };
  const actions = [];
  const timers = new Map();
  let timerId = 0;
  const api = runInNewContext(code, {
    ...production, tool, sessionId: 'test', unlisteners: [],
    hasTerminalInteraction: () => false,
    term: { onTitleChange(callback) { listener = callback; } },
    window: {
      setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); },
    },
    dispatch(action) { actions.push(action); state = api.reducer(state, action); },
  });
  return {
    submit: api.submit,
    title: title => listener(title),
    state: () => state,
    expectStatus: expected => assert.equal(state.terminals[0].agentStatus, expected),
    actions,
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(callback => callback());
    },
  };
}

const omp = fixture();
omp.title('π ! Session');
// Enter may advance to another question without changing OMP's title. Its
// emitter deduplicates identical titles, so there is no second title callback.
omp.submit(); omp.flushTimers(); omp.expectStatus('wait_input');
omp.title('π > Session'); omp.expectStatus('idle');
const idleState = omp.state();
omp.submit(); omp.flushTimers();
assert.equal(omp.state(), idleState, 'empty Enter must not manufacture a working/done cycle');
omp.title('π : Session'); omp.submit(); omp.flushTimers(); omp.expectStatus('working');
omp.title('π ⠋ Session');
const workingState = omp.state();
for (const frame of '⠙⠹⠸⠼⠴⠦⠧⠇⠏') omp.title(`π ${frame} Session`);
assert.equal(omp.state(), workingState, 'spinner frames do not rerender state');
assert.equal(omp.actions.filter(action => action.type === 'SET_TAB_TITLE').length, 1, 'spinner frames keep the stored title stable');
omp.title('π > Session'); omp.expectStatus('idle');
omp.title('π : Session'); omp.title('π: Session'); omp.expectStatus('idle');
const staticState = omp.state();
omp.submit(); omp.flushTimers();
assert.equal(omp.state(), staticState, 'disabled title reporting must not guess activity from Enter');

for (const tool of ['claude', 'codex', 'kimicode']) {
  const other = fixture(tool);
  other.submit(); other.expectStatus('working');
  other.flushTimers(); other.expectStatus('idle');
}
console.log('OK: OMP title lifecycle, pending selectors, empty Enter, state/title deduplication, and existing-tool submission behavior');
