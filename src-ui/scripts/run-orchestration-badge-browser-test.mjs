import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium }=await import(process.env.COFFEE_PLAYWRIGHT_MODULE||'playwright-core');
const project=fileURLToPath(new URL('..',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'coffee-orchestration-badge-'));
await build({stdin:{resolveDir:project,loader:'tsx',contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {Gambit} from './src/components/center/Gambit';import './src/styles/global.css';
window.sent=[];function Fixture(){const[draft,setDraft]=useState(''),[kind,setKind]=useState('claude'),[status,setStatus]=useState(true);window.setKind=setKind;window.setStatus=setStatus;return <Gambit sessionId="source" draft={draft} onDraftChange={setDraft} onClose={()=>{}} onSend={async text=>{window.sent.push({text});return !window.fail}} workspaceName="Project" leftPanelHidden rightPanelHidden claude={kind==='claude'} codex={kind==='codex'} orchestration={status} computer={status} browser={status}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`},bundle:true,jsx:'automatic',outfile:join(directory,'fixture.js'),logLevel:'silent',external:['/fonts/*','/monogram.svg'],plugins:[{name:'native-boundary',setup(b){
  b.onResolve({filter:/\/store\/app-state$|\/tauri$|\/claude-session$|\/codex-session$/},a=>({path:a.path,namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({loader:'js',contents:a.path.endsWith('/tauri')?'export const commands={},isTauri=false;export const invoke=async()=>{};':a.path.endsWith('/app-state')?'export function useAppLanguage(){return "zh-CN"};export function useAppState(){return {state:{gambitEnterToSend:true},dispatch(){}}}':a.path.endsWith('/claude-session')?'export const controlClaude=async()=>{};const state={ready:true,models:[{value:"claude-model",displayName:"Claude",supportsEffort:false}],model:"claude-model",modelUsage:{},contextWindow:100000,contextTokens:500,permissionMode:"bypassPermissions",commands:[],effort:"high"};export const useClaudeSession=()=>state;':'export const configureCodex=()=>{},runCodexCommand=async()=>{};const state={ready:true,busy:false,models:[{id:"codex-model",model:"codex-model",supportedReasoningEfforts:[]}],model:"codex-model",sandbox:{type:"workspaceWrite"},contextWindow:100000,contextTokens:500,commands:[],messages:[]};export const useCodexSession=()=>state;'}));
}}]});
const server=http.createServer(async(req,res)=>{
 if(req.url==='/fixture.js'||req.url==='/fixture.css'){res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':'text/css');return res.end(await readFile(join(directory,req.url.slice(1))))}
 if(/^\/fonts\/[\w.-]+\.woff2$/.test(req.url)||req.url==='/monogram.svg')return res.end(await readFile(join(project,'public',req.url)));
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE});
try {
 const page=await browser.newPage({viewport:{width:1060,height:700}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const badge=page.locator('.gambit-capabilities[role="status"]'),draft=page.locator('textarea');await badge.waitFor();
 const position=()=>page.evaluate(()=>{
  const box=selector=>{const r=document.querySelector(selector)?.getBoundingClientRect();return r?{left:r.left,right:r.right,top:r.top}:null};
  return {workspace:box('.gambit-workspace'),permission:box('.claude-permission-control'),badge:box('.gambit-capabilities'),model:box('.claude-model-controls'),send:box('.gambit-send')};
 });
 for(const kind of ['claude','codex','terminal']) {
  await page.evaluate(kind=>window.setKind(kind),kind);await badge.waitFor();
  const enabled=await position();
  assert.ok(enabled.badge.left>=(enabled.permission??enabled.workspace).right,'badge follows existing permission controls');
  if(kind!=='terminal')assert.ok(enabled.badge.right<=enabled.model.left,'models remain to the right of badge');
  assert.equal((await badge.textContent()).trim(),'多智能体编排电脑控制浏览器控制');assert.equal(await badge.locator('button').count(),0);assert.equal(await page.getByRole('combobox',{name:'指派给'}).count(),0);
  await page.evaluate(()=>window.setStatus(undefined));await badge.waitFor({state:'detached'});const original=await position();
  assert.equal(original.workspace.left,enabled.workspace.left,'workspace position is preserved');
  if(kind!=='terminal'){assert.equal(original.permission.left,enabled.permission.left,'permission position is preserved');assert.equal(original.model.left,enabled.model.left,'model position is preserved')}
  assert.equal(original.send.left,enabled.send.left,'send position is preserved');
  await page.evaluate(()=>window.setStatus(true));
 }
 await page.evaluate(()=>window.setKind('claude'));
 await page.screenshot({path:join(directory,'orchestration-dark.png')});
 const colors=()=>page.locator('.gambit-capability').evaluateAll(els=>els.map(el=>getComputedStyle(el).color));
 const enabledColors=await colors();assert.equal(new Set(enabledColors).size,3,'capabilities have three distinct semantic colors');
 await page.evaluate(()=>window.setStatus(false));await badge.waitFor({state:'detached'});assert.equal(await page.getByText('新会话生效',{exact:true}).count(),0);
 await page.evaluate(()=>window.setStatus(true));await draft.fill('让 Claude 自己决定如何协作');await draft.press('Enter');
 await page.waitForFunction(()=>window.sent.length===1);assert.deepEqual(await page.evaluate(()=>window.sent),[{text:'让 Claude 自己决定如何协作'}]);assert.equal(await draft.inputValue(),'');assert.equal((await badge.textContent()).trim(),'多智能体编排电脑控制浏览器控制','badge stays enabled after sending');
 await page.evaluate(()=>window.fail=true);await draft.fill('失败时保留草稿');await draft.press('Enter');
 await page.waitForFunction(()=>window.sent.length===2);assert.equal(await draft.inputValue(),'失败时保留草稿');
 await page.evaluate(()=>document.documentElement.dataset.mode='light');await page.screenshot({path:join(directory,'orchestration-light.png')});
 assert.notDeepEqual(await colors(),enabledColors,'capability colors follow light/dark theme');
 assert.deepEqual(errors,[]);console.log('OK: static themed orchestration badge, permission/model placement, original routing, activation state, Enter and failure draft retention');console.log('Screenshots: '+directory);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
