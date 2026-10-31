// Real conversation, composer and session store; native transport is isolated.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-codex-ui-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {CodexConversation} from './src/components/center/CodexConversation';
    import {Gambit} from './src/components/center/Gambit';
    import {useCodexSession,sendCodexMessage,interruptCodex} from './src/lib/codex-session';
    import './src/styles/global.css';import './src/components/center/TierTerminal.css';
    function Fixture(){const [active,setActive]=useState('a'),[drafts,setDrafts]=useState({a:'',b:''}),[provider,setProvider]=useState('codex'),[welcomeEpoch,setWelcomeEpoch]=useState(0);window.rerollWelcome=()=>setWelcomeEpoch(n=>n+1);window.setActive=setActive;window.setProvider=setProvider;const s=useCodexSession(active);window.currentState=s;return <div className="panel-center">
      {['a','b'].map(id=><div key={id} className="host" style={{display:active===id?'flex':'none'}}><CodexConversation key={id+'-'+welcomeEpoch} sessionId={id} cwd="D:/Test" isActive={active===id}/></div>)}
      <Gambit sessionId={active} draft={drafts[active]} onDraftChange={text=>setDrafts(d=>({...d,[active]:text}))} onClose={()=>{}} onSend={text=>sendCodexMessage(active,text)} codex={provider==='codex'} claude={provider==='claude'} running={s.busy} onCancel={()=>interruptCodex(active)} leftPanelHidden rightPanelHidden workspaceName="Test" toolIcon={<span>◈</span>}/>
    </div>};createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg'], nodePaths: [join(project, 'node_modules')],
  loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.gif': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/shiki$/ }, () => ({ path: 'syntax', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)clipboard$/ }, () => ({ path: 'clipboard', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/claude-session$/ }, () => ({ path: 'claude-session', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
    b.onResolve({ filter: /\.svg\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?raw', '')), namespace: 'svg' }));
    b.onLoad({ filter: /.*/, namespace: 'svg' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'store' ? `
      const state={theme:'dark',gambitEnterToSend:true,terminals:[{id:'a',folderPath:'D:/Test'},{id:'b',folderPath:'D:/Test'}]},dispatch=action=>(window.actions??=[]).push(action);
      export function useAppLanguage(){return 'en'};export function useAppState(){return {state,dispatch}};
    ` : args.path === 'syntax' ? `
      export async function tokenizeFile(){return null};export async function tokenizeByLang(){return null};export function getShikiTheme(){return 'dark'};
    ` : args.path === 'clipboard' ? `
      export async function clipboardWrite(text){window.copiedText=text};export async function clipboardRead(){return window.clipboardText||''};
    ` : args.path === 'claude-session' ? `
      import {useSyncExternalStore} from 'react';
      let state={ready:true,busy:false,backgroundTasks:[],models:[],commands:[],model:'claude-test',permissionMode:'default',contextTokens:25000,contextWindow:100000,modelUsage:{first:{inputTokens:10000,outputTokens:300,cacheReadInputTokens:15000,cacheCreationInputTokens:1000},second:{inputTokens:6000,outputTokens:100}}};const listeners=new Set();
      window.setClaude=patch=>{state={...state,...patch};listeners.forEach(fn=>fn())};
      export function useClaudeSession(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state)};
      export async function controlClaude(){};
    ` : args.path === 'event' ? `
      export async function listen(name,fn){window.codexListener=fn;return()=>{}};
    ` : `
      window.calls=[];let turn=0;
      const history=(prefix,count)=>Array.from({length:count},(_,i)=>({id:prefix+i,status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:prefix+i+' '+ 'Readable history. '.repeat(30)}]},...(i===1?[{id:'exec-1',type:'commandExecution',command:'echo first',status:'completed'},{id:'exec-2',type:'commandExecution',command:'echo second',status:'completed'}]:[]),{id:'a',type:'agentMessage',text:'Answer '+i+' '+ 'Earlier context. '.repeat(30)}]}));
      window.emit=(id,method,params={},requestId)=>{const start=window.calls.find(c=>c.name==='codex_session_start'&&c.id===id);window.codexListener({payload:{id,generation:start.generation,event:{method,params:{threadId:'thread-'+id,...params},...(requestId===undefined?{}:{id:requestId})}}})};
      export const isTauri=false,commands=new Proxy({},{get:(_,name)=>async(...args)=>{(window.nativeActions??=[]).push({name,args});if(name==='computerName')return 'TEST-DESKTOP'}});
      export async function invoke(name,args){window.calls.push({name,...args});
        if(name==='codex_session_start'&&args.id==='a')await new Promise(resolve=>window.resolveStartup=resolve);
        if(name==='codex_session_start')return {thread:{id:'thread-'+args.id,turns:args.id==='b'?history('history-',48):[]},turnsBackwardsCursor:args.id==='b'?'older':null,model:'gpt-test',reasoningEffort:'high',approvalPolicy:'on-request',sandbox:{type:'readOnly'},models:[{id:'gpt-test',model:'gpt-test',displayName:'GPT Test',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]},{id:'second',model:'second',displayName:'Second model',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'ultra'}]}]};
        if(args.method==='turn/start'){const id='turn-'+(++turn);window.turn=id;window.emit(args.id,'turn/started',{turn:{id,status:'inProgress'}});window.emit(args.id,'item/completed',{turnId:id,item:{id:'user',type:'userMessage',content:args.params.input}});return {turn:{id,status:'inProgress'}}}
        if(args.method==='turn/interrupt'){window.emit(args.id,'turn/completed',{turn:{id:args.params.turnId,status:'interrupted',durationMs:1500}})}
        if(args.method==='skills/list')return {data:[{skills:[{name:'test-skill',path:'D:/skills/test/SKILL.md',description:'A native test skill',enabled:true},{name:'disabled',path:'disabled',enabled:false}]}]};
        if(args.method==='mcpServerStatus/list')return {data:[{name:args.params.cursor?'second-server':'test-server',tools:{read:{description:'Read content'}}}],nextCursor:args.params.cursor?null:'page-2'};
        if(args.method==='review/start'||args.method==='thread/compact/start'){const id='native-'+(++turn);window.emit(args.id,'turn/started',{turn:{id}});window.emit(args.id,'turn/completed',{turn:{id,status:'completed'}});return {turn:{id}}}
        if(args.method==='thread/turns/list')return {data:history('older-',20).reverse(),nextCursor:null};
        return {};
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
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css');res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
page.setDefaultTimeout(7000);
const errors = [];page.on('pageerror', error => errors.push(error.message));
const emit = (method, params, requestId) => page.evaluate(({method,params,requestId})=>window.emit('a',method,params,requestId),{method,params,requestId});
try {
  await page.addInitScript(()=>{window.originalRandom=Math.random;Math.random=()=>0});
  await page.clock.setFixedTime(new Date(2026,9,24,9,0));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'Select Codex model',exact:true}).waitFor();
  await page.waitForFunction(()=>window.resolveStartup&&document.querySelector('.host .claude-empty-title'));
  assert.equal(await page.locator('.host:visible .codex-working').count(),0,'startup does not insert a Connecting row');
  assert.equal(await page.locator('.host:visible .claude-session-error').count(),0);
  assert.equal(await page.locator('.host:visible .claude-empty-separator').count(),0,'startup does not show a separator before the model is known');
  assert.equal(await page.locator('.host:visible .conversation-navigation').count(),0,'empty conversations have no navigation');
  await page.evaluate(()=>window.resolveStartup());
  await page.waitForFunction(()=>window.currentState.ready);
  assert.equal(await page.locator('.host:visible .claude-empty-model').textContent(),'gpt-test','welcome shows the actual session model ID');
  await page.getByRole('button',{name:'Select Codex model',exact:true}).click();
  await page.getByRole('button',{name:'Second model',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.host .claude-empty-model')?.textContent==='second');
  await page.getByRole('button',{name:'Select Codex model',exact:true}).click();
  await page.getByRole('button',{name:'GPT Test',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.host .claude-empty-model')?.textContent==='gpt-test');
  const input=page.locator('.gambit-textarea');
  const welcome=page.locator('.host:visible .claude-empty-title');await page.waitForFunction(()=>document.querySelector('.host .claude-empty-title')?.textContent==='Good morning, TEST-DESKTOP');
  const mascot=page.locator('.host').first().locator('.codex-welcome-icon');
  const loaded=await mascot.evaluate(async el=>{const url=getComputedStyle(el).backgroundImage.slice(5,-2),image=new Image();image.src=url;await image.decode();return {width:image.naturalWidth,height:image.naturalHeight}});assert.deepEqual(loaded,{width:1536,height:2288});
  for(const shape of ['carbon','glass','monogram']){await page.evaluate(shape=>document.body.dataset.shape=shape,shape);assert.notEqual(await mascot.evaluate(el=>getComputedStyle(el).backgroundImage),'none',shape+' preserves the mascot');}
  await page.evaluate(()=>document.body.dataset.shape='soft');
  const bounds=await mascot.boundingBox();
  assert.equal(await mascot.evaluate(el=>el.getAnimations()[0].effect.getTiming().duration),6600,'idle uses the native slow cadence rather than the fast action timing');
  // Native idle holds: 1680, 660, 660, 840, 840, 1920 ms. Sample each boundary.
  for(const [time,column] of [[0,0],[1679,0],[1681,1],[2339,1],[2341,2],[2999,2],[3001,3],[3839,3],[3841,4],[4679,4],[4681,5],[6599,5],[6601,0]]){
    const position=await mascot.evaluate((el,time)=>{const animation=el.getAnimations()[0];animation.pause();animation.currentTime=time;return getComputedStyle(el).backgroundPosition},time);
    const [x,y]=position.split(' ').map(parseFloat);assert.ok(Math.abs(x-column/7*100)<.001,`native idle frame at ${time}ms: ${position}`);assert.equal(y,0,'idle stays in its own atlas row');
    assert.deepEqual(await mascot.boundingBox(),bounds,'frame changes never move the welcome layout');
  }
  await mascot.evaluate(el=>el.getAnimations()[0].play());
  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('.host .codex-welcome-icon').getAnimations().length===0);
  await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>window.setActive('b'));await page.waitForFunction(()=>document.querySelector('.host .codex-welcome-icon')?.dataset.paused==='true');assert.equal(await mascot.evaluate(el=>el.getAnimations().length),0);await page.evaluate(()=>window.setActive('a'));
  const variants=[['idle',0,[1680,660,660,840,840,1920]],['walking-right',1,[120,120,120,120,120,120,120,220]],['walking-left',2,[120,120,120,120,120,120,120,220]],['waving',3,[140,140,140,280]],['jumping',4,[140,140,140,140,280]],['waiting',6,[150,150,150,150,150,260]],['running',7,[120,120,120,120,120,220]],['review',8,[150,150,150,150,150,280]]];
  for(const [index,[id,row,holds]] of variants.entries()){
    await page.evaluate(index=>{Math.random=()=>(index+.5)/8;window.rerollWelcome()},index);
    await page.waitForFunction(id=>{const el=document.querySelector('.host .codex-welcome-icon');return el?.dataset.welcomeIcon===id&&el.getAnimations().length===1},id);
    const duration=holds.reduce((total,hold)=>total+hold,0);
    assert.equal(await mascot.evaluate(el=>el.getAnimations()[0].effect.getTiming().duration),duration,`${id} keeps its original speed`);
    assert.equal(await mascot.evaluate(el=>el.getAnimations()[0].effect.getTiming().iterations),id==='idle'?Infinity:3,`${id} follows the native repetition limit`);
    let elapsed=0;
    for(const [column,hold] of holds.entries()){
      const [x,y]=await mascot.evaluate((el,time)=>{const animation=el.getAnimations()[0];animation.pause();animation.currentTime=time;return getComputedStyle(el).backgroundPosition.split(' ').map(parseFloat)},elapsed+hold/2);
      assert.ok(Math.abs(x-column/7*100)<.001);assert.equal(y,row*10,`${id} stays on the intended atlas row`);elapsed+=hold;
    }
    assert.deepEqual(await mascot.boundingBox(),bounds,`${id} does not shift the layout`);
    if(id!=='idle'){
      await mascot.evaluate(el=>el.getAnimations()[0].finish());
      await page.waitForFunction(()=>document.querySelector('.host .codex-welcome-icon')?.getAnimations()[0]?.effect.getTiming().duration===6600);
      assert.equal(await mascot.evaluate(el=>el.getAnimations()[0].effect.getTiming().iterations),Infinity,'finished actions settle into slow idle');
      const y=await mascot.evaluate(el=>{const a=el.getAnimations()[0];a.pause();a.currentTime=3000;return parseFloat(getComputedStyle(el).backgroundPosition.split(' ')[1])});
      assert.equal(y,0,'idle uses its own atlas row after every random action');
      assert.deepEqual(await mascot.boundingBox(),bounds,'settling into idle does not move the layout');
    }
    await mascot.evaluate(el=>el.getAnimations()[0].play());
    await page.evaluate(()=>{Math.random=()=>.99});await input.fill('rerender');await input.fill('');
    assert.equal(await mascot.getAttribute('data-welcome-icon'),id,'composer rerenders do not reroll the current mascot');
  }
  await page.evaluate(()=>{Math.random=window.originalRandom});
  await page.clock.setFixedTime(new Date(2026,9,24,12,0));await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForFunction(()=>document.querySelector('.host .claude-empty-title')?.textContent==='Good afternoon, TEST-DESKTOP');
  await page.clock.setFixedTime(new Date(2026,9,24,18,0));await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.waitForFunction(()=>document.querySelector('.host .claude-empty-title')?.textContent==='Good evening, TEST-DESKTOP');
  assert.equal(await page.evaluate(()=>window.nativeActions.filter(a=>a.name==='computerName').length),1,'the machine name is fetched once and shared');assert.equal(await welcome.getAttribute('lang'),'en');
  if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT.replace('.png','-welcome.png')});
  console.log('ok eight random Codex actions, original frame timing, stable layout, motion preferences, hidden tabs and English greetings');

  await page.getByRole('button',{name:'Command',exact:true}).click();
  const commandMenu=page.getByRole('dialog',{name:'Command',exact:true});
  assert.equal(await commandMenu.getByRole('button').count(),11);
  if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT.replace('.png','-slash.png')});
  await commandMenu.getByRole('button',{name:/^\/status/}).click();
  await page.getByRole('dialog',{name:'Context window',exact:true}).waitFor();await page.keyboard.press('Escape');
  await input.fill('/mo');await input.press('Enter');
  await page.getByRole('dialog',{name:'Select Codex model',exact:true}).waitFor();assert.equal(await input.inputValue(),'');await page.keyboard.press('Escape');
  await page.mouse.move(5,5);await input.fill('/');await commandMenu.waitFor();await input.press('ArrowDown');
  await page.waitForFunction(()=>document.querySelector('.codex-control-menu .is-selected strong')?.textContent==='/permissions');
  await input.press('Tab');
  await page.getByRole('dialog',{name:'Codex permissions',exact:true}).waitFor();await page.keyboard.press('Escape');
  await input.fill('/effort');await page.locator('.gambit-footer > .gambit-send').click();
  await page.getByRole('slider').waitFor();assert.equal(await input.inputValue(),'');await page.keyboard.press('Escape');
  await input.fill('/missing');await input.press('Enter');
  assert.equal(await input.inputValue(),'/missing');assert.ok((await commandMenu.textContent()).includes('No matching commands'));
  await page.locator('.gambit-footer > .gambit-send').click();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.method==='turn/start').length),0,'slash commands never become model prompts');
  await input.fill('/status');await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});
  await commandMenu.waitFor();await input.press('Escape');assert.equal(await page.locator('.codex-control-menu').count(),0,'Escape dismisses slash suggestions');
  console.log('ok slash button, filtering, Enter/Tab/arrows, send click, IME and empty results');
  for(const command of ['skills','mcp']){
    await input.fill('/'+command);await input.press('Enter');
    const catalog=page.getByRole('dialog',{name:command==='skills'?'Skills':'MCP servers',exact:true});await catalog.waitFor();
    if(command==='skills'){await catalog.getByRole('button',{name:/test-skill/}).click();assert.equal(await input.inputValue(),'$test-skill ')}
    else{await catalog.getByText('test-server',{exact:false}).waitFor();assert.equal(await catalog.locator('details').count(),2);await page.keyboard.press('Escape')}
  }
  for(const command of ['compact','review']){await input.fill('/'+command);await input.press('Enter');await page.waitForFunction(()=>!window.currentState.busy);assert.ok(await page.evaluate(method=>window.calls.some(c=>c.method===method),command==='compact'?'thread/compact/start':'review/start'))}
  await input.fill('/new');await input.press('Enter');assert.equal(await page.evaluate(()=>window.actions.filter(a=>a.type==='ADD_TERMINAL').at(-1).session.folderPath),'D:/Test');

  await input.fill('Hello Coffee');await input.press('Enter');
  await page.waitForFunction(()=>window.currentState.busy);
  assert.equal(await input.inputValue(),'');
  assert.equal(await page.locator('.host:visible .conversation-navigation').count(),0,'one user turn does not need navigation');
  const turnId=await page.evaluate(()=>window.turn);
  await emit('item/started',{turnId,item:{id:'exec',type:'commandExecution',command:'echo Coffee',status:'inProgress',aggregatedOutput:''}});
  const group=page.locator('.host:visible .codex-group-heading');await group.click();
  const heading=page.locator('.host:visible .codex-tool-heading .claude-tool-heading');await heading.click();
  await emit('item/commandExecution/outputDelta',{turnId,itemId:'exec',delta:'Coffee output'});
  await page.waitForFunction(()=>document.querySelector('.codex-tool-body')?.textContent==='Coffee output');
  assert.equal(await heading.getAttribute('aria-expanded'),'true','streaming keeps expansion open');
  await page.locator('.codex-tool-heading .conversation-copy').click();
  assert.ok((await page.evaluate(()=>window.copiedText)).includes('Coffee output'));
  assert.equal(await page.getByRole('button',{name:'Select Codex model',exact:true}).isDisabled(),true);
  await input.fill('Keep this draft');
  await emit('item/commandExecution/requestApproval',{turnId,itemId:'exec',command:'echo approved'},7);
  await page.locator('.codex-request').waitFor();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='codex_session_respond').length),0);
  await page.getByRole('button',{name:'Decline',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='codex_session_respond').requestId),7);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!window.currentState.busy);
  assert.equal(await input.inputValue(),'Keep this draft','stop preserves a draft');
  assert.equal(await page.locator('.claude-session-error').count(),0,'user stop is neutral');
  await page.getByText('Interrupted · 2s',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Codex permissions',exact:true}).click();
  const permissions=page.getByRole('dialog',{name:'Codex permissions',exact:true});
  assert.equal(await permissions.locator('pre').count(),0,'permission menu does not expose protocol JSON');
  assert.equal(await permissions.locator('.codex-permission-option').count(),3);
  if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT.replace('.png','-permissions.png')});
  await permissions.getByRole('button',{name:/^Workspace/}).click();
  assert.equal(await page.evaluate(()=>window.currentState.sandbox.type),'workspaceWrite');
  await page.locator('.claude-effort-trigger').click();
  const effort=page.getByRole('slider');
  assert.equal(await effort.getAttribute('max'),'1','effort uses only the two supported Codex levels');
  await effort.press('Home');await page.waitForFunction(()=>window.currentState.effort==='medium');
  if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT.replace('.png','-effort.png')});
  await effort.press('Escape');assert.equal(await page.locator('.codex-control-menu').count(),0);
  await emit('thread/tokenUsage/updated',{turnId,tokenUsage:{last:{totalTokens:42182},total:{totalTokens:123334},modelContextWindow:475000}});
  await page.getByRole('button',{name:'Context used: 9%',exact:true}).click();
  const context=page.getByRole('dialog',{name:'Context window',exact:true});
  assert.equal(await context.getByRole('progressbar').getAttribute('aria-valuenow'),'9');
  assert.ok((await context.textContent()).includes('42,182 / 475,000'));
  assert.ok((await context.textContent()).includes('Session total tokens'));
  assert.ok((await context.textContent()).includes('123,334'));
  if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT.replace('.png','-context.png')});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Select Codex model',exact:true}).click();
  await page.getByRole('button',{name:'Second model',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.currentState.effort),'low','model selects a supported effort');
  await page.locator('.claude-effort-trigger').click();await page.getByRole('slider').press('End');
  await page.waitForFunction(()=>window.currentState.effort==='ultra');
  assert.equal(await page.locator('.claude-effort-trigger').textContent(),'Ultra');
  assert.equal(await page.getByRole('slider').getAttribute('aria-valuetext'),'Ultra');await page.keyboard.press('Escape');
  assert.equal(await page.locator('.claude-effort-trigger').evaluate(el=>getComputedStyle(el).color),'rgb(180, 147, 124)','Ultra footer uses the theme accent');

  await page.getByRole('button',{name:'Select Codex model',exact:true}).click();await page.keyboard.press('Escape');
  assert.equal(await page.locator('.codex-control-menu').count(),0);
  await emit('item/tool/requestUserInput',{turnId,itemId:'question',questions:[{id:'target',header:'Target',question:'Which target?',options:[{label:'Local',description:'Use workspace'},{label:'Remote',description:'Use service'}]}]},'question');
  await page.getByRole('radio',{name:/Local/}).check();await page.getByRole('button',{name:'Submit',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.name==='codex_session_respond').at(-1).response),{answers:{target:{answers:['Local']}}});
  await emit('item/tool/call',{turnId,itemId:'unsupported'},'unknown');
  await page.getByRole('button',{name:'Decline',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='codex_session_respond').at(-1).reject),true);
  await page.evaluate(()=>window.setActive('b'));await page.waitForFunction(()=>window.currentState.nativeId==='thread-b');
  assert.equal(await page.locator('.host:visible .codex-tool').count(),0);
  assert.equal(await input.inputValue(),'');
  await page.evaluate(()=>window.setActive('a'));await page.waitForFunction(()=>window.currentState.nativeId==='thread-a');
  assert.equal(await input.inputValue(),'Keep this draft');
  console.log('ok stream expansion, copy, approval, questions, stop, model capabilities and tab isolation');
  await emit('item/completed',{turnId,item:{id:'links',type:'agentMessage',text:'[Open test page](simple-web-test/index.html) [Website](https://example.com) [File URL](file:///D:/Test/test%20page.html) [Blocked](javascript:alert%281%29)'}});
  const local=page.getByRole('link',{name:'Open test page',exact:true});await local.click();
  assert.deepEqual(await page.evaluate(()=>window.nativeActions.at(-1)),{name:'openUrl',args:['D:/Test/simple-web-test/index.html']});
  await page.getByRole('link',{name:'Website',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.nativeActions.at(-1).args),['https://example.com']);
  await page.getByRole('link',{name:'File URL',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.nativeActions.at(-1).args),['D:/Test/test page.html']);
  assert.equal(await page.getByRole('link',{name:'Blocked',exact:true}).count(),0);
  await local.click({button:'right'});await page.locator('.term-ctx-menu').waitFor();await page.waitForTimeout(150);if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT.replace('.png','-menu.png')});await page.locator('.term-ctx-menu').getByRole('button',{name:'Copy link address',exact:true}).click();assert.equal(await page.evaluate(()=>window.copiedText),'D:/Test/simple-web-test/index.html');
  await local.click({button:'right'});await page.locator('.term-ctx-menu').getByRole('button',{name:'Reveal in File Explorer',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.nativeActions.at(-1)),{name:'showInFolder',args:['D:/Test/simple-web-test/index.html']});
  await local.evaluate(el=>{window.getSelection().selectAllChildren(el)});await local.click({button:'right'});await page.locator('.term-ctx-menu').getByRole('button',{name:/^Copy Ctrl/}).dispatchEvent('mousedown');assert.equal(await page.evaluate(()=>window.copiedText),'Open test page');
  await local.click({button:'right'});await page.locator('.term-ctx-menu').waitFor();await page.keyboard.press('Escape');await page.locator('.term-ctx-menu').waitFor({state:'hidden'});
  await local.dispatchEvent('contextmenu',{clientX:998,clientY:798});await page.locator('.term-ctx-menu').waitFor();await page.waitForTimeout(150);const menuBounds=await page.locator('.term-ctx-menu').boundingBox();assert.ok(menuBounds.x+menuBounds.width<=996&&menuBounds.y+menuBounds.height<=796,'context menu fits the lower right corner');await page.keyboard.press('Escape');
  await input.fill('/copy');await input.press('Enter');assert.ok((await page.evaluate(()=>window.copiedText)).includes('[Open test page]'));
  await input.fill('Keep this draft');
  console.log('ok expanded native commands, skill and MCP catalogs, Ultra accent, local/URL clicks and context menus');

  if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT});
  for(const width of [1000,520,360,320]) {
    await page.setViewportSize({width,height:800});await page.waitForTimeout(100);
    const bounds=await page.locator('.gambit-footer').evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,scroll:el.scrollWidth,width:el.clientWidth}));
    assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.scroll<=bounds.width+1,`footer fits ${width}: ${JSON.stringify(bounds)}`);
    await page.getByRole('button',{name:'Select Codex model',exact:true}).click();
    const box=await page.locator('.codex-control-menu').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width,'model popup stays in viewport');
    await page.keyboard.press('Escape');
  }
  await page.screenshot({path:join(directory,'codex-narrow.png')});
  await page.setViewportSize({width:1000,height:800});await page.evaluate(()=>window.setActive('b'));
  const scroller=page.locator('.host:visible .claude-scroll');
  await page.waitForFunction(()=>window.currentState.nativeId==='thread-b');
  await page.waitForTimeout(400);
  const metrics=()=>scroller.evaluate(el=>({top:el.scrollTop,distance:el.scrollHeight-el.clientHeight-el.scrollTop}));
  assert.ok((await metrics()).distance<2,'restored history starts at the latest message: '+JSON.stringify(await metrics()));
  await scroller.hover();await page.mouse.wheel(0,-400);await page.waitForTimeout(300);
  const reading=await metrics();
  const returnLatest=page.locator('.host:visible .claude-scroll-bottom');
  assert.equal(await returnLatest.evaluate(el=>el.classList.contains('gambit-send')),true);
  assert.equal(await returnLatest.locator('svg path').count(),1,'return button uses the shared SVG arrow');
  const returnSize=await returnLatest.boundingBox(),sendSize=await page.locator('.gambit-footer > .gambit-send').boundingBox();assert.equal(returnSize.width,sendSize.width);assert.equal(returnSize.height,sendSize.height);
  await page.evaluate(()=>{window.emit('b','turn/started',{turn:{id:'live'}});window.emit('b','item/agentMessage/delta',{turnId:'live',itemId:'answer',delta:'New answer. '.repeat(90)})});
  await page.waitForTimeout(200);
  assert.ok(Math.abs((await metrics()).top-reading.top)<2,'streaming preserves upward reading position');
  const navigation=page.locator('.host:visible .conversation-navigation');
  assert.equal(await navigation.locator('button').count(),48,'only user turns become navigation ticks, including history with grouped tools');
  const turn=navigation.locator('[data-conversation-navigation-target="history-10:u"]');
  await turn.hover();
  assert.ok((await navigation.getByRole('tooltip').textContent()).startsWith('history-10 '),'hover previews the user prompt');
  await turn.click();await page.waitForTimeout(300);
  const target=page.locator('[data-message-id="history-10:u"]');
  const targetOffset=async()=>{const box=await target.boundingBox(),viewport=await scroller.boundingBox();assert.ok(box,'the target is rendered by the virtualizer');return box.y-viewport.y};
  assert.ok(Math.abs(await targetOffset()-24)<2,'navigation jumps to the correct row after tool grouping');
  assert.equal(await turn.getAttribute('aria-current'),'step','the selected turn is highlighted');
  const jumped=await metrics();
  await page.evaluate(()=>window.emit('b','item/agentMessage/delta',{turnId:'live',itemId:'answer',delta:'More streamed content. '.repeat(30)}));await page.waitForTimeout(200);
  assert.ok(Math.abs(await targetOffset()-24)<2,'streaming keeps the navigation target aligned');
  await scroller.hover();await page.mouse.wheel(0,-150);await page.waitForTimeout(200);
  const manual=await metrics();await page.waitForTimeout(150);
  assert.ok(manual.top<jumped.top-30&&Math.abs((await metrics()).top-manual.top)<2,'manual scrolling releases the navigation anchor');
  await scroller.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(300);
  const first=page.locator('[data-message-id="history-0:u"]'),before=await first.boundingBox();
  await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();await page.waitForTimeout(500);
  const after=await first.boundingBox();assert.ok(after&&Math.abs(after.y-before.y)<2,`history prepend preserves its visible anchor: ${JSON.stringify({before,after,metrics:await metrics()})}`);
  assert.equal(await navigation.locator('button').count(),68,'navigation includes newly loaded history');
  await turn.focus();await turn.press('Enter');await page.waitForTimeout(300);
  assert.ok(Math.abs(await targetOffset()-24)<2,'keyboard navigation still finds the same turn after history is prepended');
  const rail=await navigation.boundingBox(),thread=await page.locator('.host:visible .claude-thread').boundingBox(),view=await scroller.boundingBox();
  assert.ok(rail.x+rail.width+12<=thread.x,'navigation leaves room for the conversation text');
  assert.ok(rail.y+rail.height<=view.y+view.height+1,'navigation clears the docked composer');
  for(const width of [520,360]){await page.setViewportSize({width,height:800});assert.equal(await navigation.isVisible(),false,'narrow panes hide navigation at '+width+'px')}
  await page.setViewportSize({width:1000,height:800});
  await page.evaluate(()=>window.setActive('a'));assert.equal(await page.locator('.host').nth(1).locator('.conversation-navigation').count(),0,'inactive sessions do not retain an interactive navigation rail');
  await page.evaluate(()=>window.setActive('b'));await navigation.waitFor();
  console.log('ok shared conversation navigation, preview, grouped virtual rows, keyboard jump, streaming, history prepend and narrow panes');
  await page.evaluate(()=>{document.documentElement.style.setProperty('--bg-terminal','#eee9e2');document.documentElement.style.setProperty('--text-2','#51473d');document.documentElement.style.setProperty('--bg-panel','#e7dfd4')});
  assert.equal(await page.locator('.host:visible .codex-conversation').evaluate(el=>getComputedStyle(el).color),'rgb(81, 71, 61)');
  await page.evaluate(()=>window.setProvider('claude'));await page.getByRole('button',{name:'Context used: 25%',exact:true}).click();
  const claudeContext=page.getByRole('dialog',{name:'Context window',exact:true});
  assert.equal(await claudeContext.getByRole('progressbar').getAttribute('aria-valuenow'),'25');
  assert.ok((await claudeContext.textContent()).includes('25,000 / 100,000'));
  assert.ok((await claudeContext.textContent()).includes('32,400'),'Claude sums the native usage of both models');
  if(process.env.COFFEE_CODEX_SCREENSHOT)await page.screenshot({path:process.env.COFFEE_CODEX_SCREENSHOT.replace('.png','-claude-context.png')});
  await page.evaluate(()=>window.setClaude({modelUsage:{unknown:{contextWindow:100000}}}));
  assert.equal(await claudeContext.locator('.context-usage-total > span').last().textContent(),'—','missing native token counters are not fabricated');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.emit('b','coffee/exit',{code:1,detail:'Startup unavailable'}));
  await page.waitForFunction(()=>document.querySelector('.host:has(.claude-reconnect)'));
  assert.equal(await page.locator('.host:visible .claude-session-error').count(),0,'connection failures do not become red conversation messages');
  assert.equal(await page.locator('.host:visible .claude-reconnect').getAttribute('title'),'Startup unavailable');
  assert.deepEqual(errors,[]);
  console.log('ok 1000/520/360/320px, theme colors, virtual history, paused reading and history prepend');
  console.log('ok Ultra label preserves the native parameter; Claude and Codex share context usage layout');
} catch (error) {
  console.error('Browser errors:',errors,'Focus/selection:',await page.evaluate(()=>({focus:document.activeElement?.tagName,selected:[...document.querySelectorAll('.codex-control-menu .is-selected')].map(el=>el.textContent)})),'Visible text:',(await page.locator('body').innerText()).slice(0,1800));
  throw error;
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));
  for(const name of ['fixture.js','fixture.css','codex-narrow.png'])await unlink(join(directory,name)).catch(()=>{});
  await rmdir(directory);
}
