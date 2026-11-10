// Composer voice input against a scripted native boundary; no microphone, account or network.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-voice-ui-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{VoiceInputButton,VoiceUsageSlot}from'./src/components/center/VoiceInputButton';
import{matchFastestVoiceSource}from'./src/lib/voice-source-discovery';window.matchFastestVoiceSource=matchFastestVoiceSource;
function App(){const[draft,setDraft]=useState(window.initialDraft??'');const[tool,setTool]=useState('claude');window.setTool=setTool;window.draft=()=>draft;
return <div className="gambit-footer"><textarea aria-label="draft" value={draft} onChange={e=>setDraft(e.target.value)}/><VoiceUsageSlot waveKey="s1"><span className="usage-meter" style={{display:'inline-block',width:120}}>5h 100%</span></VoiceUsageSlot><VoiceInputButton key={tool} tool={tool} waveKey="s1" draft={draft} onDraftChange={setDraft}/><button className="gambit-send">send</button></div>}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')], plugins: [{ name: 'voice-fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'store' ? `export function useAppLanguage(){return 'zh-CN'}` : `
window.calls=[];window.signedIn={claude:true,codex:false,doubao:true,doubaowork:true,workbuddy:true,cursor:true,macos:true,'minimax:cn':true};
export const isTauri=true;
export const commands={
  async voiceInputSources(){return[{id:'cursor',name:'Cursor',accountId:'cursor-account'}]},
  async voiceInputProbeSource(){return new Promise(resolve=>window.resolveMatchProbe=resolve)},
  async voiceInputAvailable(tool,cwd,source){window.calls.push(['available',tool]);return window.signedIn[source||tool]},
  async voiceInputStart(tool,cwd,language,device,onEvent,source){window.selectedSource=source;window.calls.push(['start',tool,language,device]);if(window.startError)throw window.startError;window.emit=onEvent;if(window.deferStart)await new Promise(resolve=>window.resolveVoiceStart=resolve);return 7},
  async voiceInputFinish(id){window.calls.push(['finish',id])},
  async voiceInputCancel(id){window.calls.push(['cancel',id])},
};
`, loader: 'js' }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-mode="dark"><link rel="stylesheet" href="/gambit.css"><style>:root{--accent:#c595a5;--bg-hover:#393236;--text-1:#e5dce1;--text-2:#bcb2b8;--text-3:#9f939a}</style><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/gambit.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(project, 'src/components/center/Gambit.css')));
  if (req.url === '/fixture.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(directory, 'fixture.css')));
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  if (req.url.startsWith('/sounds/voice-')) { res.setHeader('Content-Type', 'audio/mpeg'); return res.end(await readFile(join(project, 'public', req.url))); }
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.initialDraft = '请帮我';
    window.played = [];
    HTMLMediaElement.prototype.play = function () { window.played.push(new URL(this.src).pathname); return Promise.resolve(); };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const mic = page.getByRole('button', { name: '语音输入', exact: true });
  await mic.waitFor();
  assert.equal(await page.locator('.gambit-voice-anchor').evaluate(el => el.nextElementSibling.className), 'gambit-send', 'the mic sits right before Send');
  assert.equal(await mic.getAttribute('aria-pressed'), 'false');
  await mic.hover();
  assert.equal(await page.locator('.gambit-voice-anchor').evaluate(el => getComputedStyle(el, '::after').content), '"语音输入"', 'hovering the mic shows our tip, not a native title');
  assert.equal(await mic.getAttribute('title'), null);
  assert.equal(await mic.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(57, 50, 54)', 'idle uses the footer button chip');

  // Start: connecting until the service is ready, then the start chime and the recording state.
  await mic.click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'start'));
  assert.deepEqual(await page.evaluate(() => window.calls.find(c => c[0] === 'start')), ['start', 'claude', 'zh', '']);
  assert.equal(await page.locator('.gambit-voice.is-connecting .gambit-voice-spinner').count(), 1, 'connecting shows a spinner');
  assert.equal(await page.locator('.gambit-voice').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(57, 50, 54)', 'connecting keeps the plain chip');
  await page.locator('.gambit-voice').click();
  await page.locator('.gambit-voice').dblclick();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c[0] !== 'available' && c[0] !== 'start').length), 0, 'clicks while connecting are ignored');
  assert.deepEqual(await page.evaluate(() => window.played), [], 'no chime before the service accepts the stream');
  assert.equal(await page.locator('.gambit-voice-wave').count(), 0, 'no waveform while connecting');
  const before = await page.locator('.usage-meter').boundingBox();
  await page.evaluate(() => window.emit({ kind: 'ready' }));
  await page.locator('.gambit-voice.is-recording').waitFor();
  const wave = page.getByRole('status', { name: '正在聆听', exact: true });
  await wave.waitFor();
  assert.equal(await page.locator('.usage-meter').count(), 0, 'the usage meter steps aside while listening');
  const waveBox = await wave.boundingBox();
  assert.deepEqual([Math.round(waveBox.x), Math.round(waveBox.width)], [Math.round(before.x), Math.round(before.width)], 'the waveform takes exactly the meter\'s place and width');
  // Ink above and below the centre line means a dot grew past the 2px silence line.
  const tall = () => page.locator('.gambit-voice-wave').evaluate(el => { const c = el.getContext('2d'), d = c.getImageData(0, 0, el.width, Math.floor(el.height * 0.3)).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
  await page.waitForTimeout(300);
  assert.equal(await tall(), false, 'silence is a flat dotted line');
  await page.evaluate(() => window.emit({ kind: 'level', level: 1 }));
  await page.waitForFunction(() => { const el = document.querySelector('.gambit-voice-wave'); const d = el.getContext('2d').getImageData(el.width - 8, 0, 8, Math.floor(el.height * 0.3)).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; });
  // The tall dots enter on the right and drift left at a steady pace.
  const column = () => page.locator('.gambit-voice-wave').evaluate(el => { const h = Math.floor(el.height * 0.3), d = el.getContext('2d').getImageData(0, 0, el.width, h).data; for (let x = 0; x < el.width; x++) for (let y = 0; y < h; y++) if (d[(y * el.width + x) * 4 + 3]) return x; return -1; });
  await page.evaluate(() => window.emit({ kind: 'level', level: 0 }));
  await page.waitForTimeout(150);
  const first = await column();
  await page.waitForTimeout(200);
  const second = await column();
  assert.ok(first > 0 && second >= 0 && second < first, `loud dots move left (${first} → ${second})`);
  assert.deepEqual(await page.evaluate(() => window.played), ['/sounds/voice-start.mp3']);
  assert.equal(await page.getByRole('button', { name: '完成语音输入', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.gambit-voice-cancel').count(), 0, 'no separate cancel button');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.gambit-voice')).backgroundColor === 'rgb(197, 149, 165)');
  assert.equal(await page.locator('.gambit-voice .gambit-voice-spinner').count(), 0, 'listening shows the mic, not the spinner');
  // Listening just (re)started: the guard window begins now (the repeated chime is not part of this flow).
  await page.evaluate(() => { window.emit({ kind: 'ready' }); window.played.pop(); });
  await page.locator('.gambit-voice').click();
  assert.equal(await page.evaluate(() => window.calls.some(c => c[0] === 'finish')), false, 'a click right after listening starts is a double click, not finish');
  await page.waitForTimeout(350);
  const recording = await page.locator('.gambit-voice').evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, border: s.borderTopWidth, animation: s.animationName }; });
  assert.equal(recording.background, 'rgb(197, 149, 165)', 'recording lights up with the accent fill like Send');
  assert.deepEqual({ border: recording.border, animation: recording.animation }, { border: '0px', animation: 'none' }, 'no border or pulse');

  // Words stream into the draft after what was already typed.
  await page.evaluate(() => window.emit({ kind: 'text', text: '看', done: false }));
  await page.waitForFunction(() => window.draft() === '请帮我看');
  await page.evaluate(() => window.emit({ kind: 'text', text: '看看这个', done: false }));
  await page.waitForFunction(() => window.draft() === '请帮我看看这个');

  // Finish: stop chime, waiting state, then the final text replaces the interim text.
  await page.getByRole('button', { name: '完成语音输入', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'finish'));
  assert.deepEqual(await page.evaluate(() => window.played), ['/sounds/voice-start.mp3', '/sounds/voice-stop.mp3']);
  assert.equal(await page.locator('.gambit-voice.is-finishing .gambit-voice-spinner').count(), 1, 'wrapping up shows the spinner');
  await page.locator('.gambit-voice').click();
  assert.equal(await page.evaluate(() => window.calls.filter(c => c[0] === 'finish' || c[0] === 'cancel').length), 1, 'clicks while wrapping up are ignored');
  await page.evaluate(() => window.emit({ kind: 'text', text: '看看这个文件。', done: true }));
  await page.waitForFunction(() => window.draft() === '请帮我看看这个文件。');
  await page.locator('.gambit-voice:not([class*="is-"])').waitFor();
  assert.equal(await page.locator('.gambit-voice-spinner').count(), 0, 'the mic returns when idle');
  assert.equal(await page.locator('.gambit-voice-wave').count(), 0, 'the waveform hides once the final text is in');
  assert.equal(await page.locator('.usage-meter').count(), 1, 'the usage meter comes back');
  // Late events from a finished recording are ignored.
  await page.evaluate(() => window.emit({ kind: 'text', text: 'late', done: true }));
  assert.equal(await page.evaluate(() => window.draft()), '请帮我看看这个文件。');

  // A service error ends the recording with a short hint.
  await page.locator('.gambit-voice').click();
  await page.evaluate(() => window.emit({ kind: 'error', message: 'connect: timed out' }));
  await page.getByText('语音输入失败，请重试', { exact: true }).waitFor();
  const notice = await page.locator('.gambit-voice-notice').boundingBox(), button = await page.locator('.gambit-voice').boundingBox();
  assert.ok(notice.y + notice.height <= button.y, 'the problem opens upward above the mic instead of sitting in the row');
  assert.equal(await page.locator('.gambit-send-hint').count(), 0, 'no inline hint text');
  assert.equal(await page.locator('.gambit-voice:not([class*="is-"])').count(), 1);

  // Turned off in Settings: the button goes away at once, and comes back when turned on.
  await page.evaluate(() => { localStorage.setItem('cc-voice-enabled', 'false'); window.dispatchEvent(new StorageEvent('storage', { key: 'cc-voice-enabled' })); });
  await page.waitForFunction(() => !document.querySelector('.gambit-voice'));
  await page.evaluate(() => { localStorage.setItem('cc-voice-enabled', 'true'); window.dispatchEvent(new StorageEvent('storage', { key: 'cc-voice-enabled' })); });
  await mic.waitFor();

  // Signed out at start: the button disappears and says why.
  await page.evaluate(() => { window.startError = 'signed_out'; });
  await mic.click();
  await page.getByText('需要在该工具里用账号登录才能使用语音输入', { exact: true }).waitFor();
  assert.equal(await page.locator('.gambit-voice').count(), 0);

  // Codex signed in with an API key: no button at all.
  await page.evaluate(() => { window.startError = null; window.setTool('codex'); });
  await page.waitForFunction(() => window.calls.some(c => c[0] === 'available' && c[1] === 'codex'));
  assert.equal(await page.locator('.gambit-voice').count(), 0);
  // An explicitly selected local sign-in supplies voice to an unrelated tool.
  await page.evaluate(() => {
    localStorage.setItem('cc-voice-enabled', 'true');
    localStorage.setItem('cc-voice-source', 'claude');
    window.dispatchEvent(new StorageEvent('storage', { key: 'cc-voice-source' }));
    window.setTool('opencode');
  });
  await mic.waitFor();
  await mic.click();
  await page.waitForFunction(() => window.selectedSource === 'claude');
  assert.equal(await page.evaluate(() => window.calls.filter(c => c[0] === 'start').at(-1)[1]), 'opencode');
  await page.evaluate(() => window.emit({ kind: 'text', text: '跨工具输入', done: true }));
  await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('跨工具输入'));
  for (const source of ['workbuddy', 'cursor', 'macos', 'doubao', 'doubaowork']) {
    await page.evaluate(source => { localStorage.setItem('cc-voice-source', source); window.dispatchEvent(new StorageEvent('storage', { key: 'cc-voice-source' })); }, source);
    await mic.click();
    await page.waitForFunction(source => window.selectedSource === source, source);
    assert.equal(await page.evaluate(() => window.calls.filter(c => c[0] === 'start').at(-1)[2]),source === 'macos' ? 'zh-CN' : 'zh','Apple receives the full locale; existing services keep their language code');
    const finishes = await page.evaluate(() => window.calls.filter(call => call[0] === 'finish').length);
    await page.evaluate(() => window.emit({ kind: 'ready' }));
    await page.locator('.gambit-voice.is-recording').waitFor();
    await page.evaluate(() => window.emit({ kind: 'text', text: '豆包的实时草稿', done: false }));
    await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('豆包的实时草稿'));
    assert.equal(await page.locator('.gambit-voice.is-recording').getAttribute('aria-pressed'), 'true', 'partial text appears while recording');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call[0] === 'finish').length), finishes, 'partial text does not require stopping');
    await page.evaluate(() => window.emit({ kind: 'text', text: '豆包转写', done: true }));
    await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('豆包转写'));
    assert.equal((await page.locator('textarea').inputValue()).includes('豆包的实时草稿'), false, 'final text replaces the interim hypothesis');
  }
  // Signing out hides the selected source; never switch to a different account silently.
  await page.evaluate(() => { window.signedIn.doubaowork = false; window.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => !document.querySelector('.gambit-voice'));
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')), 'doubaowork');

  // System authorization denial offers a useful hint and leaves the channel available to retry.
  await page.evaluate(() => { localStorage.setItem('cc-voice-source','macos');window.dispatchEvent(new StorageEvent('storage',{key:'cc-voice-source'})); });
  await mic.waitFor();
  await mic.click();
  await page.waitForFunction(() => window.selectedSource === 'macos');
  await page.evaluate(() => window.emit({kind:'error',message:'speech_permission'}));
  await page.getByText('请在系统设置中允许 Coffee CLI 使用语音识别和麦克风。',{exact:true}).waitFor();
  assert.equal(await mic.getAttribute('aria-pressed'),'false');
  // A batch channel retains the draft while listening and finishes through the same composer.
  const beforeBatch=await page.locator('textarea').inputValue();
  await page.evaluate(() => { localStorage.setItem('cc-voice-source','minimax:cn');window.dispatchEvent(new StorageEvent('storage',{key:'cc-voice-source'})); });
  await mic.click();
  await page.waitForFunction(() => window.selectedSource==='minimax:cn');
  await page.evaluate(() => window.emit({kind:'ready'}));
  await page.locator('.gambit-voice.is-recording').waitFor();
  assert.equal(await page.locator('textarea').inputValue(),beforeBatch);
  await page.waitForTimeout(350);
  await page.getByRole('button',{name:'完成语音输入',exact:true}).click();
  await page.locator('.gambit-voice.is-finishing').waitFor();
  await page.evaluate(() => window.emit({kind:'text',text:'录完转写结果',done:true}));
  await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('录完转写结果'));
  await mic.click();
  await page.evaluate(() => window.emit({kind:'error',message:'http_402'}));
  await page.getByText('该语音渠道暂不可调用（HTTP 402），请检查官方账号的权限或额度。',{exact:true}).waitFor();
  assert.equal(await mic.getAttribute('aria-pressed'),'false','payment/entitlement errors do not sign the user out');
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')),'minimax:cn');
  await mic.click();
  await page.evaluate(() => { window.emit({kind:'ready'}); window.emit({kind:'processing'}); });
  await page.locator('.gambit-voice.is-finishing').waitFor({timeout:2000});
  await page.evaluate(() => window.emit({kind:'text',text:'自动结束录音后的转写',done:true}));
  await page.waitForFunction(() => document.querySelector('textarea').value.endsWith('自动结束录音后的转写'));
  // Changing channels also cancels a recording waiting for its final result.
  const beforeSwitch=await page.locator('textarea').inputValue();
  const cancelledBefore=await page.evaluate(() => window.calls.filter(c=>c[0]==='cancel').length);
  await mic.click();
  await page.evaluate(() => { window.previousVoiceEvent=window.emit;window.emit({kind:'ready'}); });
  await page.locator('.gambit-voice.is-recording').waitFor();
  await page.waitForTimeout(350);
  await page.getByRole('button',{name:'完成语音输入',exact:true}).click();
  await page.locator('.gambit-voice.is-finishing').waitFor();
  await page.evaluate(() => { localStorage.setItem('cc-voice-source','cursor');window.dispatchEvent(new StorageEvent('storage',{key:'cc-voice-source'}));window.previousVoiceEvent({kind:'text',text:'过时的账号结果',done:true}); });
  await page.waitForFunction(count=>window.calls.filter(c=>c[0]==='cancel').length>count,cancelledBefore,{timeout:2000});
  await page.locator('.gambit-voice:not([class*="is-"])').waitFor();
  await page.evaluate(() => window.previousVoiceEvent({kind:'text',text:'过时的账号结果',done:true}));
  assert.equal(await page.locator('textarea').inputValue(),beforeSwitch,'late results from the previous channel never replace the draft');
  // The previous native start can also resolve after its channel has been deselected.
  const pendingCancels=await page.evaluate(() => window.calls.filter(c=>c[0]==='cancel').length);
  await page.evaluate(() => { window.deferStart=true; });
  await mic.click();
  await page.locator('.gambit-voice.is-connecting').waitFor();
  await page.evaluate(() => { localStorage.setItem('cc-voice-source','workbuddy');window.dispatchEvent(new StorageEvent('storage',{key:'cc-voice-source'})); });
  await page.locator('.gambit-voice:not([class*="is-"])').waitFor();
  await page.evaluate(() => { window.deferStart=false;window.resolveVoiceStart(); });
  await page.waitForFunction(count=>window.calls.filter(c=>c[0]==='cancel').length>count,pendingCancels);
  await page.evaluate(() => window.emit({kind:'text',text:'迟到的启动结果',done:true}));
  assert.equal(await page.locator('textarea').inputValue(),beforeSwitch);
  // A background match finishing after dictation starts must preserve the active channel.
  await page.evaluate(() => { window.pendingMatch=window.matchFastestVoiceSource(); });
  await page.waitForFunction(() => typeof window.resolveMatchProbe === 'function');
  await mic.click();
  await page.evaluate(() => window.emit({kind:'ready'}));
  await page.locator('.gambit-voice.is-recording').waitFor();
  await page.evaluate(async () => {
    window.resolveMatchProbe({latencyMs:1,accountId:'cursor-account'});
    await window.pendingMatch;
  });
  assert.equal(await page.evaluate(() => localStorage.getItem('cc-voice-source')), 'workbuddy', 'a connection measurement cannot replace a channel while dictating');
  await page.locator('.gambit-voice.is-recording').waitFor();
  await page.evaluate(() => window.emit({kind:'text',text:'后台匹配保留当前录音',done:true}));
  assert.deepEqual(errors, []);
  console.log('voice input browser test passed');
} finally {
  await browser.close();
  server.close();
}
