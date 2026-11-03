import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-new-session-tab-'));

// The real tab strip renders the button after every tab, including the diff tab.
const center = await readFile(new URL('../src/components/center/CenterPanel.tsx', import.meta.url), 'utf8');
const strip = center.slice(center.indexOf('className="chrome-tabs-header"'), center.indexOf('tabSlot)}'));
assert.ok(strip.includes('<NewSessionTabButton />') && strip.indexOf('<NewSessionTabButton />') > strip.lastIndexOf('diffTabVisible &&'), 'the + closes the tab strip, after every tab');

await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React from'react';import{createRoot}from'react-dom/client';import{NewSessionTabButton}from'./src/components/center/NewSessionTabButton';import'./src/styles/global.css';import'./src/components/center/CenterPanel.css';
window.opened=0;window.addEventListener('coffee-new-session',()=>window.opened++);
createRoot(document.getElementById('root')).render(<div className="chrome-tabs-header" style={{width:600}}><div className="chrome-tab active"><span className="tab-title">Downloads</span></div><div className="chrome-tab"><span className="tab-title">coffee-cli</span></div><NewSessionTabButton/></div>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, external: ['/fonts/*', '/monogram.svg'],
  plugins: [{ name: 'language', setup(b) {
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'language', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export function useAppLanguage(){return 'zh-CN'}` }));
  } }] });
const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', `${name.endsWith('.js') ? 'text/javascript' : 'text/css'}; charset=utf-8`).end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:var(--bg-app)"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 200 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const add = page.getByRole('button', { name: '新建会话', exact: true });
  await add.waitFor();
  assert.equal(await add.getAttribute('title'), null, 'no native browser tooltip');
  const [box, last, header] = await Promise.all([add.boundingBox(), page.locator('.chrome-tab').last().boundingBox(), page.locator('.chrome-tabs-header').boundingBox()]);
  assert.ok(box.x >= last.x + last.width && box.x - (last.x + last.width) <= 6, `the + sits right after the last tab: ${JSON.stringify({ box, last })}`);
  assert.ok(box.width === 26 && box.height === 26 && Math.abs(box.y + box.height / 2 - (header.y + header.height / 2)) < 1, 'a 26px square, centered in the strip');
  await add.click();
  assert.equal(await page.evaluate(() => window.opened), 1, 'it opens a new session like the sidebar button');
  await page.screenshot({ path: join(directory, 'tab-strip.png') });
  console.log('OK: the tab strip ends with a + that opens a new session, right after the last tab');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
