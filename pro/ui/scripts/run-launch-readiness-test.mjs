import assert from 'node:assert/strict';
import { build } from 'esbuild';

const checks = [];
globalThis.__launchReadiness = async (name, args) => {
  if (name === 'get_tool_control') return new Promise(resolve => checks.push(() => resolve({ ready: true, agents: ['claude', 'codex'].map(tool => ({ tool, enabled: true, conflict: false })) })));
  if (name === 'claude_session_start') return { sessionId: args.id, history: { data: '', cursor: null }, initialization: { models: [], commands: [] } };
  if (name === 'codex_session_start') return { thread: { id: args.id, turns: [] }, models: [] };
  return {};
};
const output = await build({ stdin: { resolveDir: process.cwd(), contents: `export * from './src/lib/claude-session';export * from './src/lib/codex-session';export {useSessionControls} from './src/lib/session-controls'` }, bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'transport', setup(b) {
  b.onResolve({ filter: /^react$|^\.\.\/tauri$|^@tauri-apps\/api\/event$/ }, args => ({ path: args.path, namespace: 'mock' }));
  b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'react' ? 'export const useSyncExternalStore=(_subscribe,snapshot)=>snapshot();' : args.path.includes('event') ? 'export async function listen(){return ()=>{}}' : 'export const invoke=globalThis.__launchReadiness;' }));
} }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const releaseClaude = api.retainClaudeSession('claude', null), releaseCodex = api.retainCodexSession('codex', null);
for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
try {
  assert.equal(api.getClaudeConnection('claude').ready, true, 'Claude starts without waiting for an optional capability scan');
  assert.equal(api.getCodexConnection('codex').ready, true, 'Codex starts without waiting for an optional capability scan');
  releaseCodex();
  checks.forEach(finish => finish());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(api.useSessionControls('claude'), ['computer', 'browser']);
  assert.deepEqual(api.useSessionControls('codex'), [], 'a late scan cannot republish capabilities for a closed owner');
} finally { releaseClaude(); }
console.log('OK: delayed capability scans do not block startup or revive closed sessions');
