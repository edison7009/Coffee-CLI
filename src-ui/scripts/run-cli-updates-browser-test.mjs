import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-cli-update-ui-'));
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CliUpdateButton}from'./src/components/center/CliUpdateButton';import{LaunchModeControl}from'./src/components/center/LaunchModeControl';import'./src/styles/global.css';import'./src/components/center/CenterPanel.css';
const tools=[['claude','Claude Code'],['codex','Codex CLI'],['cursor','Cursor'],['copilot','Copilot CLI'],['opencode','OpenCode'],['terminal','终端']];
function App(){const[visible,setVisible]=useState(true),[language,setLanguage]=useState('zh-CN');window.showLauncher=setVisible;window.changeLanguage=value=>{window.language=value;setLanguage(value)};return <main data-language={language} className="panel-center"><div className="launchpad-container"><div className="launchpad-inner"><div className="launchpad-grid">{tools.map(([id,label])=><div key={id} className="launchpad-card-group"><div className="launchpad-card" onClick={()=>window.launches++}><div className="launchpad-icon">◇</div><div className="launchpad-card-info"><div className="launchpad-card-title"><span className="launchpad-card-name">{label}</span>{visible&&id!=='terminal'&&<CliUpdateButton tool={id} active installed={id!=='opencode'}/>}</div></div>{id==='claude'&&<button className="launchpad-folder" aria-label="打开文件夹" onClick={event=>{event.stopPropagation();window.configs++}}>📁</button>}{id==='claude'&&<LaunchModeControl value="desktop" onChange={()=>window.modes++}/>}</div></div>)}</div></div></div></main>};createRoot(document.getElementById('root')).render(<App/>);` }, bundle: true, jsx: 'automatic', outfile: join(directory, 'fixture.js'), external: ['/fonts/*','/monogram.svg', '/backgrounds/*'], plugins: [{ name: 'native', setup(b) {
  b.onResolve({filter:/(^|\/)tauri$/},()=>({path:'native',namespace:'fixture'}));
  b.onResolve({filter:/store\/app-state$/},()=>({path:'store',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='store'?`export function useAppLanguage(){return window.language||'zh-CN'}`:`
