// A finished turn folds its thinking and calls into 「工作了 X」, lists the files it changed after the reply, and each
// changed file opens its diff. Isolated browser regression; no Claude process, credentials or user windows.
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
const directory = await mkdtemp(join(tmpdir(), 'coffee-turn-fold-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ClaudeConversation} from './src/components/center/ClaudeConversation';
    import './src/styles/global.css';import './src/components/center/TierTerminal.css';
    function Fixture(){const [active,setActive]=useState(true);window.setActive=setActive;return <div className="host" style={{display:active?'flex':'none'}}><ClaudeConversation sessionId="scroll" cwd="D:/Test" isActive={active}/></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
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
    ` : args.path === 'tauri' ? `export const commands=new Proxy({},{get:(_,name)=>async(...args)=>{(window.nativeActions??=[]).push({name,args});if(name==='gitChanges')return {state:'ok',repo_root:'D:/Test',branch:'main',uncommitted:[{path:'D:/Test/src/a.ts',rel:'src/a.ts',status:'M',added:4,deleted:1}],untracked:[],session_commits:[]};if(name==='computerName')return 'TEST-DESKTOP'}});` : `
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
const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: 'no-preference' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const at = Date.now() - 60000;
const turn = [
  { id: 'u', role: 'user', content: 'Fix the build', timestamp: at },
  { id: 'r', role: 'reasoning', content: 'Look at the build script first.', timestamp: at + 1000, startedAt: at + 1000, endedAt: at + 2000 },
  { id: 'a1', role: 'assistant', content: 'Reading the script.', timestamp: at + 2000 },
  { id: 't1', role: 'tool', toolName: 'Read', toolStatus: 'done', input: { file_path: 'D:/Test/build.js' }, output: 'x', content: '', timestamp: at + 3000 },
  { id: 't2', role: 'tool', toolName: 'Edit', toolStatus: 'done', input: { file_path: 'D:/Test/src/a.ts', old_string: 'a\n', new_string: 'b\nc\n' }, output: 'ok', content: '', timestamp: at + 4000 },
  { id: 't3', role: 'tool', toolName: 'Bash', toolStatus: 'failed', input: { command: 'npm run lint' }, output: 'error', content: '', timestamp: at + 5000 },
  { id: 'a2', role: 'assistant', content: 'Fixed the build.', timestamp: at + 45000, turnStats: { durationMs: 45000, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } } },
];
const actions = () => page.evaluate(() => (window.actions ?? []).filter(action => action.type === 'SET_DIFF_SELECTION').map(action => action.selection));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  // While the turn runs nothing folds, and the group names the step under way with no timer of its own.
  await page.evaluate(messages => window.setSession({ ...window.emptyFixture, busy: true, status: 'tool', startedAt: Date.now(), messages }), [...turn.slice(0, 5), { ...turn[5], toolStatus: 'running' }]);
  await page.locator('.claude-working').waitFor();
  assert.equal(await page.locator('.turn-fold').count(), 0, 'a running turn stays open');
  assert.equal(await page.locator('.claude-tool-group-time, .claude-step-spinner, .claude-elapsed').count(), 1, 'the working line is the only timer');
  assert.equal(await page.locator('.claude-step.is-now .claude-step-pulse').count(), 1, 'the step under way is a breathing dot on the line');
  assert.equal(await page.locator('.claude-step.is-now .claude-step-verb').evaluate(el => getComputedStyle(el).animationName), 'claude-live-step');
  assert.ok(await page.locator('.claude-step.is-now .claude-step-toggle').isDisabled(), 'the step under way does not open yet');
  if (process.env.COFFEE_TURN_SHOT) await page.screenshot({ path: `${process.env.COFFEE_TURN_SHOT}-live.png` });

  // Past five steps, a running line keeps the newest four and folds the rest into 「N steps done」.
  const many = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, role: 'tool', toolName: 'Read', toolStatus: i < 5 ? 'done' : 'running', input: { file_path: 'D:/Test/f' + i + '.ts' }, output: 'x', content: '', timestamp: at + i }));
  await page.evaluate(messages => window.setSession({ messages }), [turn[0], ...many]);
  await page.locator('.claude-rail-more').waitFor();
  assert.equal(await page.locator('.claude-rail-more').innerText(), '2 steps done');
  assert.equal(await page.locator('.claude-rail .claude-step').count(), 4);
  await page.locator('.claude-rail-more').click();
  assert.equal(await page.locator('.claude-rail .claude-step').count(), 6, 'the folded steps open in place');

  // Finished: one quiet line with the time and a failure mark; the reply and its changed files stay in sight.
  await page.evaluate(messages => window.setSession({ busy: false, status: 'idle', messages }), turn);
  await page.locator('.turn-fold').waitFor();
  assert.equal((await page.locator('.turn-fold-label').innerText()).trim(), 'Steps: 4 · 45s');
  assert.deepEqual(await page.locator('.turn-fold-dots i').evaluateAll(dots => dots.map(dot => dot.className)), ['is-think', 'is-tool', 'is-edit', 'is-fail'], 'a dot per step: thought, call, changed file, failure');
  assert.equal(await page.locator('.turn-fold-warn').innerText(), 'Last step failed');
  assert.equal(await page.locator('.claude-tool-group, .claude-reasoning').count(), 0, 'the work hides behind the fold');
  assert.equal(await page.getByText('Reading the script.').count(), 0, 'commentary folds with the work');
  assert.equal(await page.getByText('Fixed the build.').count(), 1, 'the reply stays');
  assert.equal(await page.locator('.turn-files-title').innerText(), 'Files changed: 1');
  assert.deepEqual([await page.locator('.turn-file-badge').innerText(), await page.locator('.turn-file-name').innerText(), await page.locator('.turn-file-dir').innerText()], ['M', 'a.ts', 'src/'], 'an edited file: its badge, name, and folder relative to the conversation');
  if (process.env.COFFEE_TURN_SHOT) await page.screenshot({ path: `${process.env.COFFEE_TURN_SHOT}-folded.png` });

  // A changed file opens its uncommitted diff; the heading's button opens the first file.
  await page.locator('.turn-file').click();
  await page.waitForFunction(() => (window.actions ?? []).some(action => action.type === 'SET_DIFF_SELECTION'));
  assert.deepEqual(await actions(), [{ repoRoot: 'D:/Test', folderPath: 'D:/Test', path: 'D:/Test/src/a.ts', rel: 'src/a.ts', kind: 'uncommitted', added: 4, deleted: 1 }]);

  // Unfolded, every row is back; the edited file in its call row is a link to the same diff, apart from the row's toggle.
  await page.locator('.turn-fold').click();
  await page.getByText('Reading the script.').waitFor();
  assert.equal(await page.locator('.turn-fold').getAttribute('aria-expanded'), 'true');
  const file = page.locator('.claude-step-file');
  assert.equal(await file.innerText(), 'a.ts');
  await file.click();
  await page.waitForFunction(() => (window.actions ?? []).filter(action => action.type === 'SET_DIFF_SELECTION').length === 2);
  assert.equal(await page.locator('.claude-step-detail').count(), 0, 'opening the file does not toggle the row');
  assert.equal(await page.locator('.claude-step--failed .claude-step-error').innerText(), 'error', 'a failed call shows its first error line without opening');
  if (process.env.COFFEE_TURN_SHOT) await page.screenshot({ path: `${process.env.COFFEE_TURN_SHOT}-open.png` });
  await page.locator('.turn-fold').click();
  await page.waitForFunction(() => !document.body.textContent.includes('Reading the script.'));

  // A run that starts with a thought keeps the thought and the calls on one line.
  await page.evaluate(messages => window.setSession({ messages }), [turn[0], turn[1], turn[3], turn[4], turn[6]]);
  await page.locator('.turn-fold').click();
  await page.locator('.claude-rail .claude-step-kind-think').waitFor();
  assert.equal(await page.locator('.claude-rail .claude-step').count(), 3, 'the thought, the read and the edit');
  assert.equal(await page.locator('.claude-reasoning').count(), 0, 'no stray thinking row in place of the line');
  await page.locator('.turn-fold').click();
  // An interrupted turn with no reply reads as stopped.
  await page.evaluate(messages => window.setSession({ messages }), [turn[0], turn[1], turn[3], { ...turn[5], interrupted: true }]);
  await page.waitForFunction(() => document.querySelector('.turn-fold-label')?.textContent.startsWith('Stopped'));
  assert.deepEqual(errors, []);
  console.log('OK: running turns stay open on the line with one timer and fold old steps; finished turns fold into steps · time with a dot per step, list changed files that open their diff, and unfold back to every call');
} finally { await browser.close(); server.close(); }
