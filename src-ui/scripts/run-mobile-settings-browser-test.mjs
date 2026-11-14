// Settings → Devices against a scripted native boundary: enabling, the pairing card, a device pairing, and removal.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-mobile-settings-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{MobileSettings}from'./src/components/common/MobileSettings';
const root=createRoot(document.getElementById('root'));
window.mount=()=>root.render(<div className="settings-modal settings-modal--page"><section className="settings-content"><div className="settings-body"><MobileSettings/></div></section></div>);
window.unmount=()=>root.render(null);
window.mount();
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')], plugins: [{ name: 'mobile-settings-fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/plugin-clipboard-manager$/ }, () => ({ path: 'clipboard', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'store' ? `export function useAppLanguage(){return 'zh-CN'}`
    : args.path === 'clipboard' ? `export async function writeText(text){window.copied=text}export async function readText(){return window.copied??''}`
    : args.path === 'event' ? `export async function listen(name,handler){window.listeners[name]=handler;return()=>{delete window.listeners[name]}}`
    : `
window.calls=[];window.listeners={};
window.mobile={enabled:false,port:47391,publicKey:'ab'.repeat(32),devices:[],connected:[],host:'192.168.1.8',hosts:['192.168.1.8','10.0.0.2'],clients:0,protocol:0};
window.firewall='blocked';
const copy=()=>JSON.parse(JSON.stringify(window.mobile));
export const isTauri=true;
export const commands={
  async mobileRpcStatus(){return copy()},
  async mobileRpcSetEnabled(enabled){window.calls.push(['enable',enabled]);window.mobile.enabled=enabled;return copy()},
  async mobileRpcBeginPairing(){window.calls.push(['pair']);if(!window.mobile.enabled)throw Error('Enable mobile access first');return {uri:'coffeecli://pair?v=0&host=192.168.1.8&port=47391&pk='+window.mobile.publicKey+'&code=c0ffee',host:'192.168.1.8',port:47391,publicKey:window.mobile.publicKey,code:'c0ffee',remoteHost:window.pairRemote??null,expiresAt:Date.now()+300000}},
  async mobileRpcCancelPairing(){window.calls.push(['cancel'])},
  async mobileRpcFirewallStatus(){return {state:window.firewall}},
  async mobileRpcFirewallAllow(){window.calls.push(['firewall']);window.firewall='open';return {state:'open'}},
  async mobileRpcRevokeDevice(key){window.calls.push(['revoke',key]);window.mobile.devices=window.mobile.devices.filter(d=>d.publicKey!==key);window.mobile.connected=window.mobile.connected.filter(k=>k!==key);return copy()},
};
` }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-mode="dark"><link rel="stylesheet" href="/settings.css"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#292528} .settings-body{padding:24px;max-width:760px} :root{--type-body:14px;--type-label:12px;--text-3:#aaa;--accent:#c595a5;--bg-hover:#393236;--bg-panel:#292528;--text-1:#e5dce1;--text-2:#bcb2b8;--border:#443a40;--border-input:#443a40}</style><div id="root"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/settings.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(project, 'src/components/common/SettingsModal.css')));
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 760 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  // Off by default: nothing can be paired until phones are allowed.
  const master = page.getByRole('switch', { name: '允许其他设备连接', exact: true });
  await page.waitForFunction(() => document.querySelector('[role=switch]')?.disabled === false, null, { timeout: 5000 }).catch(e => { throw new Error(errors.join('\n') || e.message); });
  assert.equal(await master.getAttribute('aria-checked'), 'false');
  const pair = page.getByRole('button', { name: '配对', exact: true });
  assert.equal(await pair.isDisabled(), true);
  await page.getByText('请先打开“允许其他设备连接”。').waitFor();
  await page.getByText('还没有配对的设备。').waitFor();

  await master.click();
  await page.waitForFunction(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true');
  await page.getByText('用另一台设备的相机扫码，或在浏览器打开链接。').waitFor();

  // Firewall: blocked shows a fix; allowing clears it.
  await page.getByText('Windows 防火墙拦截了手机连接').waitFor();
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await page.getByText('Windows 防火墙拦截了手机连接').waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['firewall']);
  await page.evaluate(() => { window.calls.length = 0; window.calls.push(['enable', true]); });

  // One card: the QR code, the address once (it copies the link), and the countdown.
  await pair.click();
  const qr = page.getByRole('img', { name: '访问二维码' });
  await qr.waitFor();
  assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/);
  await page.getByText('扫码配对新设备', { exact: true }).waitFor();
  assert.equal(await page.getByText('192.168.1.8').count(), 1, 'the address shows once');
  await page.getByRole('button', { name: 'http://192.168.1.8:47391', exact: true }).waitFor();
  // Copy: the button turns into "copied" without changing width, and the link carries the pairing code.
  const copy = page.locator('.settings-mobile-copy').first();
  const copyBefore = await copy.boundingBox();
  await copy.click();
  await page.waitForFunction(() => document.querySelector('.settings-mobile-copy')?.classList.contains('is-done'));
  const after = await copy.boundingBox();
  assert.equal(Math.round(after.width), Math.round(copyBefore.width), "the copy button keeps its width");
  await page.waitForFunction(() => { const [idle, done] = document.querySelector('.settings-mobile-copy').children; return getComputedStyle(idle).opacity === '0' && getComputedStyle(done).opacity === '1'; });
  await page.screenshot({ path: join(directory, 'mobile-copied.png') });
  assert.match(await page.evaluate(() => window.copied), /^http:\/\/192\.168\.1\.8:47391\/\?remote#pair=coffeecli/);
  await page.getByText(/^(5:00|4:59) 后失效$/).waitFor();
  await page.getByText('新设备连接需重新请求，不能沿用老设备的地址', { exact: true }).waitFor();
  assert.equal(await page.getByRole('combobox').count(), 0, 'nobody has to pick a network');
  await page.getByText(/^小技巧：想在外面也能用/).waitFor();
  assert.equal(await page.getByText('在外面用', { exact: true }).count(), 0, 'no virtual LAN, no second address');
  await page.screenshot({ path: join(directory, 'mobile-pairing.png') });

  await page.getByRole('button', { name: '取消', exact: true }).click();
  await qr.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.calls.map(c => c[0])), ['enable', 'pair', 'cancel']);

  // With a virtual LAN (Tailscale, ZeroTier…) the card adds the away-from-home address and the tip goes.
  await page.evaluate(() => { window.mobile.remoteHost = '100.88.2.4'; window.listeners['mobile-rpc-devices']({ payload: JSON.parse(JSON.stringify(window.mobile)) }); window.pairRemote = '100.88.2.4'; });
  await page.getByText(/^小技巧：/).waitFor({ state: 'detached' });
  await pair.click();
  await page.getByText('在外面用', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'http://100.88.2.4:47391', exact: true }).waitFor();
  await page.screenshot({ path: join(directory, 'mobile-pairing-remote.png') });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await qr.waitFor({ state: 'detached' });
  await page.evaluate(() => { delete window.mobile.remoteHost; window.pairRemote = null; window.calls.length = 0; window.calls.push(['enable', true]); });

  // A phone pairing closes the QR code and appears, connected.
  await pair.click();
  await qr.waitFor();
  const phone = 'cd'.repeat(32);
  await page.evaluate(key => {
    window.mobile.devices = [{ publicKey: key, name: '我的 iPhone', pairedAt: Date.UTC(2026, 10, 12) }];
    window.mobile.connected = [key];
    window.listeners['mobile-rpc-devices']({ payload: JSON.parse(JSON.stringify(window.mobile)) });
  }, phone);
  await qr.waitFor({ state: 'detached' });
  await page.getByText('我的 iPhone').waitFor();
  await page.getByText('已连接', { exact: true }).waitFor();
  assert.equal(await page.locator('.settings-mobile-dot.is-connected').count(), 1);
  await page.screenshot({ path: join(directory, 'mobile-settings.png') });

  await page.getByRole('button', { name: '移除', exact: true }).click();
  await page.getByText('还没有配对的设备。').waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), ['revoke', phone]);

  // Turning phones off clears an open QR code.
  await pair.click();
  await qr.waitFor();
  await master.click();
  await qr.waitFor({ state: 'detached' });
  assert.equal(await pair.isDisabled(), true);

  // Without a network the address is missing and pairing explains why.
  await master.click();
  await page.evaluate(() => { window.mobile.host = null; window.listeners['mobile-rpc-devices']({ payload: JSON.parse(JSON.stringify(window.mobile)) }); });
  await page.getByText('没有检测到网络连接，请连上 Wi-Fi 或网线后再配对。').waitFor();
  assert.equal(await pair.isDisabled(), true);

  // Leaving the page withdraws any pairing code.
  const before = await page.evaluate(() => window.calls.length);
  await page.evaluate(() => window.unmount());
  assert.deepEqual(await page.evaluate(n => window.calls.slice(n), before), [['cancel']]);

  assert.deepEqual(errors, []);
  console.log(`mobile settings browser test passed (screenshot: ${join(directory, 'mobile-settings.png')})`);
} finally { await browser.close(); server.close(); }