export const isTauri=true;window.launches=0;window.configs=0;window.modes=0;window.checks=[];window.updates=[];window.releaseChecks=[];window.releaseUpdates={};
window.statuses={claude:{tool:'claude',current:'1.0.0',latest:'1.2.0',available:true},codex:{tool:'codex',current:'1.0.0',latest:'2.0.0',available:true},cursor:{tool:'cursor',current:'2026.10.22-abc',latest:null,available:false},copilot:{tool:'copilot',current:'1.0.0',latest:'1.0.0',available:false}};
export const commands={async checkCliUpdate(tool){window.checks.push(tool);if(window.holdChecks)await new Promise(resolve=>window.releaseChecks.push(resolve));if(window.failCheck)throw 'offline';return window.statuses[tool]},async updateCli(tool){window.updates.push(tool);return new Promise((resolve,reject)=>{window.releaseUpdates[tool]=error=>{if(error){reject(error);return}window.statuses[tool]={...window.statuses[tool],current:window.statuses[tool].latest,available:false};resolve(window.statuses[tool])}})}};`}));
} }] });
const server = http.createServer(async (req,res) => {
  if(req.url==='/')return res.setHeader('Content-Type','text/html; charset=utf-8').end('<html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{margin:0;height:100%;width:100%}.panel-center{height:100%}</style><div id="root"></div><script src="/fixture.js"></script></html>');
  try{const name=req.url.slice(1);if(!['fixture.js','fixture.css'].includes(name))throw Error();res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css');res.end(await readFile(join(directory,name)))}catch{res.writeHead(404).end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.COFFEE_CHROMIUM_EXECUTABLE?{executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE}:{})});
try{
  const page=await browser.newPage({viewport:{width:900,height:700}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.holdChecks=true;localStorage.setItem('cc-cli-updates-v1',JSON.stringify([{tool:'claude',current:'1.0.0',latest:'1.1.0',available:true}]))});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card=name=>page.locator('.launchpad-card').filter({has:page.locator('.launchpad-card-info',{hasText:name})});
  await card('Claude Code').getByRole('button',{name:'更新 1.1.0',exact:true}).waitFor();
  assert.equal(await card('Claude Code').locator('.cli-update-label').textContent(),'更新','the card shows one word; the version is in the tip');
  await page.waitForFunction(()=>window.checks.length===4);
  assert.deepEqual(await page.evaluate(()=>window.checks.sort()),['claude','codex','copilot','cursor'],'only installed favorites are checked');
  await page.evaluate(()=>{window.holdChecks=false;window.releaseChecks.splice(0).forEach(resolve=>resolve())});
  await card('Claude Code').getByRole('button',{name:'更新 1.2.0',exact:true}).waitFor();
  assert.equal(await card('OpenCode').locator('.cli-update-button').count(),0);
  assert.equal(await card('Cursor').locator('.cli-update-button').count(),0);
  assert.equal(await card('Copilot CLI').locator('.cli-update-button').count(),0,'up-to-date tools have no extra label');
  await card('Claude Code').getByRole('button',{name:'更新 1.2.0',exact:true}).dblclick();
  await page.waitForFunction(()=>window.updates.length===1);
  assert.equal(await page.evaluate(()=>window.launches),0,'update clicks never launch a CLI or open its folder menu');
  const updating=card('Claude Code').getByRole('button',{name:'更新中',exact:true});
  assert.equal(await updating.isDisabled(),true);assert.equal(await updating.locator('.cli-update-label').evaluate(el=>getComputedStyle(el).visibility),'visible','busy keeps its label visible above the stripes');
  assert.equal(await updating.locator('.cli-update-label').textContent(),'更新中');
  assert.equal(await updating.locator('.cli-update-stripes').count(),1);
  assert.equal(await updating.locator('.cli-update-stripes').evaluate(el=>getComputedStyle(el).animationName),'cli-update-stripes');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await updating.locator('.cli-update-stripes').evaluate(el=>getComputedStyle(el).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  assert.equal(await card('Codex CLI').getByRole('button',{name:'更新 2.0.0',exact:true}).isEnabled(),true,'another tool retains its own update state');
  await page.evaluate(()=>window.showLauncher(false));await page.evaluate(()=>window.showLauncher(true));await updating.waitFor();
  assert.equal(await page.evaluate(()=>window.updates.length),1,'in-flight state survives launcher remounts');
  await page.evaluate(()=>window.releaseUpdates.claude('cli_update_timeout'));
  const retry=card('Claude Code').getByRole('button',{name:'更新 1.2.0',exact:true});await retry.waitFor();await page.mouse.move(0,0);await retry.hover();
  await page.getByRole('tooltip').filter({hasText:'更新超时'}).waitFor();assert.equal(await retry.getAttribute('title'),null);
  await retry.press('Enter');await page.waitForFunction(()=>window.updates.length===2);
  await card('Codex CLI').getByRole('button',{name:'更新 2.0.0',exact:true}).click();await page.waitForFunction(()=>window.updates.length===3);
  assert.equal(await page.getByRole('button',{name:'更新中',exact:true}).count(),2);
  await page.evaluate(()=>{window.releaseUpdates.claude();window.releaseUpdates.codex()});
  await page.waitForFunction(()=>document.querySelectorAll('.cli-update-button').length===0);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('cc-cli-updates-v1')).find(status=>status.tool==='claude').current),'1.2.0');
  await page.getByRole('button',{name:'打开文件夹',exact:true}).click();await page.getByRole('button',{name:'Terminal',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.configs),1);assert.equal(await page.evaluate(()=>window.modes),1);
  // A new upstream version refreshes independently of the other tools.
  await page.evaluate(()=>{window.statuses.claude={tool:'claude',current:'1.2.0',latest:'1.3.0',available:true};window.showLauncher(false)});
  await page.evaluate(()=>window.showLauncher(true));await card('Claude Code').getByRole('button',{name:'更新 1.3.0',exact:true}).waitFor();
  await page.evaluate(()=>{window.failCheck=true;window.showLauncher(false)});await page.evaluate(()=>window.showLauncher(true));
  await card('Claude Code').getByRole('button',{name:'更新 1.3.0',exact:true}).waitFor();
  for(const[mode,shape,width]of[['dark','soft',900],['light','panel',620],['dark','glass',460]]){
    await page.evaluate(({mode,shape})=>{document.documentElement.dataset.mode=mode;document.documentElement.dataset.shape=shape},{mode,shape});await page.setViewportSize({width,height:700});
    const update=await card('Claude Code').locator('.cli-update-button').boundingBox(),bounds=await card('Claude Code').boundingBox(),gear=await page.getByRole('button',{name:'打开文件夹',exact:true}).boundingBox();
    const name=await card('Claude Code').locator('.launchpad-card-name').boundingBox();
    assert.ok(update.x>=name.x+name.width&&update.x-(name.x+name.width)<=10,'the update label follows the tool name');
    assert.ok(Math.abs(update.y+update.height/2-(name.y+name.height/2))<2,'on the name line');
    assert.ok(update.x>=bounds.x&&update.x+update.width<=Math.min(bounds.x+bounds.width,gear.x),'inside the card, clear of the folder button');
    await page.mouse.move(0,0);await card('Claude Code').locator('.cli-update-button').hover();
    const tip=await page.getByRole('tooltip').boundingBox();
    const expectedLeft=Math.max(8,Math.min(update.x+update.width/2-tip.width/2,width-tip.width-8));
    assert.ok(Math.abs(tip.x-expectedLeft)<1&&tip.x+tip.width<=width-8,'tip is centered beneath the update button and clamped at viewport edges');
    assert.ok(Math.abs(tip.y-update.y-update.height-8)<1,'centered tip retains the space below the button');
    await page.mouse.move(0,0);await card('Claude Code').locator('.cli-update-button').evaluate(el=>el.blur());await card('Claude Code').locator('.cli-update-button').focus();
    assert.ok(Math.abs((await page.getByRole('tooltip').boundingBox()).x-tip.x)<1,'keyboard focus uses the same centered placement');
    await page.screenshot({path:join(directory,`cli-updates-${mode}-${shape}.png`)});
    await card('Claude Code').locator('.cli-update-button').click();
    await updating.waitFor();
    const busyBounds=await updating.boundingBox();
    assert.equal(busyBounds.width,update.width,'the busy pill keeps its size');
    assert.equal(await updating.evaluate(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)'),false,'busy track remains visible in each shape');
    await page.screenshot({path:join(directory,`cli-updating-${mode}-${shape}.png`)});
    await page.evaluate(()=>window.releaseUpdates.claude('cli_update_timeout'));
    await card('Claude Code').getByRole('button',{name:'更新 1.3.0',exact:true}).waitFor();
  }
  for(const language of ['zh-CN','zh-TW','en','ja','ko','es','fr','de','pt','ru','vi']){
    const source=await readFile(join(project,'src','i18n',`${language}.ts`),'utf8');
    const idleLabel=source.match(/'cli_update.label': '([^']+)'/)[1],busyLabel=source.match(/'cli_update.updating': '([^']+)'/)[1];
    await page.evaluate(language=>window.changeLanguage(language),language);
    const button=card('Claude Code').locator('.cli-update-button');
    await page.waitForFunction(label=>document.querySelector('.cli-update-label')?.textContent===label,idleLabel);
    const idle=await button.boundingBox();
    await button.click();
    await page.waitForFunction(label=>document.querySelector('.cli-update-label')?.textContent===label,busyLabel);
    const busy=await button.boundingBox();
    assert.deepEqual(busy,idle,`${language}: changing state keeps the button position and size`);
    assert.equal(await button.locator('.cli-update-label').evaluate(el=>getComputedStyle(el).visibility),'visible');
    assert.equal(await button.locator('.cli-update-label').evaluate(el=>getComputedStyle(el).color),await button.evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--bg-app)';el.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color}),'busy uses the theme text color for accent backgrounds');
    await page.evaluate(()=>window.releaseUpdates.claude('cli_update_timeout'));
    await page.waitForFunction(()=>document.querySelector('.cli-update-button')?.getAttribute('aria-busy')==='false');
    assert.deepEqual(await button.boundingBox(),idle,`${language}: failure also keeps the button size`);
  }
  await page.evaluate(()=>window.changeLanguage('zh-CN'));
  await page.evaluate(()=>{window.failCheck=false;window.statuses.cursor={tool:'cursor',current:'1.0.70',latest:'2026.10.22-27dcf5f',available:true};window.showLauncher(false)});await page.evaluate(()=>window.showLauncher(true));
  const cursorUpdate=card('Cursor').getByRole('button',{name:'更新 2026.10.22-27dcf5f',exact:true});await cursorUpdate.waitFor();
  for(const edge of ['left','right']){
    await card('Cursor').evaluate((el,edge)=>{el.style.position='fixed';el.style.top='180px';el.style.width='280px';el.style.left=edge==='left'?'-120px':'calc(100vw - 280px)'},edge);
    await page.mouse.move(0,0);await cursorUpdate.hover();
    const button=await cursorUpdate.boundingBox(),tip=await page.getByRole('tooltip').boundingBox(),width=page.viewportSize().width;
    assert.ok(tip.x>=8&&tip.x+tip.width<=width-8,'long version tips stay inside both viewport edges');
    assert.ok(Math.abs(tip.x-Math.max(8,Math.min(button.x+button.width/2-tip.width/2,width-tip.width-8)))<1,'long version tips center when space permits');
  }
  assert.deepEqual(errors,[]);console.log('OK: cached detection, favorite/installation gating, update animations, centered hover/focus tips, long versions at viewport edges, reduced motion, deduplication, remount retention and existing launch controls');console.log('Screenshots: '+directory);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
