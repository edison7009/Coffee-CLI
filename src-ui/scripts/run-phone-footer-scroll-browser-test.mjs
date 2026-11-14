// Phones: the composer footer scrolls sideways under a finger in Chromium (Android) too. An end-aligned row
// overflows to the left, where Chromium cannot scroll, so the swipe did nothing there while iOS still scrolled.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const css = await readFile(join(project, 'src/components/center/Gambit.css'), 'utf8');
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 412, height: 800 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const page = await context.newPage();
  const footer = count => `<!doctype html><html data-width="xs"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} body{margin:0} button{width:96px;height:26px}</style>
    <div style="position:fixed;left:0;right:0;bottom:0"><div class="gambit-footer"><span class="gambit-workspace">project-folder</span>
    ${Array.from({ length: count }, (_, i) => `<button type="button">Control ${i}</button>`).join('')}<button type="button" class="gambit-send" style="width:32px">↑</button></div></div></html>`;
  const state = () => page.evaluate(() => {
    const row = document.querySelector('.gambit-footer'), send = document.querySelector('.gambit-send').getBoundingClientRect();
    return { scrollLeft: row.scrollLeft, overflow: row.scrollWidth - row.clientWidth, sendRight: Math.round(send.right), width: row.clientWidth };
  });

  // A crowded row overflows to the right and a finger swipe scrolls it.
  await page.setContent(footer(8));
  const before = await state();
  assert.ok(before.overflow > 0, `row should overflow to the right, got ${JSON.stringify(before)}`);
  const box = await page.locator('.gambit-footer').boundingBox(), y = box.y + box.height / 2;
  const touch = await context.newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 320, y }] });
  for (const x of [280, 220, 160, 100]) { await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); await page.waitForTimeout(16); }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('.gambit-footer').scrollLeft > 0);
  // Send stays pinned to the right edge while the row scrolls.
  assert.ok(Math.abs((await state()).sendRight - before.width) <= 12, 'send stays on the right while scrolled');

  // A short row still keeps send on the right.
  await page.setContent(footer(1));
  const short = await state();
  assert.equal(short.overflow, 0);
  assert.ok(short.width - short.sendRight <= 12, `send should sit on the right, got ${JSON.stringify(short)}`);
  console.log('phone footer scroll browser test passed');
} finally { await browser.close(); }
