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

// COFFEE_TEST_BROWSER=webkit runs the same checks in the engine macOS uses.
const chromium = (await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core'))[process.env.COFFEE_TEST_BROWSER || 'chromium'];
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-turn-title-'));
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
  nodePaths: [join(project, 'node_modules')], loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.mov': 'dataurl', '.gif': 'dataurl' },
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
      window.setSession=patch=>{state={...state,...patch};listeners.forEach(fn=>fn())};window.currentMessages=()=>state.messages;window.emptyFixture={...emptyClaudeState(),ready:true};
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
      export function retainClaudeSession(){return()=>{}};export async function controlClaude(){return {}};export async function respondClaude(){};export function continueClaudeInNewConversation(){};export async function settleClaudeColdReturn(){return ''};
      export async function loadClaudeHistory(){const older=Array.from({length:24},(_,i)=>({id:'older-'+i,role:'user',content:'Older '+i+'\\n\\n'+'Older context. '.repeat(35),timestamp:Date.now()-200000+i}));window.setSession({messages:[...older,...state.messages],historyCursor:0})};
    ` }));
  } }],
});
const html = `<!doctype html><link rel="stylesheet" href="/fixture.css"><style>
*{box-sizing:border-box}body{margin:0;background:#15101d}:root{--font:Arial,sans-serif;--mono:monospace;--accent:#937fa3;--bg-terminal:#15101d;--bg-panel:#231c2b;--bg-hover:#302838;--text-1:#ded5e5;--text-2:#bdb0c7;--text-3:#a597af;--border:#463b50;--gambit-dock-h:180px}#root,.host{height:100vh}.host{width:100%}
</style><body class="gambit-docked"><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(html);
  const name = req.url.slice(1);
  if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
  res.setHeader('Content-Type', `${name.endsWith('.js') ? 'text/javascript' : 'text/css'}; charset=utf-8`);
  res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, reducedMotion: 'no-preference' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const word = () => page.locator('.claude-working .claude-morph-face:not(.is-leaving)').innerText();
const tool = (id, description, extra = {}) => ({ id, role: 'tool', toolName: 'Bash', toolStatus: 'running', input: description === undefined ? { command: 'ls' } : { command: 'ls', description }, output: '', content: '', timestamp: Date.now(), ...extra });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => window.setSession({ ...window.emptyFixture, busy: true, status: 'working', startedAt: Date.now(), messages: [{ id: 'u', role: 'user', content: 'Fix the build', timestamp: Date.now() - 1 }] }));
  await page.locator('.claude-working').waitFor();
  assert.equal(await word(), 'Thinking…', 'the default words fill in before Claude titles the step');

  await page.evaluate(t => window.setSession({ messages: [...window.currentMessages(), t] }), tool('t1', 'Compare the launch page before the fix'));
  await page.waitForFunction(() => document.querySelector('.claude-working .claude-morph-face:not(.is-leaving)')?.textContent === 'Compare the launch page before the fix…');
  const leaving = page.locator('.claude-working .claude-morph-face.is-leaving');
  assert.equal(await leaving.count(), 1, 'the old face leaves while the new one enters');
  assert.equal(await leaving.innerText(), 'Thinking…');
  assert.equal(await page.locator('.claude-working .claude-morph-face.is-entering').evaluate(el => getComputedStyle(el).animationName), 'claude-morph-in');
  assert.equal(await page.locator('.claude-working .claude-working-word').last().evaluate(el => getComputedStyle(el).animationName), 'claude-word-shine', 'the text keeps its shine while it morphs');
  await leaving.waitFor({ state: 'detached' });
  await page.waitForTimeout(250);
  const box = await page.locator('.claude-morph').boundingBox(), text = await page.locator('.claude-working .claude-morph-face').boundingBox();
  assert.ok(Math.abs(box.width - text.width) < 2, `the width follows the new title: ${JSON.stringify({ box, text })}`);

  // A sub-agent's step and a step without a description keep the main title; a newer main step retitles it.
  await page.evaluate(([a, b]) => window.setSession({ messages: [...window.currentMessages(), a, b] }), [tool('t2', 'Inside a sub-agent', { parentId: 'agent' }), tool('t3', undefined)]);
  await page.waitForTimeout(250);
  assert.equal(await word(), 'Compare the launch page before the fix…');
  await page.evaluate(t => window.setSession({ messages: [...window.currentMessages(), t] }), tool('t4', 'Run the browser tests'));
  await page.waitForFunction(() => document.querySelector('.claude-working .claude-morph-face:not(.is-leaving)')?.textContent === 'Run the browser tests…');

  // A long title stays on one line within the status row.
  await page.evaluate(t => window.setSession({ messages: [...window.currentMessages(), t] }), tool('t5', 'Read every stylesheet and replace each fixed font size with the shared type scale variables '.repeat(3)));
  await page.waitForTimeout(400);
  const row = await page.locator('.claude-working').boundingBox(), long = await page.locator('.claude-morph').boundingBox();
  assert.ok(long.width <= 561 && row.height < 40, `long titles truncate on one line: ${JSON.stringify({ row, long })}`);

  // Stopping always says so, whatever the title.
  await page.evaluate(() => window.setSession({ interruptRequested: true }));
  await page.waitForFunction(() => document.querySelector('.claude-working .claude-morph-face:not(.is-leaving)')?.textContent?.startsWith('Stopping'));
  assert.deepEqual(errors, []);
  console.log('OK: the working row shows Claude Code\'s step description with a Claude-style morph, keeps the default words until then, ignores sub-agent steps, truncates long titles and still says Stopping');
} finally { await browser.close(); server.close(); }
