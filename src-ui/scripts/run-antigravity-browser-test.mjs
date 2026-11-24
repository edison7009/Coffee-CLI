// Real Antigravity conversation, composer and session store; the native transport replays a recorded Antigravity CLI 1.5.16 turn.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-antigravity-ui-'));
const recorded = await readFile(new URL('./fixtures/antigravity-turn.json', import.meta.url), 'utf8');
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {AntigravityConversation} from './src/components/center/AntigravityConversation';
    import {Gambit} from './src/components/center/Gambit';
    import {useAntigravitySession,sendAntigravityMessage,abortAntigravity} from './src/lib/antigravity-session';
    import './src/styles/global.css';import './src/components/center/TierTerminal.css';
    function Fixture(){const [draft,setDraft]=useState('');const s=useAntigravitySession('a');window.currentState=s;return <div className="panel-center">
      <div className="host"><AntigravityConversation sessionId="a" cwd="D:/Test" isActive/></div>
      <Gambit sessionId="a" draft={draft} onDraftChange={setDraft} onClose={()=>{}} onSend={text=>sendAntigravityMessage('a',text)} antigravity running={s.busy} onCancel={()=>abortAntigravity('a')} leftPanelHidden rightPanelHidden workspaceName="Test" toolIcon={<span>◈</span>}/>
    </div>};createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'], nodePaths: [join(project, 'node_modules')],
  loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.gif': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
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
      const state={theme:'dark',gambitEnterToSend:true,terminals:[{id:'a',tool:'antigravity',folderPath:'D:/Test'}]},dispatch=action=>(window.actions??=[]).push(action);
      export function useAppLanguage(){return 'en'};export function useAppState(){return {state,dispatch}};
    ` : args.path === 'syntax' ? `
      export async function tokenizeFile(){return null};export async function tokenizeByLang(){return null};export function getShikiTheme(){return 'dark'};
    ` : args.path === 'clipboard' ? `
      export async function clipboardWrite(text){window.copiedText=text};export async function clipboardRead(){return ''};
    ` : args.path === 'event' ? `
      export async function listen(name,fn){window.listener=fn;return()=>{}};
    ` : `
      const recorded=${recorded}; const session=recorded.session.sessionId; window.calls=[];
      window.emit=event=>{if(['agent_message_chunk','agent_thought_chunk','tool_call'].includes(event.params?.update?.sessionUpdate))window.promptActive=true;const start=window.calls.find(c=>c.name==='antigravity_session_start');window.listener({payload:{id:'a',generation:start.generation,event}})};
      window.finish=()=>{for(const event of recorded.events)window.emit(event);window.finishTurn(recorded.result)};
      export const isTauri=false,commands=new Proxy({},{get:(_,name)=>async()=>name==='computerName'?'TEST-DESKTOP':undefined});
      export async function invoke(name,args){window.calls.push({name,...args});
        if(name==='antigravity_session_start')return recorded.session;
        if(name==='antigravity_session_request') {
          if(args.method==='session/prompt'){window.promptActive=false;return new Promise(resolve=>window.finishTurn=resolve);}
          if(args.method==='session/cancel'){if(window.promptActive)window.finishTurn({stopReason:'cancelled'});return null;}
          if(args.method==='session/set_config_option') {
            if(window.failConfig){window.failConfig=false;throw new Error('config rejected');}
            const configOptions=structuredClone(recorded.session.configOptions);configOptions.find(c=>c.id===args.params.configId).currentValue=args.params.value;recorded.session.configOptions=configOptions;return {configOptions};
          }
        }
        return null;
      }

    ` }));
  } }],
});
const html = `<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><style>
*{box-sizing:border-box}body{margin:0}:root{--font:Arial,sans-serif;--mono:monospace;--accent:#b4937c;--bg-terminal:#211d19;--bg-panel:#29231f;--bg-hover:#39312a;--text-1:#ded8cf;--text-2:#bdb4aa;--text-3:#9d948b;--border:#4c4239;--shape-radius-btn:8px;--shape-radius-panel:14px;--shadow-rgb:0,0,0}.panel-center,.host{height:100vh;width:100%}.panel-center{padding:0!important}
</style><body data-shape="soft"><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url.split('?')[0] === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  const name = req.url.slice(1);
  if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
 const page=await browser.newPage({viewport:{width:1100,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Model',exact:true}).waitFor();
 await page.getByRole('button',{name:'Model',exact:true}).click();
 await page.getByRole('button',{name:'Claude Sonnet 4.6 (Thinking)',exact:true}).click();
 await page.waitForFunction(()=>window.currentState.configOptions.find(c=>c.id==='model').currentValue==='claude-sonnet-4-6');
 await page.getByRole('button',{name:'Mode',exact:true}).click();
 await page.getByRole('button',{name:/Accept edits/}).click();
 await page.waitForFunction(()=>window.currentState.configOptions.find(c=>c.id==='mode').currentValue==='accept-edits');
 await page.locator('.claude-effort-trigger').click();
 const slider=page.getByRole('slider');await slider.focus();await slider.press('Home');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.params?.configId==='thought_level').length),0,'thinking previews before commit');
 await page.mouse.click(5,5);await page.waitForFunction(()=>window.currentState.configOptions.find(c=>c.id==='thought_level').currentValue==='low');
 const editor=page.locator('.gambit textarea');await editor.fill('Reply with the test marker');await editor.press('Enter');
 await page.waitForFunction(()=>window.currentState.busy);
 await page.evaluate(()=>window.emit({id:42,method:'session/request_permission',params:{sessionId:window.currentState.sessionId,toolCall:{title:'Run test command'},options:[{optionId:'no',kind:'reject_once',name:'Reject command'},{optionId:'yes',kind:'allow_once',name:'Allow command once'}]}}));
 await page.getByRole('button',{name:'Reject command',exact:true}).click();
 await page.waitForFunction(()=>window.calls.some(c=>c.name==='antigravity_session_respond'&&c.optionId==='no'&&c.requestId==='42'));
 // Antigravity's own tools read like every tool's: a read, a new file (its diff), on the step line.
 await page.evaluate(()=>{const sid=window.currentState.sessionId,up=update=>window.emit({method:'session/update',params:{sessionId:sid,update}});
  up({sessionUpdate:'tool_call',toolCallId:'r1',name:'read_file',kind:'read',title:'File a.txt',status:'in_progress',locations:[{path:'D:/Test/a.txt'}],rawInput:{Path:'D:/Test/a.txt'}});
  up({sessionUpdate:'tool_call_update',toolCallId:'r1',name:'read_file',kind:'read',title:'File a.txt',status:'completed',locations:[{path:'D:/Test/a.txt'}],rawInput:{Path:'D:/Test/a.txt'}});
  up({sessionUpdate:'tool_call',toolCallId:'w1',name:'write_file',kind:'edit',title:'File b.txt',status:'in_progress',locations:[{path:'D:/Test/b.txt'}],rawInput:{Path:'D:/Test/b.txt',Content:'HELLO\n'}});
  up({sessionUpdate:'tool_call_update',toolCallId:'w1',name:'write_file',kind:'edit',title:'File b.txt',status:'completed',content:[{type:'diff',path:'D:/Test/b.txt',newText:'HELLO\n'}]});});
 await page.locator('.claude-step').filter({hasText:'a.txt'}).locator('.claude-step-verb').filter({hasText:/^Read$/}).waitFor();
 await page.evaluate(()=>window.finish());
 await page.getByText('COFFEE_ACP_OK',{exact:true}).waitFor();
 await page.waitForFunction(()=>!window.currentState.busy);
 await page.locator('.turn-fold').waitFor();
 assert.match(await page.locator('.turn-fold-label').innerText(),/^Steps: 2/,'the finished turn folds its steps');
 assert.deepEqual([await page.locator('.turn-file-badge').innerText(),await page.locator('.turn-file-name').innerText()],['A','b.txt'],'the new file is listed after the reply');
 await page.locator('.turn-fold').click();
 assert.equal(await page.locator('.claude-step').filter({hasText:'b.txt'}).locator('.claude-step-file').innerText(),'b.txt','the written file is a link to its diff');
 if(process.env.COFFEE_SCREENSHOT) await page.screenshot({path:process.env.COFFEE_SCREENSHOT.replace('.png','-turn.png')});
 await page.locator('.turn-fold').click();
 await editor.fill('Cancel this turn');await editor.press('Enter');await page.waitForFunction(()=>window.currentState.busy);
 await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='session/cancel').length),1,'cancel immediately reaches an active model/network wait');
 await page.evaluate(()=>window.emit({method:'session/update',params:{sessionId:window.currentState.sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thinking'}}}}));
 await page.waitForFunction(()=>window.currentState.interrupted&&!window.currentState.busy);
 await page.evaluate(()=>window.failConfig=true);
 await page.getByRole('button',{name:'Model',exact:true}).click();await page.getByRole('button',{name:'Gemini 3.8 Flash',exact:true}).click();
 await page.getByText('Error: config rejected',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.currentState.configOptions.find(c=>c.id==='model').currentValue),'claude-sonnet-4-6');
 if(process.env.COFFEE_SCREENSHOT) await page.screenshot({path:process.env.COFFEE_SCREENSHOT,fullPage:true});
 assert.deepEqual(errors,[]);console.log('Antigravity UI: real store, model/mode choices, rejection, streamed reply, cancel, config failure passed');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));for(const name of ['fixture.js','fixture.css'])await unlink(join(directory,name)).catch(()=>{});await rmdir(directory).catch(()=>{});}
