// Returning to a long idle conversation: the real session store and card; only the native transport is isolated.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-cold-return-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
    import {ClaudeConversation} from './src/components/center/ClaudeConversation';
    import {sendClaudeInteractive} from './src/lib/claude-session';
    import {subscribe,tab} from './fixture-tab';
    import './src/styles/global.css';
    function Fixture(){const t=useSyncExternalStore(subscribe,tab);window.send=text=>sendClaudeInteractive(t.id,text);return <div className="host"><ClaudeConversation key={t.id} sessionId={t.id} cwd="D:/Test" resumeToken={t.resumeToken} isActive/></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'], nodePaths: [join(project, 'node_modules')],
  loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.mov': 'dataurl', '.gif': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /fixture-tab$/ }, () => ({ path: 'tab', namespace: 'fixture' }));
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/shiki$/ }, () => ({ path: 'syntax', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)clipboard$/ }, () => ({ path: 'clipboard', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
    b.onResolve({ filter: /\.svg\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?raw', '')), namespace: 'svg' }));
    b.onLoad({ filter: /.*/, namespace: 'svg' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'tab' ? `
      let current={id:'old',resumeToken:'11111111-1111-4111-8111-111111111111'};const listeners=new Set();
      export const tab=()=>current;export const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      window.reopen=()=>{current={id:'old-'+crypto.randomUUID(),resumeToken:'11111111-1111-4111-8111-111111111111'};window.calls=[];listeners.forEach(fn=>fn())};
      window.applyAction=action=>{if(action.type==='RESTART_TERMINAL'){current={id:action.newId,resumeToken:action.fresh?undefined:current.resumeToken};listeners.forEach(fn=>fn())}};
    ` : args.path === 'store' ? `
      import {tab} from 'fixture-tab';
      export function useAppLanguage(){return 'en'};
      export function useAppState(){return {state:{theme:'dark',terminals:[tab()]},dispatch(action){(window.actions??=[]).push(action);window.applyAction(action)}}};
    ` : args.path === 'syntax' ? `
      export async function tokenizeFile(){return null};export async function tokenizeByLang(){return null};export function getShikiTheme(){return 'dark'};
    ` : args.path === 'clipboard' ? `
      export async function clipboardWrite(){};export async function clipboardRead(){return ''};
    ` : args.path === 'event' ? `
      export async function listen(){return()=>{}};
    ` : `
      window.calls=[];
      const ago=minutes=>new Date(Date.now()-minutes*60000).toISOString();
      const history=()=>{const minutes=window.idleMinutes??180,tokens=window.contextTokens??680000;return [
        {type:'user',uuid:'u1',timestamp:ago(minutes+1),message:{role:'user',content:[{type:'text',text:'Earlier question'}]}},
        {type:'assistant',uuid:'a1',timestamp:ago(minutes),message:{id:'m1',role:'assistant',content:[{type:'text',text:'Earlier answer'}],usage:{input_tokens:2,cache_read_input_tokens:tokens,cache_creation_input_tokens:0,output_tokens:10}}},
        ...(window.compacted?[{type:'system',subtype:'compact_boundary',timestamp:ago(minutes)}]:[]),
      ].map(row=>JSON.stringify(row)).join('\\n')};
      export const isTauri=false,commands=new Proxy({},{get:(_,name)=>async()=>name==='computerName'?'TEST-DESKTOP':undefined});
      export async function invoke(name,args){window.calls.push({name,...args});
        if(name==='claude_session_start')return {sessionId:args.resumeToken??'22222222-2222-4222-8222-222222222222',initialization:{},history:{data:args.resumeToken?history():'',cursor:0}};
        if(name==='claude_session_control')return {applied:{},effective:{}};
        if(name==='get_tool_control')return {ready:false,agents:[]};
        return null;
      }
    ` }));
  } }],
});
const html = `<!doctype html><link rel="stylesheet" href="/fixture.css"><style>
*{box-sizing:border-box}body{margin:0}:root{--font:Arial,sans-serif;--mono:monospace;--accent:#b4937c;--bg-terminal:#211d19;--bg-panel:#29231f;--bg-hover:#39312a;--text-1:#ded8cf;--text-2:#bdb4aa;--text-3:#9d948b;--border:#4c4239;--shape-radius-btn:8px;--shape-radius-panel:14px;--shadow-rgb:0,0,0}.host{height:100vh;width:100%}
</style><body data-shape="soft"><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  const name = req.url.slice(1);
  if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.setDefaultTimeout(5000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const sends = () => page.evaluate(() => window.calls.filter(c => c.name === 'claude_session_send').map(c => c.text));
const starts = () => page.evaluate(() => window.calls.filter(c => c.name === 'claude_session_start'));
const ready = () => page.getByText('Earlier answer').waitFor();
const card = page.getByText('Idle for 3h, about 680k of context', { exact: false }).first();
const open = async (setup = () => {}) => { await page.evaluate(setup); await page.evaluate(() => window.reopen()); await ready(); await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_control')); await page.waitForTimeout(50); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await ready();
  await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_control'));
  await page.waitForTimeout(50);

  // Holding the prompt: nothing reaches the CLI until the person chooses.
  assert.equal(await page.evaluate(() => window.send('Keep going')), true);
  await card.waitFor();
  assert.deepEqual(await sends(), [], 'opening and sending into a cold conversation pays nothing yet');
  if (process.env.COFFEE_COLD_SCREENSHOT) await page.screenshot({ path: process.env.COFFEE_COLD_SCREENSHOT });
  assert.equal(await page.evaluate(() => window.send('Second')), false, 'one held prompt at a time');

  // Cancel returns the text to the composer.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForFunction(() => window.actions?.some(a => a.type === 'SET_GAMBIT_DRAFT' && a.draft === 'Keep going'));
  assert.equal(await card.count(), 0);
  assert.deepEqual(await sends(), []);

  // Resume in full sends into the same conversation.
  await page.evaluate(() => window.send('Keep going'));
  await page.getByRole('button', { name: 'Resume in full' }).click();
  await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_send'));
  assert.deepEqual(await sends(), ['Keep going']);
  assert.equal((await starts()).at(-1).resumeToken, '11111111-1111-4111-8111-111111111111');

  // Continuing fresh restarts the tab with a pointer and no resume, then sends the held prompt.
  await open();
  await page.evaluate(() => window.send('Fix the bug'));
  await page.getByRole('button', { name: 'Continue in a new conversation (recommended)' }).click();
  await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_send'));
  const started = (await starts()).at(-1);
  assert.equal(started.resumeToken, null, 'the old history is not re-sent');
  assert.equal(started.continueFrom.token, '11111111-1111-4111-8111-111111111111');
  assert.equal(started.continueFrom.prompt, 'Earlier question');
  assert.equal(started.continueFrom.reply, 'Earlier answer');
  assert.deepEqual(await sends(), ['Fix the bug'], 'the prompt is sent verbatim, without the pointer');

  // No prompt where nothing would be rewritten.
  for (const [label, setup] of [
    ['a short idle', () => { window.idleMinutes = 30; }],
    ['a small context', () => { window.idleMinutes = 180; window.contextTokens = 50000; }],
    ['a compacted context', () => { window.contextTokens = 680000; window.compacted = true; }],
  ]) {
    await open(setup);
    await page.evaluate(() => window.send('Hello'));
    await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_send'));
    assert.deepEqual(await sends(), ['Hello'], `${label} sends directly`);
  }

  // Slash commands pass through, and Don't ask again is remembered.
  await open(() => { window.compacted = false; });
  await page.evaluate(() => window.send('/compact'));
  await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_send'));
  assert.deepEqual(await sends(), ['/compact']);
  await open();
  await page.evaluate(() => window.send('First'));
  await page.getByRole('button', { name: "Don't ask again" }).click();
  await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_send'));
  await open();
  await page.evaluate(() => window.send('Later'));
  await page.waitForFunction(() => window.calls.some(c => c.name === 'claude_session_send'));
  assert.deepEqual(await sends(), ['Later'], 'the choice sticks');
  assert.deepEqual(errors, []);
  console.log('ok cold return: held prompt, cancel, full resume, new conversation pointer, thresholds, slash commands and never');
} catch (error) {
  console.error('Browser errors:', errors, 'Visible text:', (await page.locator('body').innerText()).slice(0, 900));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  for (const name of ['fixture.js', 'fixture.css']) await unlink(join(directory, name)).catch(() => {});
  await rmdir(directory);
}
