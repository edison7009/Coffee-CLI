// Tool updates from a browser: the desktop runs them and both screens show the same entry.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const entry = fileURLToPath(new URL('../src/lib/cli-updates.ts', import.meta.url));
const stubs = {
  name: 'stubs',
  setup(builder) {
    builder.onResolve({ filter: /^react$|[/\\]tauri$|remote[/\\]bridge$|[/\\]session-mirror$/ }, args => ({ path: args.path, namespace: 'stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      loader: 'js',
      contents: args.path === 'react' ? 'export const useSyncExternalStore = (subscribe, read) => (subscribe(() => {}), read());'
        : /tauri$/.test(args.path) ? 'export const commands = globalThis.host.commands;'
        : /bridge$/.test(args.path) ? 'export const REMOTE = globalThis.host.remote;'
        : 'export const { mirrorCall, mirrorSource, mirrorTarget, registerMirrorActions } = globalThis.host.mirror;',
    }));
  },
};
const code = (await build({ entryPoints: [entry], bundle: true, platform: 'neutral', format: 'cjs', write: false, logLevel: 'silent', plugins: [stubs] })).outputFiles[0].text;

function load(remote) {
  const host = { remote, calls: [], actions: {}, invoked: [], changed: 0 };
  host.commands = {
    checkCliUpdate: async tool => { host.invoked.push(['check', tool]); return { tool, current: null, latest: null, available: false }; },
    updateCli: tool => { host.invoked.push(['update', tool]); return new Promise(resolve => { host.finish = () => resolve({ tool, current: '1.1.0', latest: '1.1.0', available: false }); }); },
  };
  host.mirror = {
    mirrorCall: (kind, name, args) => { host.calls.push([kind, name, args]); return Promise.resolve(); },
    mirrorSource: (kind, id, read) => { host.source = { kind, id, read }; return () => { host.changed++; }; },
    mirrorTarget: (kind, id, apply) => { host.target = { kind, id, apply }; return () => {}; },
    registerMirrorActions: (kind, fns) => { host.actions = { ...host.actions, ...fns }; host.kind = kind; },
  };
  const store = new Map();
  const module = { exports: {} };
  runInNewContext(code, { module, exports: module.exports, globalThis: { host }, localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }, console });
  return { host, api: module.exports };
}

// Desktop: the update runs here, and a browser asking for it does not wait minutes for npm.
{
  const { host, api } = load(false);
  assert.equal(host.source.kind, 'app'); assert.equal(host.source.id, 'cli-updates');
  host.commands.checkCliUpdate = async tool => ({ tool, current: '1.0.0', latest: '1.1.0', available: true });
  await api.checkCliUpdate('codex');
  assert.equal(host.source.read().codex.status.available, true, 'browsers see the desktop versions');
  assert.ok(host.changed > 0, 'a new version is sent to browsers');
  assert.equal(host.kind, 'app');
  assert.equal(host.actions.updateCli('codex'), undefined, 'the browser request returns at once');
  await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(host.invoked.at(-1))), ['update', 'codex']);
  assert.equal(host.source.read().codex.busy, true, 'browsers see the update running');
  host.finish(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(JSON.parse(JSON.stringify(host.source.read().codex)), { status: { tool: 'codex', current: '1.1.0', latest: '1.1.0', available: false }, busy: false });
}

// Browser: the button asks the desktop, and never runs an update or a version check itself.
{
  const { host, api } = load(true);
  assert.equal(host.source, undefined, 'a browser offers nothing of its own');
  assert.equal(api.useCliUpdate('claude').busy, false);
  assert.equal(host.target.id, 'cli-updates', 'showing a button follows the desktop entries');
  host.target.apply({ claude: { status: { tool: 'claude', current: '1.0.0', latest: '1.1.0', available: true }, busy: true } });
  assert.equal(api.useCliUpdate('claude').busy, true, 'the desktop progress shows here');
  await api.updateCli('claude'); await api.checkCliUpdate('claude');
  assert.deepEqual(JSON.parse(JSON.stringify(host.calls)), [['app', 'updateCli', ['claude']], ['app', 'checkCliUpdate', ['claude']]]);
  assert.deepEqual(host.invoked, []);
}

console.log('ok tool updates from a browser run on the desktop and show on both screens');
