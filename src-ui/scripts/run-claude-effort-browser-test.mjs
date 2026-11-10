import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-effort-ui-'));
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React,{useRef}from'react';import{createRoot}from'react-dom/client';import{ClaudeComposerControls}from'./src/components/center/ClaudeComposerControls';import'./src/styles/global.css';
function App(){const handler=useRef();return <div style={{position:'absolute',bottom:30,right:30}}><ClaudeComposerControls sessionId="test" draft="" onDraftChange={()=>{}} keyHandler={handler}/></div>};createRoot(document.getElementById('root')).render(<App/>);` }, bundle:true, jsx:'automatic', outfile:join(directory,'fixture.js'), external:['/fonts/*','/monogram.svg', '/backgrounds/*'], plugins:[{name:'session',setup(b){
  b.onResolve({filter:/lib\/claude-session$/},()=>({path:'session',namespace:'fixture'}));
  b.onResolve({filter:/store\/app-state$/},()=>({path:'language',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',resolveDir:project,contents:args.path==='language'?`export function useAppLanguage(){return 'zh-CN'};export function useAppState(){return {state:{terminals:[]},dispatch(){}}}`:`
import{useSyncExternalStore}from'react';let listeners=new Set();let state={ready:true,backgroundTasks:[],model:'test',models:[{value:'test',supportsEffort:true,supportedEffortLevels:['low','medium','high','xhigh','max'],supportsThinkingOff:true}],effort:'high',ultracode:false,thinking:true,commands:[],modelUsage:{},contextWindow:0,contextTokens:0,permissionMode:'default'};
export function continueClaudeInNewConversation(){return false};window.requests=[];export function useClaudeSession(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state)}
export async function controlClaude(id,request){window.requests.push(request);await new Promise(resolve=>{window.finishControl=()=>{state={...state,...(request.settings.effortLevel?{effort:request.settings.effortLevel}:{}),...(typeof request.settings.ultracode==='boolean'?{ultracode:request.settings.ultracode}:{}),...(typeof request.settings.alwaysThinkingEnabled==='boolean'?{thinking:request.settings.alwaysThinkingEnabled}:{})};listeners.forEach(fn=>fn());resolve({})}})}
`}));
}}]});
const server=http.createServer(async(req,res)=>{
  if(req.url==='/')return res.setHeader('Content-Type','text/html; charset=utf-8').end('<html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
  try{const name=req.url.slice(1);if(!['fixture.js','fixture.css'].includes(name))throw Error();res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(join(directory,name)))}catch{res.writeHead(404).end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.COFFEE_CHROMIUM_EXECUTABLE?{executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE}:{})});
try{
  const page=await browser.newPage({viewport:{width:900,height:650}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const chip=page.getByRole('button',{name:'思考强度',exact:true}),slider=page.getByRole('slider',{name:'思考强度'}),thinking=page.getByRole('switch',{name:'扩展思考',exact:true});
  const effortRequests=()=>page.evaluate(()=>window.requests.filter(request=>'effortLevel' in request.settings).map(request=>request.settings.effortLevel));
  const drag=async destination=>{const bounds=await slider.boundingBox();
    await page.mouse.move(bounds.x+bounds.width*.4,bounds.y+bounds.height/2);await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*destination,bounds.y+bounds.height/2,{steps:8});await page.mouse.up();};
  await chip.click();
  // Dragging back and forth and letting go only previews: nothing is applied while the menu is open.
  await drag(.05);await drag(.65);await drag(.05);
  assert.equal(await slider.evaluate(el=>Number(el.value)),0,'the slider shows the previewed level');
  await page.waitForTimeout(150);
  assert.deepEqual(await effortRequests(),[],'no switch while dragging or after letting go');
  assert.equal(await thinking.isDisabled(),false,'previewing does not lock the thinking toggle');
  // Escape closes without applying; reopening shows the applied level again.
  await page.keyboard.press('Escape');
  await slider.waitFor({state:'detached'});
  await page.waitForTimeout(150);
  assert.deepEqual(await effortRequests(),[],'Escape discards the preview');
  await chip.click();
  assert.equal(await slider.evaluate(el=>Number(el.value)),2,'back to the applied level');
  // Arrow keys preview too.
  await slider.focus();await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  assert.deepEqual(await effortRequests(),[],'arrow keys only preview');
  // Clicking elsewhere closes the menu and applies the last previewed level once.
  await page.mouse.click(5,5);
  await page.waitForFunction(()=>!!window.finishControl);
  assert.deepEqual(await effortRequests(),['low'],'one switch, to the final level, on close');
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  // Closing with the chip applies too; ending where it started applies nothing.
  await chip.click();await drag(.65);await chip.click();
  await page.waitForFunction(()=>!!window.finishControl);
  assert.deepEqual(await effortRequests(),['low','xhigh']);
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  // Like WKWebView: closing with the chip while the slider kept focus and never saw the release still applies.
  await chip.click();
  await slider.evaluate(el=>{const box=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:9,clientX:box.right-2,clientY:box.top+box.height/2}))});
  await page.waitForFunction(()=>document.querySelector('.claude-effort-range input').value==='4');
  await chip.evaluate(el=>el.click());
  await page.waitForFunction(()=>!!window.finishControl);
  assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).settings),{effortLevel:'max'},'the rightmost stop is Max, and changing the level never touches the Ultracode switch');
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  await chip.click();
  assert.equal(await slider.evaluate(el=>Number(el.value)),4,'reopening shows the level where it was chosen');
  assert.equal(await slider.getAttribute('max'),'4','the slider holds effort levels only, up to Max');
  // Ultracode is its own switch: it changes only the Ultracode flag and keeps the level.
  const ultra=page.getByRole('switch',{name:'Ultracode',exact:true});
  assert.equal(await ultra.getAttribute('aria-checked'),'false');
  assert.deepEqual(await ultra.evaluate(el=>{const box=el.getBoundingClientRect(),css=getComputedStyle(el);return{w:box.width,h:box.height,radius:css.borderTopLeftRadius,text:el.textContent}}),{w:40,h:24,radius:'12px',text:''},'the shared 40x24 switch, with no words');
  await ultra.click();await page.waitForFunction(()=>!!window.finishControl);
  assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).settings),{ultracode:true});
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  await page.waitForFunction(()=>document.querySelector('[aria-label="Ultracode"]').getAttribute('aria-checked')==='true');
  assert.equal(await slider.evaluate(el=>Number(el.value)),4,'switching Ultracode leaves the level alone');
  await drag(.4);await page.mouse.click(5,5);await slider.waitFor({state:'detached'});
  await page.waitForFunction(()=>!!window.finishControl);
  assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).settings),{effortLevel:'high'},'changing the level leaves Ultracode alone');
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  await chip.click();
  assert.equal(await page.getByRole('switch',{name:'Ultracode',exact:true}).getAttribute('aria-checked'),'true','Ultracode stays on after a level change');
  await page.getByRole('switch',{name:'Ultracode',exact:true}).click();await page.waitForFunction(()=>!!window.finishControl);
  assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).settings),{ultracode:false});
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  await page.mouse.click(5,5);await slider.waitFor({state:'detached'});
  // Previewing a level and then clicking a switch in the same menu: the click must land (blur applies nothing).
  await chip.click();await drag(.05);
  await page.getByRole('switch',{name:'Ultracode',exact:true}).click();
  await page.waitForFunction(()=>!!window.finishControl);
  assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).settings),{ultracode:true},'the first click on the switch lands');
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  await page.getByRole('switch',{name:'Ultracode',exact:true}).click();await page.waitForFunction(()=>!!window.finishControl);
  await page.evaluate(()=>{window.finishControl();window.finishControl=null});
  await page.waitForFunction(()=>!document.querySelector('.claude-effort-range input').disabled);
  await drag(.4);await page.mouse.click(5,5);
  await page.waitForTimeout(150);
  assert.deepEqual(await effortRequests(),['low','xhigh','max','high'],'returning to the applied level sends nothing');
  await chip.click();
  // The slider keeps focus for the arrow keys but never draws a focus ring, whatever key is pressed (Alt included).
  const ring=()=>slider.evaluate(el=>getComputedStyle(el).outlineStyle);
  await slider.evaluate(el=>el.focus({focusVisible:true}));
  assert.equal(await ring(),'none','no focus ring after opening or clicking');
  for(const key of ['Alt','Shift','ArrowLeft','ArrowRight'])await slider.press(key);
  assert.equal(await ring(),'none','no focus ring after any key');
  await thinking.click();await page.waitForFunction(()=>!!window.finishControl);
  await page.evaluate(()=>window.finishControl());
  await page.waitForFunction(()=>document.querySelector('[aria-label="扩展思考"]').getAttribute('aria-checked')==='false');
  assert.deepEqual(errors,[]);console.log('OK: effort drags and arrow keys only preview, close applies the final level once, Escape and returning to the applied level send nothing, and the thinking toggle stays');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
