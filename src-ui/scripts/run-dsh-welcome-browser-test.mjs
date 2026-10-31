import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-dsh-welcome-'));
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{DshWelcomeIcon}from'./src/components/center/DshWelcomeIcon';import'./src/styles/global.css';import'./src/components/center/DshConversation.css';
// Called directly so each icon's lazy initial pick sees its own Math.random.
function One({pick}){Math.random=()=>pick;return DshWelcomeIcon({isActive:!location.search.includes('hidden')})}
function App(){return <div style={{display:'flex',gap:16,padding:16}}>{[0,.2,.4,.6,.8].map(pick=><One key={pick} pick={pick}/>)}</div>}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.gif': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.svg': 'dataurl' }, external: ['/fonts/*', '/monogram.svg'] });
const server = http.createServer(async (req, res) => {
  const name = req.url.split('?')[0].slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css').end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="background:var(--bg-terminal)"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  const page = await browser.newPage({ viewport: { width: 800, height: 220 } });
  await page.goto(url);
  const icons = page.locator('[data-welcome-icon]');
  await icons.nth(4).waitFor();
  assert.deepEqual(await icons.evaluateAll(list => list.map(icon => icon.dataset.welcomeIcon)), ['idle', 'happy', 'cheer', 'thinking', 'talking']);
  await page.waitForFunction(() => [...document.querySelectorAll('.dsh-welcome-icon img')].every(image => image.complete && image.naturalWidth === 512));
  await page.screenshot({ path: join(directory, 'dsh-welcome.png') });
  const hidden = await browser.newPage();
  await hidden.goto(`${url}?hidden`);
  await hidden.locator('.dsh-welcome-still').nth(4).waitFor();
  assert.equal(await hidden.locator('.dsh-welcome-icon img').count(), 0, 'an inactive tab decodes no GIF');
  const reduced = await browser.newPage({ reducedMotion: 'reduce' });
  await reduced.goto(url);
  await reduced.locator('.dsh-welcome-still').nth(4).waitFor();
  assert.equal(await reduced.locator('.dsh-welcome-icon img').count(), 0, 'reduced motion shows the still mark');
  console.log('OK: five DeepSeek Harness welcome animations, inactive tabs and reduced motion');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
