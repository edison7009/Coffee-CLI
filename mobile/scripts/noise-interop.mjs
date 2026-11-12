// Pairs with and reconnects to a desktop over the real protocol, using the app's own client.
// Usage: node scripts/noise-interop.mjs <host> <port> <desktopPublicKeyHex> <pairingCode>
// Prints one JSON line with what happened; the Rust test (src/mobile_rpc/tests.rs) drives it.
import { CoffeeClient, generateKeyPair } from '../src/protocol.ts';

const [host, port, publicKey, code] = process.argv.slice(2);
// An unreachable address first: the client must race past it.
const desktop = { hosts: ['192.0.2.1', host], port: Number(port), publicKey };
const keys = generateKeyPair();
const base = { desktop, keys, deviceName: 'Interop phone', platform: 'node', appVersion: '0.0.1', timeoutMs: 10_000, dialTimeoutMs: 5000 };
const out = {};
const paired = await CoffeeClient.connect({ ...base, pairingCode: code });
out.hello = paired.hello.protocol;
out.host = paired.host;
out.ping = typeof (await paired.request('ping')).t;
paired.close();
const resumed = await CoffeeClient.connect(base);
const big = 'x'.repeat(200_000);
try { await resumed.request('conversation.send', { id: 'missing', text: big }); } catch (error) { out.bigError = error.code; }
out.subscribe = await resumed.request('session.subscribe', { id: 'interop-conv' });
const event = new Promise(resolve => resumed.onEvent(resolve));
console.log(JSON.stringify({ ready: true }));
out.event = await event;
resumed.close();
try { await CoffeeClient.connect({ ...base, keys: generateKeyPair() }); out.stranger = 'accepted'; } catch (error) { out.stranger = error.code; }
console.log(JSON.stringify(out));
