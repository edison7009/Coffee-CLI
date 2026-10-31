// OpenCode welcome wordmark: still by default, charges while held, bursts on release and settles back.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-opencode-logo-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {OpenCodeWelcomeLogo} from './src/components/center/OpenCodeWelcomeLogo';
    function Fixture(){const [active,setActive]=useState(true);window.setActive=setActive;return <OpenCodeWelcomeLogo isActive={active}/>};
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"development"' },
});
const html = `<!doctype html><link rel="stylesheet" href="/fixture.css"><style>
body{margin:0;padding:40px;background:#211d19}:root{--bg-terminal:#211d19;--text-1:#ded8cf;--text-3:#9d948b;--accent:#b4937c}
</style><body><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  const name = req.url.slice(1);
  if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 400, height: 160 }, deviceScaleFactor: 2 });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const shot = name => process.env.COFFEE_OPENCODE_SCREENSHOT && page.locator('canvas').screenshot({ path: process.env.COFFEE_OPENCODE_SCREENSHOT.replace('.png', `-logo-${name}.png`) });
const pixels = () => page.locator('canvas').evaluate(canvas => canvas.toDataURL());
const frames = () => page.evaluate(() => window.frames.count);
try {
  await page.addInitScript(() => {
    window.frames = { count: 0 };
    const request = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => request(time => { window.frames.count++; callback(time); });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const canvas = page.locator('canvas');
  await canvas.waitFor();
  assert.deepEqual(await canvas.evaluate(c => [c.style.width, c.style.height]), ['273px', '56px'], '39 x 4 terminal cells');
  const still = await pixels();
  await shot('still');
  await page.waitForTimeout(300);
  assert.equal(await frames(), 0, 'the still mark never schedules frames');
  const box = await canvas.boundingBox();
  // A blank cell (top row, left half) does nothing.
  await page.mouse.click(box.x + 3, box.y + 3);
  await page.waitForTimeout(100);
  assert.equal(await frames(), 0, 'clicks outside the letters are ignored');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('canvas')).cursor), 'auto');
  // Hold the "p" of "open" (column 6, row 2), then release.
  const p = { x: box.x + 6.5 * 7, y: box.y + 2.5 * 14 };
  await page.mouse.move(p.x, p.y);
  assert.equal(await canvas.evaluate(c => c.style.cursor), 'pointer');
  await page.mouse.down();
  await page.waitForTimeout(900);
  const charged = await pixels();
  assert.notEqual(charged, still, 'holding charges the pressed letter');
  await shot('charging');
  await page.mouse.up();
  await page.waitForTimeout(160);
  assert.notEqual(await pixels(), charged, 'release sends the burst');
  await shot('burst');
  await page.waitForTimeout(2200);
  const settled = await frames();
  await page.waitForTimeout(200);
  assert.equal(await frames(), settled, 'the loop stops once the burst has faded');
  assert.equal(await pixels(), still, 'the mark settles back to its still image');
  // A long hold bursts by itself after the full charge.
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.waitForTimeout(3300);
  assert.equal(await page.evaluate(() => 1), 1);
  await page.mouse.up();
  // Hiding the tab stops the animation at once.
  await page.mouse.down(); await page.waitForTimeout(200);
  await page.evaluate(() => window.setActive(false));
  await page.waitForTimeout(50);
  const hidden = await frames(); await page.waitForTimeout(200);
  assert.equal(await frames(), hidden, 'hidden marks do not animate');
  assert.equal(await pixels(), still);
  await page.mouse.up();
  // Reduced motion keeps the mark still.
  await page.evaluate(() => window.setActive(true));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const before = await frames();
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.waitForTimeout(200); await page.mouse.up();
  assert.equal(await frames(), before, 'reduced motion never animates');
  assert.deepEqual(errors, []);
  console.log('ok OpenCode wordmark: still, charge, burst, settle, hidden and reduced motion');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  for (const name of ['fixture.js', 'fixture.css']) await unlink(join(directory, name)).catch(() => {});
  await rmdir(directory);
}
