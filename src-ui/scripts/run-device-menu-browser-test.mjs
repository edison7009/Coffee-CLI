// The sidebar's device menu: always opens; controls other computers (each in a window of its own),
// remembers them, lists devices connected to this one. Native calls are faked; the UI is real.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const directory = await mkdtemp(join(tmpdir(), 'coffee-device-menu-'));
const server = await createServer({ cacheDir: join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });

async function open({ connected }) {
  const page = await browser.newPage({ viewport: { width: 1300, height: 820 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route(/\/src\/components\/center\/(TierTerminal|ClaudeConversation|CodexConversation)\.tsx/, route => {
    const name = route.request().url().match(/\/([A-Za-z]+)\.tsx/)[1];
    return route.fulfill({ contentType: 'text/javascript', body: `export function ${name}(){return null} export const TERM_COLOR_SCHEMES=[]; export const ClaudeTool=()=>null, ClaudeThinking=()=>null;` });
  });
  await page.addInitScript(connected => {
    for (const [k, v] of Object.entries({ 'cc-lang': 'zh-CN', 'cc-theme': 'dark', 'cc-mode': 'dark', 'cc-shape': 'soft', 'cc-tasks-seeded': '1' })) localStorage.setItem(k, v);
    window.calls = []; window.listeners = {}; window.remotes = [];
    let callback = 0; const callbacks = {};
    const status = { enabled: connected, port: 47321, publicKey: 'p', host: null, hosts: [], clients: 0, protocol: 0,
      devices: connected ? [{ publicKey: 'k1', name: 'iPhone', platform: 'web' }] : [], connected: connected ? ['k1'] : [] };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(fn) { const id = ++callback; callbacks[id] = fn; return id; },
      async invoke(name, args) {
        window.calls.push({ name, args });
        if (name === 'plugin:event|listen') { (window.listeners[args.event] ??= []).push(callbacks[args.handler]); return args.handler; }
        if (name === 'mobile_rpc_status') return status;
        if (name === 'remote_window_list') return window.remotes;
        if (name === 'remote_window_open') {
          const origin = new URL(args.address).origin, host = origin.replace(/^https?:\/\//, '');
          const win = { label: 'remote-x', name: host, title: args.prefix + host, origin };
          window.remotes = [win]; window.emit('remote-windows-changed', window.remotes);
          return win;
        }
        if (name === 'remote_window_close') { window.remotes = []; window.emit('remote-windows-changed', []); return null; }
        if (name === 'check_tools_installed') return {};
        if (name.startsWith('orchestration_')) return { enabled: false, agents: [], coordinators: [], tasks: [], revision: 0 };
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.emit = (event, payload) => (window.listeners[event] ?? []).forEach(fn => fn({ event, id: 1, payload }));
  }, connected);
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded', timeout: 90_000 });
  return { page, errors };
}

try {
  // Nothing connected: the status still opens a menu (it used to jump to Settings).
  {
    const { page, errors } = await open({ connected: false });
    const status = page.locator('.sidebar-footer-status-button');
    await status.waitFor({ timeout: 60_000 });
    assert.equal((await status.innerText()).trim(), '未连接设备');
    await status.click();
    const menu = page.getByRole('menu');
    assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(), ['下载 Coffee CLI 移动端', '操控其他设备…', '连接设置'], 'empty sections are left out; the phone app placeholder leads');
    assert.equal(await page.evaluate(() => document.querySelector('.settings-page, .settings-modal') === null), true, 'it no longer jumps to Settings');

    // Paste an address: a wrong one is explained, a pairing link opens the window for that computer.
    await menu.getByRole('menuitem', { name: '操控其他设备…' }).click();
    const dialog = page.getByRole('dialog', { name: '操控其他设备' });
    await dialog.waitFor();
    const box = await dialog.boundingBox();
    assert.ok(Math.abs(box.x + box.width / 2 - 650) < 2 && Math.abs(box.y + box.height / 2 - 410) < 2, 'the dialog is centered');
    const input = dialog.getByRole('textbox');
    await input.fill('hello');
    await dialog.getByRole('button', { name: '打开' }).click();
    await dialog.getByRole('alert').filter({ hasText: '这不是 Coffee CLI 的连接地址。' }).waitFor();
    const link = `coffeecli://pair?v=0&hosts=192.168.1.20&port=47321&pk=${'a'.repeat(64)}&code=${'b'.repeat(32)}`;
    await input.fill(link);
    await input.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    const opened = await page.evaluate(() => window.calls.find(c => c.name === 'remote_window_open').args);
    assert.equal(opened.address, `http://192.168.1.20:47321/?remote#pair=${encodeURIComponent(link)}`);
    assert.equal(opened.prefix, '远程：');
    await page.waitForFunction(() => document.querySelector('.sidebar-web-label')?.textContent === '正在操控 192.168.1.20:47321');

    // The page reports the computer's name: the status and the remembered entry follow it.
    await page.evaluate(() => { window.remotes = [{ ...window.remotes[0], name: 'MacBook Pro', title: '远程：MacBook Pro' }]; window.emit('remote-windows-changed', window.remotes); });
    await page.waitForFunction(() => document.querySelector('.sidebar-web-label')?.textContent === '正在操控 MacBook Pro');
    assert.equal(await status.getAttribute('data-on'), 'true');
    await status.click();
    assert.deepEqual(await menu.locator('.sidebar-web-section').allInnerTexts(), ['正在操控']);
    assert.deepEqual(await menu.locator('.sidebar-web-remote-name').allInnerTexts(), ['MacBook Pro']);
    await page.waitForTimeout(300); // the menu's rise animation
    await page.screenshot({ path: join(directory, 'controlling.png'), clip: { x: 0, y: 560, width: 420, height: 260 } });

    // Closing it ends the connection; the computer stays in Recent to reopen without pairing.
    await menu.getByRole('button', { name: '断开 MacBook Pro' }).click();
    await page.waitForFunction(() => document.querySelector('.sidebar-web-label')?.textContent === '未连接设备');
    assert.deepEqual(await menu.locator('.sidebar-web-section').allInnerTexts(), ['最近操控']);
    await menu.getByRole('menuitem', { name: 'MacBook Pro' }).click();
    const reopened = await page.evaluate(() => window.calls.filter(c => c.name === 'remote_window_open').at(-1).args.address);
    assert.equal(reopened, 'http://192.168.1.20:47321/?remote', 'reopening needs no pairing link');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`OK the menu always opens, pairs from a pasted link, names the computer, remembers it (screenshot: ${join(directory, 'controlling.png')})`);
  }

  // Devices connected to this computer keep their section and Disconnect all.
  {
    const { page, errors } = await open({ connected: true });
    const status = page.locator('.sidebar-footer-status-button');
    await status.waitFor({ timeout: 60_000 });
    assert.equal((await status.innerText()).trim(), '已连接 1 台设备');
    await status.click();
    const menu = page.getByRole('menu');
    assert.deepEqual(await menu.locator('.sidebar-web-section').allInnerTexts(), ['连接到本机']);
    assert.equal((await menu.locator('.sidebar-web-device-name').innerText()).trim(), 'iPhone');
    assert.equal(await menu.getByRole('menuitem', { name: '全部断开' }).count(), 1);
    assert.equal(await menu.getByRole('menuitem').first().innerText(), '下载 Coffee CLI 移动端', 'the phone app placeholder stays on top');
    assert.equal(await menu.getByRole('menuitem', { name: '下载 Coffee CLI 移动端' }).isDisabled(), true, 'not out yet');
    assert.deepEqual(errors, []);
    await page.close();
    console.log('OK devices connected to this computer keep their own section');
  }
} finally {
  await browser.close();
  await server.close();
}
