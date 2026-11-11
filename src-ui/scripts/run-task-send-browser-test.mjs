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
      store: `import {useSyncExternalStore} from 'react';const p=new URLSearchParams(location.search),listeners=new Set();let state={preInputQueue:[],preInputReveal:0,preInputButton:true,currentLang:'en',activeTerminalId:p.get('tool')||'claude',terminals:['claude','codex','terminal','unready'].map(tool=>({id:tool,tool:tool==='unready'?'claude':tool,claudeMode:'conversation',codexMode:'conversation',folderPath:'D:/test'}))};window.selectSession=id=>{state={...state,activeTerminalId:id};listeners.forEach(fn=>fn())};window.addBlankTab=()=>{state={...state,terminals:[...state.terminals,{id:'blank',folderPath:'D:/test'}],activeTerminalId:'blank'};listeners.forEach(fn=>fn())};export const useAppLanguage=()=> 'en';export function useAppState(){return {state:useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state),dispatch(action){(window.actions||=[]).push(action)}}}`,
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
  // A click on a note's text sends it.
  const open = async tool => {
    await page.goto('http://127.0.0.1:'+server.address().port+'/?tool='+tool);
    await page.waitForFunction(() => window.ready?.());
    const note = page.locator('#root .task-note-preview').first();
    await note.waitFor();
    return note;
  };
  // A click puts the note into the current conversation's composer; nothing is sent from the board.
  for (const tool of ['claude', 'codex', 'terminal']) {
    const note = await open(tool);
    await note.click();
    const actions = await page.evaluate(() => window.actions || []);
    const expected = [{ type: 'APPEND_GAMBIT_DRAFT', id: tool, text: 'Build a page\n\nInclude tests' }];
    // A terminal tab's composer is closed in this fixture, so it opens first; conversations always show theirs.
    assert.deepEqual(actions, tool === 'terminal' ? [{ type: 'TOGGLE_GAMBIT' }, ...expected] : expected, tool + ': the note lands in the composer');
    assert.equal(await page.evaluate(() => window.calls.filter(call => ['claude_session_send','terminal_send'].includes(call.name)||call.method==='turn/start').length), 0, 'nothing is sent');
    assert.equal(await page.evaluate(() => window.saved[0].status), 'todo', 'the note keeps its state');
    assert.equal(await note.textContent(), 'Build a page\n\nInclude tests', 'and stays on the board');
    await page.evaluate(() => { window.actions = []; });
  }
  // A tab with no tool yet takes the note too, opening its composer.
  const blank = await open('claude');
  await page.evaluate(() => { window.actions = []; window.addBlankTab(); });
  await blank.click();
  assert.deepEqual(await page.evaluate(() => window.actions), [{ type: 'TOGGLE_GAMBIT' }, { type: 'APPEND_GAMBIT_DRAFT', id: 'blank', text: 'Build a page\n\nInclude tests' }], 'a tab with no tool gets the note in its composer');
  // With no tab at all the click does nothing.
  const none = await open('claude');
  await page.evaluate(() => { window.actions = []; window.selectSession(null); });
  await none.click();
  assert.deepEqual(await page.evaluate(() => window.actions), [], 'with no session the click does nothing');
  // Notes another window wrote land through the sync event (a reload resets the fixture's saved notes).
  const setNotes = async notes => {
    await page.evaluate(list => window.events.get('tasks-changed')({ payload: JSON.stringify(list) }), notes);
    await page.waitForFunction(first => document.querySelector('#root .task-note-preview')?.textContent === first, notes[0].title);
  };
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
  // Notes are read-only: no editor, no add, edit, copy or send buttons; at most three lines, then an ellipsis.
  await open('claude');
  await setNotes([{ id: 'long', title: Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n'), status: 'todo', createdAt: 1 }]);
  const preview = page.locator('#root .task-note-preview');
  for (const gone of ['textarea', '.task-note-edit', '.task-note-copy', '.task-note-send', '.task-fab-simple', '.task-note-actions']) assert.equal(await page.locator('#root ' + gone).count(), 0, gone + ' is gone');
  assert.equal(await preview.evaluate(el => getComputedStyle(el).webkitLineClamp), '3', 'a note clamps to three lines');
  assert.ok(await preview.evaluate(el => el.scrollHeight > el.clientHeight + 1), 'a long note is cut off');
  assert.ok(await preview.evaluate(el => { const s = getComputedStyle(el); return Math.abs(el.clientHeight - 3 * parseFloat(s.lineHeight)) < 1; }), 'exactly three lines show');
  assert.equal(await preview.evaluate(el => getComputedStyle(el).userSelect), 'none', 'note text cannot be selected by a drag');
  // Dragging a note slides the others out of the way and moves its dashed outline to the drop slot; the drop does not send.
  await page.evaluate(() => window.events.get('tasks-changed')({ payload: JSON.stringify(['A', 'B', 'C'].map((title, i) => ({ id: title, title, status: 'todo', createdAt: i }))) }));
  const cards = page.locator('#root .task-note-card');
  await page.waitForFunction(() => document.querySelectorAll('#root .task-note-card').length === 3);
  const sentBefore = await page.evaluate(() => (window.actions || []).filter(action => action.type === 'APPEND_GAMBIT_DRAFT').length);
  const first = await cards.nth(0).boundingBox(), second = await cards.nth(1).boundingBox();
  await page.mouse.move(first.x + 60, first.y + first.height / 2); await page.mouse.down();
  await page.mouse.move(first.x + 60, second.y + second.height * 0.75, { steps: 8 });
  assert.equal(await cards.nth(0).evaluate(el => getComputedStyle(el).outlineStyle), 'dashed', 'the dragged note leaves a dashed outline');
  const moved = await cards.evaluateAll(els => els.map(el => Math.round(new DOMMatrix(el.style.transform || 'none').m42)));
  assert.ok(moved[1] < 0, 'the passed note slides up out of the way '+moved);
  assert.ok(moved[0] > 0, 'the dashed outline slides down to the drop slot '+moved);
  assert.equal(moved[2], 0, 'notes past the slot stay put');
  await page.mouse.up();
  await page.waitForFunction(() => window.saved.map(task => task.title).join() === 'B,A,C');
  assert.deepEqual(await cards.evaluateAll(els => els.map(el => el.style.transform)), ['', '', ''], 'slide offsets clear after the drop');
  assert.equal(await page.evaluate(() => (window.actions || []).filter(action => action.type === 'APPEND_GAMBIT_DRAFT').length), sentBefore, 'a drop does not fill the composer');
  // At rest a note is just its text. On hover a soft glow follows the pointer and the trash slides in at the right
  // end while the text fades beneath it without moving.
  const tabCard = page.locator('#root [data-note-id="B"]');
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => [...document.querySelectorAll('#root .task-note-card')].every(el => getComputedStyle(el).transform === 'none' && !el.getAnimations().length));
  const restCard = await tabCard.boundingBox(), restLine = await tabCard.locator('.task-note-preview').boundingBox();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#root [data-note-id="B"] .task-note-quick')).opacity === '0');
  await page.mouse.move(restCard.x + 30, restCard.y + restCard.height / 2);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#root [data-note-id="B"] .task-note-quick')).opacity === '1' && getComputedStyle(document.querySelector('#root [data-note-id="B"]'), '::before').opacity === '1');
  const glowAt = () => tabCard.evaluate(el => el.style.getPropertyValue('--glow-x'));
  const leftGlow = await glowAt();
  await page.mouse.move(restCard.x + restCard.width - 120, restCard.y + restCard.height / 2);
  assert.ok(parseInt(await glowAt()) > parseInt(leftGlow) + 100, `the glow follows the pointer (${leftGlow} -> ${await glowAt()})`);
  assert.deepEqual(await tabCard.locator('.task-note-quick button').evaluateAll(els => els.map(el => el.classList.contains('task-note-delete'))), [true], 'the trash is the only hover icon');
  const del = await tabCard.locator('.task-note-delete').boundingBox();
  assert.ok(del.x + del.width <= restCard.x + restCard.width, 'the trash sits at the right end');
  assert.equal(await tabCard.locator('.task-note-delete').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', 'a plain icon until aimed at');
  assert.deepEqual(await tabCard.locator('.task-note-preview').boundingBox(), restLine, 'the text does not move');
  assert.ok(/linear-gradient/.test(await tabCard.locator('.task-note-preview').evaluate(el => getComputedStyle(el).webkitMaskImage || getComputedStyle(el).maskImage)), 'the text fades beneath the icon');
  // The trash removes the note without sending it.
  await tabCard.locator('.task-note-delete').click();
  await page.waitForFunction(() => window.saved.map(task => task.title).join() === 'A,C');
  assert.equal(await page.evaluate(() => (window.actions || []).filter(action => action.type === 'APPEND_GAMBIT_DRAFT').length), sentBefore, 'deleting does not fill the composer');
  // Pressing a note never starts a text selection.
  const pressPrevented = selector => page.evaluate(sel => { const el = document.querySelector(sel); const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }); el.dispatchEvent(ev); window.dispatchEvent(new PointerEvent('pointerup')); return ev.defaultPrevented; }, selector);
  assert.equal(await pressPrevented('#root .task-note-card'), true, 'note press does not select text');
  assert.deepEqual(errors, []);
  console.log('OK: read-only notes go into the Claude/Codex desktop and terminal composers on click, never send, reorder and delete');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
