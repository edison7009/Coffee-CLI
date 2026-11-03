import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({ entryPoints: [`${root}src/lib/agent-client.ts`], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] });
const module = { exports: {} };
const reads = [];
const channelReads = [];
const listReads = [];
const sends = [];
const created = [];
const page = (id, messages, extra = {}) => ({ id: id === 'desktop' ? 'desktop-thread' : id, route: 'desktop', messages, hasOlder: false, runId: null, ...extra });
runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports,
  require: () => ({ useSyncExternalStore: (_subscribe, snapshot) => snapshot() }),
  Date,
  window: { __TAURI_INTERNALS__: { invoke: (command, args) => {
    if (command === 'agent_get_conversation') return new Promise(resolve => reads.push(messages => resolve(Array.isArray(messages) ? page(args.conversationId, messages) : messages)));
    if (command === 'agent_list_conversations') return new Promise(resolve => listReads.push(resolve));
    if (command === 'agent_new_conversation') { created.push(args.conversationId); return Promise.resolve(created.length === 1 ? 'new-thread' : 'button-thread'); }
    if (command === 'channel_get_settings') return new Promise(resolve => channelReads.push(resolve));
    if (command === 'agent_send_message') { sends.push(args); return Promise.resolve('new-run'); }
    throw new Error(`Unexpected IPC ${command}`);
  } } },
});
const api = module.exports;

const initial = api.refreshAgentConversation();
reads.shift()([{ role: 'user', text: 'old' }, { role: 'assistant', text: 'old reply' }]);
await initial;
api.receiveAgentEvent({ conversationId: 'desktop-thread', runId: 'old-run', kind: 'started' });
api.receiveAgentEvent({ conversationId: 'desktop-thread', runId: 'old-run', kind: 'done' });
const staleRead = reads.shift();
await api.sendAgentMessage('new message');
api.receiveAgentEvent({ conversationId: 'desktop-thread', runId: 'new-run', kind: 'started' });
api.receiveAgentEvent({ conversationId: 'desktop-thread', runId: 'new-run', kind: 'text', text: 'new reply' });
staleRead([{ role: 'user', text: 'old' }, { role: 'assistant', text: 'old reply' }]);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(Array.from(api.useAgentClient().messages, message => message.text), ['old', 'old reply', 'new message', 'new reply']);
assert.equal(api.useAgentClient().running, true);
console.log('  ok  stale history refresh cannot erase a newer prompt or model reply');

const older = api.refreshAgentConversation();
const newer = api.refreshAgentConversation();
const olderRead = reads.shift(), newerRead = reads.shift();
newerRead([{ role: 'assistant', text: 'latest history' }]);
await newer;
olderRead([{ role: 'assistant', text: 'outdated history' }]);
await older;
assert.equal(api.useAgentClient().messages[0].text, 'latest history');
console.log('  ok  out-of-order history reads preserve the already refreshed conversation');

const firstSwitch = api.openAgentConversation('wechat-thread');
const delayedSwitch = reads.shift();
const secondSwitch = api.openAgentConversation('telegram-thread');
reads.shift()(page('telegram-thread', [{ id: 4, role: 'user', text: 'Telegram history' }], { route: 'telegram-bound' }));
await secondSwitch;
delayedSwitch(page('wechat-thread', [{ id: 2, role: 'user', text: 'WeChat history' }], { route: 'weixin-bound' }));
await firstSwitch;
api.receiveAgentEvent({ conversationId: 'wechat-thread', runId: 'wechat-run', kind: 'started' });
api.receiveAgentEvent({ conversationId: 'wechat-thread', runId: 'wechat-run', kind: 'text', text: 'private WeChat reply' });
assert.equal(api.useAgentClient().conversationId, 'telegram-thread');
assert.equal(api.useAgentClient().messages[0].text, 'Telegram history');
assert.equal(api.useAgentClient().running, false);
console.log('  ok  delayed loads and background channel events cannot cross conversations');

const historySwitch = api.openAgentConversation('old-thread');
reads.shift()(page('old-thread', [{ id: 101, role: 'user', text: 'newest page' }], { hasOlder: true }));
await historySwitch;
const loadOlder = api.loadOlderAgentMessages();
reads.shift()(page('old-thread', [{ id: 1, role: 'user', text: 'original first message' }]));
await loadOlder;
assert.deepEqual(Array.from(api.useAgentClient().messages, message => message.id), [1, 101]);
assert.equal(api.useAgentClient().hasOlder, false);
console.log('  ok  older archive pages prepend without discarding current messages');

const streamingHistory = api.openAgentConversation('streaming-history');
reads.shift()(page('streaming-history', [{ id: 201, role: 'user', text: 'current prompt' }], { hasOlder: true }));
await streamingHistory;
api.receiveAgentEvent({ conversationId: 'streaming-history', runId: 'streaming-run', kind: 'started' });
api.receiveAgentEvent({ conversationId: 'streaming-history', runId: 'streaming-run', kind: 'text', text: 'first reply' });
const olderWhileRunning = api.loadOlderAgentMessages();
reads.shift()(page('streaming-history', [{ id: 11, role: 'user', text: 'older prompt' }]));
await olderWhileRunning;
api.receiveAgentEvent({ conversationId: 'streaming-history', runId: 'streaming-run', kind: 'text', text: ' continued reply' });
assert.deepEqual(Array.from(api.useAgentClient().messages, message => [message.role, message.text]), [
  ['user', 'older prompt'], ['user', 'current prompt'], ['assistant', 'first reply continued reply'],
]);
assert.equal(api.useAgentClient().running, true);
api.receiveAgentEvent({ conversationId: 'streaming-history', runId: 'streaming-run', kind: 'done' });
reads.shift()(page('streaming-history', [{ id: 201, role: 'user', text: 'current prompt' }, { id: 202, role: 'assistant', text: 'first reply continued reply' }]));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(Array.from(api.useAgentClient().messages, message => message.text), ['current prompt', 'first reply continued reply']);
console.log('  ok  loading older messages during a run preserves the active reply and historical messages');

