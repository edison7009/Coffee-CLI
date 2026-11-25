import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/remote-control.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const { controlAddress, originOf, rememberRemote, forgetRemote, loadRecentRemotes, recentAddress } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

// Both things Settings → 设备连接 offers are accepted: the Web 端 address and the bare pairing link.
const pk = 'a'.repeat(64), code = 'b'.repeat(32);
const link = `coffeecli://pair?v=0&hosts=192.168.1.20,mac.local&port=47321&pk=${pk}&code=${code}`;
assert.equal(controlAddress(`  ${link}  `), `http://192.168.1.20:47321/?remote#pair=${encodeURIComponent(link)}`);
assert.equal(controlAddress(`http://192.168.1.20:47321/?remote#pair=x`), 'http://192.168.1.20:47321/?remote#pair=x');
assert.equal(controlAddress(`coffeecli://pair?v=0&hosts=fd7a::1&port=8080&pk=${pk}&code=${code}`)?.startsWith('http://[fd7a::1]:8080/?remote#pair='), true);
for (const bad of ['', 'hello', 'http://192.168.1.20:47321/', 'file:///etc/passwd', 'javascript:alert(1)', 'coffeecli://pair?v=0&port=1', 'https://example.com/?q=remote']) assert.equal(controlAddress(bad), null, bad);
console.log('ok addresses and pairing links become the Web 端 address; anything else is refused');

// Recent computers: one per origin, newest first, a learned name kept over the address placeholder.
assert.equal(originOf('http://192.168.1.20:47321/?remote#pair=x'), 'http://192.168.1.20:47321');
rememberRemote('http://a:1', 'a:1', 1);
rememberRemote('http://a:1', 'MacBook Pro', 2);
rememberRemote('http://b:2', 'Studio', 3);
assert.deepEqual(loadRecentRemotes().map(r => [r.origin, r.title]), [['http://b:2', 'Studio'], ['http://a:1', 'MacBook Pro']]);
rememberRemote('http://a:1', 'a:1', 4);
assert.equal(loadRecentRemotes()[0].title, 'MacBook Pro', 'reopening by address keeps the known name');
assert.deepEqual(forgetRemote('http://b:2').map(r => r.origin), ['http://a:1']);
for (let i = 0; i < 12; i++) rememberRemote(`http://h${i}:1`, `n${i}`, 10 + i);
assert.equal(loadRecentRemotes().length, 8, 'the list is capped');
store.set('cc-remote-recent', '{broken');
assert.deepEqual(loadRecentRemotes(), [], 'a damaged list reads as empty');
assert.equal(recentAddress('http://a:1'), 'http://a:1/?remote');
console.log('ok recent computers: one each, newest first, named, capped, damage-tolerant');
