// A window that controls another computer (src/remote_window.rs) runs this app's own UI in remote
// mode against that computer's data. Its Tauri IPC object is locked; the bridge takes over through
// the routing in vite.config.ts, keeps the clipboard and links local, and dials through this
// computer (src/remote_link.rs). Native calls are faked here; a real link is checked by hand.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const directory = await mkdtemp(join(tmpdir(), 'coffee-control-window-'));
const server = await createServer({ cacheDir: join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const link = `coffeecli://pair?v=0&hosts=192.168.1.20,mac.local&port=47321&pk=${'a'.repeat(64)}&code=${'b'.repeat(32)}`;

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // As Tauri does: this window's own IPC, defined so it cannot be replaced.
  await page.addInitScript(link => {
    window.localCalls = [];
    const callbacks = {}; let next = 0;
    window.localCallbacks = callbacks;
    window.linkEvents = handler => (window.linkHandler = handler);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: Object.freeze({
      plugins: {},
      metadata: { currentWindow: { label: 'remote-192-168-1-20-47321' }, currentWebview: { label: 'remote-192-168-1-20-47321' } },
      transformCallback(fn) { const id = ++next; callbacks[id] = fn; return id; },
      async invoke(cmd, args) {
        window.localCalls.push({ cmd, args });
        // A key saved from an earlier pairing: a freshly pasted link still means pairing again.
        if (cmd === 'remote_control_info') return { origin: 'http://192.168.1.20:47321', pairing: { desktop: { hosts: ['192.168.1.20'], port: 47321, publicKey: 'c'.repeat(64) }, computerName: 'Old', deviceName: 'x', privateKey: 'd'.repeat(64), publicKey: 'e'.repeat(64) }, pairLink: link };
        if (cmd === 'plugin:event|listen') {
          if (args.event === 'remote-link') window.linkHandler = callbacks[args.handler];
          if (args.event === 'window-control-request') window.controlHandler = callbacks[args.handler];
          return args.handler;
        }
        if (cmd === 'plugin:app|version') return '4.0.6';
        return null;
      },
    }) });
  }, link);
  await page.goto(`${server.resolvedUrls.local[0]}?remote&control`, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  // The window's own UI, in remote mode, pairing with the link it was opened with.
  await page.getByRole('heading', { name: '连接到 Coffee CLI' }).waitFor({ timeout: 60_000 });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('is-control')), true);
  assert.equal(await page.getByRole('textbox', { name: '这台设备的名称' }).inputValue(), 'Coffee CLI 客户端');
  assert.equal(await page.getByRole('textbox', { name: '配对链接' }).count(), 0, 'the link came with the window');
  assert.deepEqual(await page.evaluate(() => window.localCalls.map(c => c.cmd).filter(c => c === 'remote_control_info')), ['remote_control_info']);
  assert.equal(await page.evaluate(() => typeof globalThis.__COFFEE_TAURI__?.invoke), 'function', 'the bridge took over through the routed global');
  console.log('OK a control window starts its own UI in remote mode with the link it was opened with');

  // @tauri-apps/api reads the routed global: its calls reach the bridge, which keeps the clipboard and links here.
  await page.evaluate(async () => {
    const core = await import('/node_modules/@tauri-apps/api/core.js');
    await core.invoke('plugin:clipboard-manager|write_text', { text: 'hi' });
    await globalThis.__COFFEE_TAURI__.invoke('open_url', { url: 'https://coffeecli.com' });
  });
  const kept = await page.evaluate(() => window.localCalls.map(c => c.cmd));
  assert.ok(kept.includes('plugin:clipboard-manager|write_text'), 'clipboard stays on this computer');
  assert.ok(kept.includes('open_url'), 'links open on this computer');
  console.log('OK @tauri-apps/api goes through the bridge; clipboard and links stay local');

  // Voice input listens on this computer: the command stays here, the other computer's folder is dropped,
  // and the waveform/transcript channel is relayed through this computer's own IPC callbacks.
  const voice = await page.evaluate(async () => {
    const core = await import('/node_modules/@tauri-apps/api/core.js');
    const got = [];
    const channel = new core.Channel(message => got.push(message));
    await core.invoke('voice_input_start', { tool: 'claude', cwd: '/Users/other/project', language: 'zh', device: null, onEvent: channel });
    const call = window.localCalls.find(c => c.cmd === 'voice_input_start');
    const relay = Number(String(call?.args.onEvent).replace('__CHANNEL__:', ''));
    window.localCallbacks[relay]?.({ index: 0, message: { kind: 'level', level: 0.5 } });
    return { cwd: call?.args.cwd, channel: String(call?.args.onEvent), got };
  });
  assert.equal(voice.cwd, null, 'the other computer\'s folder is not looked up here');
  assert.match(voice.channel, /^__CHANNEL__:\d+$/);
  assert.deepEqual(voice.got, [{ kind: 'level', level: 0.5 }], 'events from this computer reach the composer');
  console.log('OK voice input runs on this computer and its events come back through a relayed channel');

  // This computer's requests to the window (src/window_control.rs) are heard and answered on this
  // computer's own IPC, not routed to the other computer like everything else.
  const heard = await page.evaluate(async () => {
    const { onLocalEvent, localInvoke } = await import('/src/remote/local-ipc.ts');
    const got = new Promise(resolve => onLocalEvent('window-control-request', resolve));
    await new Promise(resolve => setTimeout(resolve, 50));
    const listen = window.localCalls.find(c => c.cmd === 'plugin:event|listen' && c.args.event === 'window-control-request');
    if (!listen) return { listened: false };
    window.controlHandler({ event: 'window-control-request', id: 2, payload: { requestId: 'r1', name: 'sessions_list', arguments: {} } });
    const payload = await got;
    await localInvoke('window_control_resolve', { requestId: payload.requestId, result: { ok: true } });
    return { listened: true, requestId: payload.requestId, resolved: window.localCalls.some(c => c.cmd === 'window_control_resolve' && c.args.requestId === 'r1') };
  });
  assert.deepEqual(heard, { listened: true, requestId: 'r1', resolved: true }, 'window control listens and answers on this computer');
  console.log('OK window control requests are heard and answered on this computer');

  // Connecting dials every address of the computer through this computer's relay.
  await page.getByRole('button', { name: '连接' }).click();
  await page.waitForFunction(() => window.localCalls.filter(c => c.cmd === 'remote_link_open').length === 2);
  const dials = await page.evaluate(() => window.localCalls.filter(c => c.cmd === 'remote_link_open').map(c => c.args));
  assert.deepEqual(dials.map(d => d.url).sort(), ['ws://192.168.1.20:47321', 'ws://mac.local:47321']);
  assert.ok(dials.every(d => /^[0-9a-f-]{36}$/.test(d.id)), 'each dial has its own link id');
  // Neither address answers: the relay reports both closed, and the page says it cannot reach the computer.
  await page.evaluate(ids => { for (const id of ids) window.linkHandler({ event: 'remote-link', id: 1, payload: { id, kind: 'close' } }); }, dials.map(d => d.id));
  await page.getByRole('alert').filter({ hasText: '连不上电脑' }).waitFor();

  // An address that answers gets the handshake's first frame, through the relay, in base64.
  await page.getByRole('button', { name: '连接' }).click();
  await page.waitForFunction(() => window.localCalls.filter(c => c.cmd === 'remote_link_open').length === 4);
  const [first] = await page.evaluate(() => window.localCalls.filter(c => c.cmd === 'remote_link_open').slice(2).map(c => c.args));
  await page.evaluate(id => window.linkHandler({ event: 'remote-link', id: 1, payload: { id, kind: 'open' } }), first.id);
  await page.waitForFunction(id => window.localCalls.some(c => c.cmd === 'remote_link_send' && c.args.id === id), first.id);
  const sent = await page.evaluate(id => window.localCalls.find(c => c.cmd === 'remote_link_send' && c.args.id === id).args.data, first.id);
  assert.ok(Buffer.from(sent, 'base64').length >= 32, 'the Noise handshake goes out as binary');
  const others = await page.evaluate(id => window.localCalls.filter(c => c.cmd === 'remote_link_close').map(c => c.args.id), first.id);
  assert.equal(others.length, 1, 'the slower address is hung up');

  assert.deepEqual(errors, []);
  console.log('OK connecting dials through this computer, reports unreachable computers, and sends the handshake through the relay');
} finally {
  await browser.close();
  await server.close();
}
