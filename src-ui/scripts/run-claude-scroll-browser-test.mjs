// Isolated browser regression; no Claude process, credentials or user windows.
// Optional: COFFEE_PLAYWRIGHT_MODULE=file:///.../playwright-core/index.mjs,
// COFFEE_CHROMIUM_EXECUTABLE=/path/to/chromium (otherwise Playwright's browser).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-scroll-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ClaudeConversation} from './src/components/center/ClaudeConversation';
    import './src/styles/global.css';import './src/components/center/TierTerminal.css';
    function Fixture(){const [active,setActive]=useState(true);window.setActive=setActive;return <div className="host" style={{display:active?'flex':'none'}}><ClaudeConversation sessionId="scroll" cwd="D:/Test" isActive={active}/></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg'],
  nodePaths: [join(project, 'node_modules')], loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.gif': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'isolated-session', setup(builder) {
    builder.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    builder.onResolve({ filter: /claude-session$/ }, () => ({ path: 'session', namespace: 'fixture' }));
    builder.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/shiki$/ }, () => ({ path: 'syntax', namespace: 'fixture' }));
    builder.onResolve({ filter: /(^|\/)clipboard$/ }, () => ({ path: 'clipboard', namespace: 'fixture' }));
    builder.onResolve({ filter: /\.svg\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?raw', '')), namespace: 'svg' }));
    builder.onLoad({ filter: /.*/, namespace: 'svg' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'store' ? `
      export function useAppLanguage(){return 'en'};export function useAppState(){return {dispatch(action){(window.actions??=[]).push(action)}}};
    ` : args.path === 'syntax' ? `
      export async function tokenizeFile(){return null};export async function tokenizeByLang(){return null};export function getShikiTheme(){return 'light'};
    ` : args.path === 'clipboard' ? `
      export async function clipboardWrite(text){window.copiedText=text};export async function clipboardRead(){return 'pasted text'};
    ` : args.path === 'tauri' ? `export const commands=new Proxy({},{get:(_,name)=>async(...args)=>{(window.nativeActions??=[]).push({name,args});if(name==='computerName')return 'TEST-DESKTOP'}});` : `
      import {useSyncExternalStore} from 'react';import {emptyClaudeState,reduceClaudeEvent} from './src/lib/claude-protocol';
      let state={...emptyClaudeState(),ready:true};const listeners=new Set();
      window.setSession=patch=>{state={...state,...patch};listeners.forEach(fn=>fn())};
      window.stopFixture=errors=>{state=reduceClaudeEvent({...state,interruptRequested:true},{type:'result',is_error:true,errors});listeners.forEach(fn=>fn())};
      window.reset=kind=>{
        clearInterval(window.streamTimer);window.tick=0;
        const messages=Array.from({length:96},(_,i)=>({id:'history-'+i,role:i%2?'assistant':'user',content:'History '+i+'\\n\\n'+'Earlier readable context. '.repeat(35),timestamp:Date.now()-100000+i}));
        messages.push({id:'live',role:kind==='tool'||kind==='write'?'tool':kind,partial:kind!=='tool'&&kind!=='write',toolName:kind==='write'?'Write':'Bash',toolStatus:'running',input:kind==='write'?{file_path:'example.ts',content:'line\\n'.repeat(80)}:{command:'echo test'},output:'output\\n',content:'Live output.\\n\\n',timestamp:Date.now()});
        window.setSession({...emptyClaudeState(),ready:true,busy:true,status:'working',messages,historyCursor:100,startedAt:Date.now()});
      };
      window.startStream=()=>{window.streamTimer=setInterval(()=>{
        window.tick++;const last=state.messages.at(-1);window.setSession({messages:[...state.messages.slice(0,-1),{...last,content:last.content+'Streamed paragraph '+window.tick+'.\\n\\n',output:last.output+'output '+window.tick+'\\n'}],thinkingTokens:window.tick*20});
      },40)};
      window.stopStream=()=>clearInterval(window.streamTimer);
      window.appendReply=()=>window.setSession({messages:[...state.messages,{id:crypto.randomUUID(),role:'assistant',content:'A new reply paragraph.\\n\\n'.repeat(30),timestamp:Date.now()}]});
      window.finish=()=>{window.stopStream();window.setSession({busy:false,status:'idle',endedAt:Date.now(),messages:state.messages.map(m=>m.id==='live'?{...m,partial:false,toolStatus:m.role==='tool'?'done':undefined}:m)})};
      export function useClaudeSession(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state)};
      export function retainClaudeSession(){return()=>{}};export async function controlClaude(){return {}};export async function respondClaude(){};
      export async function loadClaudeHistory(){const older=Array.from({length:24},(_,i)=>({id:'older-'+i,role:'user',content:'Older '+i+'\\n\\n'+'Older context. '.repeat(35),timestamp:Date.now()-200000+i}));window.setSession({messages:[...older,...state.messages],historyCursor:0})};
    ` }));
  } }],
});
const html = `<!doctype html><link rel="stylesheet" href="/fixture.css"><style>
*{box-sizing:border-box}body{margin:0;background:#15101d}:root{--font:Arial,sans-serif;--mono:monospace;--accent:#937fa3;--bg-terminal:#15101d;--bg-panel:#231c2b;--bg-hover:#302838;--text-1:#ded5e5;--text-2:#bdb0c7;--text-3:#a597af;--border:#463b50;--gambit-dock-h:180px}#root,.host{height:100vh}.host{width:100%}
</style><body class="gambit-docked"><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  const name = req.url.slice(1);
  if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css');
  res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'no-preference' });
if (process.env.COFFEE_TEST_CPU_RATE) {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.COFFEE_TEST_CPU_RATE) });
}
const errors = []; page.on('pageerror', error => errors.push(error.message));
const scroll = page.locator('.claude-scroll');
const metrics = () => scroll.evaluate(el => ({ top: el.scrollTop, distance: el.scrollHeight - el.clientHeight - el.scrollTop }));
const atBottom = () => page.waitForFunction(() => { const el = document.querySelector('.claude-scroll'); return el.scrollHeight - el.clientHeight - el.scrollTop < 2; });
const wheelUp = async (pixels = 30) => {
  const box = await scroll.boundingBox(); await page.mouse.move(box.x + box.width - 70, box.y + box.height - 5);
  await page.mouse.wheel(0, -pixels); await page.waitForTimeout(150);
};
const returnBottom = async () => {
  const button = page.locator('.claude-scroll-bottom');
  if (await button.count()) await button.click();
  await atBottom();
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for (const role of ['reasoning', 'tool', 'assistant']) {
    await page.evaluate(role => window.reset(role), role); await page.waitForTimeout(450); await returnBottom();
    if (role === 'reasoning') await page.locator('.claude-reasoning summary').click();
    await page.evaluate(() => window.startStream()); await page.waitForTimeout(200); await atBottom();
    await wheelUp(); assert.ok((await metrics()).distance > 10, `${role}: small wheel escapes follow`);
    await wheelUp(450); const reading = await metrics(); await page.waitForTimeout(400);
    assert.ok(Math.abs((await metrics()).top - reading.top) < 2, `${role}: streaming preserves reading position`);
    await returnBottom(); await page.waitForTimeout(500); await atBottom();
    await wheelUp(300); const beforeFinish = await metrics(); await page.evaluate(() => window.finish()); await page.waitForTimeout(200);
    assert.ok(Math.abs((await metrics()).top - beforeFinish.top) < 2, `${role}: completion never pulls back`);
    console.log('ok', role, 'stream, upward reading, return follow and completion');
  }
  await returnBottom();
  await page.evaluate(() => window.setSession({usage:{input_tokens:69000,output_tokens:2100},totalCost:1.4818}));
  const summary = page.locator('.claude-turn-summary'); await summary.waitFor();
  assert.equal(await summary.locator('..').getAttribute('data-message-id'), 'live', 'usage belongs inside the final timeline message');
  const summaryBox = await summary.boundingBox(), copyBox = await summary.locator('..').locator('.conversation-copy').boundingBox();
  assert.ok(summaryBox.y - copyBox.y - copyBox.height >= 0 && summaryBox.y - copyBox.y - copyBox.height <= 12, 'usage follows the copy action without a large gap');
  assert.ok((await summary.textContent()).includes('71.1k') && (await summary.textContent()).includes('1.4818'), 'usage values remain intact');
  console.log('ok usage is inside the timeline, close to copy, with original values');
  await page.setViewportSize({ width: 1100, height: 600 }); await page.waitForTimeout(150); await atBottom();
  await page.setViewportSize({ width: 1100, height: 850 }); await page.waitForTimeout(150); await atBottom();
  await page.evaluate(() => window.setActive(false)); await page.waitForTimeout(100); await page.evaluate(() => window.setActive(true)); await page.waitForTimeout(200); await atBottom();
  await wheelUp(600); const beforeResize = await metrics();
  await page.setViewportSize({ width: 1100, height: 650 }); await page.waitForTimeout(200);
  assert.ok(Math.abs((await metrics()).top - beforeResize.top) < 2, 'resizing while reading never resumes follow');
  await page.evaluate(() => window.setActive(false)); await page.waitForTimeout(100); await page.evaluate(() => window.setActive(true)); await page.waitForTimeout(250);
  assert.ok(Math.abs((await metrics()).top - beforeResize.top) < 2, 'tab hide/reveal preserves reading position');
  console.log('ok viewport resizing and tab hide/reveal');

  await page.evaluate(() => window.reset('write')); await page.waitForTimeout(450); await returnBottom();
  await page.locator('.claude-tool-body .claude-tool-resize').click(); await page.waitForTimeout(200); await atBottom();
  await wheelUp(180); await page.locator('.claude-tool-body .claude-tool-resize').evaluate(el => el.click()); await page.waitForTimeout(200);
  const collapsed = await metrics(); await page.evaluate(() => window.appendReply()); await page.waitForTimeout(350);
  assert.ok(Math.abs((await metrics()).top - collapsed.top) < 2, 'tool collapse cannot silently resume follow');
  console.log('ok tool expansion follows only while pinned; collapse cannot re-enable follow');

  const beforeApproval = await metrics();
  await page.evaluate(() => window.setSession({requests:[{id:'approval',request:{subtype:'can_use_tool',tool_name:'Edit',input:{file_path:'example.ts'}}}]})); await page.waitForTimeout(150);
  await page.evaluate(() => window.setSession({requests:[]})); await page.waitForTimeout(150);
  assert.ok(Math.abs((await metrics()).top - beforeApproval.top) < 2, 'permission card appearance and dismissal preserve reading position');
  console.log('ok permission cards preserve reading position');

  await page.evaluate(() => window.reset('assistant')); await page.waitForTimeout(400); await returnBottom();
  await scroll.evaluate(el => { el.tabIndex = 0; el.focus(); }); await page.keyboard.press('PageUp'); await page.waitForTimeout(250);
  assert.ok((await metrics()).distance > 10, 'keyboard can move upward');
  const keyboardPosition = await metrics(); await page.evaluate(() => window.startStream()); await page.waitForTimeout(300); await page.evaluate(() => window.stopStream());
  assert.ok(Math.abs((await metrics()).top - keyboardPosition.top) < 2, 'keyboard reading stays paused');
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); }); await page.evaluate(() => window.startStream()); await page.waitForTimeout(200); await atBottom(); await page.evaluate(() => window.stopStream());
  console.log('ok keyboard reading and manual bottom resume');
  await scroll.evaluate(el => { el.scrollTop -= 30; window.appendReply(); }); await page.waitForTimeout(200);
  assert.ok((await metrics()).distance > 10, 'a scrollbar movement is respected even before its scroll event is delivered');
  await returnBottom(); await scroll.dispatchEvent('touchmove');
  await scroll.evaluate(el => { el.scrollTop -= 30; window.appendReply(); }); await page.waitForTimeout(200);
  assert.ok((await metrics()).distance > 10, 'touch movement pauses follow before content updates');
  console.log('ok scrollbar event race and touch intent');

  await page.evaluate(() => window.reset('assistant')); await page.waitForTimeout(400);
  await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); }); await page.waitForTimeout(350);
  const anchor = page.locator('[data-message-id="history-0"]');
  const before = await anchor.boundingBox(); await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click(); await page.waitForTimeout(400);
  const after = await anchor.boundingBox(); assert.ok(Math.abs(after.y - before.y) < 2, `loading earlier history preserves its visible anchor: ${JSON.stringify({ before, after, scroll: await metrics() })}`);
  assert.equal(await page.locator('.conversation-navigation-item').count(), 72, 'navigation includes newly loaded history turns');
  console.log('ok history prepend anchor');
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => window.reset('assistant')); await page.waitForTimeout(400); await returnBottom();
  const navigation = page.locator('.conversation-navigation');
  assert.equal(await navigation.locator('button').count(), 48, 'each loaded user turn has one navigation tick');
  const turn = navigation.locator('[data-conversation-navigation-target="history-10"]');
  await turn.hover();
  assert.ok((await navigation.getByRole('tooltip').textContent()).startsWith('History 10'), 'hover previews the user prompt');
  const railBox = await navigation.boundingBox(), tooltipBox = await navigation.getByRole('tooltip').boundingBox();
  assert.ok(tooltipBox.x > railBox.x + railBox.width, 'left-side preview opens to the right');
  await turn.click(); await page.mouse.move(5, 5); await page.waitForTimeout(450);
  const target = await page.locator('[data-message-id="history-10"]').boundingBox();
  const viewport = await scroll.boundingBox();
  assert.ok(target && target.y >= viewport.y && target.y < viewport.y + 120, `navigation lands on its turn: ${JSON.stringify({ target, viewport })}`);
  const jumped = await metrics(); await page.evaluate(() => window.startStream()); await page.waitForTimeout(350);
  assert.ok(Math.abs((await metrics()).top - jumped.top) < 2, 'navigation pauses streaming follow');
  await wheelUp(90); const afterJumpWheel = await metrics(); await page.waitForTimeout(200);
  assert.ok(afterJumpWheel.top < jumped.top - 30 && Math.abs((await metrics()).top - afterJumpWheel.top) < 2, 'manual scrolling releases the navigation anchor');
  await returnBottom(); await page.waitForTimeout(200); await atBottom(); await page.evaluate(() => window.stopStream());
  await turn.click(); await page.waitForTimeout(300);
  assert.ok(Math.abs((await page.locator('[data-message-id="history-10"]').boundingBox()).y - 24) < 2, 'repeat jumps use measured rows accurately');
  await returnBottom();
  const slider = page.locator('.cc-scrollbar-wide .cc-scrollbar-slider');
  await scroll.hover(); await page.waitForTimeout(100);
  const sliderBox = await slider.boundingBox();
  assert.equal(sliderBox.width, 8, 'conversation scrollbar thumb is wider');
  assert.equal((await slider.locator('..').boundingBox()).width, 12, 'scrollbar hit area matches its wider layout');
  await page.mouse.move(sliderBox.x + 4, sliderBox.y + sliderBox.height / 2);
  await page.mouse.down(); await page.mouse.move(sliderBox.x + 4, sliderBox.y + sliderBox.height / 2 - 20, { steps: 5 }); await page.mouse.up();
  const dragged = await metrics(); assert.ok(dragged.distance > 10, 'wider thumb supports dragging upward');
  await page.evaluate(() => window.startStream()); await page.waitForTimeout(250); await page.evaluate(() => window.stopStream());
  assert.ok(Math.abs((await metrics()).top - dragged.top) < 2, 'dragging the wider thumb pauses follow');
  console.log('ok wider conversation scrollbar geometry and drag');
  for (const width of [1100, 850, 761]) {
    await page.setViewportSize({ width, height: 800 }); await page.waitForTimeout(150);
    const rail = await navigation.boundingBox(), thread = await page.locator('.claude-thread').boundingBox();
    assert.ok(rail && rail.x + rail.width + 12 <= thread.x, `left navigation stays outside the text at ${width}px`);
    assert.ok(rail.y + rail.height <= (await scroll.boundingBox()).height + 1, 'navigation clears the docked composer');
  }
  for (const width of [760, 390]) {
    await page.setViewportSize({ width, height: 800 }); await page.waitForTimeout(150);
    assert.equal(await navigation.isVisible(), false, `navigation hides at ${width}px instead of crowding the conversation`);
  }
  await page.evaluate(() => window.setSession({messages:[],busy:false}));
  assert.equal(await navigation.count(), 0, 'empty conversations have no navigation');
  console.log('ok left-side navigation preview, jump, paused follow, responsive spacing and empty state');

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => {
    window.reasoningMessage = { id: 'thinking-toggle', role: 'reasoning', content: 'Reasoning remains readable while tokens arrive.\n\n'.repeat(20), partial: true, timestamp: Date.now() };
    window.setSession({ messages: [window.reasoningMessage], busy: true, status: 'thinking', requests: [], historyCursor: 0, endedAt: undefined });
  });
  const thinking = page.locator('.claude-reasoning');
  await thinking.locator('summary').click();
  await page.evaluate(() => window.setSession({ thinkingTokens: 500, messages: [{ ...window.reasoningMessage, content: window.reasoningMessage.content + 'A new streamed thought.' }] }));
  await page.waitForTimeout(250);
  assert.equal(await thinking.evaluate(el => el.open), true, 'manual reasoning expansion survives streamed content and token rerenders');
  await thinking.locator('summary').click(); await page.waitForTimeout(100);
  await page.evaluate(() => window.setSession({ thinkingTokens: 600 }));
  assert.equal(await thinking.evaluate(el => el.open), false, 'manual collapse also survives updates');
  await page.keyboard.press('Control+o'); await page.waitForTimeout(100);
  assert.equal(await thinking.evaluate(el => el.open), true, 'Ctrl+O still expands reasoning');
  await page.keyboard.press('Control+o'); await page.waitForTimeout(100);
  assert.equal(await thinking.evaluate(el => el.open), false, 'Ctrl+O still collapses reasoning');
  await thinking.locator('summary').click(); await page.waitForTimeout(100);
  await page.evaluate(() => window.setSession({ messages: [window.reasoningMessage, ...Array.from({ length: 60 }, (_, i) => ({ id: 'toggle-tail-' + i, role: 'user', content: 'Another turn. '.repeat(50), timestamp: Date.now() }))] }));
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); }); await page.waitForTimeout(350);
  assert.equal(await thinking.count(), 0, 'offscreen reasoning is virtualized');
  await scroll.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); }); await page.waitForTimeout(350);
  assert.equal(await thinking.evaluate(el => el.open), true, 'expansion survives virtual row remounting');
  await page.evaluate(() => window.setSession({ messages: [{ ...window.reasoningMessage, content: '' }] }));
  assert.equal(await thinking.locator('summary').count(), 0, 'empty or withheld reasoning has no misleading expand arrow');
  await page.evaluate(() => window.setSession({ messages: [window.reasoningMessage] }));
  assert.equal(await thinking.evaluate(el => el.open), true, 'new reasoning content retains the saved expansion choice');
  console.log('ok reasoning toggle stays under user control during streaming');

  await page.evaluate(() => {
    window.toolMessage = { id: 'tool-controls', role: 'tool', toolName: 'Bash', toolStatus: 'done', input: { command: 'echo full-output' }, output: Array.from({ length: 80 }, (_, i) => 'Original output line ' + i).join('\n'), content: '', timestamp: Date.now() };
    window.setSession({ messages: [window.toolMessage], busy: false, requests: [], historyCursor: 0 });
  });
  await page.waitForTimeout(200);
  const inputRow = page.locator('.claude-io-row').first(), outputRow = page.locator('.claude-io-row').last();
  await inputRow.getByRole('button', { name: 'Copy message', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedText), 'echo full-output');
  await outputRow.getByRole('button', { name: 'Copy message', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedText), await page.evaluate(() => window.toolMessage.output), 'copy includes the whole output, beyond the clipped preview');
  const outputScroll = outputRow.locator('.claude-tool-content-scroll');
  const preview = await outputScroll.boundingBox();
  assert.ok(preview.height <= 180);
  await outputRow.getByRole('button', { name: 'Click to expand', exact: true }).click(); await page.waitForTimeout(100);
  assert.ok((await outputScroll.boundingBox()).height > preview.height + 100);
  await page.evaluate(() => window.setSession({ messages: [{ ...window.toolMessage, output: window.toolMessage.output + '\nLast streamed line' }] }));
  assert.equal(await outputRow.locator('.claude-tool-resize').getAttribute('aria-expanded'), 'true', 'stream updates preserve expanded output');
  await outputRow.getByRole('button', { name: 'Collapse', exact: true }).click();
  assert.equal(await outputRow.locator('.claude-tool-resize').getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => window.setSession({ messages: [{ ...window.toolMessage, toolName: 'Write', toolStatus: 'running', input: {}, output: undefined }] }));
  assert.equal(await page.locator('.claude-tool-pending').count(), 1, 'a streaming Write with incomplete arguments displays a pending state');
  assert.equal(await page.locator('.claude-tool-subtitle').count(), 0, 'incomplete Write arguments do not claim a one-line file');
  await page.evaluate(() => window.setSession({ messages: [{ ...window.toolMessage, toolName: 'Write', input: { file_path: 'example.ts', content: 'new file line\n'.repeat(40) } }] }));
  await page.locator('.claude-tool-body').getByRole('button', { name: 'Copy message', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedText), 'new file line\n'.repeat(40));
  await page.locator('.claude-tool-resize').click();
  assert.equal(await page.locator('.claude-tool-resize').getAttribute('aria-expanded'), 'true');
  await page.evaluate(() => window.setSession({ messages: [{ ...window.toolMessage, toolName: 'Edit', input: { file_path: 'example.ts', old_string: 'before\n'.repeat(20), new_string: 'after\n'.repeat(20) } }] }));
  await page.locator('.claude-diff').getByRole('button', { name: 'Copy message', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copiedText), 'after\n'.repeat(20));
  await page.locator('.claude-tool-resize').click();
  assert.equal(await page.locator('.claude-diff.is-expanded').count(), 1);
  await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(150);
  assert.ok(await scroll.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  console.log('ok tool input/output copy, expansion, streaming updates, Write pending state and diff controls');

  for (const [action,label] of [['start','Delegate task'],['list','View collaboration tasks'],['wait','Wait for collaboration results'],['read','Check collaboration progress'],['send','Continue collaboration task'],['reply','Answer collaborator'],['interrupt','Interrupt collaboration task']]) {
    await page.evaluate(action => window.setSession({messages:[{...window.toolMessage,id:'team-'+action,toolName:'mcp__coffee-team__worker_'+action,input:{taskId:'original-task'},output:'Original worker output'}]}),action);
    const heading=page.locator('.claude-tool-heading > button').first();
    assert.equal(await heading.innerText(),label,'coordination headings use readable action labels');
    await heading.click();
    assert.ok((await page.locator('.claude-tool-body').innerText()).includes('original-task'),'expanded details retain the original input');
    assert.ok((await page.locator('.claude-tool-body').innerText()).includes('Original worker output'),'expanded details retain the original result');
  }
  console.log('ok seven readable orchestration headings preserve expandable inputs and outputs');

  const searchQuery='select:mcp__coffee-team__worker_start,mcp__coffee-team__worker_list,mcp__coffee-team__worker_wait,mcp__coffee-team__';
  await page.evaluate(query=>window.setSession({messages:[{...window.toolMessage,id:'team-search',toolName:'ToolSearch',input:{query},output:'Original search result'}]}),searchQuery);
  const searchHeading=page.locator('.claude-tool-heading > button').first();
  assert.equal(await searchHeading.innerText(),'Find collaboration tools');
  assert.equal(await page.locator('.claude-tool-heading > span').innerText(),'Delegate task · View collaboration tasks · Wait for collaboration results');
  assert.equal(await page.locator('.claude-tool-body').count(),0);
  await searchHeading.click();
  assert.ok((await page.locator('.claude-tool-body').innerText()).includes(searchQuery),'expanded search retains the exact native query');
  assert.ok((await page.locator('.claude-tool-body').innerText()).includes('Original search result'));
  const otherQuery='select:mcp__other__worker_start';
  await page.evaluate(query=>window.setSession({messages:[{...window.toolMessage,id:'other-search',toolName:'ToolSearch',input:{query}}]}),otherQuery);
  assert.equal(await searchHeading.innerText(),'ToolSearch');
  assert.equal(await page.locator('.claude-tool-heading > span').innerText(),otherQuery,'unrelated tool searches retain their original display');
  console.log('ok localized collaboration tool searches preserve raw details and leave unrelated searches unchanged');

  await page.evaluate(() => {
    window.setSession({messages:[{id:'stop-tool',role:'tool',toolName:'Bash',toolStatus:'running',content:'',input:{command:'echo hello'},output:'Already printed output',timestamp:Date.now()}],busy:true,pendingTurns:1,error:undefined});
    window.stopFixture(['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use']);
  });
  await page.locator('[role="status"].claude-interrupted').waitFor();
  assert.equal(await page.locator('[role="status"].claude-interrupted').textContent(),'Interrupted');
  assert.equal(await page.locator('.claude-session-error').count(),0);
  assert.equal(await page.locator('.claude-row--interrupted').count(),1);
  assert.equal(await page.locator('.claude-io-row.is-error').count(),0);
  assert.ok((await page.locator('.claude-tool-body').textContent()).includes('Already printed output'));
  assert.equal(await page.locator('[role="status"].claude-interrupted').evaluate(el=>getComputedStyle(el).fontStyle),'italic');
  await page.evaluate(()=>window.stopFixture(['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use','API Error: 503 unavailable']));
  assert.equal(await page.locator('.claude-session-error').textContent(),'API Error: 503 unavailable');
  assert.equal(await page.locator('[role="status"].claude-interrupted').count(),0);
  await page.evaluate(()=>window.setSession({busy:true,interrupted:false,error:undefined}));
  assert.equal(await page.locator('[role="status"].claude-interrupted').count(),0);
  console.log('ok user interruption is neutral, keeps partial output and never hides a real API failure');

  await page.evaluate(() => { window.originalRandom = Math.random; Math.random = () => 0; window.setSession({ messages: [], ready: false, status: 'starting', busy: false, requests: [], error: undefined, endedAt: undefined }); });
  await page.waitForFunction(()=>document.querySelector('.claude-empty-title'));
  assert.equal(await page.locator('.claude-working').count(),0,'startup shows the welcome screen without a Connecting row');
  await page.evaluate(()=>window.setSession({error:'Startup unavailable'}));
  await page.waitForFunction(()=>document.querySelector('.claude-reconnect'));
  assert.equal(await page.locator('.claude-session-error').count(),0,'connection failures do not become red conversation messages');
  assert.equal(await page.locator('.claude-reconnect').getAttribute('title'),'Startup unavailable');
  await page.evaluate(()=>window.setSession({ready:true,status:'idle',error:undefined}));
  const resolvedModel = 'deepseek-flash[1m]';
  await page.evaluate(resolvedModel=>window.setSession({model:'selected',models:[{value:'selected',resolvedModel}]}),resolvedModel);
  await page.waitForFunction(model=>document.querySelector('.claude-empty-model')?.textContent===model,resolvedModel);
  for (const width of [496,1100]) {
    await page.setViewportSize({width,height:800});
    assert.ok(await page.locator('.claude-empty-model').evaluate(el=>el.scrollWidth<=el.clientWidth),'the model fits when the conversation has enough room');
  }
  const longModel = 'example-model-with-a-long-identifier-that-fits-the-welcome-area';
  await page.evaluate(model=>window.setSession({models:[{value:'selected',resolvedModel:model}]}),longModel);
  await page.waitForFunction(model=>document.querySelector('.claude-empty-model')?.textContent===model,longModel);
  assert.ok(await page.locator('.claude-empty-model').evaluate(el=>el.scrollWidth<=el.clientWidth),'wide conversations do not impose an artificial model width limit');
  await page.setViewportSize({width:320,height:800});
  assert.ok(await page.locator('.claude-scroll').evaluate(el=>el.scrollWidth<=el.clientWidth),'a long model does not overflow a narrow split pane');
  await page.setViewportSize({width:1100,height:800});
  await page.evaluate(resolvedModel=>window.setSession({models:[{value:'selected',resolvedModel}]}),resolvedModel);
  const welcome = page.locator('.claude-empty-icon'), mascot = welcome.locator('video');
  await page.waitForFunction(() => { const video = document.querySelector('.claude-empty-icon video'); return video?.readyState >= 2 && !video.paused; });
  assert.ok(await mascot.evaluate(video => video.muted && video.loop && video.playsInline), 'welcome mascot plays silently and loops inline');
  const laptopPixels = await mascot.evaluate(async video => {
    video.pause(); await new Promise(resolve => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = 1.5; });
    const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let gray = 0, transparent = 0;
    for (let i = 0; i < pixels.length; i += 4) { if (pixels[i + 3] === 0) transparent++; else if (pixels[i + 3] > 240 && pixels[i] > 80 && pixels[i] < 180 && Math.abs(pixels[i] - pixels[i + 1]) < 6 && Math.abs(pixels[i] - pixels[i + 2]) < 6) gray++; }
    await video.play(); return { gray, transparent };
  });
  assert.ok(laptopPixels.gray > 20, 'desktop laptop stays gray and visible on a dark background');
  assert.ok(laptopPixels.transparent > 1000, 'desktop laptop retains its transparent background');
  const bounds = await welcome.boundingBox(), frames = new Set();
  for (let frame = 0; frame < 4; frame++) {
    await page.waitForTimeout(350);
    frames.add(await mascot.evaluate(video => { const canvas = document.createElement('canvas'); canvas.width = 136; canvas.height = 100; const ctx = canvas.getContext('2d'); ctx.drawImage(video, -10, -8, 160, 160 * video.videoHeight / video.videoWidth); return canvas.toDataURL(); }));
    assert.deepEqual(await welcome.boundingBox(), bounds, 'mascot animation never shifts the welcome layout');
  }
  assert.ok(frames.size > 1, 'decoded mascot frames actually animate');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(150);
  assert.equal(await mascot.evaluate(video => video.paused), true);
  assert.equal(await welcome.locator('.claude-empty-still').evaluate(el => getComputedStyle(el).visibility), 'visible');
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.waitForTimeout(150);
  assert.equal(await mascot.evaluate(video => video.paused), false);
  await page.evaluate(() => window.setActive(false)); await page.waitForTimeout(100);
  assert.equal(await mascot.evaluate(video => video.paused), true, 'inactive tabs pause the welcome animation');
  await page.evaluate(() => window.setActive(true)); await page.waitForTimeout(150);
  assert.equal(await mascot.evaluate(video => video.paused), false);
  await mascot.dispatchEvent('error');
  assert.equal(await mascot.count(), 0);
  assert.equal(await welcome.locator('.claude-empty-still').evaluate(el => getComputedStyle(el).visibility), 'visible', 'unsupported video falls back to the existing static icon');
  for (const [index, id] of ['laptop', 'waving', 'jumping', 'walking', 'lurking', 'racing', 'cloud'].entries()) {
    await page.evaluate(() => window.setSession({ messages: [{ id: 'hide-welcome', role: 'user', content: 'A new turn', timestamp: Date.now() }] }));
    await page.waitForFunction(() => !document.querySelector('.claude-empty-icon'));
    await page.evaluate(index => { Math.random = () => (index + .5) / 7; window.setSession({ messages: [] }); }, index);
    await page.waitForFunction(() => document.querySelector('.claude-empty-icon')?.classList.contains('is-animated'));
    assert.equal(await welcome.getAttribute('data-welcome-icon'), id, 'every bundled animation can be selected');
    const asset = await welcome.locator('video,img').getAttribute('src');
    assert.ok(asset.startsWith('data:'), 'test fixture loads the bundled asset without a remote request');
    await page.evaluate(() => { Math.random = () => .99; window.setSession({ contextTokens: 42 }); });
    assert.equal(await welcome.getAttribute('data-welcome-icon'), id, 'rerenders do not reroll the current animation');
    if (id !== 'laptop') {
      await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(100);
      assert.equal(await welcome.locator('img').count(), 0, 'reduced motion unmounts animated GIFs');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForFunction(() => document.querySelector('.claude-empty-icon img')?.naturalWidth > 0);
      await page.evaluate(() => window.setActive(false)); await page.waitForTimeout(100);
      assert.equal(await welcome.locator('img').count(), 0, 'inactive tabs stop GIF playback');
      await page.evaluate(() => window.setActive(true));
      await page.waitForFunction(() => document.querySelector('.claude-empty-icon img')?.naturalWidth > 0);
      assert.equal(await welcome.getAttribute('data-welcome-icon'), id);
    }
  }
  await page.evaluate(() => { Math.random = window.originalRandom; });
  console.log('ok welcome animation frames, stable layout, reduced motion, inactive tab pause and static fallback');
  await page.clock.setFixedTime(new Date(2026,9,24,12,0));await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForFunction(()=>document.querySelector('.claude-empty-title')?.textContent==='Good afternoon, TEST-DESKTOP');assert.equal(await page.locator('.claude-empty-title').getAttribute('lang'),'en');
  console.log('ok Claude shares the English time greeting and native computer name');

  await page.evaluate(()=>window.setSession({busy:false,ready:true,messages:[{id:'link',role:'assistant',content:'[Open page](./test%20page.html) [Website](https://example.com)',timestamp:Date.now()}]}));
  const local=page.getByRole('link',{name:'Open page',exact:true});await local.click();assert.deepEqual(await page.evaluate(()=>window.nativeActions.at(-1)),{name:'openUrl',args:['D:/Test/test page.html']});
  await page.getByRole('link',{name:'Website',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.nativeActions.at(-1).args),['https://example.com']);
  await local.click({button:'right'});await page.locator('.term-ctx-menu').getByRole('button',{name:'Copy link address',exact:true}).click();assert.equal(await page.evaluate(()=>window.copiedText),'D:/Test/test page.html');
  await local.click({button:'right'});await page.locator('.term-ctx-menu').getByRole('button',{name:'Reveal in File Explorer',exact:true}).click();assert.equal(await page.evaluate(()=>window.nativeActions.at(-1).name),'showInFolder');
  await local.evaluate(el=>window.getSelection().selectAllChildren(el));await local.click({button:'right'});await page.locator('.term-ctx-menu').getByRole('button',{name:/^Copy Ctrl/}).dispatchEvent('mousedown');assert.equal(await page.evaluate(()=>window.copiedText),'Open page');
  await local.click({button:'right'});await page.locator('.term-ctx-menu').getByRole('button',{name:/^Paste Ctrl/}).dispatchEvent('mousedown');assert.deepEqual(await page.evaluate(()=>window.actions.at(-1)),{type:'APPEND_GAMBIT_DRAFT',id:'scroll',text:'pasted text'});
  console.log('ok Claude local files, website clicks, link actions, selection copy and paste into draft');
  assert.deepEqual(errors, []);
} finally {
  await page.evaluate(() => window.stopStream?.()).catch(() => {});
  await browser.close(); await new Promise(accept => server.close(accept));
  for (const file of ['fixture.js', 'fixture.css']) await unlink(join(directory, file));
  await rmdir(directory);
}
