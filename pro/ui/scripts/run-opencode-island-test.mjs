import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const pluginSource = readFileSync(new URL('../../src/integrations/opencode-island/tui.mjs', import.meta.url), 'utf8');
const titleSource = readFileSync(new URL('../src/lib/opencode-terminal-title.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(titleSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { parseOpenCodeTerminalTitle: parse } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const titles = [], timers = new Map(), sessions = new Map();
  let listener, nextTimer = 0, healthy = true, refreshes = 0;
  const session = id => sessions.get(id);
  const context = {
    renderer: { isDestroyed: false, setTerminalTitle: title => titles.push(title) },
    ui: { router: { current: () => route } },
    client: { server: { async info() { if (!healthy) throw new Error('offline'); } } },
    data: {
      listen(fn) { listener = fn; return () => { listener = undefined; }; },
      session: {
        get: id => session(id), root: id => session(id)?.root ?? id,
        family: id => [...sessions.keys()].filter(key => key === id || session(key).root === id),
        status: id => session(id)?.status ?? 'idle',
        pending: { list: id => session(id)?.pending ?? [] },
        permission: { list: id => session(id)?.permissions, async sync() { refreshes++; } },
        form: { list: id => session(id)?.forms, async sync() { refreshes++; } },
        async sync() { refreshes++; },
      },
    },
  };
  let route = { type: 'home' };
  const plugin = vm.runInNewContext(pluginSource.replace('export default', 'globalThis.plugin ='), {
    setInterval(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearInterval(id) { timers.delete(id); }, queueMicrotask, AbortSignal,
  });
  const cleanup = plugin.setup(context);
  return {
    titles, sessions, cleanup, timers,
    add(id, values = {}) { sessions.set(id, { title: id, status: 'idle', permissions: [], forms: [], ...values }); },
    select(id) { route = id ? { type: 'session', sessionID: id } : { type: 'home' }; },
    async event() { listener?.({ details: { type: 'session.status' } }); await flush(); },
    async tick(delay = 500) { for (const timer of [...timers.values()]) if (timer.delay === delay) timer.fn(); await flush(); },
    set healthy(value) { healthy = value; },
    get status() { return parse(titles.at(-1)).status; },
    get refreshes() { return refreshes; },
  };
}

const a = fixture(), b = fixture();
await flush();
assert.equal(a.status, 'idle', 'empty home is idle after connection is verified');
assert.equal(parse('OC | plain title'), null, 'stock/v1 titles cannot manufacture a status');
assert.equal(parse('CoffeeCLI:OpenCode:v2:invalid | name'), null);
a.add('same-project-a'); b.add('same-project-b');
a.select('same-project-a'); b.select('same-project-b');
a.sessions.get('same-project-a').status = 'running';
await a.event(); await b.tick();
assert.equal(a.status, 'working'); assert.equal(b.status, 'idle', 'a second terminal cannot inherit the first terminal activity');
a.add('child', { root: 'same-project-a', permissions: [{ id: 'permission' }] });
await a.event();
assert.equal(a.status, 'wait_input', 'a family permission outranks running');
a.sessions.get('child').permissions = [];
a.sessions.get('child').forms = [{ id: 'question' }];
await a.tick(); assert.equal(a.status, 'wait_input', 'questions also wait for input');
a.sessions.get('child').forms = [];
await a.tick(); assert.equal(a.status, 'working', 'reply resumes real running state');
a.sessions.get('same-project-a').status = 'idle';
a.sessions.get('same-project-a').pending = [{ type: 'synthetic' }];
await a.tick(); assert.equal(a.status, 'idle', 'parked synthetic context is not work');
a.sessions.get('same-project-a').pending = [{ type: 'user' }];
await a.tick(); assert.equal(a.status, 'working', 'native queued user work remains active');
a.select('unloaded'); await a.tick(); assert.equal(a.status, undefined, 'unloaded sessions have no guessed island');
a.select('same-project-a'); a.healthy = false;
await a.tick(2000); assert.equal(a.status, undefined, 'connection loss clears stale working/waiting');
a.sessions.get('same-project-a').pending = [];
a.sessions.get('same-project-a').permissions = [{ id: 'still-pending' }];
a.healthy = true; await a.tick(2000);
assert.equal(a.status, 'wait_input', 'reconnect restores pending approvals');
assert.equal(a.refreshes, 6, 'recovery refreshes the whole session family, permissions and forms');
a.sessions.get('same-project-a').title = 'safe\x07\x1b]0;injected';
await a.tick(); assert.ok(!a.titles.at(-1).includes('\x07'), 'session titles cannot inject terminal control bytes');
const count = a.titles.length; await a.tick(); assert.equal(a.titles.length, count, 'unchanged states do not repaint titles');
a.cleanup(); b.cleanup();
assert.equal(a.timers.size, 0); assert.equal(b.timers.size, 0);
assert.equal(a.status, undefined, 'unloading clears state');

// Exercise the actual xterm title callback, including the Coffee tab ID binding.
const terminal = readFileSync(new URL('../src/components/center/TierTerminal.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('TierTerminal.tsx', terminal, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let titleCallback;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'term.onTitleChange') titleCallback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(titleCallback);
const actions = [];
const titleContext = {
  mounted: true, ptyEnded: false,
  tool: 'opencode', sessionId: 'coffee-tab-a', lastTabTitle: undefined, nativeStatus: null,
  parseOpenCodeTerminalTitle: parse, dispatch: action => actions.push(action),
  publishNativeStatus: status => actions.push({ type: 'SET_AGENT_STATUS', id: 'coffee-tab-a', status }),
};
const callback = vm.runInNewContext(`(${ts.transpileModule(titleCallback.getText(tree), {}).outputText.trim().replace(/;$/, '')})`, titleContext);
callback('CoffeeCLI:OpenCode:v2:working | OC | title');
assert.equal(actions[0].id, 'coffee-tab-a'); assert.equal(actions[0].status, 'working');
assert.equal(actions[1].title, 'OC | title');
callback('CoffeeCLI:OpenCode:v2:unknown | OC | title');
assert.equal(actions.at(-1).status, undefined);
const statusCount = actions.filter(action => action.type === 'SET_AGENT_STATUS').length;
callback('OpenCode');
assert.equal(actions.filter(action => action.type === 'SET_AGENT_STATUS').length, statusCount);
const actionCount = actions.length;
titleContext.mounted = false;
callback('CoffeeCLI:OpenCode:v2:working | OC | after unmount');
assert.equal(actions.length, actionCount, 'unmounted terminals ignore late title events');
titleContext.mounted = true;
titleContext.ptyEnded = true;
callback('CoffeeCLI:OpenCode:v2:working | OC | after exit');
assert.equal(actions.length, actionCount, 'exited terminals ignore late title events');
console.log('OK: native status, permissions/questions, session isolation, reconnect, cleanup, title safety, and actual xterm dispatch');
