// Isolated dev server with real app/store/menu and native view/picker fixtures.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
const directory=await mkdtemp(join(tmpdir(),'coffee-launch-directory-'));
const devServer=await createServer({cacheDir:join(directory,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0}});
await devServer.listen();
const {chromium}=await import(process.env.COFFEE_PLAYWRIGHT_MODULE||'playwright-core');
const browser=await chromium.launch({headless:true,...(process.env.COFFEE_CHROMIUM_EXECUTABLE?{executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE}:{})});
async function prepare(recent){const page=await browser.newPage({viewport:{width:1400,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route(/\/src\/components\/center\/(TierTerminal|ClaudeConversation|CodexConversation)\.tsx/,route=>{const name=route.request().url().match(/\/([A-Za-z]+)\.tsx/)[1];return route.fulfill({contentType:'text/javascript',body:`export function ${name}(){return null} export const TERM_COLOR_SCHEMES=[];`})});await page.route(/@tauri-apps_plugin-dialog/,route=>route.fulfill({contentType:'text/javascript',body:'export async function open(){window.pickCount=(window.pickCount??0)+1;return window.pickedFolder??null}'}));await page.addInitScript(recent=>{if(localStorage.getItem('fixture:seeded'))return;for(const[k,v]of Object.entries({'fixture:seeded':'1','cc-lang':'en','cc-theme':'sakura','cc-mode':'dark','cc-shape':'soft','cc-tasks-seeded':'1','cc-folder':'D:/Inherited','coffee_pinned_items':JSON.stringify(['agent:claude','agent:codex','agent:opencode','agent:terminal','agent:four-split']),'coffee:last-cwd-by-tool':JSON.stringify({claude:'D:/Legacy',codex:'D:/Legacy',opencode:'D:/Legacy',terminal:'D:/Legacy'}),'coffee:recent-folders':JSON.stringify(recent),'coffee:claude-launch-mode':'conversation','coffee:codex-launch-mode':'terminal'}))localStorage.setItem(k,v)},recent);await page.goto(devServer.resolvedUrls.local[0]);await page.locator('.launchpad-mode-tabs').first().waitFor();return {page,errors};}
const state=page=>page.evaluate(()=>{const root=document.getElementById('root'),fiber=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))];let context;function walk(f){if(!f||context)return;const v=f.memoizedProps?.value;if(v?.state?.terminals&&typeof v.dispatch==='function'){context=v;return}walk(f.child);walk(f.sibling)}walk(fiber.stateNode.current);return context.state.terminals.find(t=>t.id===context.state.activeTerminalId)});
const fresh=page=>page.evaluate(()=>{const root=document.getElementById('root'),fiber=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))];function walk(f){if(!f)return;const v=f.memoizedProps?.value;if(v?.state?.terminals&&typeof v.dispatch==='function'){v.dispatch({type:'ADD_TERMINAL',session:{id:crypto.randomUUID(),tool:null,folderPath:'D:/Inherited'}});return true}return walk(f.child)||walk(f.sibling)}walk(fiber.stateNode.current)});
try{
 const {page,errors}=await prepare(['D:/Recent','D:/Older']);
 assert.equal(await page.locator('.launchpad-config').count(),0,'tool settings live in App configuration, not on the launch cards');
 for(let attempt=0;attempt<5;attempt++){
   await page.locator('.launchpad-icon').first().click();
   await page.keyboard.press('Escape');
   await page.locator('.folder-menu').waitFor({state:'hidden'});
 }
 for(const card of await page.locator('.launchpad-card').all()){
   const folder=card.locator('.launchpad-folder');
   assert.equal(await folder.count(),1,'every directory-based card has a folder button');
   await folder.hover();
   assert.equal(await folder.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','the folder is a plain enlarged icon, with no button background even on hover');
   assert.ok((await folder.locator('svg').boundingBox()).width>=24,'the folder icon is enlarged');
   assert.equal((await card.locator('.launchpad-card-path').innerText()).trim(),'Choose a project folder','a tool never opened shows the folder hint on its second line');
   assert.equal(await card.locator('.launchpad-card-path').evaluate(el=>getComputedStyle(el).direction),'ltr','the hint elides at its end; only paths keep their end');
   const [icon,info,path]=await Promise.all([card.locator('.launchpad-icon').boundingBox(),card.locator('.launchpad-card-info').boundingBox(),card.locator('.launchpad-card-path').boundingBox()]);
   assert.ok(Math.abs(info.y+info.height/2-(icon.y+icon.height/2))<2&&path.y+path.height<=icon.y+icon.height+2,'name and path stand beside the icon, within its height');
   for(const opener of [card.locator('.launchpad-icon'),folder]){
     await opener.click();await page.locator('.folder-menu').waitFor();
     assert.equal((await state(page)).tool,null,'opening the list never launches');
     const [menu,cardBounds,button]=await Promise.all([page.locator('.folder-menu').boundingBox(),card.boundingBox(),folder.boundingBox()]);
     assert.ok(Math.abs(menu.y-(cardBounds.y+cardBounds.height+4))<.5,'the list opens below the card, clear of the mode tabs');
     assert.ok(Math.abs(menu.x-Math.min(button.x,1400-290))<.5,'the list is left-aligned with the folder button');
     assert.deepEqual(await page.locator('.folder-menu-item:not(.folder-menu-open) .folder-menu-name').allTextContents(),['Recent','Older']);
     await page.keyboard.press('Escape');await page.locator('.folder-menu').waitFor({state:'hidden'});assert.equal((await state(page)).tool,null);
   }
 }
 const terminal=page.locator('.launchpad-card').filter({has:page.locator('.launchpad-card-name',{hasText:/^Terminal$/})});
 const remote=terminal.getByRole('button',{name:'Remote',exact:true});
 const [remoteBox,nameBox]=await Promise.all([remote.boundingBox(),terminal.locator('.launchpad-card-name').boundingBox()]);
 assert.ok(remoteBox.x>=nameBox.x+nameBox.width&&Math.abs(remoteBox.y+remoteBox.height/2-(nameBox.y+nameBox.height/2))<2,'Remote is a text chip on the terminal name line');
 await remote.click();await page.locator('.remote-form-overlay').waitFor();
 assert.equal((await state(page)).tool,null,'Remote opens the connection form instead of a local terminal');
 assert.equal(await page.locator('.folder-menu').count(),0);
 const [terminalIcon,claudeIcon]=await Promise.all([terminal.locator('.launchpad-icon').boundingBox(),page.locator('.launchpad-icon').first().boundingBox()]);
 assert.equal(terminalIcon.width,claudeIcon.width,'the terminal icon fills the same box as the other tools');
 await page.reload();await page.locator('.launchpad-mode-tabs').first().waitFor();
 console.log('OK cards have no settings gear; the folder button and a never-opened card open the list, aligned under the button, without launching; Remote is a name-line chip');
 const claude=page.getByRole('group',{name:'Claude launch mode'});
 await claude.getByRole('button',{name:'Terminal',exact:true}).click();assert.equal(await page.locator('.folder-menu').count(),0);assert.equal((await state(page)).tool,null);
 await claude.locator('..').locator('.launchpad-card-info').click();await page.locator('.folder-menu-item:not(.folder-menu-open)').nth(1).click();
 let launched=await state(page);assert.equal(launched.tool,'claude');assert.equal(launched.folderPath,'D:/Older');assert.equal(launched.claudeMode,'terminal');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('coffee:recent-folders'))),['D:/Older','D:/Recent']);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('coffee:last-folder-by-tool'))),{claude:'D:/Older'},'each tool remembers its own last folder');
 await fresh(page);
 assert.equal((await claude.locator('..').locator('.launchpad-card-path').innerText()).trim(),'D:/Older','the card shows its last folder');
 assert.equal(await claude.locator('..').locator('.launchpad-card-path').evaluate(el=>getComputedStyle(el).direction),'rtl','a long path elides its start and keeps the folder name');await page.locator('.launchpad-mode-tabs').first().waitFor();
 const codex=page.getByRole('group',{name:'Codex launch mode'});await codex.getByRole('button',{name:'Desktop',exact:true}).click();await codex.locator('..').locator('.launchpad-card-info').click();
 assert.deepEqual(await page.locator('.folder-menu-item:not(.folder-menu-open) .folder-menu-name').allTextContents(),['Older','Recent']);
 await page.locator('.folder-menu-item:not(.folder-menu-open)').first().click();launched=await state(page);assert.equal(launched.tool,'codex');assert.equal(launched.folderPath,'D:/Older');assert.equal(launched.codexMode,'conversation');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('coffee:recent-folders'))),['D:/Older','D:/Recent'],'reusing a recent path does not duplicate it');
 await page.reload();await page.locator('.launchpad-mode-tabs').first().waitFor();
 const claudeCard=page.getByRole('group',{name:'Claude launch mode'}).locator('..');
 assert.equal((await claudeCard.locator('.launchpad-card-path').innerText()).trim(),'D:/Older','the last folder survives a reload');
 await claudeCard.locator('.launchpad-folder').click();assert.deepEqual(await page.locator('.folder-menu-item:not(.folder-menu-open) .folder-menu-name').allTextContents(),['Older','Recent']);
 await page.keyboard.press('Escape');await page.locator('.folder-menu').waitFor({state:'hidden'});assert.equal((await state(page)).tool,null);
 await claudeCard.locator('.launchpad-card-info').click();await page.waitForFunction(()=>!document.querySelector('.launchpad-mode-tabs'));
 launched=await state(page);assert.equal(launched.tool,'claude','clicking the card opens the tool directly');assert.equal(launched.folderPath,'D:/Older','in its last folder');
 assert.equal(await page.locator('.folder-menu').count(),0,'without asking for a folder');await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);await page.close();console.log('OK explicit directory and current mode reach the session; most recent first, deduplication, per-tool last folder shown and reopened directly after reload');
 {
  // A double click on a card with a remembered folder launches once.
  const {page:dbl,errors:dblErrors}=await prepare(['D:/Recent']);
  await dbl.evaluate(()=>{localStorage.setItem('coffee:last-folder-by-tool',JSON.stringify({claude:'D:/Recent'}));});
  await dbl.reload();await dbl.locator('.launchpad-mode-tabs').first().waitFor();
  const launches=[];await dbl.exposeFunction('countLaunch',tool=>launches.push(tool));
  await dbl.evaluate(()=>{const root=document.getElementById('root'),fiber=root[Object.keys(root).find(k=>k.startsWith('__reactContainer$'))];let ctx;(function walk(f){if(!f||ctx)return;const v=f.memoizedProps?.value;if(v?.state?.terminals&&typeof v.dispatch==='function'){ctx=v;return}walk(f.child);walk(f.sibling)})(fiber);const dispatch=ctx.dispatch;ctx.dispatch=a=>{if(a.type==='LAUNCH_TERMINAL_TOOL')window.countLaunch(a.tool);return dispatch(a)};});
  const card=dbl.getByRole('group',{name:'Claude launch mode'}).locator('..').locator('.launchpad-card-info');
  await card.dblclick();await dbl.waitForTimeout(400);
  assert.ok(launches.length<=1,`a double click launches at most once: ${launches.join(',')}`);
  assert.deepEqual(dblErrors,[]);await dbl.close();

  // Removing a folder from the recents list by hand keeps it as a tool's last folder.
  const {page:tidy}=await prepare(['D:/Recent','D:/Older']);
  await tidy.evaluate(()=>{localStorage.setItem('coffee:last-folder-by-tool',JSON.stringify({claude:'D:/Recent'}));});
  await tidy.reload();await tidy.locator('.launchpad-mode-tabs').first().waitFor();
  const claudeCard=tidy.getByRole('group',{name:'Claude launch mode'}).locator('..');
  await claudeCard.locator('.launchpad-folder').click();await tidy.locator('.folder-menu').waitFor();
  await tidy.locator('.folder-menu-item',{hasText:'Recent'}).first().locator('.folder-menu-del').dispatchEvent('mousedown');
  await tidy.keyboard.press('Escape');
  assert.deepEqual(await tidy.evaluate(()=>JSON.parse(localStorage.getItem('coffee:recent-folders'))),['D:/Older']);
  assert.deepEqual(await tidy.evaluate(()=>JSON.parse(localStorage.getItem('coffee:last-folder-by-tool'))),{claude:'D:/Recent'},'tidying recents keeps the tool\'s last folder');
  assert.equal((await claudeCard.locator('.launchpad-card-path').innerText()).trim(),'D:/Recent');
  await tidy.close();

  // A damaged per-tool entry falls back to the hint instead of breaking the launch page.
  const {page:bad,errors:badErrors}=await prepare([]);
  await bad.evaluate(()=>{localStorage.setItem('coffee:last-folder-by-tool',JSON.stringify({claude:123,codex:{},opencode:'D:/Ok'}));});
  await bad.reload();await bad.locator('.launchpad-mode-tabs').first().waitFor();
  assert.equal((await bad.getByRole('group',{name:'Claude launch mode'}).locator('..').locator('.launchpad-card-path').innerText()).trim(),'Choose a project folder');
  assert.deepEqual(badErrors,[]);await bad.close();
  console.log('OK a double click launches once, tidying recents keeps last folders, damaged entries fall back to the hint');
 }
 const empty=await prepare([]),p=empty.page;
 await p.getByRole('group',{name:'Claude launch mode'}).locator('..').locator('.launchpad-card-info').click();await p.waitForFunction(()=>window.pickCount===1);assert.equal((await state(p)).tool,null,'cancelling a native chooser does not launch');
 await p.evaluate(()=>window.pickedFolder='D:/NewProject');await p.getByRole('group',{name:'Codex launch mode'}).locator('..').locator('.launchpad-card-info').click();await p.waitForFunction(()=>window.pickCount===2);
 launched=await state(p);assert.equal(launched.tool,'codex');assert.equal(launched.folderPath,'D:/NewProject');assert.deepEqual(await p.evaluate(()=>JSON.parse(localStorage.getItem('coffee:recent-folders'))),['D:/NewProject']);assert.deepEqual(empty.errors,[]);
 console.log('OK empty history uses the native chooser; cancel is safe; a new selection becomes the first recent directory');await p.close();
}finally{await browser.close();await devServer.close()}
