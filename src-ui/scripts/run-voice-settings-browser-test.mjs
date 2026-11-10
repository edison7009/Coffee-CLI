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
import{initializeVoiceSources}from'./src/lib/voice-source-discovery';window.initializeVoiceSources=initializeVoiceSources;
function Probe(){return <output id="enabled">{String(useVoiceEnabled())}</output>}
createRoot(document.getElementById('root')).render(<div className="settings-modal settings-modal--page"><section className="settings-content"><div className="settings-body"><VoiceSettings/><Probe/></div></section></div>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')], plugins: [{ name: 'voice-settings-fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'store' ? `export function useAppLanguage(){return 'zh-CN'}` : `
window.calls=[];window.scanCalls=0;window.sources=[{id:'claude',name:'Claude Code',accountId:'claude-account'},{id:'codex',name:'Codex / ChatGPT',accountId:'codex-account-with-a-long-identifier-0123456789'},{id:'doubao',name:'Doubao',accountId:'doubao-123'},{id:'doubaowork',name:'Doubao Work',accountId:'work-456'}];let next=1;
export const isTauri=true;
export const commands={
  async voiceInputSelectSource(source){window.imported=source;if(window.deferImport)await new Promise(resolve=>window.resolveImport=resolve);if(window.importFailure)throw Error("import")},
  async voiceInputSources(){window.scanCalls++;if(window.scanFailure)throw Error('scan');if(window.deferScan)await new Promise(resolve=>window.resolveScan=resolve);return window.sources},
  async voiceInputProbeSource(source){return window.probeResults?.[source]??null},
  async voiceInputDevices(){return {devices:['MacBook Pro Microphone','USB Audio & HID'],default:'MacBook Pro Microphone'}},
  async voiceMicTestStart(device,onLevel){const id=next++;window.calls.push(['start',device,id]);window.level=onLevel;if(window.deferMic)await new Promise(resolve=>window.resolveMic=resolve);return id},
  async voiceMicTestStop(id){window.calls.push(['stop',id])},
};
`, loader: 'js' }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-mode="dark"><link rel="stylesheet" href="/settings.css"><style>*{box-sizing:border-box}#enabled{display:none}body{margin:0;font-family:Arial,sans-serif;background:#292528} :root{--type-body:14px;--type-label:12px;--text-3:#aaa;--accent:#c595a5;--bg-hover:#393236;--bg-panel:#292528;--text-1:#e5dce1;--text-2:#bcb2b8;--border:#443a40;--border-input:#443a40}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`);
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
  assert.equal(await page.getByRole('combobox', {name:'麦克风',exact:true}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name:'开始测试',exact:true}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name:'扫描语音渠道',exact:true}).isDisabled(), true);
  assert.equal(await page.locator('.settings-voice-source-card').first().isDisabled(), true);
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

  // Disabling voice stops an active microphone check and re-enabling requires a new click.
  await page.getByRole('button', {name:'开始测试',exact:true}).click();
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'start' && call[2] === 3));
  await master.click();
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'stop' && call[1] === 3));
  assert.equal(await page.locator('.settings-voice-wave-room canvas').count(), 0);
  await master.click();
  assert.equal(await test.getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => window.calls.filter(call => call[0] === 'start').length), 3);
  await page.evaluate(() => { window.deferMic = true; });
  await page.getByRole('button', {name:'开始测试',exact:true}).click();
  await page.waitForFunction(() => typeof window.resolveMic === 'function');
  await master.click();
  await page.evaluate(() => { window.deferMic = false; window.resolveMic(); });
  await page.waitForFunction(() => window.calls.some(call => call[0] === 'stop' && call[1] === 4));
  await master.click();
  assert.equal(await test.getAttribute('aria-pressed'), 'false', 'a late microphone start is stopped after disabling');

  // A saved microphone that is unplugged stays visible instead of silently switching.
  await page.evaluate(() => localStorage.setItem('cc-voice-device', 'Old Headset'));
  await page.reload();
  await page.getByRole('combobox', { name: '麦克风', exact: true }).getByText('Old Headset（未连接）', { exact: true }).waitFor();
  // Cards show channel + account ID, and scan metadata survives reopening Settings.
  const channels = page.getByRole('group', {name:'语音渠道',exact:true});
  const card = name => channels.getByRole('button').filter({has:page.getByText(name,{exact:true})});
  const scan = page.getByRole('button', {name:'扫描语音渠道',exact:true});
  assert.equal(await page.getByRole('combobox', {name:'语音渠道',exact:true}).count(), 0);
  assert.equal(await card('自动匹配').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.scanCalls), 0);
  await page.evaluate(() => window.deferScan = true);
  const scanBounds = await scan.boundingBox();
  await scan.click();
  assert.equal(await page.getByRole('button', {name:'正在扫描…',exact:true}).isDisabled(), true);
  assert.deepEqual(await page.locator('.settings-voice-scan').boundingBox(), scanBounds, 'scanning keeps the button size and position');
  await page.screenshot({path:join(directory,'voice-source-scanning.png')});
  await page.evaluate(() => window.resolveScan());
  await card('Doubao').waitFor();
  assert.equal(await channels.getByRole('button').count(), 5);
  await card('Doubao').getByText('账号 ID：doubao-123',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('cc-voice-sources')).length), 4);
  await page.reload();
  await card('Doubao').getByText('账号 ID：doubao-123',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.scanCalls), 0, 'reopening shows the cache without scanning');
  await card('Doubao').click();
  await page.waitForFunction(() => localStorage.getItem('cc-voice-source') === 'doubao');
  assert.equal(await page.evaluate(() => window.imported), 'doubao');
  assert.equal(await card('Doubao').getAttribute('aria-pressed'), 'true');
  const savedSources = await page.evaluate(() => localStorage.getItem('cc-voice-sources'));
  await master.click();
  assert.equal(await scan.isDisabled(), true);
  assert.equal(await card('Doubao').isDisabled(), true);
  assert.equal(await card('Doubao').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('.settings-voice-channels').evaluate(element => Number(getComputedStyle(element).opacity) < 1), 'all channel content is dimmed');
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-sources')), savedSources);
  await page.screenshot({path:join(directory,'voice-disabled.png')});
  await master.click();
  assert.equal(await card('Doubao').isDisabled(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')), 'doubao');
  await page.evaluate(() => { window.deferImport = true; });
  await card('Doubao Work').click();
  await page.waitForFunction(() => typeof window.resolveImport === 'function');
  await master.click();
  await page.evaluate(() => { window.deferImport = false; window.resolveImport(); });
  await page.waitForFunction(() => document.querySelector('.settings-voice-scan').getAttribute('aria-busy') === 'false');
  await master.click();
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')), 'doubao', 'disabling cancels a pending account selection');
  const selectedShapeStyle = await page.evaluate(() => {
    const reference = document.createElement('button');
    reference.className = 'settings-chip active';
    document.body.append(reference);
    const style = getComputedStyle(reference);
    const result = { border: style.borderTopColor, background: style.backgroundColor };
    reference.remove();
    return result;
  });
  const cardStyle = element => ({border:getComputedStyle(element).borderTopColor,background:getComputedStyle(element).backgroundColor});
  assert.deepEqual(await card('Doubao').evaluate(cardStyle), selectedShapeStyle, 'selected channels use the theme shape fill without an accent border');
  await card('Doubao').hover();
  assert.deepEqual(await card('Doubao').evaluate(cardStyle), selectedShapeStyle, 'hovering the selected channel preserves its selection fill');
  await page.screenshot({path:join(directory,'voice-source-cards.png')});
  const content = await page.locator('.settings-content').boundingBox();
  const body = await page.locator('.settings-body').boundingBox();
  assert.equal(body.x+body.width/2,content.x+content.width/2,'voice settings use the same centered content area as other settings');
  const upperGroup = await page.locator('.settings-sound-list').boundingBox();
  const channelGrid = await channels.boundingBox();
  const firstCard = await card('自动匹配').boundingBox();
  const lastColumn = await card('Codex / ChatGPT').boundingBox();
  assert.equal(firstCard.x, upperGroup.x, 'channel cards align with the upper settings block left edge');
  assert.equal(lastColumn.x + lastColumn.width, upperGroup.x + upperGroup.width, 'channel cards align with the upper settings block right edge');
  assert.equal(channelGrid.width, upperGroup.width);
  assert.equal(await page.locator('.settings-voice-channels > .settings-sound-row').evaluate(el => getComputedStyle(el).paddingInline), '0px', 'the channel heading and scan button have no side inset');
  await page.setViewportSize({width:420,height:800});
  assert.ok(await channels.evaluate(el=>el.scrollWidth<=el.clientWidth),'long account IDs do not overflow a narrow card grid');
  await page.screenshot({path:join(directory,'voice-source-cards-narrow.png')});
  await page.setViewportSize({width:1280,height:720});

  // A failed import keeps the previous card selected.
  await page.evaluate(() => window.importFailure = true);
  await card('Doubao Work').focus();
  await card('Doubao Work').press('Enter');
  await page.getByRole('alert').filter({hasText:'扫描本机账号失败'}).waitFor();
  assert.equal(await card('Doubao').getAttribute('aria-pressed'),'true');
  await page.evaluate(() => { window.importFailure=false;window.scanFailure=true; });
  const cached=await page.evaluate(() => localStorage.getItem('cc-voice-sources'));
  await scan.click();
  await page.getByRole('alert').filter({hasText:'扫描本机账号失败'}).waitFor();
  assert.equal(await channels.getByRole('button').count(),5,'failed refresh retains cached cards');
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-sources')),cached);

  // Busy channels cannot be selected; a fresh empty scan replaces stale results.
  await page.evaluate(() => { window.scanFailure=false;window.sources=[{id:'doubao',name:'Doubao',issue:'busy'}]; });
  await scan.click();
  await page.getByRole('status').filter({hasText:'首次扫描导入前请退出客户端'}).waitFor();
  assert.equal(await card('Doubao').isDisabled(),true);
  await card('自动匹配').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')),'');
  await page.evaluate(() => { localStorage.setItem('cc-voice-source','doubao');window.dispatchEvent(new StorageEvent('storage',{key:'cc-voice-source'}));window.sources=[]; });
  await scan.click();
  await card('Doubao').getByText('已退出或不可用',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-sources')),'[]');
  await page.reload();
  await card('Doubao').getByText('已退出或不可用',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => window.scanCalls),0);
  await page.evaluate(() => localStorage.setItem('cc-voice-sources','{invalid'));
  await page.reload();
  await card('Doubao').getByText('已保存的选择',{exact:true}).waitFor();

  // Apple Speech is selectable without a third-party sign-in or credential import.
  await page.evaluate(() => { window.sources=[{id:'macos',name:'macOS'}];window.importFailure=true; });
  await scan.click();
  await card('macOS 系统语音').getByText('无需账号，首次使用需授权',{exact:true}).waitFor();
  await card('macOS 系统语音').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')),'macos');
  assert.equal(await page.evaluate(() => window.imported),undefined,'system speech does not import credentials');
  await page.reload();
  assert.equal(await card('macOS 系统语音').getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(() => window.scanCalls),0,'system channel is cached too');

  // Additional desktop channels select their own sign-in without importing Doubao credentials.
  await page.evaluate(() => { window.sources=[{id:'workbuddy',name:'WorkBuddy',accountId:'workbuddy-user'},{id:'cursor',name:'Cursor',accountId:'cursor-user'}];window.importFailure=true; });
  await scan.click();
  for (const name of ['WorkBuddy','Cursor']) {
    await card(name).getByText(`账号 ID：${name.toLowerCase()}-user`,{exact:true}).waitFor();
    await card(name).click();
    assert.equal(await card(name).getAttribute('aria-pressed'),'true');
  }
  assert.equal(await page.evaluate(() => window.imported),undefined,'other adapters do not import Doubao credentials');
  await card('Cursor').getByText('实时转写',{exact:true}).waitFor();
  await page.evaluate(() => { window.sources=[{id:'minimax:cn',name:'MiniMax',accountId:'minimax-user',transcriptionMode:'batch',token:'fixture-secret'}]; });
  await scan.click();
  await card('MiniMax').getByText('录完转写',{exact:true}).waitFor();
  await card('MiniMax').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')),'minimax:cn');
  const stored=await page.evaluate(() => JSON.parse(localStorage.getItem('cc-voice-sources'))[0]);
  assert.equal(stored.transcriptionMode,'batch');
  assert.equal('token' in stored,false,'only display metadata is cached');
  await page.reload();
  await card('MiniMax').getByText('录完转写',{exact:true}).waitFor();
  assert.equal(await card('MiniMax').getAttribute('aria-pressed'),'true');
  await page.evaluate(() => { window.sources=[{id:'cursor',name:'Cursor',accountId:'grok|user_01M4TQMYT0QXPWKGXZFNCWY3W'.repeat(5)}]; });
  await scan.click();
  const account = card('Cursor').locator('.settings-voice-source-account');
  await account.waitFor();
  const accountLayout = await account.evaluate(element => {
    const text = element.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const labelTop = range.getBoundingClientRect().top;
    const idStart = text.textContent.indexOf('grok|');
    range.setStart(text, idStart);
    range.setEnd(text, idStart + 1);
    return { labelTop, idTop:range.getBoundingClientRect().top, height:element.getBoundingClientRect().height, lineHeight:parseFloat(getComputedStyle(element).lineHeight), fullHeight:element.scrollHeight };
  });
  assert.equal(accountLayout.idTop, accountLayout.labelTop, 'a long account ID starts beside its label on the first line');
  assert.ok(accountLayout.height <= accountLayout.lineHeight * 2 + 1, 'account details occupy at most two lines');
  assert.ok(accountLayout.fullHeight > accountLayout.height, 'the long fixture is clipped after the second line');
  await page.screenshot({path:join(directory,'voice-account-two-lines.png')});
  // A startup match updates an already open settings page through the shared cache.
  await page.evaluate(async () => {
    window.sources=[{id:'workbuddy',name:'WorkBuddy',accountId:'workbuddy-account'},{id:'cursor',name:'Cursor',accountId:'cursor-account'}];
    window.probeResults={workbuddy:{latencyMs:20,accountId:'workbuddy-account'},cursor:{latencyMs:120,accountId:'cursor-account'}};
    await window.initializeVoiceSources();
  });
  await card('WorkBuddy').getByText('账号 ID：workbuddy-account',{exact:true}).waitFor();
  assert.equal(await card('WorkBuddy').getAttribute('aria-pressed'),'true','the background match is reflected without reopening Settings');
  assert.deepEqual(errors, []);
  console.log('voice settings browser test passed');
  console.log(`Screenshots: ${directory}`);
} finally {
  await browser.close();
  server.close();
}
