// Protocol unit tests, run by Node directly against src/protocol.ts.
// The desktop interop test lives in src/mobile_rpc/tests.rs (cargo test).
import assert from 'node:assert/strict';
import { x25519 } from '@noble/curves/ed25519.js';
import { Initiator, generateKeyPair, pairingPsk, parsePairingLink, toHex, fromHex, PROTOCOL } from '../src/protocol.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok ${name}`); };

test('hex round trip and rejection', () => {
  const bytes = Uint8Array.of(0, 1, 254, 255);
  assert.equal(toHex(bytes), '0001feff');
  assert.deepEqual(fromHex('0001FEFF'), bytes);
  assert.throws(() => fromHex('abc'));
});

test('pairing link parsing', () => {
  const pk = 'ab'.repeat(32), code = 'c0'.repeat(16);
  assert.deepEqual(parsePairingLink(` coffee://pair?v=${PROTOCOL}&host=192.168.1.8&port=47391&pk=${pk.toUpperCase()}&code=${code} `), { host: '192.168.1.8', port: 47391, publicKey: pk, code });
  for (const bad of ['https://example.com', `coffee://pair?v=9&host=h&port=1&pk=${pk}&code=${code}`, `coffee://pair?v=0&host=h&port=0&pk=${pk}&code=${code}`, `coffee://pair?v=0&host=h&port=1&pk=xyz&code=${code}`, `coffee://pair?v=0&port=1&pk=${pk}&code=${code}`]) {
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

console.log(`${passed} mobile protocol tests passed`);
