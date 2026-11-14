// Narrow windows and phones: the tab menu lists every tab, switches on a tap, closes a tab without
// switching to it, and gets out of the way on Escape or a tap elsewhere.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-compact-tabs-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { CompactTabMenu } from './src/components/center/CompactTabMenu';
window.picks = []; window.closes = [];
function App() {
  const [tabs, setTabs] = useState([
    { id: 'a', title: 'build a flash card website', status: 'working' },
    { id: 'b', title: 'snake game', status: 'waiting' },
    { id: 'c', title: '终端', status: undefined },
  ]);
  const [active, setActive] = useState('a');
  return <div style={{ padding: 12, display: 'flex', gap: 8 }}>
    <span id="active">{active}</span>
    <CompactTabMenu tabs={tabs.map(tab => ({ ...tab, icon: <i>◆</i>, active: tab.id === active }))}
      onPick={id => { window.picks.push(id); setActive(id); }}
      onClose={(_event, id) => { window.closes.push(id); setTabs(list => list.filter(tab => tab.id !== id)); }} />
  </div>;
}
createRoot(document.getElementById('root')).render(<App />);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')], plugins: [{ name: 'fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export function useAppLanguage(){return 'zh-CN'}` }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-width="xs"><link rel="stylesheet" href="/center.css"><style>body{margin:0;font-family:Arial,sans-serif;background:#292528;color:#e5dce1} :root{--type-body:14px;--type-label:12px;--text-1:#e5dce1;--text-2:#bcb2b8;--text-3:#aaa;--bg-app:#292528;--bg-hover:#393236;--bg-active:#443a40;--border:#443a40;--radius-sm:10px}</style><div id="root"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/center.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(project, 'src/components/center/CenterPanel.css')));
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const button = page.getByRole('button', { name: '全部标签（3）', exact: true });
  await button.waitFor();
  assert.equal(await button.innerText(), '3');

  // Opens with every tab, the current one marked, each with its status.
  await button.click();
  const items = page.getByRole('menuitem');
  assert.deepEqual(await page.locator('.compact-tabs-title').allInnerTexts(), ['build a flash card website', 'snake game', '终端']);
  assert.equal(await page.locator('.compact-tabs-item.is-active .compact-tabs-title').innerText(), 'build a flash card website');
  assert.equal(await page.locator('.compact-tabs-status.status-working').count(), 1);
  assert.equal(await page.locator('.compact-tabs-status.status-waiting').count(), 1);
  // A phone row is big enough for a finger, and the list fits the screen.
  await page.waitForFunction(() => document.querySelector('.compact-tabs-menu').getAnimations().every(animation => animation.playState === 'finished'));
  const row = await items.first().evaluate(element => element.offsetHeight), menu = await page.locator('.compact-tabs-menu').boundingBox();
  assert.ok(row >= 44, `row height ${row}`);
  assert.ok(menu.x >= 8 && menu.x + menu.width <= 390 - 8 + 1, `menu ${menu.x}+${menu.width}`);
  await page.screenshot({ path: join(directory, 'compact-tabs.png') });

  // A tap switches and closes the list.
  await items.nth(1).click();
  await page.locator('.compact-tabs-menu').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#active').innerText(), 'b');

  // Closing a tab from the list does not switch to it, and the list stays open.
  await button.click();
  await page.locator('.compact-tabs-item').nth(2).locator('.compact-tabs-close').click();
  assert.deepEqual(await page.evaluate(() => [window.picks, window.closes]), [['b'], ['c']]);
  assert.equal(await page.locator('#active').innerText(), 'b');
  assert.equal(await page.getByRole('menuitem').count(), 2);

  // Escape and a tap elsewhere close it.
  await page.keyboard.press('Escape');
  await page.locator('.compact-tabs-menu').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '全部标签（2）', exact: true }).click();
  await page.mouse.click(200, 650);
  await page.locator('.compact-tabs-menu').waitFor({ state: 'detached' });

  assert.deepEqual(errors, []);
  console.log(`compact tabs browser test passed (screenshot: ${join(directory, 'compact-tabs.png')})`);
} finally { await browser.close(); server.close(); }
