// Real task views and desktop stores; isolate native transport and terminal I/O.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-task-send-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
  import React from 'react';import {createRoot} from 'react-dom/client';import {TaskBoard} from './src/components/right/TaskBoard';
  import {retainClaudeSession,getClaudeConnection} from './src/lib/claude-session';import {retainCodexSession,getCodexConnection} from './src/lib/codex-session';
  window.calls=[];window.saved=[{id:'task',title:'Build a page',description:'Include tests',status:'todo',createdAt:1}];window.events=new Map();
  window.transport=async(name,args={})=>{
    window.calls.push({name,...args});
    if(name==='claude_session_start')return {sessionId:'native-claude',initialization:{},history:{data:'',cursor:0}};
    if(name==='codex_session_start')return {thread:{id:'native-codex',turns:[]},models:[]};
    if(name==='claude_session_send'||name==='terminal_send'||name==='codex_session_request'&&args.method==='turn/start'){
      if(window.holdSend)await new Promise(resolve=>window.finishSend=resolve);
      if(window.failSend)throw Error('Send failed');
      return {turn:{id:'turn'}};
    }
    return {};
  };
  retainClaudeSession('claude',null);retainCodexSession('codex',null);
  window.ready=()=>getClaudeConnection('claude')?.ready&&getCodexConnection('codex')?.ready;
  createRoot(document.getElementById('root')).render(<React.Profiler id="tasks" onRender={()=>{window.taskCommits=(window.taskCommits||0)+1}}><TaskBoard onCountChange={()=>{}}/></React.Profiler>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"', __IS_LINUX__: 'false' },
  plugins: [{ name: 'task-transport', setup(b) {
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onResolve({ filter: /(?:\.\.\/tauri|^\.\.\/\.\.\/tauri)$/ }, () => ({ path: 'native', namespace: 'fixture' }));
    b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'events', namespace: 'fixture' }));
    b.onResolve({ filter: /(?:\.\/|lib\/)terminal-control$/ }, () => ({ path: 'terminal', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', resolveDir: project, contents: {
      store: `import {useSyncExternalStore} from 'react';const p=new URLSearchParams(location.search),listeners=new Set();let state={preInputQueue:[],preInputReveal:0,preInputButton:true,currentLang:'en',activeTerminalId:p.get('tool')||'claude',terminals:['claude','codex','terminal','unready'].map(tool=>({id:tool,tool:tool==='unready'?'claude':tool,claudeMode:'conversation',codexMode:'conversation',folderPath:'D:/test'}))};window.selectSession=id=>{state={...state,activeTerminalId:id};listeners.forEach(fn=>fn())};export const useAppLanguage=()=> 'en';export function useAppState(){return {state:useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state),dispatch(){}}}`,
      native: `export const isTauri=true,invoke=(name,args)=>window.transport(name,args);export const commands={loadTasks:async()=>JSON.stringify(window.saved),saveTasks:async text=>{window.saved=JSON.parse(text)}};`,
      events: `export async function listen(name,fn){window.events.set(name,fn);return ()=>window.events.delete(name)}`,
      terminal: `export const submitTerminalPrompt=(id,text)=>window.transport('terminal_send',{id,text});`,
    }[args.path] }));
    b.onResolve({ filter: /\.(?:svg|png)\?(?:raw|inline)$/ }, args => ({ path: resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'asset' }));
    b.onLoad({ filter: /.*/, namespace: 'asset' }, async args => ({ loader: 'js', contents: 'export default '+JSON.stringify(await readFile(args.path, 'utf8')) }));
  } }],
});
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/?') || req.url === '/') return res.setHeader('Content-Type', 'text/html').end('<link rel="stylesheet" href="/fixture.css"><style>:root{--red:#d77;--text-1:#ddd;--text-2:#aaa;--bg-panel:#222;--accent:#ccd}body{background:#171717;color:#ddd}#root{width:400px;height:720px}</style><div id="root"></div><script src="/fixture.js"></script>');
  if (!['/fixture.js', '/fixture.css'].includes(req.url)) return res.writeHead(404).end();
  res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css').end(await readFile(join(directory, req.url.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const open = async tool => {
    await page.goto('http://127.0.0.1:'+server.address().port+'/?tool='+tool);
    await page.waitForFunction(() => window.ready?.());
    const button = page.locator('.task-note-send');
    await button.waitFor();
    return button;
  };
  for (const tool of ['claude', 'codex', 'terminal']) {
    const button = await open(tool);
    await page.evaluate(() => window.holdSend = true);
    await button.evaluate(el => { el.click(); el.click(); });
    await page.waitForFunction(() => typeof window.finishSend === 'function', null, { timeout: 3000 });
    assert.equal(await button.isDisabled(), true, 'pending sends disable repeated submission');
    const sends = await page.evaluate(() => window.calls.filter(call => ['claude_session_send','terminal_send'].includes(call.name)||call.method==='turn/start'));
    assert.equal(sends.length, 1, 'send exactly once');
    assert.equal(sends[0].id, tool, 'use the focused existing session');
    assert.equal(tool === 'codex' ? sends[0].params.input[0].text : sends[0].text, 'Build a page\n\nInclude tests', 'send the note text, with an old to-do note folded in');
    assert.equal(await page.evaluate(() => window.saved[0].status), 'todo', 'do not mark working before acknowledgement');
    if (tool === 'claude') await page.evaluate(() => window.selectSession('codex'));
    await page.evaluate(() => window.finishSend());
    await page.waitForFunction(() => document.querySelector('.task-board')?.getAttribute('aria-busy') === 'false');
    await page.waitForFunction(() => window.saved[0].status === 'working');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.name.endsWith('_session_start')).length), 2, 'sending never creates another session');
  }
  for (const tool of ['claude', 'codex', 'terminal']) {
    const button = await open(tool);
    await page.evaluate(() => window.failSend = true);
    await button.click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(() => window.saved[0].status), 'todo');
    assert.equal(await page.locator('.task-note-body').inputValue(), 'Build a page\n\nInclude tests', 'failed sends preserve the note');
  }
  const edited = await open('claude');
  await page.evaluate(() => window.holdSend = true);
  await edited.click();
  await page.waitForFunction(() => typeof window.finishSend === 'function');
  await page.locator('.task-note-preview').dblclick();await page.locator('.task-note-body').fill('New unsent task');
  await page.evaluate(() => window.finishSend());
  await page.waitForFunction(() => document.querySelector('.task-board')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.evaluate(() => window.saved[0].status), 'todo', 'acknowledging an older send must not promote newly edited content');
  assert.equal(await page.locator('.task-note-body').inputValue(), 'New unsent task');
  const button = await open('unready');
  assert.equal(await button.isDisabled(), true, 'desktop sessions must be ready before sending');
  await page.evaluate(() => window.selectSession(null));
  assert.equal(await button.isDisabled(), true, 'no target disables sending');
  const plan = await open('claude');
  await page.locator('.task-note-preview').dblclick();await page.locator('.task-note-body').fill('/plan Inspect layout');
  await plan.click();
  await page.waitForFunction(() => window.saved[0].status === 'working');
  const calls = await page.evaluate(() => window.calls);
  const planIndex = calls.findIndex(call => call.name === 'claude_session_control' && call.request.subtype === 'set_permission_mode');
  const sendIndex = calls.findIndex(call => call.name === 'claude_session_send');
  assert.ok(planIndex >= 0 && sendIndex > planIndex, 'retain the composer plan-command behavior');
  assert.equal(calls[sendIndex].text, 'Inspect layout');
  await open('claude');
  const commits = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const previous = window.taskCommits;
    const start = window.calls.find(call => call.name === 'claude_session_start');
    const emit = event => window.events.get('claude-session-event')({payload:{id:'claude',generation:start.generation,event}});
    emit({type:'assistant',message:{id:'stream',content:[{type:'text',text:'Streaming progress'}]}});
    emit({type:'result',subtype:'success',result:'Done'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {previous,current:window.taskCommits};
  });
  assert.equal(commits.current, commits.previous, 'streamed conversation content must not redraw the task board when send availability is unchanged');
  // Notes start collapsed; a click opens or closes one, a double-click edits it, leaving ends editing.
  await open('claude');
  const note = page.locator('.task-note-body');
  const preview = page.locator('#root .task-note-preview');
  assert.equal(await note.getAttribute('aria-expanded'), 'false', 'notes start collapsed');
  assert.equal(await note.evaluate(el => el.readOnly), true, 'a collapsed note is not editable');
  await preview.dblclick();
  assert.equal(await note.evaluate(el => el.readOnly), false, 'a double-click edits');
  assert.equal(await note.getAttribute('aria-expanded'), 'true', 'editing shows the note');
  const long = Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n');
  await note.fill(long);
  await page.waitForFunction(text => window.saved[0].title === text, long);
  await page.mouse.click(20, 700);
  assert.equal(await note.evaluate(el => el.readOnly), true, 'a press anywhere else ends editing');
  await note.click();
  assert.equal(await note.getAttribute('aria-expanded'), 'false', 'a click collapses an open note');
  // Collapsed, the note shows a two-line preview that ends in an ellipsis because there is more.
  const collapsed = await preview.evaluate(el => el.getBoundingClientRect().height);
  const twoLines = await preview.evaluate(el => { const s = getComputedStyle(el); return parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + 2 * parseFloat(s.lineHeight); });
  assert.ok(Math.abs(collapsed - twoLines) < 1, `a collapsed note shows two lines (${collapsed} vs ${twoLines})`);
  assert.equal(await preview.evaluate(el => getComputedStyle(el).webkitLineClamp), '2', 'the preview clamps to two lines with an ellipsis');
  assert.ok(await preview.evaluate(el => el.scrollHeight > el.clientHeight + 1), 'the clamped preview has more text to open');
  // Nothing of a third line shows: the clipped box holds exactly two lines of text.
  assert.ok(await preview.evaluate(el => { const s = getComputedStyle(el); return Math.abs(el.clientHeight - 2 * parseFloat(s.lineHeight)) < 1; }), 'no part of a third line shows');
  await preview.hover();
  assert.equal(await page.locator('.cc-scrollbar:not(.is-empty)').count(), 0, 'a collapsed note shows no scrollbar');
  assert.equal(await page.locator('.task-note-resize').isVisible(), false, 'a collapsed note has no resize grip');
  await preview.click();
  assert.equal(await note.getAttribute('aria-expanded'), 'true', 'a click expands');
  const expanded = await note.evaluate(el => el.getBoundingClientRect().height);
  assert.ok(expanded > 320 && expanded <= 480, 'an expanded note grows up to its cap');
  assert.ok(await note.evaluate(el => el.scrollHeight > el.clientHeight), 'content past the cap scrolls');
  await note.hover();
  await page.locator('.cc-scrollbar:not(.is-empty)').waitFor({ state: 'attached' });
  assert.equal(await page.locator('.task-note-resize').isVisible(), true, 'an expanded note can be resized');
  assert.equal(await note.evaluate(el => el.readOnly), true, 'a click does not start editing');
  // Dragging from a read-only body moves the card: no text selection, a dashed outline stays in place, the drop does not toggle.
  const box = await note.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + 40, box.y + 80, { steps: 5 });
  const card = page.locator('.task-note-card').first();
  assert.equal(await card.evaluate(el => el.classList.contains('dragging')), true, 'dragging the body drags the card');
  assert.equal(await card.evaluate(el => getComputedStyle(el).outlineStyle), 'dashed', 'the dragged note leaves a dashed outline');
  assert.equal(await page.locator('#root .task-note-body').evaluate(el => getComputedStyle(el).userSelect), 'none', 'a read-only body cannot have its text selected by a drag');
  await page.mouse.up();
  assert.equal(await note.getAttribute('aria-expanded'), 'true', 'dropping does not collapse the note');
  await note.click();
  assert.equal(await note.getAttribute('aria-expanded'), 'false', 'the next click still toggles');
  await preview.click();
  // Dragging a note slides the others out of the way and moves its dashed outline to the drop slot.
  await page.evaluate(() => window.events.get('tasks-changed')({ payload: JSON.stringify(['A', 'B', 'C'].map((title, i) => ({ id: title, title, status: 'todo', createdAt: i }))) }));
  const cards = page.locator('#root .task-note-card');
  await page.waitForFunction(() => document.querySelectorAll('#root .task-note-card').length === 3);
  const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
  await page.mouse.move(first.x + 60, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(first.x + 60, second.y + second.height * 0.75, { steps: 8 });
  const moved = await cards.evaluateAll(els => els.map(el => Math.round(new DOMMatrix(el.style.transform || 'none').m42)));
  assert.ok(moved[1] < 0, 'the passed note slides up out of the way '+moved);
  assert.ok(moved[0] > 0, 'the dashed outline slides down to the drop slot '+moved);
  assert.equal(moved[2], 0, 'notes past the slot stay put');
  await page.mouse.up();
  await page.waitForFunction(() => window.saved.map(task => task.title).join() === 'B,A,C');
  assert.deepEqual(await cards.evaluateAll(els => els.map(el => el.style.transform)), ['', '', ''], 'slide offsets clear after the drop');
  // A note that already shows in full (a line or two) does not open on click, so it never shows a resize grip.
  const shortNote = page.locator('#root [data-note-id="C"]');
  await shortNote.locator('.task-note-preview').click();
  assert.equal(await shortNote.locator('.task-note-body').getAttribute('aria-expanded'), 'false', 'a short note stays as it is');
  assert.equal(await shortNote.locator('.task-note-resize').isVisible(), false, 'a short note shows no resize grip');
  // The + button adds an empty note in edit mode, and it stays editable after the add animation (until the user clicks away).
  await page.clock.install();
  await open('claude');
  await page.locator('.task-fab-simple').click();
  const fresh = page.locator('#root .task-note-body').first();
  assert.equal(await fresh.inputValue(), '', 'a new note starts empty');
  await page.clock.runFor(500);
  assert.equal(await fresh.evaluate(el => el.readOnly), false, 'a new note stays in edit mode');
  assert.equal(await fresh.evaluate(el => document.activeElement === el), true, 'a new note has the caret');
  await page.keyboard.type('fresh note');
  await page.waitForFunction(() => window.saved[0].title === 'fresh note');
  // Pressing a note never starts a text selection.
  const pressPrevented = selector => page.evaluate(sel => { const el = document.querySelector(sel); const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }); el.dispatchEvent(ev); window.dispatchEvent(new PointerEvent('pointerup')); return ev.defaultPrevented; }, selector);
  assert.equal(await pressPrevented('#root .task-note-card'), true, 'note press does not select text');
  assert.deepEqual(errors, []);
  console.log('OK: note, category and list send to existing Claude/Codex desktop and terminal sessions, acknowledge before promotion, prevent duplicates, preserve failures and disable unavailable targets');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
