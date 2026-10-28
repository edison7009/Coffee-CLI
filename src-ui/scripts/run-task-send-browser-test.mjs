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
      store: `import {useSyncExternalStore} from 'react';const p=new URLSearchParams(location.search),listeners=new Set();let state={taskViewMode:p.get('view')||'note',currentLang:'en',activeTerminalId:p.get('tool')||'claude',terminals:['claude','codex','terminal','unready'].map(tool=>({id:tool,tool:tool==='unready'?'claude':tool,claudeMode:'conversation',codexMode:'conversation',folderPath:'D:/test'}))};window.selectSession=id=>{state={...state,activeTerminalId:id};listeners.forEach(fn=>fn())};export const useAppLanguage=()=> 'en';export function useAppState(){return {state:useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state),dispatch(){}}}`,
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
  const open = async (tool, view = 'note') => {
    await page.goto('http://127.0.0.1:'+server.address().port+'/?tool='+tool+'&view='+view);
    await page.waitForFunction(() => window.ready?.());
    const button = page.locator(view === 'note' ? '.task-note-send' : view === 'prompt' ? '.task-prompt-send' : '.task-slot-send');
    await button.waitFor();
    return button;
  };
  for (const tool of ['claude', 'codex', 'terminal']) for (const view of ['note', 'prompt', 'list']) {
    const button = await open(tool, view);
    await page.evaluate(() => window.holdSend = true);
    await button.evaluate(el => { el.click(); el.click(); });
    await page.waitForFunction(() => typeof window.finishSend === 'function', null, { timeout: 3000 });
    assert.equal(await button.isDisabled(), true, 'pending sends disable repeated submission');
    const sends = await page.evaluate(() => window.calls.filter(call => ['claude_session_send','terminal_send'].includes(call.name)||call.method==='turn/start'));
    assert.equal(sends.length, 1, 'send exactly once');
    assert.equal(sends[0].id, tool, 'use the focused existing session');
    const body = view === 'prompt' ? 'Include tests' : 'Build a page\n\nInclude tests';
    assert.equal(tool === 'codex' ? sends[0].params.input[0].text : sends[0].text, body, 'preserve each view\'s message content');
    assert.equal(await page.evaluate(() => window.saved[0].status), 'todo', 'do not mark working before acknowledgement');
    if (tool === 'claude' && view === 'note') await page.evaluate(() => window.selectSession('codex'));
    await page.evaluate(() => window.finishSend());
    await page.waitForFunction(() => document.querySelector('.task-board')?.getAttribute('aria-busy') === 'false');
    if (view !== 'prompt') await page.waitForFunction(() => window.saved[0].status === 'working');
    else assert.equal(await page.evaluate(() => window.saved[0].status), 'todo', 'prompt mode does not change task priority');
    assert.equal(await page.evaluate(() => window.calls.filter(call => call.name.endsWith('_session_start')).length), 2, 'sending never creates another session');
  }
  for (const tool of ['claude', 'codex', 'terminal']) {
    const button = await open(tool);
    await page.evaluate(() => window.failSend = true);
    await button.click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.evaluate(() => window.saved[0].status), 'todo');
    assert.equal(await page.locator('.task-note-body').inputValue(), 'Build a page', 'failed sends preserve the note');
  }
  const edited = await open('claude');
  await page.evaluate(() => window.holdSend = true);
  await edited.click();
  await page.waitForFunction(() => typeof window.finishSend === 'function');
  await page.locator('.task-note-body').fill('New unsent task');
  await page.evaluate(() => window.finishSend());
  await page.waitForFunction(() => document.querySelector('.task-board')?.getAttribute('aria-busy') === 'false');
  assert.equal(await page.evaluate(() => window.saved[0].status), 'todo', 'acknowledging an older send must not promote newly edited content');
  assert.equal(await page.locator('.task-note-body').inputValue(), 'New unsent task');
  const button = await open('unready');
  assert.equal(await button.isDisabled(), true, 'desktop sessions must be ready before sending');
  await page.evaluate(() => window.selectSession(null));
  assert.equal(await button.isDisabled(), true, 'no target disables sending');
  const plan = await open('claude');
  await page.locator('.task-note-body').fill('/plan Inspect layout');
  await plan.click();
  await page.waitForFunction(() => window.saved[0].status === 'working');
  const calls = await page.evaluate(() => window.calls);
  const planIndex = calls.findIndex(call => call.name === 'claude_session_control' && call.request.subtype === 'set_permission_mode');
  const sendIndex = calls.findIndex(call => call.name === 'claude_session_send');
  assert.ok(planIndex >= 0 && sendIndex > planIndex, 'retain the composer plan-command behavior');
  assert.equal(calls[sendIndex].text, 'Inspect layout\n\nInclude tests');
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
  assert.deepEqual(errors, []);
  console.log('OK: note, category and list send to existing Claude/Codex desktop and terminal sessions, acknowledge before promotion, prevent duplicates, preserve failures and disable unavailable targets');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
