// Real OpenCode conversation, composer and session store; the native transport replays a recorded OpenCode 2.2.4 turn.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-opencode-ui-'));
const recorded = await readFile(new URL('./fixtures/opencode-turn.json', import.meta.url), 'utf8');
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {OpenCodeConversation} from './src/components/center/OpenCodeConversation';
    import {Gambit} from './src/components/center/Gambit';
    import {useOpenCodeSession,sendOpenCodeMessage,interruptOpenCode} from './src/lib/opencode-session';
    import './src/styles/global.css';import './src/components/center/TierTerminal.css';
    function Fixture(){const [draft,setDraft]=useState('');const s=useOpenCodeSession('a');window.currentState=s;return <div className="panel-center">
      <div className="host"><OpenCodeConversation sessionId="a" cwd="D:/Test" isActive/></div>
      <Gambit sessionId="a" draft={draft} onDraftChange={setDraft} onClose={()=>{}} onSend={text=>sendOpenCodeMessage('a',text)} opencode running={s.busy} onCancel={()=>interruptOpenCode('a')} leftPanelHidden rightPanelHidden workspaceName="Test" toolIcon={<span>◈</span>}/>
    </div>};createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg'], nodePaths: [join(project, 'node_modules')],
  loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.gif': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/shiki$/ }, () => ({ path: 'syntax', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)clipboard$/ }, () => ({ path: 'clipboard', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
    b.onResolve({ filter: /\.svg\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?raw', '')), namespace: 'svg' }));
    b.onLoad({ filter: /.*/, namespace: 'svg' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'store' ? `
      const state={theme:'dark',gambitEnterToSend:true,terminals:[{id:'a',tool:'opencode',folderPath:'D:/Test'}]},dispatch=action=>(window.actions??=[]).push(action);
      export function useAppLanguage(){return 'en'};export function useAppState(){return {state,dispatch}};
    ` : args.path === 'syntax' ? `
      export async function tokenizeFile(){return null};export async function tokenizeByLang(){return null};export function getShikiTheme(){return 'dark'};
    ` : args.path === 'clipboard' ? `
      export async function clipboardWrite(text){window.copiedText=text};export async function clipboardRead(){return ''};
    ` : args.path === 'event' ? `
      export async function listen(name,fn){window.listener=fn;return()=>{}};
    ` : `
      const recorded=${recorded};const session=recorded.events.find(e=>e.data.sessionID).data.sessionID;
      window.calls=[];
      window.emit=event=>{const start=window.calls.find(c=>c.name==='opencode_session_start');window.listener({payload:{id:'a',generation:start.generation,event:{...event,data:{sessionID:session,...event.data}}}})};
      window.replay=async(until)=>{for(const event of recorded.events){if(until&&event.type===until)return;window.emit(event);await new Promise(r=>setTimeout(r,5))}};
      export const isTauri=false,commands=new Proxy({},{get:(_,name)=>async()=>name==='computerName'?'TEST-DESKTOP':undefined});
      export async function invoke(name,args){window.calls.push({name,...args});
        if(name==='opencode_session_start')return {session:{id:session,title:'',agent:'build',model:{id:'deepseek-flash',providerID:'echobird'},tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}}},
          models:[{id:'deepseek-flash',providerID:'echobird',name:'DeepSeek Flash',variants:['low','high','max'],context:200000},{id:'big-pickle',providerID:'opencode',name:'Big Pickle',variants:[],context:100000}],
          agents:[{id:'build',name:'Build',description:'The default agent.',mode:'primary'},{id:'plan',name:'Plan',description:'Plan without editing.',mode:'primary'},{id:'general',name:'General',mode:'subagent'}],
          commands:[{name:'init',description:'guided AGENTS.md setup'},{name:'review',description:'review changes'}],messages:[],cursor:null,permissions:[],forms:[],running:false};
        if(name==='opencode_session_request'&&args.op==='prompt'){setTimeout(()=>window.replay(window.stopAt),0);return {data:{id:recorded.events[0].data.inboxID,type:'user',payload:{text:args.params.text},time:{created:Date.now()}}}}
        if(name==='opencode_session_request'&&args.op==='interrupt'){window.emit({type:'session.execution.interrupted',id:'evt_stop',created:Date.now(),data:{reason:'user'}});return {data:{interrupted:true}}}
        return null;
      }
    ` }));
  } }],
});
const html = `<!doctype html><link rel="stylesheet" href="/fixture.css"><style>
*{box-sizing:border-box}body{margin:0}:root{--font:Arial,sans-serif;--mono:monospace;--accent:#b4937c;--bg-terminal:#211d19;--bg-panel:#29231f;--bg-hover:#39312a;--text-1:#ded8cf;--text-2:#bdb4aa;--text-3:#9d948b;--border:#4c4239;--shape-radius-btn:8px;--shape-radius-panel:14px;--shadow-rgb:0,0,0}.panel-center,.host{height:100vh;width:100%}.panel-center{padding:0!important}
</style><body data-shape="soft"><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  const name = req.url.slice(1);
  if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.setDefaultTimeout(7000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const shot = name => process.env.COFFEE_OPENCODE_SCREENSHOT && page.screenshot({ path: process.env.COFFEE_OPENCODE_SCREENSHOT.replace('.png', `-${name}.png`) });
const calls = op => page.evaluate(op => window.calls.filter(c => c.name === 'opencode_session_request' && c.op === op), op);
try {
  await page.clock.setFixedTime(new Date(2026, 9, 31, 9, 0));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.currentState?.ready);
  assert.equal(await page.locator('.claude-empty-model').textContent(), 'DeepSeek Flash', 'welcome shows the session model');
  assert.equal(await page.locator('.opencode-welcome-icon canvas').count(), 1, 'the welcome shows the OpenCode wordmark');
  await shot('welcome');

  // Composer: model, variant and agent go to the session's own endpoints.
  await page.getByRole('button', { name: 'Select OpenCode model', exact: true }).click();
  await page.getByRole('button', { name: /Big Pickle/ }).click();
  assert.deepEqual((await calls('model')).map(c => c.params), [{ id: 'big-pickle', providerID: 'opencode' }]);
  assert.equal(await page.getByRole('button', { name: 'Reasoning effort' }).count(), 0, 'models without variants hide the effort control');
  await page.getByRole('button', { name: 'Select OpenCode model', exact: true }).click();
  await page.getByRole('button', { name: /DeepSeek Flash/ }).click();
  // The effort slider is the shared one, with Default before the model's own levels, and marks the top level.
  const effort = page.locator('.claude-effort-trigger');
  assert.equal(await effort.innerText(), 'Default');
  await effort.click();
  const slider = page.locator('.claude-effort-control input[type="range"]');
  assert.equal(await slider.getAttribute('max'), '3', 'Default plus low, high and max');
  await slider.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => window.calls.some(c => c.op === 'model' && c.params.variant === 'max'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.claude-effort-trigger')?.classList.contains('is-ultracode'));
  await page.waitForFunction(() => !document.querySelector('.claude-effort-control'));
  await effort.click();
  await slider.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(() => window.calls.at(-1).op === 'model' && !('variant' in window.calls.at(-1).params));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.claude-effort-control'));
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  assert.equal(await page.locator('.codex-control-menu .codex-permission-option').count(), 2, 'sub-agents are not offered as the session agent');
  await page.locator('.codex-control-menu .codex-permission-option', { hasText: 'Plan' }).click();
  assert.deepEqual((await calls('agent')).map(c => c.params), [{ agent: 'plan' }]);
  const input = page.locator('.gambit-textarea');
  await input.fill('/');
  for (const name of ['/model', '/agent', '/effort', '/compact', '/init', '/review']) assert.equal(await page.locator('.codex-control-menu strong', { hasText: new RegExp(`^${name}$`) }).count(), 1, `${name} is offered`);
  await page.keyboard.press('Escape');
  await input.fill('');

  // A full recorded turn: prompt, tool, reply, completion.
  await input.fill('Read readme.txt');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.claude-row--completed'));
  const rows = await page.locator('.claude-row').evaluateAll(rows => rows.map(row => row.className.match(/claude-row--(\w+)/)[1]));
  assert.deepEqual(rows, ['user', 'tool', 'assistant', 'completed']);
  assert.match(await page.locator('.codex-group-heading').textContent(), /Activity 1.*read/);
  assert.equal(await page.locator('.claude-row--assistant').innerText(), 'The readme.txt file contains the single word: hello.');
  assert.equal(await page.locator('.claude-row--user').count(), 1, 'the prompt is shown once though both the reply and the event carry it');
  assert.equal(await page.locator('.codex-working').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.actions.filter(a => a.type === 'SET_SESSION_TOKEN').map(a => a.token).slice(-1)), [await page.evaluate(() => window.currentState.nativeId)]);
  await page.locator('.codex-group-heading').click();
  await page.locator('.codex-tool .claude-tool-heading').click();
  assert.match(await page.locator('.codex-tool-body').textContent(), /readme\.txt/);
  await shot('turn');

  // Approvals and questions while a turn runs.
  await page.evaluate(() => window.emit({ type: 'session.execution.started', data: {} }));
  await page.evaluate(() => window.emit({ type: 'permission.asked', data: { id: 'per_1', action: 'read', resources: ['.env'], save: ['*'] } }));
  await page.getByText('Approval required').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Always allow' }).count(), 1);
  await page.getByRole('button', { name: 'Allow once' }).click();
  assert.deepEqual((await calls('permission.reply')).map(c => c.params), [{ requestID: 'per_1', decision: 'once' }]);
  assert.equal(await page.getByText('Approval required').count(), 0);
  await page.evaluate(() => window.emit({ type: 'form.created', data: { form: { id: 'frm_1', title: 'Questions', fields: [{ key: 'q0', title: 'Color preference', description: 'Which color do you prefer?', type: 'string', options: [{ value: 'Red', label: 'Red' }, { value: 'Blue', label: 'Blue' }], custom: true }] } } }));
  await page.getByText('Color preference').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Submit' }).isDisabled(), true, 'an unanswered required field blocks submit');
  await page.getByText('Blue', { exact: true }).click();
  await shot('question');
  await page.getByRole('button', { name: 'Submit' }).click();
  assert.deepEqual((await calls('form.reply')).map(c => c.params), [{ formID: 'frm_1', answer: { q0: 'Blue' } }]);

  // Stop: the button and Escape interrupt the running turn.
  assert.equal(await page.getByRole('button', { name: 'Stop' }).count(), 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('.claude-row--interrupted'));
  assert.equal((await calls('interrupt')).length, 1);

  // A process exit offers a reconnect and shows why.
  await page.evaluate(() => window.emit({ type: 'coffee.exit', data: { code: 1, detail: 'This OpenCode version cannot host desktop conversations.' } }));
  await page.getByRole('button', { name: 'Reconnect OpenCode' }).waitFor();
  assert.match(await page.locator('.claude-session-error').textContent(), /cannot host desktop conversations/);
  await shot('exit');
  assert.deepEqual(errors, []);
  console.log('ok OpenCode welcome, model/variant/agent controls, recorded turn, approval, question, stop and exit');
} catch (error) {
  console.error('Browser errors:', errors, 'Visible text:', (await page.locator('body').innerText()).slice(0, 1800));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  for (const name of ['fixture.js', 'fixture.css']) await unlink(join(directory, name)).catch(() => {});
  await rmdir(directory);
}
