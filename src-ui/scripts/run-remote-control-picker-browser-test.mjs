// The composer's remote control chip against a scripted native boundary: hidden for a tab without the
// window tools, "Auto" by default, tying a tab to one window, a stale pick and windows coming and going.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-remote-picker-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{RemoteControlPicker}from'./src/components/center/RemoteControlPicker';
import{useRemoteControlState}from'./src/lib/remote-control-state';
import './src/styles/global.css';import './src/components/center/Gambit.css';
function Chip({session}){const[state,set]=useRemoteControlState(session,true);return state?.attached?<RemoteControlPicker sessionId={session} state={state} onState={set}/>:<span id="hidden">none</span>}
const root=createRoot(document.getElementById('root'));
window.show=session=>root.render(<div className="gambit-capabilities" role="status" style={{position:'absolute',left:20,bottom:20}}><Chip session={session}/></div>);
window.show('tab-a');
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', loader: { '.svg': 'text', '.png': 'dataurl', '.woff2': 'empty' }, external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'], nodePaths: [join(project, 'node_modules')], logLevel: 'silent', plugins: [{ name: 'remote-picker-fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'store' ? `export function useAppLanguage(){return 'zh-CN'}`
    : args.path === 'event' ? `export async function listen(name,handler){window.listeners[name]=handler;return()=>{delete window.listeners[name]}}`
    : `
window.calls=[];window.listeners={};
window.windows=[{window:'eb',title:'EB'},{window:'studio',title:'Studio'}];window.attached={'tab-a':true};window.picks={};
const state=id=>{if(window.picks[id]&&!window.windows.some(w=>w.window===window.picks[id]))delete window.picks[id];return {attached:!!window.attached[id],windows:structuredClone(window.windows),pick:window.picks[id]??null}};
export const commands={
  async windowControlState(id){window.calls.push(['state',id]);return state(id)},
  async windowControlSetPick(id,pick){window.calls.push(['pick',id,pick]);if(pick&&!window.windows.some(w=>w.window===pick))throw 'That window is no longer open';if(pick)window.picks[id]=pick;else delete window.picks[id];return state(id)},
};
` }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/fixture.js' || req.url === '/fixture.css') return res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript').end(await readFile(join(directory, req.url.slice(1))));
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 360 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const chip = page.locator('.gambit-capability.is-remote');
  const option = name => page.getByRole('menuitemradio', { name, exact: true });

  // A tab with the window tools starts on Auto, and its menu lists every open window.
  await chip.waitFor();
  assert.equal(await chip.textContent(), '远程操控：自动');
  await chip.click();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['自动✓', 'EB', 'Studio']);
  await page.screenshot({ path: join(directory, 'remote-picker-menu.png') });

  // Choosing a window ties this tab to it.
  await option('EB').click();
  await page.waitForFunction(() => document.querySelector('.gambit-capability.is-remote')?.textContent === '远程操控：EB');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call[0] === 'pick')), [['pick', 'tab-a', 'eb']]);
  assert.equal(await page.getByRole('menuitemradio').count(), 0, 'the menu closes after a choice');
  await chip.click();
  assert.equal(await option('EB').getAttribute('aria-checked'), 'true');
  await option('自动').click();
  await page.waitForFunction(() => document.querySelector('.gambit-capability.is-remote')?.textContent === '远程操控：自动');

  // The tied window closing drops the pick: the chip reads Auto again once the windows change.
  await chip.click(); await option('Studio').click();
  await page.waitForFunction(() => document.querySelector('.gambit-capability.is-remote')?.textContent === '远程操控：Studio');
  await page.evaluate(() => { window.windows = window.windows.filter(w => w.window !== 'studio'); window.listeners['remote-windows-changed']({ payload: null }); });
  await page.waitForFunction(() => document.querySelector('.gambit-capability.is-remote')?.textContent === '远程操控：自动');

  // A window that closed while the menu was open is refused, and the chip shows what is true.
  await chip.click();
  await page.evaluate(() => { window.windows = []; });
  await option('EB').click();
  await page.waitForFunction(() => document.querySelector('.gambit-capability.is-remote')?.textContent === '远程操控：自动');
  await chip.click();
  await page.getByText('还没有打开远程电脑窗口', { exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('menuitemradio').allTextContents(), ['自动✓']);
  await page.keyboard.press('Escape');

  // Turning the tool off in settings takes the chip away from open tabs.
  await page.evaluate(() => { window.attached['tab-a'] = false; window.listeners['window-control-changed']({ payload: null }); });
  await page.locator('#hidden').waitFor();
  await page.evaluate(() => { window.attached['tab-a'] = true; window.listeners['window-control-changed']({ payload: null }); });
  await chip.waitFor();

  // Another tab keeps its own choice, and a tab started without the window tools shows no chip.
  await page.evaluate(() => { window.windows = [{ window: 'eb', title: 'EB' }]; window.picks['tab-a'] = 'eb'; window.attached['tab-b'] = true; window.show('tab-b'); });
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'state' && call[1] === 'tab-b'));
  await page.waitForFunction(() => document.querySelector('.gambit-capability.is-remote')?.textContent === '远程操控：自动');
  await page.evaluate(() => window.show('tab-a'));
  await page.waitForFunction(() => document.querySelector('.gambit-capability.is-remote')?.textContent === '远程操控：EB');
  await page.evaluate(() => window.show('tab-c'));
  await page.locator('#hidden').waitFor();
  assert.equal(await chip.count(), 0);
  assert.deepEqual(errors, []);
  console.log(`remote control picker browser test passed (screenshot: ${join(directory, 'remote-picker-menu.png')})`);
} finally { await browser.close(); server.close(); }
