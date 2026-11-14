import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-cli-app-close-'));

// The close host runs against a scripted native side: close requests and tray clicks are emitted by the test,
// and every command the host sends is recorded.
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import { createRoot } from 'react-dom/client'; import { AppCloseHost } from './src/components/common/AppCloseHost'; import './src/styles/global.css';
createRoot(document.getElementById('root')).render(<AppCloseHost />);` }, bundle: true, jsx: 'automatic', outfile: join(directory, 'fixture.js'), external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'], plugins: [{ name: 'native', setup(b) {
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /lib\/tool-info$/ }, () => ({ path: 'tools', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)platform$/ }, () => ({ path: 'platform', namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/api\/(event|path)$/ }, args => ({ path: args.path.endsWith('event') ? 'event' : 'path', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', resolveDir: project, contents: {
    native: `export const isTauri = true; window.calls = [];
      export const commands = new Proxy({}, { get: (_, name) => async (...args) => { window.calls.push([name, ...args]); } });`,
    store: `import { useSyncExternalStore } from 'react';
      window.dispatched = []; const listeners = new Set();
      window.setTerminals = terminals => { window.appState = { ...window.appState, terminals }; listeners.forEach(listener => listener()); };
      window.appState = { terminals: [] };
      export function useAppLanguage() { return 'zh-CN'; }
      export function useAppState() { const state = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => window.appState); return { state, dispatch: window.dispatch ??= action => window.dispatched.push(action) }; }`,
    tools: `export function getToolDisplayName(id) { return { claude: 'Claude Code', codex: 'Codex CLI' }[id] ?? id; }`,
    platform: `export const IS_WINDOWS = true; export const IS_MACOS = false;`,
    event: `const handlers = {}; window.emitNative = (name, payload) => handlers[name]?.({ payload });
      export async function listen(name, handler) { handlers[name] = handler; return () => { delete handlers[name]; }; }`,
    path: `export async function homeDir() { return 'C:\\\\Users\\\\me'; }`,
  }[args.path] }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
  try { const name = req.url.slice(1); if (!['fixture.js', 'fixture.css'].includes(name)) throw Error(); res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(join(directory, name))); } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof window.emitNative === 'function' && window.calls.some(call => call[0] === 'appTrayMenu'));
  const calls = name => page.evaluate(name => window.calls.filter(call => call[0] === name), name);
  const reset = () => page.evaluate(() => { window.calls.length = 0; });
  const close = seq => page.evaluate(seq => window.emitNative('main-window-close-requested', seq), seq);
  const dialog = page.getByRole('dialog', { name: '关闭 Coffee CLI？' });

  // Nothing running: "ask" quits at once, and every request is acknowledged so the native fallback stays idle.
  await reset(); await close(1);
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'appQuit'));
  assert.deepEqual(await calls('appCloseAck'), [['appCloseAck', 1]]);
  assert.equal(await dialog.count(), 0, 'no dialog when nothing would be lost');

  // Running sessions are named with their folders; a launcher tab and a browser mirror are not sessions.
  await page.evaluate(() => window.setTerminals([
    { id: 'a', tool: 'claude', folderPath: 'C:\\Users\\me\\proj', agentStatus: 'working' },
    { id: 'b', tool: 'codex', folderPath: 'D:\\Test' },
    { id: 'c', tool: 'terminal', folderPath: 'D:\\Test' },
    { id: 'd', tool: 'claude', folderPath: 'D:\\Other', isHidden: true },
    { id: 'e', tool: 'codex', folderPath: 'D:\\Other' },
    { id: 'launcher', tool: null, folderPath: null },
    { id: 'mirror', tool: 'claude', folderPath: 'D:\\Remote', mirror: true },
  ]));
  await reset(); await close(2); await dialog.waitFor();
  assert.equal(await dialog.locator('#app-close-description').textContent(), '5 个会话仍在运行，退出会把它们一起结束。');
  assert.deepEqual(await dialog.locator('.app-close-name').allTextContents(), ['Claude Code · ~\\proj', 'Codex CLI · D:\\Test', '终端 · D:\\Test']);
  assert.equal(await dialog.locator('.is-working .app-close-status').textContent(), '工作中');
  assert.equal(await dialog.locator('.app-close-more').textContent(), '等另外 2 个');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '最小化到托盘', 'the safe choice has focus');
  await close(3);
  assert.equal(await page.getByRole('dialog').count(), 1, 'a second close while asking does not stack dialogs');
  assert.deepEqual((await calls('appCloseAck')).map(call => call[1]), [2, 3]);

  // Cancel leaves everything running.
  await dialog.getByRole('button', { name: '取消', exact: true }).last().click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await calls('appQuit')).length + (await calls('appKeepRunning')).length, 0);

  // A one-off choice is not remembered.
  await close(4); await dialog.waitFor();
  await dialog.getByRole('button', { name: '最小化到托盘', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal((await calls('appKeepRunning')).length, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-close-behavior')), null);

  // A remembered choice applies to later closes without asking.
  await reset(); await close(5); await dialog.waitFor();
  await dialog.getByRole('checkbox', { name: '记住我的选择' }).check();
  await dialog.getByRole('button', { name: '最小化到托盘', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-close-behavior')), 'keep');
  await reset(); await close(6);
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'appKeepRunning'));
  assert.equal(await dialog.count(), 0);
  await page.evaluate(() => localStorage.setItem('cc-close-behavior', 'quit'));
  await reset(); await close(7);
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'appQuit'));
  assert.equal(await dialog.count(), 0, 'quit never asks, even with sessions running');

  // The tray menu lists the visible running tabs in the interface language, once per burst of changes.
  await reset();
  await page.evaluate(() => { window.setTerminals([{ id: 'a', tool: 'claude', folderPath: 'D:\\Test' }]); window.setTerminals([{ id: 'a', tool: 'claude', folderPath: 'D:\\Test' }, { id: 'h', tool: 'codex', folderPath: 'D:\\X', isHidden: true }]); });
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'appTrayMenu'));
  await page.waitForTimeout(400);
  assert.deepEqual(await calls('appTrayMenu'), [['appTrayMenu', { open: '打开 Coffee CLI', quit: '退出', sessions: [{ id: 'a', label: 'Claude Code · D:\\Test' }] }]]);

  // Choosing a tab in the tray menu brings that tab forward.
  await page.evaluate(() => window.emitNative('tray-focus-tab', 'a'));
  assert.deepEqual(await page.evaluate(() => window.dispatched), [{ type: 'SET_ACTIVE_TERMINAL', id: 'a' }]);

  assert.deepEqual(errors, []);
  console.log('OK: quit at once with nothing running, named running sessions, no stacked dialogs, cancel, one-off and remembered choices, tray menu and tray tab focus');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
