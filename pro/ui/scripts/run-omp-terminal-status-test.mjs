/** Exercise OMP/Claude's production title callback, submission handling and reducer. */
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
      export { parseClaudeTerminalTitle } from './src/lib/claude-terminal-title';
      export { supportsAgentStatus } from './src/store/app-state';
      export { parseAdditionalAgentTitle, supportsAdditionalAgentStatus } from './src/lib/terminal-agent-status';
      export { parseTerminalAgentStatus } from './src/lib/terminal-interaction';
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
const code = ts.transpileModule(`${reducer}\n${statusBlock}\n${titleBlock}\n({ reducer, submit: markAgentSubmission, publishScreenStatus, scheduleScreenIdle, exit(){ publishScreenStatus('idle'); ptyEnded = true; } });`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(tool = 'omp') {
  let listener;
  let state = { terminals: [{ id: 'test', tool, agentStatus: 'idle' }] };
  const actions = [];
  const timers = new Map();
  let screen = [];
  let timerId = 0;
  const api = runInNewContext(code, {
    ...production, tool, sessionId: 'test', unlisteners: [], mounted: true, ptyEnded: false,
    hasTerminalInteraction: () => false,
    confirmTerminalAgentStatus: () => {},
    markSentinelWorking: () => {},
    readTerminalScreen: () => screen,
    term: { onTitleChange(callback) { listener = callback; } },
    window: {
      setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); },
    },
    dispatch(action) { actions.push(action); state = api.reducer(state, action); },
  });
  return {
    submit: api.submit,
    screen: lines => { screen = lines.map(text => ({ text, bold: false })); },
    publish: api.publishScreenStatus,
    settle: api.scheduleScreenIdle,
    exit: api.exit,
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

const claude = fixture('claude');
claude.title('◐ Codex 技能汉化'); claude.expectStatus('working');
const claudeWorkingState = claude.state();
for (const frame of ['◑', '◐', '⠂', '⠐']) {
  claude.title(`${frame} Codex 技能汉化`);
  claude.expectStatus('working');
  assert.equal(claude.state(), claudeWorkingState, 'Claude spinner frames keep state and title stable');
}
assert.equal(claude.actions.filter(action => action.type === 'SET_TAB_TITLE').length, 1);
assert.equal(claude.actions.find(action => action.type === 'SET_TAB_TITLE').title, 'Codex 技能汉化');
claude.submit(); claude.flushTimers(); claude.expectStatus('working');
claude.title('✳ Codex 技能汉化'); claude.expectStatus('idle');
claude.title('◑ Next turn'); claude.expectStatus('working');
claude.title('✳ Next turn'); claude.expectStatus('idle');
for (const title of ['', 'Claude Code', 'Notes ◐ inside', '◐prefix is not a status']) {
  assert.deepEqual(production.parseClaudeTerminalTitle(title), { status: 'idle', displayTitle: title });
}
assert.deepEqual(production.parseClaudeTerminalTitle('  ◑  中文标题  '), { status: 'working', displayTitle: '中文标题' });

for (const tool of ['claude', 'codex', 'kimicode']) {
  const other = fixture(tool);
  other.submit(); other.expectStatus('working');
  other.flushTimers(); other.expectStatus('idle');
}
console.log('OK: OMP/Claude title lifecycle, current/legacy Claude frames, pending selectors, empty Enter, state/title deduplication, and existing-tool submission behavior');

for (const tool of ['qwen', 'hermes', 'grok', 'antigravity', 'pi', 'copilot', 'cursor', 'cline', 'kiro', 'muse', 'mimocode', 'kilo']) {
  const terminal = fixture(tool);
  terminal.submit(); terminal.flushTimers(); terminal.expectStatus('idle');
  assert.equal(terminal.actions.length, 0, `${tool}: Enter alone is not working evidence`);
}
const qwen = fixture('qwen');
qwen.title('◐ project'); qwen.expectStatus('working');
qwen.flushTimers(); qwen.expectStatus('working');
qwen.title('✳︎ project'); qwen.expectStatus('wait_input');
qwen.title('project'); qwen.flushTimers(); qwen.expectStatus('idle');
const hermes = fixture('hermes');
hermes.title('⏳ project'); hermes.expectStatus('working');
hermes.settle(); hermes.flushTimers(); hermes.expectStatus('working');
hermes.title('⚠ project'); hermes.expectStatus('wait_input');
hermes.title('✓ project'); hermes.expectStatus('idle');
const pi = fixture('pi');
pi.screen(['⠋ Working']); pi.publish('working');
pi.settle(); pi.flushTimers(); pi.expectStatus('working');
pi.screen(['Ready for another prompt']); pi.settle(); pi.flushTimers(); pi.expectStatus('idle');
hermes.title('⏳ project'); hermes.settle(); hermes.exit();
hermes.title('⏳ stale title after exit'); hermes.flushTimers(); hermes.expectStatus('idle');
console.log('OK: new CLI Enter guards, native working/waiting/idle transitions, silent live spinners and removed working chrome');
