// Settings → Voice input against a scripted native boundary; no microphone is opened.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-voice-settings-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{VoiceSettings}from'./src/components/common/VoiceSettings';import{useVoiceEnabled}from'./src/lib/voice-settings';
function Probe(){return <output id="enabled">{String(useVoiceEnabled())}</output>}
createRoot(document.getElementById('root')).render(<div className="settings-body"><VoiceSettings/><Probe/></div>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')], plugins: [{ name: 'voice-settings-fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'store' ? `export function useAppLanguage(){return 'zh-CN'}` : `
window.calls=[];let next=1;
export const isTauri=true;
export const commands={
  async voiceInputDevices(){return {devices:['MacBook Pro Microphone','USB Audio & HID'],default:'MacBook Pro Microphone'}},
  async voiceMicTestStart(device,onLevel){const id=next++;window.calls.push(['start',device,id]);window.level=onLevel;return id},
  async voiceMicTestStop(id){window.calls.push(['stop',id])},
};
`, loader: 'js' }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-mode="dark"><link rel="stylesheet" href="/settings.css"><style>:root{--accent:#c595a5;--bg-hover:#393236;--bg-panel:#292528;--text-1:#e5dce1;--text-2:#bcb2b8;--border:#443a40;--border-input:#443a40}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/settings.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(project, 'src/components/common/SettingsModal.css')));
  if (req.url.startsWith('/sounds/voice-')) { res.setHeader('Content-Type', 'audio/mpeg'); return res.end(await readFile(join(project, 'public', req.url))); }
  if (req.url === '/fixture.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(directory, 'fixture.css')));
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { window.played = []; HTMLMediaElement.prototype.play = function () { window.played.push(new URL(this.src).pathname); return Promise.resolve(); }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  // Master switch: on by default, persisted, and seen live by the composers.
  const master = page.getByRole('switch', { name: '语音输入', exact: true });
  assert.equal(await master.getAttribute('aria-checked'), 'true');
  await master.click();
  assert.equal(await master.getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#enabled').innerText(), 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-enabled')), 'false');
  await master.click();

  // Microphone menu: system default (named) plus every device.
  const picker = page.getByRole('combobox', { name: '麦克风', exact: true });
  await picker.getByText('系统默认（MacBook Pro Microphone）', { exact: true }).waitFor();
  await picker.hover();
  assert.equal(await picker.evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)', 'hovering the menu does not light up its border');
  await picker.click();
  assert.deepEqual(await page.getByRole('option').allInnerTexts(), ['系统默认（MacBook Pro Microphone）', 'MacBook Pro Microphone', 'USB Audio & HID']);
  await page.getByRole('option', { name: 'USB Audio & HID', exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-device')), 'USB Audio & HID');

  // Test: the composer's own mic button, chimes and waveform, without the words.
  const test = page.locator('.settings-sound-row .gambit-voice');
  const roomBefore = await page.locator('.settings-voice-wave-room').boundingBox();
  assert.equal(await page.locator('.settings-voice-wave-room canvas').count(), 0, 'no waveform at rest');
  await page.getByRole('button', { name: '开始测试', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'start'));
  assert.deepEqual(await page.evaluate(() => window.calls[0]), ['start', 'USB Audio & HID', 1]);
  await page.locator('.settings-sound-row .gambit-voice.is-recording').waitFor();
  assert.deepEqual(await page.evaluate(() => window.played), ['/sounds/voice-start.mp3']);
  const wave = page.getByRole('status', { name: '正在聆听', exact: true });
  await wave.waitFor();
  assert.deepEqual(await page.locator('.settings-voice-wave-room').boundingBox(), roomBefore, 'the waveform fills reserved room; nothing in the row moves');
  await page.evaluate(() => window.level(1));
  await page.waitForFunction(() => { const el = document.querySelector('.settings-voice-wave-room canvas'); const d = el.getContext('2d').getImageData(el.width - 10, 0, 10, Math.floor(el.height * 0.3)).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
  // Switching microphone while testing restarts the check on the new one, without another chime.
  await picker.click();
  await page.getByRole('option', { name: '系统默认（MacBook Pro Microphone）', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'start' && c[1] === ''));
  assert.ok(await page.evaluate(() => window.calls.some(c => c[0] === 'stop' && c[1] === 1)), 'the previous microphone is released');
  assert.deepEqual(await page.evaluate(() => window.played), ['/sounds/voice-start.mp3']);
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'stop' && c[1] === 2));
  assert.deepEqual(await page.evaluate(() => window.played), ['/sounds/voice-start.mp3', '/sounds/voice-stop.mp3']);
  assert.equal(await page.locator('.settings-voice-wave-room canvas').count(), 0, 'the waveform goes away on stop');
  assert.equal(await test.getAttribute('aria-pressed'), 'false');

  // A saved microphone that is unplugged stays visible instead of silently switching.
  await page.evaluate(() => localStorage.setItem('cc-voice-device', 'Old Headset'));
  await page.reload();
  await page.getByRole('combobox', { name: '麦克风', exact: true }).getByText('Old Headset（未连接）', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('voice settings browser test passed');
} finally {
  await browser.close();
  server.close();
}
