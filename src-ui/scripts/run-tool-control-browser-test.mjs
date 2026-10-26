import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project=fileURLToPath(new URL('..', import.meta.url)),directory=await mkdtemp(join(tmpdir(),'coffee-control-ui-'));
const antigravitySvg=await readFile(join(project,'src/icons-inline/antigravity.svg'),'utf8');
const mock=`
window.calls=[];const agents=()=>[{tool:'claude',supported:true,enabled:false,conflict:false},{tool:'codex',supported:true,enabled:false,conflict:false},{tool:'cursor',supported:true,enabled:false,conflict:false},{tool:'copilot',supported:true,enabled:false,conflict:false},{tool:'antigravity',supported:true,enabled:false,conflict:true,issue:'configuration'},{tool:'pi',supported:false,enabled:false,conflict:false}];
window.controlStatus={computer:{supported:true,installed:true,ready:true,browser:null,agents:agents()},browser:{supported:true,installed:false,ready:false,browser:null,agents:agents()}};
window.team={enabled:false,agents:[],tasks:[],revision:0};window.teamCalls=[];
export const commands={
async orchestrationGet(){window.teamCalls.push('get');return structuredClone(window.team)},async orchestrationSetAgent(tool,enabled){window.teamCalls.push({tool,enabled});if(window.delayTeam)await new Promise(resolve=>window.resolveTeam=resolve);if(window.failTeam)throw 'write failed';window.team.agents=window.team.agents.filter(id=>id!==tool);if(enabled)window.team.agents.push(tool);window.team.enabled=window.team.agents.length>0;window.team.revision++;return structuredClone(window.team)},
async getToolControl(kind){window.calls.push({type:'read',kind});const value=structuredClone(window.controlStatus[kind]);if(window.delayRead===kind)await new Promise(resolve=>window.resolveRead=resolve);return value},
async checkToolControl(kind){window.calls.push({type:'check',kind});if(window.delayCheck)await new Promise(resolve=>window.resolveCheck=resolve);if(window.failCheck)throw 'control_unavailable';return structuredClone(window.controlStatus[kind])},
async installBrowserControl(){window.calls.push({type:'install'});if(window.delayInstall)await new Promise(resolve=>window.resolveInstall=resolve);window.controlStatus.browser.installed=true;return structuredClone(window.controlStatus.browser)},
async setToolControl(kind,tool,enabled){window.calls.push({type:'set',kind,tool,enabled});if(window.delaySet)await new Promise(resolve=>window.resolveSet=resolve);if(window.failSet)throw 'control_conflict';window.controlStatus[kind].agents.find(agent=>agent.tool===tool).enabled=enabled;return structuredClone(window.controlStatus[kind])},
async getToolSkills(){return {supported:true,skills:[]}},async searchToolSkills(){return []}};`;
await build({stdin:{loader:'tsx',resolveDir:project,contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {ToolSettingsPage} from './src/components/center/ToolSettingsPage';
import {InlineSvgIcon} from './src/components/InlineSvgIcon';
import './src/styles/global.css';import './src/components/center/CenterPanel.css';
const tools=[{value:'claude',label:'Claude Code'},{value:'codex',label:'Codex CLI'},{value:'cursor',label:'Cursor'},{value:'copilot',label:'Copilot CLI'},{value:'antigravity',label:'Antigravity CLI',installed:false},{value:'pi',label:'Pi'},{value:'kiro',label:'Kiro'}].map(item=>({...item,icon:item.value==='antigravity'?<InlineSvgIcon markup={${JSON.stringify(antigravitySvg)}}/>:<span>{item.label[0]}</span>}));
createRoot(document.getElementById('root')).render(<div className="main-content" style={{position:'absolute',inset:0}}><ToolSettingsPage active tools={tools} count={6} limit={6}><div>selection</div></ToolSettingsPage></div>);`
},bundle:true,jsx:'automatic',loader:{'.svg':'text','.png':'dataurl'},outfile:join(directory,'fixture.js'),logLevel:'silent',external:['/fonts/*','/monogram.svg'],plugins:[{name:'native-boundary',setup(b){
b.onResolve({filter:/\/tauri$/},a=>({path:a.path,namespace:'fixture'}));b.onResolve({filter:/\/store\/app-state$/},a=>({path:a.path,namespace:'fixture'}));
b.onLoad({filter:/.*/,namespace:'fixture'},a=>({loader:'js',contents:a.path.endsWith('/tauri')?mock:'export function useAppLanguage(){return "zh-CN"}'}));}}]});
const server=http.createServer(async(req,res)=>{
if(req.url==='/fixture.js'||req.url==='/fixture.css'){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'application/javascript');return res.end(await readFile(join(directory,req.url.slice(1))))}
if(/^\/fonts\/[\w.-]+\.woff2$/.test(req.url)||req.url==='/monogram.svg'){return res.end(await readFile(join(project,'public',req.url)))}
res.setHeader('Content-Type','text/html');res.end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE});
try{
const page=await browser.newPage({viewport:{width:1080,height:780}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}`);
const tab=name=>page.getByRole('tab',{name,exact:true}),agent=name=>page.getByRole('switch',{name,exact:true});
assert.equal(await page.getByRole('tab').count(),6);assert.deepEqual(await page.evaluate(()=>window.calls),[]);
assert.deepEqual(await page.getByRole('tab').allTextContents(),['常用 6/6','主记忆','多智能体编排','Skills','Computer Use','Browser Use']);
assert.deepEqual(await page.evaluate(()=>window.teamCalls),[],'orchestration reads only when opened');
await tab('多智能体编排').click();await agent('Claude Code').waitFor();await page.waitForFunction(()=>!document.querySelector('.orchestration-config [role="switch"]').disabled);
assert.equal(await agent('Claude Code').getAttribute('aria-checked'),'false');assert.equal(await page.locator('.orchestration-config .tool-control-agent').count(),6);
assert.equal(await agent('Cursor').isDisabled(),true);assert.equal(await agent('Antigravity CLI').isDisabled(),true);assert.equal(await agent('Kiro').count(),0);
await page.getByText('未安装',{exact:true}).waitFor();assert.equal(await page.getByText('暂不支持',{exact:true}).count(),3);
await page.evaluate(()=>window.delayTeam=true);await agent('Claude Code').click();await page.waitForFunction(()=>!!window.resolveTeam);
assert.equal(await agent('Claude Code').isDisabled(),true);assert.equal(await page.locator('.orchestration-config .tool-control-spinner').count(),1);
assert.equal(await agent('Claude Code').evaluate(el=>getComputedStyle(el).opacity),'1','saving must not flash the active switch to the unavailable opacity');
assert.equal(await agent('Codex CLI').evaluate(el=>getComputedStyle(el).opacity),'1','saving must not flash other available switches');
assert.ok(Number(await agent('Cursor').evaluate(el=>getComputedStyle(el).opacity))<1,'unsupported tools remain dim while another switch saves');
await page.evaluate(()=>{window.delayTeam=false;window.resolveTeam()});await page.waitForFunction(()=>window.team.agents.includes('claude'));
assert.equal(await agent('Codex CLI').getAttribute('aria-checked'),'false','each agent has an independent switch');
await agent('Codex CLI').click();await page.waitForFunction(()=>window.team.agents.includes('codex'));
await page.waitForTimeout(260);await page.screenshot({path:join(directory,'orchestration-dark.png')});
await page.evaluate(()=>window.failTeam=true);await agent('Claude Code').click();await page.getByRole('alert').waitFor();assert.equal(await agent('Claude Code').getAttribute('aria-checked'),'true');
await page.evaluate(()=>window.failTeam=false);await agent('Claude Code').click();await page.waitForFunction(()=>!window.team.agents.includes('claude'));
assert.equal(await agent('Codex CLI').getAttribute('aria-checked'),'true','disabling one agent preserves the others');
const teamCard=agent('Codex CLI').locator('..');let teamCount=await page.evaluate(()=>window.teamCalls.filter(call=>typeof call==='object').length);
await teamCard.click({position:{x:100,y:30}});await page.waitForFunction(()=>!window.team.agents.includes('codex'));
assert.equal(await page.evaluate(()=>window.teamCalls.filter(call=>typeof call==='object').length),teamCount+1,'card label toggles exactly once');
await agent('Codex CLI').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>window.team.agents.includes('codex'));
for (const enabled of [false, true]) {
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    window.delayTeam=true;window.resolveTeam=null;window.switchFrames=[];window.switchChanges=[];
    const button=document.querySelector('.orchestration-config [aria-label="Codex CLI"]'),thumb=button.querySelector('span');
    window.switchObserver=new MutationObserver(records=>window.switchChanges.push(...records.map(record=>record.oldValue)));
    window.switchObserver.observe(button,{attributes:true,attributeFilter:['aria-checked'],attributeOldValue:true});
    const frame=()=>{const transform=getComputedStyle(thumb).transform;window.switchFrames.push({x:transform==='none'?0:new DOMMatrix(transform).m41,opacity:Number(getComputedStyle(button).opacity)});if(window.switchFrames.length<30)requestAnimationFrame(frame)};
    requestAnimationFrame(frame);
  });
  await agent('Codex CLI').click();await page.waitForFunction(()=>!!window.resolveTeam);
  await page.waitForTimeout(45);await page.evaluate(()=>{window.delayTeam=false;window.resolveTeam()});
  await page.waitForFunction(()=>window.switchFrames.length===30);await page.evaluate(()=>window.switchObserver.disconnect());
  const frames=await page.evaluate(()=>window.switchFrames);
  assert.equal(await agent('Codex CLI').getAttribute('aria-checked'),String(enabled));
  assert.equal((await page.evaluate(()=>window.switchChanges)).length,1,'each successful toggle changes its logical state once');
  assert.ok(frames.every(frame=>frame.opacity===1),'no dim/bright flash in any sampled animation frame');
  assert.ok(frames.slice(1).every((frame,index)=>enabled?frame.x>=frames[index].x-.1:frame.x<=frames[index].x+.1),'thumb moves in one direction without bouncing back');
}
await tab('常用 6/6').click();await tab('多智能体编排').click();await page.waitForFunction(()=>!document.querySelector('.orchestration-config [role="switch"]').disabled);
assert.equal(await agent('Codex CLI').getAttribute('aria-checked'),'true','saved choice survives page changes');
await page.evaluate(()=>document.documentElement.dataset.mode='light');await page.screenshot({path:join(directory,'orchestration-light.png')});await page.evaluate(()=>document.documentElement.dataset.mode='dark');
await tab('Computer Use').click();await agent('Claude Code').waitFor();assert.equal(await page.getByRole('switch').count(),6);assert.equal(await page.locator('.tool-control-agents').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3);assert.equal(await agent('Pi').isDisabled(),true);assert.equal(await agent('Kiro').count(),0);await page.getByText('暂不可用',{exact:true}).waitFor();
await page.getByText('未安装',{exact:true}).waitFor();assert.equal(await agent('Antigravity CLI').isDisabled(),true);
assert.equal(await agent('Antigravity CLI').locator('..').locator('[data-tip]').count(),0,'missing tools take priority over config errors');
assert.match(await agent('Pi').locator('..').locator('[data-tip]').getAttribute('aria-label'),/Pi/);
const computerCard=agent('Claude Code').locator('..');const setCount=await page.evaluate(()=>window.calls.filter(call=>call.type==='set').length);
await computerCard.click({position:{x:100,y:30}});await page.waitForFunction(()=>window.controlStatus.computer.agents[0].enabled);
assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='set').length),setCount+1,'computer card label toggles exactly once');
await agent('Claude Code').focus();await page.keyboard.press('Space');await page.waitForFunction(()=>!window.controlStatus.computer.agents[0].enabled);
const themedHeadings=()=>page.evaluate(()=>{
 const panel=document.querySelector('[role="tabpanel"]:not([hidden]) .tool-control');
 const accent=getComputedStyle(panel.querySelector('.tool-control-symbol')).color;
 return getComputedStyle(panel.querySelector('.tool-control-summary strong')).color===accent&&getComputedStyle(panel.querySelector('.control-demo-heading > span')).color===accent;
});
assert.equal(await themedHeadings(),true,'runtime and demo headings use the dark theme accent');
assert.deepEqual(await page.evaluate(()=>window.calls.filter(call=>call.type==='read')),[{type:'read',kind:'computer'}]);
const computerIcon=await agent('Antigravity CLI').locator('..').locator('.tool-control-agent-icon').screenshot();
const checkButton=page.getByRole('button',{name:'检测',exact:true});const checkWidth=(await checkButton.boundingBox()).width;
await page.evaluate(()=>window.delayCheck=true);await checkButton.click();await page.waitForFunction(()=>!!window.resolveCheck);
assert.equal(await checkButton.getAttribute('aria-busy'),'true');assert.equal(await checkButton.locator('.tool-control-spinner').isVisible(),true);
assert.equal((await checkButton.boundingBox()).width,checkWidth,'loading keeps the runtime button width');
assert.equal(await page.locator('.tool-control-agent > .tool-control-spinner').count(),0);
assert.equal(await page.getByText('处理中…',{exact:true}).count(),0);
await page.screenshot({path:join(directory,'check-pending.png')});
await page.evaluate(()=>{window.delayCheck=false;window.resolveCheck()});await page.waitForFunction(()=>document.querySelector('.tool-control-action')?.getAttribute('aria-busy')==='false');
await agent('Cursor').click();await page.waitForFunction(()=>window.controlStatus.computer.agents[2].enabled);assert.equal(await agent('Claude Code').getAttribute('aria-checked'),'false');
await page.evaluate(()=>window.delaySet=true);await agent('Claude Code').click();await page.waitForFunction(()=>!!window.resolveSet);assert.equal(await agent('Codex CLI').isDisabled(),true);
assert.equal(await agent('Claude Code').evaluate(el=>getComputedStyle(el).opacity),'1','computer switch brightness remains stable during saving');
assert.equal(await agent('Codex CLI').evaluate(el=>getComputedStyle(el).opacity),'1','other supported computer switches do not flicker');
assert.ok(Number(await agent('Antigravity CLI').evaluate(el=>getComputedStyle(el).opacity))<1,'missing tools remain dim');
assert.equal(await agent('Claude Code').getAttribute('aria-checked'),'false','pending writes preserve the last confirmed position');
assert.equal(await agent('Claude Code').getAttribute('aria-busy'),'true');assert.equal(await agent('Claude Code').locator('..').locator('.tool-control-spinner').count(),1);
assert.equal(await page.locator('.tool-control-runtime .tool-control-spinner').count(),0);assert.equal(await checkButton.getAttribute('aria-busy'),'false');
assert.equal(await checkButton.locator('span').innerText(),'检测','agent changes leave the runtime action label unchanged');
await page.screenshot({path:join(directory,'agent-pending.png')});
await tab('Browser Use').click();await page.getByRole('button',{name:'安装',exact:true}).waitFor();
assert.deepEqual(await agent('Antigravity CLI').locator('..').locator('.tool-control-agent-icon').screenshot(),computerIcon,'both control pages paint the same icon while the other page is hidden');
assert.equal(await page.evaluate(()=>{
 const definitions=[...document.querySelectorAll('.tool-control-agent-icon svg [id]')];
 return definitions.length>0&&new Set(definitions.map(node=>node.id)).size===definitions.length&&[...document.querySelectorAll('.tool-control-agent-icon svg [mask], .tool-control-agent-icon svg [filter]')].every(node=>{
  const reference=(node.getAttribute('mask')||node.getAttribute('filter')).match(/url\(#([^)]+)\)/);
  return reference&&document.getElementById(reference[1])?.closest('svg')===node.closest('svg');
 });
}),true,'all SVG masks and filters resolve within their own instance');
await page.evaluate(()=>{window.delaySet=false;window.resolveSet()});
await tab('Computer Use').click();await page.waitForFunction(()=>document.querySelector('[role="tabpanel"]:not([hidden]) [role="switch"]').getAttribute('aria-checked')==='true');
await page.waitForTimeout(250);await page.screenshot({path:join(directory,'computer-dark.png')});
await page.evaluate(()=>window.failSet=true);await agent('Claude Code').click();await page.getByRole('alert').waitFor();assert.equal(await agent('Claude Code').getAttribute('aria-checked'),'true');assert.equal(await agent('Claude Code').locator('..').locator('.tool-control-spinner').count(),0);await page.evaluate(()=>window.failSet=false);
await tab('Browser Use').click();assert.equal(await agent('Claude Code').isDisabled(),true);await page.evaluate(()=>window.delayInstall=true);await page.getByRole('button',{name:'安装',exact:true}).click();await page.waitForFunction(()=>!!window.resolveInstall);
assert.equal(await page.getByRole('button',{name:'安装',exact:true}).locator('.tool-control-spinner').isVisible(),true);
assert.equal(await page.locator('.tool-control-agent > .tool-control-spinner').count(),0);
await page.evaluate(()=>{window.delayInstall=false;window.resolveInstall()});assert.equal(await agent('Antigravity CLI').isDisabled(),true);
await page.getByText('请先安装 Chrome，然后重新检测。',{exact:true}).waitFor();assert.equal(await page.locator('[role="tabpanel"]:not([hidden])').getByText('可用',{exact:true}).count(),0);assert.equal(await agent('Claude Code').isDisabled(),true);
await page.evaluate(()=>{window.controlStatus.browser.ready=true;window.controlStatus.browser.browser='Edge';window.failCheck=true});await page.getByRole('button',{name:'检测',exact:true}).click();await page.getByRole('alert').waitFor();
await page.evaluate(()=>window.failCheck=false);await page.getByRole('button',{name:'检测',exact:true}).click();await page.locator('[role="tabpanel"]:not([hidden])').getByText('可用',{exact:true}).waitFor();await agent('Codex CLI').click();await page.waitForFunction(()=>window.controlStatus.browser.agents[1].enabled);
assert.equal(await agent('Claude Code').getAttribute('aria-checked'),'false');
await page.evaluate(()=>{window.controlStatus.computer.agents[1].conflict=true;window.controlStatus.computer.agents[1].issue='conflict'});await tab('Computer Use').click();await agent('Codex CLI').locator('..').getByText('暂不可用',{exact:true}).waitFor();
assert.match(await agent('Codex CLI').locator('..').locator('[data-tip]').getAttribute('aria-label'),/coffee-computer-use/);assert.equal(await agent('Codex CLI').isDisabled(),true);
await page.evaluate(()=>{window.controlStatus.computer.agents[1].conflict=false;window.delaySet=true;window.resolveSet=null;window.resolveRead=null;window.delayRead='computer'});await agent('Claude Code').click();await page.waitForFunction(()=>!!window.resolveSet);
await tab('Browser Use').click();await tab('Computer Use').click();await page.waitForFunction(()=>!!window.resolveRead);
await page.evaluate(()=>{window.delaySet=false;window.resolveSet()});await page.waitForFunction(()=>document.querySelector('[role="tabpanel"]:not([hidden]) [role="switch"]').getAttribute('aria-checked')==='false');await page.evaluate(()=>{window.delayRead=null;window.resolveRead()});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
assert.equal(await agent('Claude Code').getAttribute('aria-checked'),'false');
await page.evaluate(()=>{document.documentElement.dataset.mode='light';document.documentElement.dataset.theme='mint';document.documentElement.dataset.shape='slate'});await tab('Browser Use').click();await page.waitForTimeout(250);await page.screenshot({path:join(directory,'browser-light.png')});
assert.equal(await themedHeadings(),true,'heading colors follow a changed light theme');
await page.setViewportSize({width:440,height:720});assert.equal(await page.locator('.tool-settings-page').evaluate(el=>el.scrollWidth>el.clientWidth),false);
await tab('Computer Use').focus();await page.keyboard.press('ArrowRight');assert.equal(await tab('Browser Use').getAttribute('aria-selected'),'true');
await page.setViewportSize({width:1080,height:900});await tab('Computer Use').click();
const demo=page.getByRole('region',{name:'操作演示',exact:true});await demo.scrollIntoViewIfNeeded();
assert.equal(await page.locator('.control-demo').count(),1,'inactive control tabs do not keep animations mounted');
const callsBeforeDemo=await page.evaluate(()=>window.calls.length);
await page.getByRole('button',{name:'暂停演示',exact:true}).click();
assert.equal(await demo.getAttribute('data-paused'),'true');
assert.equal(await demo.locator('.control-demo-cursor').evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
const phase=async(time)=>demo.evaluate((root,time)=>root.getAnimations({subtree:true}).forEach(animation=>{animation.currentTime=time}),time);
await phase(6500);assert.ok(Number(await demo.locator('.control-demo-bubble').evaluate(el=>getComputedStyle(el).opacity))>.99);
assert.ok(Number(await demo.locator('.control-demo-done').evaluate(el=>getComputedStyle(el).opacity))<.01);
await page.evaluate(()=>{document.documentElement.dataset.mode='dark';document.documentElement.dataset.theme='obsidian';document.documentElement.dataset.shape='panel'});
await page.screenshot({path:join(directory,'demo-computer-operating.png')});
await phase(12000);assert.ok(Number(await demo.locator('.control-demo-done').evaluate(el=>getComputedStyle(el).opacity))>.99);
assert.equal(await demo.locator('.control-demo-list-item').count(),3);
assert.ok(Number(await demo.locator('.control-demo-list-item-2').evaluate(el=>getComputedStyle(el).opacity))>.99);
await page.screenshot({path:join(directory,'demo-computer-complete.png')});await demo.screenshot({path:join(directory,'demo-wide.png')});
await page.getByRole('button',{name:'播放演示',exact:true}).click();assert.equal(await demo.getAttribute('data-paused'),'false');
await tab('Browser Use').click();await demo.scrollIntoViewIfNeeded();await page.getByRole('button',{name:'暂停演示',exact:true}).click();
await phase(7700);assert.ok(Number(await demo.locator('.control-demo-act').evaluate(el=>getComputedStyle(el).opacity))>.99,'operation step is shown with browser search results');assert.ok(Number(await demo.locator('.control-demo-search-result').evaluate(el=>getComputedStyle(el).opacity))>.99);
await page.screenshot({path:join(directory,'demo-browser-search.png')});
await phase(12000);assert.ok(Number(await demo.locator('.control-demo-result').evaluate(el=>getComputedStyle(el).opacity))>.99);
await page.screenshot({path:join(directory,'demo-browser-complete.png')});
await page.setViewportSize({width:440,height:840});
assert.equal(await page.locator('.tool-settings-page').evaluate(el=>el.scrollWidth>el.clientWidth),false);
await demo.scrollIntoViewIfNeeded();await page.screenshot({path:join(directory,'demo-narrow.png')});
await page.emulateMedia({reducedMotion:'reduce'});
assert.equal(await demo.evaluate(el=>el.getAnimations({subtree:true}).length),0,'reduced motion uses a static completed demonstration');
assert.equal(await demo.locator('.control-demo-result').isVisible(),true);
assert.equal(await page.evaluate(()=>window.calls.filter(call=>call.type==='set'||call.type==='install').length),await page.evaluate(count=>window.calls.slice(0,count).filter(call=>call.type==='set'||call.type==='install').length,callsBeforeDemo),'demo playback does not install or operate tools');
await page.emulateMedia({reducedMotion:'no-preference'});
await page.setViewportSize({width:1080,height:950});await tab('多智能体编排').click();await demo.scrollIntoViewIfNeeded();
assert.equal(await page.locator('.control-demo').count(),1,'only the active orchestration demonstration is mounted');
assert.equal(await demo.getAttribute('data-kind'),'orchestration');
const teamWrites=await page.evaluate(()=>window.teamCalls.filter(call=>typeof call==='object').length);
await page.getByRole('button',{name:'暂停演示',exact:true}).click();
await phase(2500);assert.ok(Number(await demo.locator('.team-demo-worker-0.team-demo-tab').evaluate(el=>getComputedStyle(el).opacity))<.01,'child tabs are absent before delegation');
await phase(6500);assert.equal(await demo.locator('.team-demo-worker').count(),2);
assert.deepEqual(await demo.locator('.team-demo-tabs > span').evaluateAll(tabs=>tabs.map(tab=>[...tab.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim())),['Claude','Codex','OpenCode'],'child tabs follow the coordinating Claude tab');
assert.ok(Number(await demo.locator('.team-demo-worker-1.team-demo-tab').evaluate(el=>getComputedStyle(el).opacity))>.99);
assert.ok(Number(await demo.locator('.team-demo-worker-0 .team-demo-running').evaluate(el=>getComputedStyle(el).opacity))>.99);
assert.ok(Number(await demo.locator('.team-demo-summary').evaluate(el=>getComputedStyle(el).opacity))<.01,'summary waits for both workers');
await page.screenshot({path:join(directory,'demo-orchestration-working.png')});
await phase(12500);assert.ok(Number(await demo.locator('.team-demo-worker-1 .team-demo-finished').evaluate(el=>getComputedStyle(el).opacity))>.99);
assert.ok(Number(await demo.locator('.team-demo-worker-0 .team-demo-running').evaluate(el=>getComputedStyle(el).opacity))<.01);
assert.ok(Number(await demo.locator('.team-demo-summary').evaluate(el=>getComputedStyle(el).opacity))>.99);
assert.ok(Number(await demo.locator('.control-demo-done').evaluate(el=>getComputedStyle(el).opacity))>.99);
await page.screenshot({path:join(directory,'demo-orchestration-complete.png')});await demo.screenshot({path:join(directory,'demo-orchestration-wide.png')});
await page.evaluate(()=>{document.documentElement.dataset.mode='light';document.documentElement.dataset.theme='mint';document.documentElement.dataset.shape='slab'});
await page.screenshot({path:join(directory,'demo-orchestration-light.png')});
await page.setViewportSize({width:440,height:840});await demo.scrollIntoViewIfNeeded();await phase(12500);assert.equal(await page.locator('.tool-settings-page').evaluate(el=>el.scrollWidth>el.clientWidth),false);
for (const index of [0,1]) assert.ok(Number(await demo.locator(`.team-demo-worker-${index}.team-demo-worker`).evaluate(el=>getComputedStyle(el).opacity))>.99,'worker cards remain visible after a responsive layout change');
const fits=await demo.locator('.team-demo-summary').evaluate(el=>el.getBoundingClientRect().bottom<=el.closest('.control-demo-window').getBoundingClientRect().bottom);assert.equal(fits,true,'orchestration summary fits narrow windows');
await page.screenshot({path:join(directory,'demo-orchestration-narrow.png')});
await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await demo.evaluate(el=>el.getAnimations({subtree:true}).length),0);assert.equal(await demo.locator('.team-demo-running').first().isVisible(),false);
assert.equal(await demo.locator('.team-demo-summary').isVisible(),true);assert.equal(await page.evaluate(()=>window.teamCalls.filter(call=>typeof call==='object').length),teamWrites,'demonstration never starts real workers or changes configuration');
await page.emulateMedia({reducedMotion:'no-preference'});
await page.setViewportSize({width:1080,height:1000});await tab('Skills').click();await tab('Claude Code').click();await page.getByText('暂无技能',{exact:true}).waitFor();
const emptyGeometry=await page.locator('.skills-empty').evaluate(element=>{const rect=element.getBoundingClientRect(),panel=document.querySelector('.tool-settings-page').getBoundingClientRect(),range=document.createRange();range.selectNodeContents(element);const text=range.getBoundingClientRect();return {bottom:rect.bottom,expected:panel.bottom-32,center:(rect.top+rect.bottom)/2,textCenter:(text.top+text.bottom)/2}});
assert.ok(Math.abs(emptyGeometry.bottom-emptyGeometry.expected)<2,'empty skills fill the available page height');assert.ok(Math.abs(emptyGeometry.center-emptyGeometry.textCenter)<2,'empty text is vertically centered');
assert.deepEqual(errors,[]);
console.log('OK: six themed tabs, lazy reads, explicit installation, per-agent switches, serialization, conflicts, errors, late-read protection, themes, narrow layout, isolated SVG masks, demo phases, pause/resume and reduced motion');console.log('Screenshots: '+directory);
}finally{await browser.close();await new Promise(r=>server.close(r))}
