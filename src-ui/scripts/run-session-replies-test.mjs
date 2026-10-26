import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `export * from './src/lib/session-replies';export * from './src/lib/use-session-reply-visibility'; export * as claude from './src/lib/claude-session'; export * as codex from './src/lib/codex-session';` }, bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react'
      ? 'export const useEffect=globalThis.mountEffect;export function useSyncExternalStore(){}'
      : args.path.includes('/event') ? 'export async function listen(name,fn){globalThis.nativeListeners.set(name,fn);return()=>{}}'
        : 'export const invoke=globalThis.nativeInvoke;' }));
  } }],
});
function fixture(storage = new Map(), blocked = false) {
  const nativeListeners = new Map(), generations = new Map(), documentListeners = new Map();
  let focused = true, cleanup;
  const document = { hidden: false, hasFocus: () => focused, addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) };
  const module = { exports: {} };
  const nativeInvoke = async (command, args) => {
    if (command.endsWith('_session_start')) {
      generations.set(args.id, args.generation);
      if (command.startsWith('claude')) return { sessionId: 'shared-token', initialization: {}, history: { data: '{"type":"result","subtype":"success"}', cursor: 0 } };
      return { thread: { id: 'shared-token', turns: [{ id: 'old', status: 'completed', items: [] }] }, models: [] };
    }
    assert.ok(['claude_session_control', 'claude_session_close', 'codex_session_close'].includes(command), 'no tool configuration or hook writes: ' + command);
    return {};
  };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, nativeListeners, nativeInvoke, document,
    window: { addEventListener() {}, removeEventListener() {} }, crypto: { randomUUID }, setTimeout, clearTimeout,
    mountEffect: effect => { cleanup?.(); cleanup = effect(); },
    localStorage: { getItem: key => { if (blocked) throw Error('blocked'); return storage.get(key) ?? null; }, setItem: (key, value) => { if (blocked) throw Error('blocked'); storage.set(key, value); } },
  });
  const api = module.exports;
  const terminals = [{ id: 'a', tool: 'claude', resumeToken: 'shared-token' }, { id: 'b', tool: 'codex', resumeToken: 'shared-token' }];
  let state = { terminals, activeTerminalId: null, sessionSplit: null };
  const view = patch => { state = { ...state, ...patch }; api.useSessionReplyVisibility(state); };
  const focus = value => { focused = value; documentListeners.get('visibilitychange')?.(); };
  const claude = (event, generation = generations.get('a')) => nativeListeners.get('claude-session-event')({ payload: { id: 'a', generation, event } });
  const codex = (method, params = {}, generation = generations.get('b')) => nativeListeners.get('codex-session-event')({ payload: { id: 'b', generation, event: { method, params: { threadId: 'shared-token', ...params } } } });
  return { api, storage, view, focus, claude, codex, dispose: () => cleanup?.() };
}
async function connect(h) {
  const releases = [h.api.claude.retainClaudeSession('a', 'D:/Project'), h.api.codex.retainCodexSession('b', 'D:/Project')];
  for (let i = 0; i < 100 && (!h.api.claude.getClaudeConnection('a')?.ready || !h.api.codex.getCodexConnection('b')?.ready); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(h.api.claude.getClaudeConnection('a')?.ready, true);
  assert.equal(h.api.codex.getCodexConnection('b')?.ready, true);
  return () => releases.forEach(release => release());
}
const h = fixture(), release = await connect(h);
const unread = () => [...h.api.getUnreadSessionReplies()].sort();
const startClaude = () => h.claude({ type: 'stream_event', event: { type: 'message_start', message: { id: randomUUID() } } });
const finishClaude = () => h.claude({ type: 'result', subtype: 'success' });
const startCodex = () => h.codex('turn/started', { turn: { id: 'live' } });
const finishCodex = status => h.codex('turn/completed', { turn: { id: 'live', status } });
try {
  h.view({});
  assert.deepEqual(unread(), [], 'restoring history creates no unread replies');
  finishClaude(); finishCodex('completed');
  assert.deepEqual(unread(), [], 'an unsolicited idle result is not new work');
  startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token'], 'only the completed tool/session becomes unread');
  startCodex(); finishCodex('interrupted'); startCodex(); finishCodex('failed');
  assert.deepEqual(unread(), ['claude:shared-token'], 'interruptions and failures do not invent successful replies');
  startCodex(); finishCodex('completed');
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'cross-tool tokens stay independent');
  const restarted = fixture(h.storage);
  assert.deepEqual([...restarted.api.getUnreadSessionReplies()].sort(), unread(), 'unread markers survive restart');
  h.view({ activeTerminalId: 'a' });
  assert.deepEqual(unread(), ['codex:shared-token']);
  finishClaude(); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['codex:shared-token'], 'duplicates and a visible foreground reply do not restore unread');
  h.focus(false); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token']);
  h.focus(true);
  assert.deepEqual(unread(), ['codex:shared-token'], 'returning to the visible conversation clears its marker');
  h.view({ usageOpen: true }); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'statistics does not acknowledge a covered conversation');
  h.view({ usageOpen: false, toolSettingsOpen: true }); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token', 'codex:shared-token'], 'tool settings does not acknowledge a covered conversation');
  h.view({ toolSettingsOpen: false, sessionSplit: { type: 'branch', first: { type: 'leaf', sessionId: 'a' }, second: { type: 'leaf', sessionId: 'b' } } });
  assert.deepEqual(unread(), [], 'both visible split panes are acknowledged');
  h.view({ sessionSplit: null, settingsOpen: true }); startClaude(); finishClaude();
  assert.deepEqual(unread(), ['claude:shared-token']);
  h.view({ settingsOpen: false });
  assert.deepEqual(unread(), []);
  h.view({ activeTerminalId: null }); startClaude();
  h.claude({ type: 'result', subtype: 'error_during_execution', is_error: true });
  startClaude(); await h.api.claude.controlClaude('a', { subtype: 'interrupt' }); finishClaude();
  assert.deepEqual(unread(), [], 'native failures and locally requested stops remain distinct from completion');
  startClaude(); h.claude({ type: 'result', subtype: 'success' }, 'obsolete-generation');
  assert.deepEqual(unread(), [], 'late events from another generation are ignored');
  const unavailable = fixture(new Map([['coffee:unread-session-replies', '{broken']]), true);
  unavailable.api.recordSessionReply('one', 'codex', 'new');
  assert.deepEqual([...unavailable.api.getUnreadSessionReplies()], ['codex:new']);
  unavailable.dispose(); restarted.dispose();
  console.log('OK: real desktop completion events, history/replay/stop/error isolation, per-tool identity, visible panes, focus, overlays, persistent unread and unavailable storage; no tool-file writes');
} finally { h.dispose(); release(); }
