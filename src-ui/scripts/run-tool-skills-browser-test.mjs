import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-skills-ui-'));
const mock = `
window.calls=[];window.delayInventory=true;window.delayCheck=true;window.delaySearch=true;
const demo={name:'demo',description:'An installed skill',source:'owner/repo',path:'C:/fixture/demo',managed:true,update:true,modified:false};
window.inventory={claude:{supported:true,skills:[demo,{...demo,name:'local',source:null,path:'C:/fixture/local',managed:false,update:false}]},codex:{supported:true,skills:[]},cursor:{supported:false,skills:[]}};
window.catalogue=[{name:'web-design-guidelines',source:'vercel-labs/agent-skills',description:'Review a page for accessibility and visual consistency.'},{name:'react-best-practices',source:'vercel-labs/agent-skills',description:'Build and review React applications.'},{name:'cached-description',source:'owner/repo',description:''},{name:'local',source:'owner/repo',description:'A different source with the same name.'}];
export const commands={
 async getToolSkills(tool){window.calls.push({type:'list',tool});const value=structuredClone(window.inventory[tool]??{supported:true,skills:[]});if(window.delayInventory&&tool==='claude')await new Promise(r=>window.resolveInventory=r);return value},
 async checkToolSkillUpdates(tool){const value=structuredClone(window.inventory[tool]);if(window.delayCheck)await new Promise(r=>window.resolveCheck=r);return value},
 async searchToolSkills(query,onUpdate){window.calls.push({type:'search',query});if(window.delaySearch)await new Promise(r=>window.resolveCatalogue=r);if(query==='alpha')await new Promise(r=>window.resolveAlpha=r);if(query==='progress'){window.lateCatalogueUpdate=()=>onUpdate([{name:'stale-progress',source:'owner/repo',description:'Late cached result'}]);onUpdate([{name:'partial-one',source:'owner/repo',description:'First result'},{name:'partial-two',source:'owner/repo',description:'Second result'}]);await new Promise(r=>window.resolveProgress=r);return [{name:'partial-one',source:'owner/repo',description:'First result'},{name:'partial-two',source:'owner/repo',description:'Second result'},{name:'partial-three',source:'owner/repo',description:'Third result'}]}if(window.failSearch)throw 'skills_network';return query?[{name:query,source:'owner/repo',description:query+' skill'}]:window.catalogue},
 async getToolSkillDescription(source,name){window.calls.push({type:'description',source,name});return 'A description from the public catalogue.'},
 async installToolSkill(tool,source,name){window.calls.push({type:'install',tool,source,name});if(window.failInstall)throw 'skills_modified';if(window.delayInstall)await new Promise(r=>window.resolveInstall=r);const row={...demo,name,source,path:'C:/fixture/'+tool+'/'+name,update:false};window.inventory[tool].skills=window.inventory[tool].skills.filter(s=>s.name!==name).concat(row);return structuredClone(window.inventory[tool])},
 async removeToolSkill(tool,path){window.calls.push({type:'remove',tool,path});window.inventory[tool].skills=window.inventory[tool].skills.filter(s=>s.path!==path);return structuredClone(window.inventory[tool])},
 async openUrl(url){window.calls.push({type:'open',url})}
};`;
await build({ stdin:{loader:'tsx',resolveDir:project,contents:`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ToolSkillsPanel} from './src/components/center/ToolSkillsPanel';
import './src/styles/global.css';import './src/components/center/CenterPanel.css';import './src/components/center/ToolSettingsPage.css';
const initial=[{value:'claude',label:'Claude Code'},{value:'codex',label:'Codex CLI'},{value:'cursor',label:'Cursor'}].map(s=>({...s,icon:<span>{s.label[0]}</span>}));
function Fixture(){const[active,setActive]=useState(true),[tools,setTools]=useState(initial);window.setTools=values=>setTools(values.map(s=>({...s,icon:<span>{s.label[0]}</span>})));return <><button id="navigate" onClick={()=>setActive(!active)}>Navigate</button><main className="main-content panel-center" style={{position:'absolute',inset:'40px 0 0'}}><section className="tool-settings-page" style={{display:active?'block':'none'}}><ToolSkillsPanel active={active} tools={tools}/></section></main></>}
createRoot(document.getElementById('root')).render(<Fixture/>);`},bundle:true,jsx:'automatic',outfile:join(directory,'fixture.js'),logLevel:'silent',external:['/fonts/*','/monogram.svg'],plugins:[{name:'native-boundary',setup(b){
 b.onResolve({filter:/\/(?:tauri|store\/app-state)$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path.endsWith('/tauri')?mock:'export function useAppLanguage(){return "zh-CN"}'}));
}}] });
const server=http.createServer(async(req,res)=>{
 if(/^\/fonts\/[\w.-]+\.woff2$/.test(req.url)){res.setHeader('Content-Type','font/woff2');return res.end(await readFile(join(project,'public',req.url.slice(1))))}
 if(['/fixture.js','/fixture.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');return res.end(await readFile(join(directory,req.url.slice(1))))}
 res.setHeader('Content-Type','text/html');res.end('<html data-theme="obsidian" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.COFFEE_CHROMIUM_EXECUTABLE?{executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE}:{})});
try {
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let releaseAvatars,avatarOffline=false;
 const avatarGate=new Promise(resolve=>{releaseAvatars=resolve});
 await page.route('https://github.com/*.png?size=80',async route=>{await avatarGate;if(avatarOffline)return route.abort('failed');return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#6f8fb5"/></svg>'})});
 await page.addInitScript(()=>{if(!localStorage.getItem('cc-tool-skills-v1'))localStorage.setItem('cc-tool-skills-v1',JSON.stringify({inventories:[['claude',{supported:true,skills:[{name:'cached',description:'Last snapshot',source:null,path:'C:/cache',managed:false,modified:false,update:false}]}]],catalogues:[['',[{name:'cached-catalogue',source:'owner/repo',description:'Last catalogue'}]]]}))});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const card=name=>page.locator('.skill-card').filter({has:page.locator('.skill-card-heading strong').filter({hasText:new RegExp('^'+name+'$')})});
 const tab=name=>page.getByRole('tab',{name,exact:true});
 await card('cached-catalogue').waitFor();assert.equal(await tab('已安装').count(),0,'there is no ambiguous Installed tab');
 assert.equal(await page.locator('.skill-skeleton').count(),0,'cached content does not flash a skeleton');
 assert.equal(await card('cached-catalogue').locator('.skill-avatar').getAttribute('data-ready'),'false');
 assert.equal(await card('cached-catalogue').locator('.skill-avatar-fallback').innerText(),'C');
 assert.equal(await card('cached-catalogue').locator('.skill-avatar-fallback').evaluate(el=>getComputedStyle(el).opacity),'1','cached cards have a local avatar before any image response');
 await tab('Claude Code').click();await card('cached').waitFor();
 await page.waitForFunction(()=>!!window.resolveInventory&&!!window.resolveCatalogue);
 await page.evaluate(()=>{window.delayInventory=false;window.delaySearch=false;window.resolveInventory();window.resolveCatalogue()});await card('demo').waitFor();
 assert.equal(await card('local').locator('.skill-remove').count(),0,'unmanaged skills cannot be removed');
 await tab('发现').click();await card('web-design-guidelines').waitFor();
 await card('cached-description').getByText('A description from the public catalogue.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cc-tool-skills-v1')).descriptions.some(([key])=>key==='owner/repo/cached-description')),true);
 assert.equal(await page.locator('.skills-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),3);
 assert.equal(await card('web-design-guidelines').locator('.skill-card-top > .skill-install').count(),1,'install is at the top right');
 assert.equal(await card('web-design-guidelines').locator('.skill-avatar img').getAttribute('src'),'https://github.com/vercel-labs.png?size=80');
 const avatarBox=await card('web-design-guidelines').locator('.skill-avatar').boundingBox();
 assert.equal(await card('web-design-guidelines').locator('.skill-avatar-fallback').innerText(),'W');
 assert.equal(await card('web-design-guidelines').locator('.skill-avatar-fallback').evaluate(el=>getComputedStyle(el).opacity),'1','slow GitHub images never leave an empty avatar');
 assert.equal(await card('web-design-guidelines').locator('.skill-avatar img').evaluate(el=>getComputedStyle(el).opacity),'0');
 await page.screenshot({path:join(directory,'avatars-loading.png')});
 releaseAvatars();await card('web-design-guidelines').locator('.skill-avatar[data-ready="true"]').waitFor();
 assert.notEqual(await card('web-design-guidelines').locator('.skill-avatar img').evaluate(el=>getComputedStyle(el).transitionDuration),'0s','decoded avatars fade in');
 await page.waitForFunction(()=>{const image=[...document.querySelectorAll('.skill-card')].find(el=>el.querySelector('strong')?.textContent==='web-design-guidelines')?.querySelector('.skill-avatar img');return image&&getComputedStyle(image).opacity==='1'});
 assert.deepEqual(await card('web-design-guidelines').locator('.skill-avatar').boundingBox(),avatarBox,'avatar replacement never changes the layout');
 await page.screenshot({path:join(directory,'avatars-loaded.png')});
 await card('web-design-guidelines').locator('.skill-avatar img').evaluate(img=>img.dispatchEvent(new Event('error')));assert.equal(await card('web-design-guidelines').locator('.skill-avatar').innerText(),'W');
 await card('web-design-guidelines').getByRole('button',{name:'安装',exact:true}).click();
 const targets=card('web-design-guidelines').getByRole('group',{name:'安装 web-design-guidelines',exact:true});
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.type==='install').length),0,'expanding the card installs nothing');
 assert.equal(await targets.getByRole('button').count(),3);assert.equal(await targets.getByRole('button',{name:'安装 · Cursor',exact:true}).isDisabled(),true);
 await page.evaluate(()=>window.delayInstall=true);await targets.getByRole('button',{name:'安装 · Claude Code',exact:true}).click();
 await page.waitForFunction(()=>!!window.resolveInstall);assert.equal(await targets.getByRole('button',{name:'安装 · Codex CLI',exact:true}).isDisabled(),true);
 await page.locator('#navigate').click();await page.locator('#navigate').click();await page.waitForFunction(()=>window.calls.filter(c=>c.type==='list'&&c.tool==='claude').length>=2);
 await page.evaluate(()=>{window.delayInstall=false;window.resolveInstall()});await targets.getByRole('button',{name:'已安装 · Claude Code',exact:true}).waitFor();
 assert.equal(await targets.getByRole('button',{name:'已安装 · Claude Code',exact:true}).getAttribute('aria-pressed'),'true');
 await targets.getByRole('button',{name:'安装 · Codex CLI',exact:true}).click();await targets.getByRole('button',{name:'已安装 · Codex CLI',exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.type==='install').map(({tool,source,name})=>({tool,source,name}))),[
  {tool:'claude',source:'vercel-labs/agent-skills',name:'web-design-guidelines'}, {tool:'codex',source:'vercel-labs/agent-skills',name:'web-design-guidelines'}
 ]);
 assert.equal(await card('web-design-guidelines').locator('.skill-remove').count(),0,'Discover has no remove action');
 await card('web-design-guidelines').getByRole('button',{name:'安装',exact:true}).click();
 await card('web-design-guidelines').getByRole('img',{name:'Claude Code · 已安装',exact:true}).waitFor();await card('web-design-guidelines').getByRole('img',{name:'Codex CLI · 已安装',exact:true}).waitFor();
 await page.evaluate(()=>{window.delayCheck=false;window.resolveCheck()});await tab('Claude Code').click();await card('web-design-guidelines').waitFor();
 await card('web-design-guidelines').getByRole('button',{name:'卸载 web-design-guidelines',exact:true}).click();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.type==='remove').length),0);
 await card('web-design-guidelines').getByRole('button',{name:'取消',exact:true}).click();
 await card('web-design-guidelines').getByRole('button',{name:'卸载 web-design-guidelines',exact:true}).click();await card('web-design-guidelines').getByRole('button',{name:'卸载',exact:true}).click();await card('web-design-guidelines').waitFor({state:'detached'});
 assert.deepEqual(await page.evaluate(()=>window.calls.find(c=>c.type==='remove')),{type:'remove',tool:'claude',path:'C:/fixture/claude/web-design-guidelines'});
 await tab('Codex CLI').click();await card('web-design-guidelines').waitFor();
 await tab('Claude Code').click();await page.evaluate(()=>window.failInstall=true);await card('demo').getByRole('button',{name:'更新',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/保留本地修改/);await page.evaluate(()=>window.failInstall=false);
 await tab('Cursor').click();await page.getByText('暂未支持此工具的技能管理',{exact:true}).waitFor();
 await tab('发现').click();await card('web-design-guidelines').getByRole('img',{name:'Codex CLI · 已安装',exact:true}).waitFor();assert.equal(await card('web-design-guidelines').getByRole('img',{name:'Claude Code · 已安装',exact:true}).count(),0);
 await card('local').getByRole('button',{name:'安装',exact:true}).click();assert.equal(await card('local').getByRole('button',{name:'安装 · Claude Code',exact:true}).isDisabled(),true);assert.equal(await card('local').getByRole('button',{name:'已安装 · Claude Code',exact:true}).count(),0,'same-name local files do not claim this source is installed');
 const search=page.getByRole('textbox',{name:'搜索技能',exact:true});await search.fill('progress');await page.locator('.skill-skeleton').first().waitFor();await card('partial-one').waitFor();await card('partial-two').waitFor();assert.equal(await page.locator('.skill-skeleton').count(),4,'partial results appear before completion');await page.evaluate(()=>window.resolveProgress());await card('partial-three').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.skill-skeleton').length===0);await page.evaluate(()=>window.lateCatalogueUpdate());assert.equal(await card('stale-progress').count(),0,'late progress cannot overwrite the final catalogue');
 await search.fill('alpha');await page.waitForFunction(()=>!!window.resolveAlpha);
 await tab('Codex CLI').click();assert.equal(await page.locator('.skills-search .skill-spinner').count(),0);await tab('发现').click();await search.fill('beta');await card('beta').waitFor();await page.evaluate(()=>window.resolveAlpha());assert.equal(await card('alpha').count(),0);
 await search.fill('');await card('web-design-guidelines').waitFor();await page.evaluate(()=>window.failSearch=true);await page.locator('#navigate').click();await page.locator('#navigate').click();await page.getByRole('alert').waitFor();await card('web-design-guidelines').waitFor();
 await card('web-design-guidelines').getByRole('button',{name:'安装',exact:true}).click();await page.screenshot({path:join(directory,'skills-dark.png'),animations:'disabled'});
 for(const shape of ['soft','panel','glass','carbon','monogram']){await page.evaluate(shape=>document.documentElement.dataset.shape=shape,shape);assert.notEqual(await card('web-design-guidelines').locator('.skill-install').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)',shape);assert.notEqual(await card('web-design-guidelines').evaluate(el=>getComputedStyle(el).borderTopColor),'rgba(0, 0, 0, 0)',shape+' retains card outlines');assert.notEqual(await card('web-design-guidelines').locator('.skill-avatar').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)',shape+' retains the avatar fallback surface');}
 await page.evaluate(()=>{document.documentElement.dataset.mode='light';document.documentElement.dataset.theme='mint';document.documentElement.dataset.shape='panel'});await page.screenshot({path:join(directory,'skills-light.png')});
 await page.setViewportSize({width:780,height:850});assert.equal(await page.locator('.skills-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2);
 await page.evaluate(()=>window.setTools([{value:'claude',label:'Claude Code'},{value:'codex',label:'Codex CLI'},{value:'cursor',label:'Cursor'},...Array.from({length:4},(_,i)=>({value:'extra'+i,label:'Extra '+i}))]));
 assert.equal(await page.getByRole('tablist',{name:'Skills',exact:true}).getByRole('tab').count(),7,'six tool icons plus Discover');if(await card('web-design-guidelines').getByRole('button',{name:'安装',exact:true}).getAttribute('aria-expanded')!=='true')await card('web-design-guidelines').getByRole('button',{name:'安装',exact:true}).click();assert.equal(await card('web-design-guidelines').getByRole('group').getByRole('button').count(),6);
 await page.setViewportSize({width:440,height:780});assert.equal(await page.locator('.tool-settings-page').evaluate(el=>el.scrollWidth>el.clientWidth),false);assert.equal(await page.locator('.skills-grid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1);
 avatarOffline=true;await page.addInitScript(()=>window.failSearch=true);await page.reload();await card('web-design-guidelines').waitFor();await page.waitForFunction(()=>!!window.resolveCatalogue);await page.evaluate(()=>{window.delaySearch=false;window.resolveCatalogue()});await page.getByRole('alert').waitFor();await card('web-design-guidelines').waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.skill-card')].find(el=>el.querySelector('strong')?.textContent==='web-design-guidelines')?.querySelector('.skill-avatar img')===null);
 assert.equal(await card('web-design-guidelines').locator('.skill-avatar-fallback').evaluate(el=>getComputedStyle(el).opacity),'1','blocked GitHub avatars retain the local fallback');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await card('web-design-guidelines').locator('.skill-avatar-fallback').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
 await page.screenshot({path:join(directory,'avatars-offline.png')});
 const cold=await browser.newPage({viewport:{width:1100,height:850}});cold.on('pageerror',error=>errors.push(error.message));
 await cold.route('https://github.com/*.png?size=80',route=>route.abort('failed'));
 await cold.goto(`http://127.0.0.1:${server.address().port}`);await cold.locator('.skill-skeleton').first().waitFor();
 assert.equal(await cold.locator('.skill-skeleton').count(),6,'a fresh profile shows skeletons before metadata arrives');
 await cold.waitForFunction(()=>!!window.resolveCatalogue);await cold.evaluate(()=>{window.delaySearch=false;window.resolveCatalogue()});
 await cold.locator('.skill-card-heading strong').filter({hasText:'web-design-guidelines'}).waitFor();
 assert.equal(await cold.locator('.skill-skeleton').count(),0);
 assert.equal(await cold.locator('.skill-avatar-fallback').first().evaluate(el=>getComputedStyle(el).opacity),'1','new metadata immediately has a local avatar without waiting for GitHub');
 await cold.screenshot({path:join(directory,'avatars-cold-offline.png')});await cold.close();
 assert.deepEqual(errors,[]);console.log('OK: cached discovery and tool lists, explicit per-tool installs, multiple recipients, independent removal, stale response protection, source conflicts, lazy descriptions, immediate avatar fallback, decode/fade-in, blocked avatars, cold skeletons, six-tool limit, reload/offline cache and responsive themes');
 console.log('Screenshots: '+directory);
}finally{await browser.close();await new Promise(r=>server.close(r))}