const fresh = api.sendAgentMessage('/new');
await new Promise(resolve => setImmediate(resolve));
reads.shift()(page('new-thread', []));
await new Promise(resolve => setImmediate(resolve));
while (listReads.length) listReads.shift()([]);
await fresh;
assert.equal(api.useAgentClient().conversationId, 'new-thread');
assert.equal(api.useAgentClient().messages.length, 0);
console.log('  ok  conversational /new starts a saved thread without sending a CLI task');

const fromButton = api.startNewAgentConversation();
await new Promise(resolve => setImmediate(resolve));
reads.shift()(page('button-thread', []));
await new Promise(resolve => setImmediate(resolve));
while (listReads.length) listReads.shift()([]);
await fromButton;
assert.deepEqual(created, ['streaming-history', 'new-thread'], 'the button starts from the open thread exactly like /new');
assert.equal(api.useAgentClient().conversationId, 'button-thread');
assert.equal(sends.filter(send => send.text === '/new').length, 0, 'neither path sends /new to the model');
console.log('  ok  the New chat button starts a saved thread the same way as /new');

const channelSettings = status => ({ telegram: { enabled: false }, weixin: { enabled: true }, status: { telegram: 'disconnected', weixin: status } });
const channelRefresh = api.refreshChannels();
api.receiveChannelStatus(channelSettings('connected'));
channelReads.shift()(channelSettings('connecting'));
await channelRefresh;
assert.equal(api.useAgentClient().channels.status.weixin, 'connected');
console.log('  ok  stale channel reads cannot overwrite a live connected event');

const earlierChannelRefresh = api.refreshChannels();
const laterChannelRefresh = api.refreshChannels();
const earlierChannelRead = channelReads.shift(), laterChannelRead = channelReads.shift();
laterChannelRead(channelSettings('disconnected'));
await laterChannelRefresh;
earlierChannelRead(channelSettings('connected'));
await earlierChannelRefresh;
assert.equal(api.useAgentClient().channels.status.weixin, 'disconnected');
console.log('  ok  out-of-order channel reads cannot restore a disconnected channel');

const mobileHistory = api.openAgentConversation('shared-wechat-history');
reads.shift()(page('shared-wechat-history', [{ id: 301, role: 'user', text: 'earlier mobile message' }], { route: 'weixin-bound' }));
await mobileHistory;
await api.sendAgentMessage('continue this work on desktop');
assert.equal(sends.at(-1).conversationId, 'shared-wechat-history');
assert.equal(api.useAgentClient().route, 'weixin-bound');
assert.deepEqual(Array.from(api.useAgentClient().messages, message => message.text), ['earlier mobile message', 'continue this work on desktop']);
console.log('  ok  desktop continues the original mobile conversation ID and preserves its history');

// A failed run is shown in history or as a footer error, never both. The
// current receipt must be newer than the messages present when refresh began.
const failureConversation = api.openAgentConversation('failure-history');
const oldFailure = { id: 401, role: 'assistant', text: 'Agent 请求未完成：请先在 Agent 配置中填写模型 ID' };
reads.shift()(page('failure-history', [oldFailure]));
await failureConversation;
let failureId = 401;
for (const error of ['请先在 Agent 配置中填写模型 ID', '请先在 Agent 配置中填写 API 密钥', 'Model service returned HTTP 401', 'Could not reach the model service']) {
  const runId = `failure-${failureId}`;
  api.receiveAgentEvent({ conversationId: 'failure-history', runId, kind: 'started' });
  api.receiveAgentEvent({ conversationId: 'failure-history', runId, kind: 'error', text: error });
  assert.equal(api.useAgentClient().error, error, 'an error remains visible while its history receipt is loading');
  const receipt = { id: ++failureId, role: 'assistant', text: `Agent 请求未完成：${error}` };
  reads.shift()(page('failure-history', [oldFailure, receipt]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.useAgentClient().error, '', 'the new persisted failure receipt replaces the duplicate footer error');
  assert.equal(api.useAgentClient().messages.at(-1).text, receipt.text, 'failure history remains available to reopen');
}
console.log('  ok  missing model/key, HTTP 401, and network failure show one persisted error receipt');

const repeatedError = api.useAgentClient().messages.at(-1).text.slice('Agent 请求未完成：'.length);
const unchangedHistory = Array.from(api.useAgentClient().messages);
api.receiveAgentEvent({ conversationId: 'failure-history', runId: 'no-new-receipt', kind: 'started' });
api.receiveAgentEvent({ conversationId: 'failure-history', runId: 'no-new-receipt', kind: 'error', text: repeatedError });
reads.shift()(page('failure-history', unchangedHistory));
await new Promise(resolve => setImmediate(resolve));
assert.equal(api.useAgentClient().error, repeatedError, 'an identical receipt from a previous run cannot hide the current failure');

api.receiveAgentEvent({ conversationId: 'failure-history', runId: 'unrelated-receipt', kind: 'started' });
api.receiveAgentEvent({ conversationId: 'failure-history', runId: 'unrelated-receipt', kind: 'error', text: repeatedError });
reads.shift()(page('failure-history', [...unchangedHistory, { id: ++failureId, role: 'assistant', text: 'an unrelated reply' }]));
await new Promise(resolve => setImmediate(resolve));
assert.equal(api.useAgentClient().error, repeatedError, 'a different reply cannot hide the current failure');
console.log('  ok  a missing or mismatched new failure receipt keeps the footer error visible');
