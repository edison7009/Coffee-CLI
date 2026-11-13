// Protocol unit tests, run by Node directly against src/protocol.ts.
// The desktop interop test lives in src/mobile_rpc/tests.rs (cargo test).
import assert from 'node:assert/strict';
import { x25519 } from '@noble/curves/ed25519.js';
import { Channel, CoffeeClient, Initiator, MAX_REQUEST, RpcError, generateKeyPair, pairingPsk, parsePairingLink, toHex, fromHex, PROTOCOL } from '../../src-ui/src/remote/protocol.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok ${name}`); };

test('an oversized request fails on its own instead of cutting the connection', async () => {
  const sent = [];
  const plain = { encrypt: (_ad, data) => data, decrypt: (_ad, data) => data };
  const client = new CoffeeClient({ send: data => sent.push(data), close() {} }, new Channel(plain, plain));
  await assert.rejects(client.request('ui.call', { args: ['x'.repeat(MAX_REQUEST)] }), e => e instanceof RpcError && e.code === 'too_large');
  assert.equal(sent.length, 0, 'nothing reaches the desktop');
  void client.request('ping');
  assert.equal(sent.length, 1, 'the connection still works');
});

test('hex round trip and rejection', () => {
  const bytes = Uint8Array.of(0, 1, 254, 255);
  assert.equal(toHex(bytes), '0001feff');
  assert.deepEqual(fromHex('0001FEFF'), bytes);
  assert.throws(() => fromHex('abc'));
});

test('pairing link parsing', () => {
  const pk = 'ab'.repeat(32), code = 'c0'.repeat(16);
  assert.deepEqual(parsePairingLink(` coffeecli://pair?v=${PROTOCOL}&hosts=192.168.1.8,10.0.0.2,mac.local&port=47391&pk=${pk.toUpperCase()}&code=${code} `), { hosts: ['192.168.1.8', '10.0.0.2', 'mac.local'], port: 47391, publicKey: pk, code });
  // Single-host links still parse; junk entries are dropped.
  assert.deepEqual(parsePairingLink(`coffeecli://pair?v=0&host=192.168.1.8&port=1&pk=${pk}&code=${code}`).hosts, ['192.168.1.8']);
  assert.deepEqual(parsePairingLink(`coffeecli://pair?v=0&hosts=a b,192.168.1.8,&port=1&pk=${pk}&code=${code}`).hosts, ['192.168.1.8']);
  for (const bad of ['https://example.com', `coffeecli://pair?v=9&host=h&port=1&pk=${pk}&code=${code}`, `coffeecli://pair?v=0&host=h&port=0&pk=${pk}&code=${code}`, `coffeecli://pair?v=0&host=h&port=1&pk=xyz&code=${code}`, `coffeecli://pair?v=0&port=1&pk=${pk}&code=${code}`]) {
    assert.throws(() => parsePairingLink(bad), bad);
  }
});

test('key pairs are valid x25519 keys', () => {
  const keys = generateKeyPair();
  assert.deepEqual(x25519.getPublicKey(keys.privateKey), keys.publicKey);
  assert.equal(pairingPsk('code').length, 32);
});

test('first message has the IK layout and a wrong desktop key fails the handshake', () => {
  const desktop = generateKeyPair(), phone = generateKeyPair();
  const message = new Initiator(phone, desktop.publicKey, new Uint8Array(32)).firstMessage(1);
  // mode + e (32) + encrypted s (32 + 16) + empty payload tag (16)
  assert.equal(message.length, 1 + 32 + 48 + 16);
  assert.equal(message[0], 1);
  const initiator = new Initiator(phone, desktop.publicKey, new Uint8Array(32));
  initiator.firstMessage(0);
  assert.throws(() => initiator.finish(new Uint8Array(48)), /handshake rejected/);
  assert.throws(() => new Initiator(phone, new Uint8Array(31), new Uint8Array(32)));
});

// Fake sockets: each URL decides whether it opens, fails or hangs.
function fakeSockets(plan) {
  const made = [];
  const create = url => {
    const socket = { url, binaryType: '', sent: [], closed: false, send(d) { this.sent.push(d); }, close() { this.closed = true; }, onopen: null, onclose: null, onerror: null, onmessage: null };
    made.push(socket);
    const [action, delay] = plan[new URL(url).hostname] ?? ['hang'];
    if (action !== 'hang') setTimeout(() => (action === 'open' ? socket.onopen : socket.onerror)?.(), delay);
    return socket;
  };
  return { made, create };
}
const desktopKeys = generateKeyPair();
const options = (hosts, create) => ({ desktop: { hosts, port: 47391, publicKey: toHex(desktopKeys.publicKey) }, keys: generateKeyPair(), deviceName: 't', platform: 'node', appVersion: '0', createSocket: create, timeoutMs: 200, dialTimeoutMs: 200 });

await (async () => {
  // The first address to open wins even when it is not first in the list; the rest are closed
  // and only the winner receives the handshake.
  const { made, create } = fakeSockets({ '10.0.0.1': ['fail', 5], '10.0.0.2': ['open', 30], '10.0.0.3': ['open', 10] });
  await assert.rejects(CoffeeClient.connect(options(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'], create)), (e) => e instanceof RpcError);
  const winner = made.find(s => s.url.includes('10.0.0.3'));
  assert.equal(winner.sent.length, 1, 'winner got the first handshake message');
  assert.equal(made.filter(s => s !== winner && s.sent.length).length, 0, 'losers sent nothing');
  assert.ok(made.filter(s => s !== winner).every(s => s.closed || s.url.includes('10.0.0.1')), 'losers closed');
  passed++; console.log('ok dialing races every address and hands the handshake to one');
})();

await (async () => {
  const { create } = fakeSockets({ a: ['fail', 5], b: ['fail', 10] });
  await assert.rejects(CoffeeClient.connect(options(['a', 'b'], create)), e => e.code === 'unreachable' && e.message === 'connection failed');
  const hang = fakeSockets({});
  await assert.rejects(CoffeeClient.connect(options(['c'], hang.create)), e => e.code === 'unreachable' && e.message === 'timed out');
  assert.ok(hang.made[0].closed);
  passed++; console.log('ok nothing answering is unreachable, failing fast or after the dial timeout');
})();

console.log(`${passed} mobile protocol tests passed`);
