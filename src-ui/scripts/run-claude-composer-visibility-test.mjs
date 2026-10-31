import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

function declaration(file, name) {
  const source = ts.createSourceFile(file, fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(source).replace(/^export /, '');
}
function evaluate(file, name, context = {}) {
  return vm.runInNewContext(ts.transpileModule(`${declaration(file, name)}; ${name}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText, context);
}
const isClaudeConversation = evaluate('lib/chat-tools.ts', 'isClaudeConversation');
const isCodexConversation = evaluate('lib/chat-tools.ts', 'isCodexConversation');
const isDshConversation = evaluate('lib/chat-tools.ts', 'isDshConversation');
const isConversationSession = evaluate('lib/chat-tools.ts', 'isConversationSession', { isClaudeConversation, isCodexConversation, isDshConversation });
const splitSessionIds = evaluate('lib/session-split-layout.ts', 'splitSessionIds');
const replaceSplitSession = evaluate('lib/session-split-layout.ts', 'replaceSplitSession', { splitSessionIds });
const reducer = evaluate('store/app-state.tsx', 'reducer', { isConversationSession, replaceSplitSession, getTabOrder: state => state.tabOrder });
const terminals = [{ id: 'claude', tool: 'claude' }, { id: 'terminal', tool: null }];
let state;
const effects = [];
const terminalSends = [], claudeSends = [], codexSends = [], dshSends = [];
let team = { enabled: false, agents: [], coordinators: [] };
const context = {
  isClaudeConversation, isCodexConversation, isDshConversation, isConversationSession,
  useAppState: () => ({ state, dispatch: action => { state = reducer(state, action); } }),
  useAppStateRef: () => ({ get current() { return state; } }),
  useAppDispatch: () => context.useAppState().dispatch,
  useOrchestration: () => team,
  useSessionControls: () => [],
  useCallback: fn => fn, useEffect: fn => effects.push(fn), useT: () => key => key,
  useClaudeSession: () => ({ busy: false }), useCodexSession: () => ({ busy: false }), useDshSession: () => false, stopDsh: async () => {}, getToolIcon: () => '',
  schemeLabels: () => ({ left: 'Alt+Q', gambit: 'Alt+W', right: 'Alt+E' }),
  React: { createElement: (type, props, ...children) => ({ type, props, children }) },
  Gambit: 'gambit', Changelog: 'changelog', IS_MACOS: false,
  submitTerminalPrompt: async (id, text) => terminalSends.push({ id, text }),
  sendClaudeMessage: async (id, text) => { claudeSends.push({ id, text }); return true; },
  sendCodexMessage: async (id, text) => { codexSends.push({ id, text }); return true; },
  sendDshMessage: async (id, text) => { dshSends.push({ id, text }); return true; },
};
context.basename = evaluate('components/center/ActiveGambit.tsx', 'basename');
context.sendSessionPrompt = evaluate('lib/send-session-prompt.ts', 'sendSessionPrompt', context);
const host = evaluate('components/center/ActiveGambit.tsx', 'ActiveGambit', context);
const titlebar = evaluate('components/common/TitleBar.tsx', 'TitleBar', context);
function buttons(node) {
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === 'button' ? [node] : []), ...(node.children ?? []).flat(Infinity).flatMap(buttons)];
}
const toggle = () => buttons(titlebar()).find(b => b.props['aria-label']?.startsWith('Gambit compose'));
for (const preference of [false, true]) {
  state = { terminals, activeTerminalId: 'claude', gambitOpen: preference, agentPageActive: null, diffTabActive: false };
  assert.equal(host().type, 'gambit', 'Claude always has its input, including a previously closed preference');
  assert.equal(toggle().props.disabled, true);
  assert.equal(toggle().props['aria-pressed'], true);
  const before = state;
  toggle().props.onClick();
  assert.equal(state, before, 'titlebar toggle cannot close Claude or change the terminal preference');
  host().props.onClose();
  assert.equal(state, before, 'composer close cannot close Claude');
  state = reducer(state, { type: 'TOGGLE_GAMBIT' });
  assert.equal(state, before, 'hotkey uses the same guarded reducer');
  state = { ...state, activeTerminalId: 'terminal' };
  assert.equal(!!host(), preference, 'switching to a terminal restores its existing preference');
  assert.equal(toggle().props.disabled, false);
  toggle().props.onClick();
  assert.equal(state.gambitOpen, !preference);
  assert.equal(!!host(), !preference);
  console.log(`OK: Claude is always open and ordinary terminal preference ${preference} survives tab switches`);
}
for (const surface of [{ agentPageActive: 'agent' }, { diffTabActive: true }]) {
  state = { terminals, activeTerminalId: 'claude', gambitOpen: false, agentPageActive: null, diffTabActive: false, ...surface };
  assert.equal(host(), null, 'hidden Claude does not mount an extra composer on another surface');
  assert.equal(toggle().props.disabled, false);
  toggle().props.onClick();
  assert.equal(state.gambitOpen, true, 'other surfaces retain their existing toggle behavior');
}
state = { terminals, activeTerminalId: null, gambitOpen: false };
assert.equal(host(), null, 'no composer without an active terminal');
console.log('OK: Agent, diff and no-tab surfaces retain their existing behavior');

state = { terminals: [{ id: 'native', tool: 'claude', claudeMode: 'terminal' }], activeTerminalId: 'native', gambitOpen: false };
assert.equal(host(), null, 'native Claude terminal can keep Gambit closed');
assert.equal(toggle().props.disabled, false);
toggle().props.onClick();
assert.equal(host().props.claude, false, 'native Claude uses ordinary terminal compose controls');
assert.equal(Object.hasOwn(host().props, 'canUseChat'), false, 'native Claude has no retired view switch');
console.log('OK: native Claude terminal retains its ordinary composer controls and toggle');
assert.equal(await host().props.onSend('/plan keep this native'), true);
assert.equal(terminalSends[0].text, '/plan keep this native');
assert.equal(claudeSends.length, 0, 'native terminal prompts never go to the structured session');
state = { ...state, terminals: [{ id: 'native', tool: 'claude', claudeMode: 'conversation' }] };
assert.equal(await host().props.onSend('structured prompt'), true);
assert.equal(claudeSends[0].text, 'structured prompt');
assert.equal(terminalSends.length, 1, 'conversation prompts never go to the terminal');
for (const mode of ['conversation', 'terminal']) {
  const launched = reducer({ terminals: [{ id: 'new', tool: null }], tabOrder: ['new'] }, { type: 'LAUNCH_TERMINAL_TOOL', id: 'new', tool: 'claude', claudeMode: mode });
  assert.equal(launched.terminals[0].claudeMode, mode);
  assert.equal(isClaudeConversation(launched.terminals[0]), mode === 'conversation');
  const restarted = reducer({ ...launched, activeTerminalId: 'new' }, { type: 'RESTART_TERMINAL', id: 'new', newId: 'restarted' });
  assert.equal(restarted.terminals[0].claudeMode, mode, 'reconnect retains the tab mode');
}
console.log('OK: both launch modes route prompts to the correct backend and retain mode on restart');

for (const tool of ['codex', 'kimicode', 'qwen', 'opencode', 'terminal']) {
  state = { terminals: [{ id: tool, tool, viewMode: 'chat' }], activeTerminalId: tool, gambitOpen: true };
  const composer = host();
  assert.equal(composer.props.claude, false);
  assert.equal(Object.hasOwn(composer.props, 'canUseChat'), false);
  assert.equal(Object.hasOwn(composer.props, 'onViewModeChange'), false);
  const before = terminalSends.length;
  assert.equal(await composer.props.onSend('CLI prompt'), true);
  assert.equal(terminalSends.length, before + 1);
  assert.equal(terminalSends.at(-1).id, tool);
}
console.log('OK: existing Codex/Kimi/other tool tabs retain CLI routing');
for (const preference of [false, true]) {
  state = { terminals: [{ id: 'codex-desktop', tool: 'codex', codexMode: 'conversation' }], activeTerminalId: 'codex-desktop', gambitOpen: preference, agentPageActive: null, diffTabActive: false };
  assert.equal(host().props.codex, true);
  assert.equal(toggle().props.disabled, true);
  const before = state;
  state = reducer(state, { type: 'TOGGLE_GAMBIT' });
  assert.equal(state, before);
  assert.equal(await host().props.onSend('Codex structured prompt'), true);
  assert.equal(codexSends.at(-1).id, 'codex-desktop');
}
for (const codexMode of ['conversation', 'terminal']) {
  const launched = reducer({ terminals: [{ id: 'new', tool: null }], tabOrder: ['new'] }, { type: 'LAUNCH_TERMINAL_TOOL', id: 'new', tool: 'codex', codexMode });
  assert.equal(isCodexConversation(launched.terminals[0]), codexMode === 'conversation');
  const restarted = reducer({ ...launched, activeTerminalId: 'new' }, { type: 'RESTART_TERMINAL', id: 'new', newId: 'retry' });
  assert.equal(restarted.terminals[0].codexMode, codexMode);
}
console.log('OK: Codex conversation uses its own backend, keeps its composer and retains mode on reconnect');
for (const preference of [false, true]) {
  state = { terminals: [{ id: 'dsh-desktop', tool: 'dsh' }], activeTerminalId: 'dsh-desktop', gambitOpen: preference, agentPageActive: null, diffTabActive: false };
  assert.equal(host().type, 'gambit', 'DeepSeek Harness always has its composer');
  assert.equal(host().props.dsh, true);
  assert.equal(toggle().props.disabled, true);
  assert.equal(await host().props.onSend('/compact'), true);
  assert.deepEqual(dshSends.at(-1), { id: 'dsh-desktop', text: '/compact' });
  assert.equal(terminalSends.some(send => send.id === 'dsh-desktop'), false, 'no PTY path exists for DeepSeek Harness');
}
console.log('OK: DeepSeek Harness is a desktop-only conversation with its own send path');
team = { enabled: true, agents: ['codex'], coordinators: ['claude'] };
state = {terminals:[{id:'claude',tool:'claude',claudeMode:'conversation',folderPath:'D:/Project'}],activeTerminalId:'claude',gambitOpen:true};
assert.equal(host().props.orchestration,true);
const before = claudeSends.length;
assert.equal(await host().props.onSend('Complete this task'),true);
assert.equal(claudeSends.length,before+1,'orchestration messages go to Claude for autonomous planning');
assert.equal(claudeSends.at(-1).text,'Complete this task');
assert.equal(host().props.assignment,undefined,'no manual executor selector');
team = {...team,coordinators:[]};assert.equal(host().props.orchestration,false);
team = {...team,enabled:false};assert.equal(host().props.orchestration,false);
team = {...team,enabled:true,coordinators:['claude']};state.terminals[0].parentId='another';assert.equal(host().props.orchestration,false,'workers do not advertise coordinator capabilities');
state = {terminals:[{id:'codex',tool:'codex',codexMode:'conversation'}],activeTerminalId:'codex',gambitOpen:true};assert.equal(host().props.orchestration,false,'unintegrated coordinators do not claim orchestration is enabled');
console.log('OK: autonomous Claude routing, live coordinator badge, new-session activation and worker isolation');
