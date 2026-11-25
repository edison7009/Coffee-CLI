import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-scrollbar-'));
await build({ stdin: { loader: 'ts', resolveDir: project, contents: `
import { bindAutoHideScrollbar } from './src/lib/auto-hide-scrollbar';
import './src/styles/global.css';
const list = document.getElementById('list');
window.setContent = height => { list.firstElementChild.style.height = height + 'px'; list.dispatchEvent(new Event('scroll')); };
bindAutoHideScrollbar(list);
` }, bundle: true, outfile: join(directory, 'fixture.js'), loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'] });
const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', `${name.endsWith('.js') ? 'text/javascript' : 'text/css'}; charset=utf-8`).end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0"><div id="list" style="position:absolute;top:0;left:0;width:300px;height:600px;overflow:auto"><div style="height:660px"></div></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const list = page.locator('#list'), rail = page.locator('.cc-scrollbar'), slider = page.locator('.cc-scrollbar-slider');
  const measure = async () => {
    await list.hover(); await page.waitForTimeout(100);
    const [track, thumb] = await Promise.all([rail.boundingBox(), slider.boundingBox()]);
    return { track: track.height, thumb: thumb.height, thumbBottom: thumb.y + thumb.height - track.y };
  };

  // A list just 10% taller than its panel: proportionally 91% of the track, capped at half.
  const slight = await measure();
  assert.ok(slight.thumb <= slight.track / 2 + 1 && slight.thumb >= slight.track / 2 - 2, `a barely overflowing list keeps the thumb at half the track: ${JSON.stringify(slight)}`);

  // A long list keeps the quarter-track minimum so the thumb stays easy to grab.
  await page.evaluate(() => window.setContent(60000));
  const long = await measure();
  assert.ok(Math.abs(long.thumb - Math.max(64, long.track / 4)) < 2, `a long list keeps the minimum thumb: ${JSON.stringify(long)}`);

  // At the end of the list the capped thumb reaches the end of its track.
  await page.evaluate(() => window.setContent(660));
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const end = await measure();
  assert.ok(Math.abs(end.thumbBottom - end.track) <= 3, `the thumb reaches the end of the track: ${JSON.stringify(end)}`);
  // A short panel keeps the grabbable 64px minimum even where half the track is less.
  await list.evaluate(el => { el.style.height = '110px'; el.scrollTop = 0; });
  await page.evaluate(() => window.setContent(120));
  const short = await measure();
  assert.ok(short.thumb >= 63, `a short track keeps the minimum thumb: ${JSON.stringify(short)}`);
  console.log('OK: the scrollbar thumb never exceeds half its track, keeps its minimum on long lists and short tracks, and still reaches the end');
} finally { await browser.close(); server.close(); }
