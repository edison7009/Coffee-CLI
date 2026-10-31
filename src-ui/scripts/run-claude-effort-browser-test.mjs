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
function App(){const handler=useRef();return <div style={{position:'absolute',bottom:30,right:30}}><ClaudeComposerControls sessionId="test" draft="" onDraftChange={()=>{}} keyHandler={handler}/></div>};createRoot(document.getElementById('root')).render(<App/>);` }, bundle:true, jsx:'automatic', outfile:join(directory,'fixture.js'), external:['/fonts/*','/monogram.svg'], plugins:[{name:'session',setup(b){
  b.onResolve({filter:/lib\/claude-session$/},()=>({path:'session',namespace:'fixture'}));
  b.onResolve({filter:/store\/app-state$/},()=>({path:'language',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',resolveDir:project,contents:args.path==='language'?`export function useAppLanguage(){return 'zh-CN'}`:`
import{useSyncExternalStore}from'react';let listeners=new Set();let state={ready:true,backgroundTasks:[],model:'test',models:[{value:'test',supportsEffort:true,supportedEffortLevels:['low','medium','high','xhigh','max'],supportsThinkingOff:true}],effort:'high',thinking:true,commands:[],modelUsage:{},contextWindow:0,contextTokens:0,permissionMode:'default'};
window.requests=[];export function useClaudeSession(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state)}
export async function controlClaude(id,request){window.requests.push(request);await new Promise(resolve=>{window.finishControl=()=>{state={...state,...(request.settings.effortLevel?{effort:request.settings.effortLevel}:{}),...(typeof request.settings.alwaysThinkingEnabled==='boolean'?{thinking:request.settings.alwaysThinkingEnabled}:{})};listeners.forEach(fn=>fn());resolve({})}})}
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
  await page.getByRole('button',{name:'思考强度',exact:true}).click();
  const slider=page.getByRole('slider',{name:'思考强度'}),thinking=page.getByRole('button',{name:'扩展思考 开',exact:true});
  const stable=await thinking.evaluate(el=>({opacity:getComputedStyle(el).opacity,text:el.textContent}));
  for(const destination of [.05,.65]){
    const bounds=await slider.boundingBox();
    await page.mouse.move(bounds.x+bounds.width*.4,bounds.y+bounds.height/2);await page.mouse.down();
    await page.mouse.move(bounds.x+bounds.width*destination,bounds.y+bounds.height/2,{steps:8});await page.mouse.up();
    await page.waitForFunction(()=>!!window.finishControl);
    assert.equal(await thinking.isDisabled(),true,'pending effort saves still block concurrent thinking changes');
    assert.deepEqual(await thinking.evaluate(el=>({opacity:getComputedStyle(el).opacity,text:el.textContent})),stable,'thinking text and brightness remain stable while saving');
    await thinking.evaluate(el=>el.click());
    assert.equal(await page.evaluate(()=>window.requests.filter(request=>'alwaysThinkingEnabled' in request.settings).length),0);
    await page.evaluate(()=>{window.finishControl();window.finishControl=null});
    await slider.waitFor({state:'visible'});
    await page.waitForFunction(()=>!document.querySelector('.claude-thinking-toggle').disabled);
  }
  await thinking.click();await page.waitForFunction(()=>!!window.finishControl);
  await page.evaluate(()=>window.finishControl());
  await page.getByRole('button',{name:'扩展思考 关',exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('OK: repeated effort drags preserve thinking brightness and value, block duplicate requests, and retain the thinking toggle');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
