import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-tool-memory-'));
const native = `
window.calls=[];window.docs={claude:{path:'C:/fixture/.claude/CLAUDE.md',content:'Claude 原文\\n第二行'},codex:{path:'C:/fixture/.codex/AGENTS.md',content:'Codex original'},pi:{path:'C:/fixture/.pi/agent/AGENTS.md',content:null},cursor:{path:null,content:null},copilot:{path:'C:/fixture/.copilot/copilot-instructions.md',content:'Copilot original'}};
export const commands={
 async getToolControl(){return {supported:true,installed:false,ready:false,browser:null,agents:[]}},
 async getToolSkills(){return {supported:false,skills:[]}},
 async searchToolSkills(){return []},
 async readToolMemory(tool){window.calls.push({type:'read',tool});if(window.failRead)throw 'memory_read';if(window.delayTool===tool)await new Promise(resolve=>{window.resolveRead=resolve});return {...window.docs[tool]}},
 async saveToolMemory(tool,path,original,content){window.calls.push({type:'save',tool,path,original,content});if(window.failSave)throw 'memory_write';if(window.docs[tool].path!==path||window.docs[tool].content!==original)throw 'memory_conflict';window.docs[tool]={path,content};return {...window.docs[tool]}}
};`;
await build({ stdin: { loader:'tsx', resolveDir:project, contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ToolSettingsPage} from './src/components/center/ToolSettingsPage';
import './src/styles/global.css';import './src/components/center/CenterPanel.css';
const tools=[{value:'claude',label:'Claude Code'},{value:'codex',label:'Codex CLI'},{value:'pi',label:'Pi'},{value:'cursor',label:'Cursor'},{value:'copilot',label:'Copilot CLI'}].map(item=>({...item,icon:<span>{item.label[0]}</span>}));
function Fixture(){const[active,setActive]=useState(true),[enabled,setEnabled]=useState(tools),[missing,setMissing]=useState([]);window.setMissing=setMissing;window.setEnabled=values=>setEnabled(tools.filter(item=>values.includes(item.value)));return <><button id="navigate" onClick={()=>setActive(!active)}>Navigate</button><div className="main-content" style={{position:'absolute',top:40,right:0,bottom:0,left:0}}><ToolSettingsPage active={active} tools={enabled.map(item=>({...item,installed:!missing.includes(item.value)}))} count={enabled.length} limit={6}><div id="selection">selection</div></ToolSettingsPage></div></>}
createRoot(document.getElementById('root')).render(<Fixture/>);` }, bundle:true, jsx:'automatic', loader:{'.svg':'text','.png':'dataurl'}, outfile:join(directory,'fixture.js'), logLevel:'silent',
  plugins:[{name:'native-boundary',setup(b){
    b.onResolve({filter:/\/tauri$/},args=>({path:args.path,namespace:'fixture'}));
    b.onResolve({filter:/\/store\/app-state$/},args=>({path:args.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path.endsWith('/tauri')?native:'export function useAppLanguage(){return "zh-CN"}'}));
  }}],
  external:['/fonts/*','/monogram.svg'],
});
const server=http.createServer(async(req,res)=>{
  if(/^\/fonts\/[\w.-]+\.woff2$/.test(req.url)||req.url==='/monogram.svg'){res.setHeader('Content-Type',req.url.endsWith('.svg')?'image/svg+xml':'font/woff2');return res.end(await readFile(join(project,'public',req.url.slice(1))))}
  if(req.url==='/fixture.js'||req.url==='/fixture.css'){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');return res.end(await readFile(join(directory,req.url.slice(1))))}
  res.setHeader('Content-Type','text/html');res.end('<html data-theme="obsidian" data-mode="dark" data-shape="panel"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.COFFEE_CHROMIUM_EXECUTABLE?{executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE}:{})});
try{
  const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const tab=name=>page.getByRole('tab',{name,exact:true}),editor=page.getByRole('textbox',{name:'主记忆',exact:true});
  const switchTool=name=>page.getByRole('toolbar',{name:'工具',exact:true}).getByRole('button',{name,exact:true}).click();
  const value=expected=>page.waitForFunction(expected=>document.querySelector('.tool-memory-editor')?.value===expected,expected);
  const aligned=()=>page.waitForFunction(()=>{
    const marker=document.querySelector('.tool-settings-indicator')?.getBoundingClientRect(),selected=document.querySelector('[role="tab"][aria-selected="true"]')?.getBoundingClientRect();
    return marker&&selected&&Math.abs(marker.x-selected.x)<1&&Math.abs(marker.width-selected.width)<1;
  });
  assert.equal(await page.getByRole('tab').count(),6);
  await page.locator('.tool-settings-indicator[data-ready]').waitFor({state:'attached'});await aligned();
  assert.equal(await page.getByRole('tab',{selected:true}).evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
  await tab('Skills').click();
  assert.equal(await page.locator('.tool-settings-indicator').evaluate(el=>el.getAnimations().some(animation=>animation.transitionProperty==='transform'&&animation.playState==='running')),true,'shared selection background moves between tabs');
  await aligned();assert.equal(await tab('MCP').count(),0);assert.equal(await page.evaluate(()=>window.calls.length),0,'Skills navigation performs no memory operations');
  await tab('主记忆').click();await value('Claude 原文\n第二行');
  await editor.fill('Claude 草稿\n未保存');
  await page.evaluate(()=>{window.delayTool='codex'});await switchTool('Codex CLI');
  await page.waitForFunction(()=>!!window.resolveRead);await switchTool('Claude Code');
  await value('Claude 草稿\n未保存');await page.evaluate(()=>{window.delayTool=null;window.resolveRead()});
  await switchTool('Codex CLI');await value('Codex original');
  await editor.fill('Codex changed\n中文');await editor.press('Control+s');
  await page.getByText('已保存',{exact:true}).waitFor({state:'visible'});
  const saved=await page.evaluate(()=>window.calls.find(call=>call.type==='save'));
  assert.deepEqual(saved,{type:'save',tool:'codex',path:'C:/fixture/.codex/AGENTS.md',original:'Codex original',content:'Codex changed\n中文'});
  await page.evaluate(()=>{window.docs.codex.content='External edit'});await editor.fill('My protected draft');
  await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').waitFor({state:'visible'});
  assert.match(await page.getByRole('alert').innerText(),/外部修改/);assert.equal(await editor.inputValue(),'My protected draft');
  await page.getByRole('button',{name:'重新加载',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await editor.inputValue(),'My protected draft');
  await page.getByRole('button',{name:'重新加载',exact:true}).click();await page.getByRole('button',{name:'放弃修改并重新加载',exact:true}).click();await value('External edit');
  await switchTool('Claude Code');await value('Claude 草稿\n未保存');
  await tab('常用 5/6').click();await tab('主记忆').click();await value('Claude 草稿\n未保存');
  await page.locator('#navigate').click();assert.equal(await tab('主记忆').count(),0);
  await page.locator('#navigate').click();await value('Claude 草稿\n未保存');
  await page.evaluate(()=>window.setMissing(['claude']));await page.getByText('未安装',{exact:true}).waitFor();
  assert.equal(await editor.count(),0);assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
  await page.evaluate(()=>window.setMissing([]));await value('Claude 草稿\n未保存');
  await switchTool('Pi');await value('');
  assert.equal(await page.locator('.tool-memory-notice').count(),0,'missing files open as a normal blank editor');
  const editorHeight=(await editor.boundingBox()).height;
  assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='save').length),2,'viewing a missing file does not create it');
  await editor.fill('New instructions');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByText('已保存',{exact:true}).waitFor({state:'visible'});
  const beforeMissing=await page.evaluate(()=>window.calls.length);
  await page.evaluate(()=>window.setMissing(['cursor']));await switchTool('Cursor');await page.getByText('未安装',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'重新加载',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.calls.length),beforeMissing,'uninstalled tools never read or create memory files');
  await page.evaluate(()=>window.setMissing([]));await page.getByText('暂不可用',{exact:true}).waitFor({state:'visible'});assert.equal(await editor.count(),0);assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);
  const empty=page.locator('.tool-memory-empty');assert.equal((await empty.boundingBox()).height,editorHeight,'unavailable tools reuse the normal document surface');
  assert.equal(await empty.evaluate(el=>{const board=el.getBoundingClientRect(),text=el.firstElementChild.getBoundingClientRect();return Math.abs((board.left+board.right-text.left-text.right)/2)<1&&Math.abs((board.top+board.bottom-text.top-text.bottom)/2)<1}),true,'empty-state text is centered on both axes');
  await page.evaluate(()=>{window.failRead=true});await switchTool('Copilot CLI');await page.getByRole('alert').waitFor({state:'visible'});
  await page.evaluate(()=>{window.failRead=false});await page.getByRole('button',{name:'重新加载',exact:true}).click();await value('Copilot original');
  await editor.fill('Keep after failure');await page.evaluate(()=>{window.failSave=true});await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('alert').waitFor({state:'visible'});assert.equal(await editor.inputValue(),'Keep after failure');
  await switchTool('Claude Code');await page.screenshot({path:join(directory,'memory-dark.png')});
  await page.evaluate(()=>window.setEnabled(['codex']));await value('External edit');
  assert.equal(await page.getByRole('toolbar',{name:'工具',exact:true}).getByRole('button').count(),1,'only enabled tools remain available');
  const callsBeforeEmpty=await page.evaluate(()=>window.calls.length);
  await page.evaluate(()=>window.setEnabled([]));await page.getByText('请先在「常用」中开启工具。',{exact:true}).waitFor({state:'visible'});
  assert.equal(await page.getByRole('button',{name:'重新加载',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.calls.length),callsBeforeEmpty,'no reads are issued for an empty selection');
  await page.evaluate(()=>window.setEnabled(['claude','codex']));await value('Claude 草稿\n未保存');
  const beforeResize=await editor.boundingBox();
  await page.setViewportSize({width:1100,height:1050});
  await page.waitForFunction(()=>{
    const panel=document.querySelector('.tool-settings-page'),style=getComputedStyle(panel);
    return Math.abs(document.querySelector('.tool-memory-editor').getBoundingClientRect().bottom-(panel.getBoundingClientRect().bottom-parseFloat(style.borderBottomWidth)-20))<1;
  });
  assert.ok((await editor.boundingBox()).height>beforeResize.height+190,'editor fills newly available window height');
  assert.equal(await editor.evaluate(el=>getComputedStyle(el).resize),'none');
  await page.evaluate(()=>{document.documentElement.dataset.mode='light';document.documentElement.dataset.theme='mint';document.documentElement.dataset.shape='soft'});await page.waitForTimeout(180);await page.screenshot({path:join(directory,'memory-light.png')});
  await page.setViewportSize({width:440,height:780});assert.equal(await page.locator('.tool-settings-page').evaluate(el=>el.scrollWidth>el.clientWidth),false);
  await tab('Browser Use').click();await page.keyboard.press('ArrowRight');assert.match(await page.getByRole('tab',{selected:true}).innerText(),/^常用 /);
  await aligned();
  await page.evaluate(()=>document.querySelectorAll('[role="tab"]').forEach(tab=>{tab.style.fontSize='15px'}));await aligned();
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.tool-settings-indicator').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  assert.deepEqual(errors,[]);
  console.log('OK: six themed tabs, Skills/memory isolation, actual editor/selector, lazy reads, late response isolation, per-tool drafts, page navigation, exact save payloads, conflict/failure retention, discard confirmation, missing/unsupported files, keyboard saving, themes and narrow layout');
  console.log('Screenshots: '+directory);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
