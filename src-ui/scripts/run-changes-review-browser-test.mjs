// Real ChangesBoard and DiffPanel; isolated Git/filesystem fixtures, no user data.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build, transform } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-changes-review-'));
const stateSource = await readFile(join(project, 'src/store/app-state.tsx'), 'utf8');
const resolver = stateSource.match(/export function resolveDiffContext\([\s\S]*?\n}/)?.[0];
assert.ok(resolver, 'exercise the actual workspace resolver');
const { code: diffContextResolver } = await transform(resolver, { loader: 'ts' });
const mock = `
import {useSyncExternalStore} from 'react';
const listeners=new Set();
let state={currentLang:'zh-CN',iconTheme:'material',taskViewMode:'list',activeTerminalId:'a',terminals:[{id:'a',tool:null,folderPath:'D:/test'}],diffMode:'overlay',diffSelection:null};
function emit(){state={...state};listeners.forEach(fn=>fn())}
function dispatch(action){if(action.type==='SET_DIFF_SELECTION')state={...state,diffSelection:action.selection};if(action.type==='CLEAR_DIFF')state={...state,diffSelection:null};if(action.type==='SET_DIFF_MODE')state={...state,diffMode:action.mode};emit()}
export function useAppState(){return {state:useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state),dispatch}}
export function useAppLanguage(){return 'zh-CN'}
${diffContextResolver}
const entry=(rel,added=3,deleted=1)=>({path:'D:/test/'+rel,rel,status:'M',added,deleted});
const fixture={state:'ok',branch:'feature/sidebar',repo_root:'D:/test',uncommitted:[entry('src/HistoryBoard.tsx'),entry('src/DiffPanel.tsx'),entry('lib/git-status.tsx')],untracked:[{...entry('docs/notes.md',4,0),status:'?'}],session_commits:[{hash:'abc1234',message:'Improve review layout',time:1,author:'Fixture'},{hash:'def5678',message:'Keep file identity',time:2,author:'Fixture'}]};
let changes=fixture;
window.setChanges=kind=>{changes=kind==='ok'?fixture:{state:kind};emit();window.dispatchEvent(new CustomEvent('fs-refresh',{detail:{dirPath:'D:/test'}}))};
window.makeLongList=()=>{fixture.uncommitted=Array.from({length:60},(_,i)=>entry('src/file-'+i+'.tsx'));changes=fixture;emit();window.dispatchEvent(new CustomEvent('fs-refresh',{detail:{dirPath:'D:/test'}}))};
window.setFolder=folder=>{state={...state,terminals:[{...state.terminals[0],folderPath:folder}]};emit()};
window.setTool=tool=>{state={...state,terminals:[{...state.terminals[0],tool}]};emit()};
window.setTaskMode=mode=>{state={...state,taskViewMode:mode};emit()};
window.getSelection=()=>state.diffSelection;
window.movePreview=mode=>dispatch({type:'SET_DIFF_MODE',mode});
window.calls={commits:0,init:0,taskLoads:0,taskSaves:0,gitReads:0,fileReads:0};
export const isTauri=true;
export async function invoke(){throw new Error('Unexpected native call in file-review fixture')}
export const commands={
 async gitCaptureBaseline(){},
 async gitChanges(){window.calls.gitReads++;if(window.holdGit)await new Promise(resolve=>window.resolveGit=resolve);if(changes.state==='error')throw new Error('fixture read failure');return structuredClone(changes)},
 async loadTasks(){window.calls.taskLoads++;return JSON.stringify([{id:'task-one',title:'保留原有任务',status:'todo',createdAt:1}])},
 async saveTasks(data){window.calls.taskSaves++;window.savedTasks=JSON.parse(data)},
 async gitProjectStatus(){return {repo_root:'D:/test',branch:'feature/sidebar',github:'ok',pull_request:{number:42,url:'https://github.com/example/repo/pull/42',state:'open',ci:'success'}}},
 async gitCommitFiles(root,hash){window.calls.commits++;return [entry('src/shared.tsx',2,1)]},
 async gitInit(){window.calls.init++},
 async readTextFile(path){window.calls.fileReads++;return 'const before = 1;\\nconst after = '+(window.previewAfter??3)+';\\n'+Array.from({length:180},(_,i)=>'const line_'+i+' = '+i+';').join('\\n')},
 async gitShowFile(root,spec){window.calls.fileReads++;return spec.includes('~1')?'const before = 1;\\n':'const before = 1;\\nconst after = 2;\\n'},
 async openUrl(url){window.openedUrl=url}
};
export function ContextMenu(){return null}
export function ThemedIcon({src,alt}){return <img className="icon-svg" src={src} alt={alt}/>}
export function beginExplorerDrag(){}
export async function tokenizeFile(){return null}
export async function tokenizeByLang(){return null}
export function getShikiTheme(){return 'github-dark-default'}
export function useTextContextMenu(){return {menu:null,openMenu(){}}}
export async function submitTerminalPrompt(id,text){window.pastedTask=text}
`;
await build({stdin:{resolveDir:project,loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {RightPanel} from './src/components/right/Compiler';import {GitStatusProvider} from './src/lib/git-status';import './src/styles/global.css';import './src/components/left/Explorer.css';createRoot(document.getElementById('root')).render(<GitStatusProvider><RightPanel/></GitStatusProvider>);`},bundle:true,outfile:join(directory,'fixture.js'),jsx:'automatic',nodePaths:[join(project,'node_modules')],loader:{'.woff2':'dataurl','.woff':'dataurl','.png':'dataurl','.svg':'dataurl'},define:{'process.env.NODE_ENV':'"development"','__IS_LINUX__':'false'},plugins:[{name:'review-fixture',setup(b){
 b.onResolve({filter:/^\/(?:fonts\/|monogram)/},args=>({path:join(project,'public',args.path)}));
 b.onResolve({filter:/^\.\/terminal-control$/},()=>({path:'mock',namespace:'fixture'}));
 b.onResolve({filter:/(?:store\/app-state|tauri|lib\/(?:explorer-drag|shiki|use-text-context-menu|terminal-control)|left\/Explorer)$/},()=>({path:'mock',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:mock,resolveDir:project,loader:'tsx'}));
}}]});
const html=`<!doctype html><html data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><style>:root{--font:Inter,'Segoe UI',sans-serif;--font-mono:Consolas,monospace;--accent:#ce829c;--text-1:#e0d7de;--text-2:#b5a7b1;--text-3:#a496a0;--border:#392e36;--bg-panel:#1d181d;--bg-terminal:#161216;--bg-hover:#30262e;--success:#7cb38f;--danger:#d7877f;--radius-sm:5px}html[data-mode=light]{--text-1:#34322e;--text-2:#625e57;--text-3:#746d65;--border:#ded8d0;--bg-panel:#f2eee8;--bg-terminal:#f6f3ef;--bg-hover:#e9e2dc;--success:#39754d;--danger:#ab5348}body{margin:0;background:var(--bg-terminal)}#root.panel-right{position:relative;width:360px;height:720px;min-width:0;max-width:none;padding:0;background:var(--bg-panel);display:flex}#root .compiler-top{height:100%;width:100%}</style><div id="root" class="panel-right"></div><script src="/fixture.js"></script></html>`;
const server=http.createServer(async(req,res)=>{
 const path=req.url.split('?')[0];
 if(path==='/')return res.setHeader('Content-Type','text/html; charset=utf-8').end(html);
 try {const file=path.startsWith('/icons/')?join(project,'public',path):join(directory,path.slice(1));res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'image/svg+xml');res.end(await readFile(file));}catch{res.writeHead(404).end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.COFFEE_CHROMIUM_EXECUTABLE?{executablePath:process.env.COFFEE_CHROMIUM_EXECUTABLE}:{})});
try{
 const page=await browser.newPage({viewport:{width:900,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByText('选择工作区后查看修改记录。',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.gitReads),0,'a remembered directory without an open tool does not query Git');
 assert.equal(await page.getByRole('tab',{name:/修改记录/}).locator('.changes-title-count').textContent(),'0');
 await page.evaluate(()=>{window.setFolder(null);window.setTool('claude')});
 await page.getByText('选择工作区后查看修改记录。',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.gitReads),0,'a tool without a directory also remains idle');
 await page.evaluate(()=>{window.holdGit=true;window.setFolder('D:/test')});
 await page.waitForFunction(()=>window.resolveGit);
 await page.getByText('加载中…',{exact:true}).waitFor();
 await page.evaluate(()=>{window.holdGit=false;window.resolveGit()});
 const rows=page.locator('.changes-row');await rows.first().waitFor();assert.equal(await rows.count(),4);
 await page.evaluate(()=>window.setTool(null));
 await page.getByText('选择工作区后查看修改记录。',{exact:true}).waitFor();
 assert.equal(await rows.count(),0,'closing the tool hides its cached Git files');
 assert.equal(await page.getByRole('tab',{name:/修改记录/}).locator('.changes-title-count').textContent(),'0','closing the tool clears the visible change count');
 await page.evaluate(()=>window.setTool('claude'));await rows.first().waitFor();
 console.log('OK: launchpad with a remembered directory stays idle; real loading, tool launch and close recover correctly');
 const pickScope=async scope=>{await page.getByRole('combobox').click();await page.getByRole('option',{name:{all:'全部修改',working:'未提交',committed:'本次会话提交'}[scope],exact:true}).click()};
 const typography=await page.evaluate(()=>{
  const reference=document.createElement('div');reference.className='explorer-panel';reference.style.cssText='position:absolute;left:-9999px';reference.innerHTML='<span class="tree-file">字体参考 Aa</span>';document.body.append(reference);
  const left=getComputedStyle(reference.firstChild),right=getComputedStyle(document.querySelector('.changes-name'));
  const result={left:[left.fontFamily,left.fontSize,left.fontWeight],right:[right.fontFamily,right.fontSize,right.fontWeight]};reference.remove();return result;
 });assert.deepEqual(typography.right,typography.left,'review file names match Explorer typography');
 const dotGeometry=await page.locator('.changes-footer').evaluate(el=>{const [dot,label]=el.children;const a=dot.getBoundingClientRect(),b=label.getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2)});assert.ok(dotGeometry<.5,'footer dot and text share a vertical center');
 const scopeArrow=await page.getByRole('combobox').locator('svg').boundingBox();await page.mouse.click(scopeArrow.x+scopeArrow.width/2,scopeArrow.y+scopeArrow.height/2);assert.equal(await page.locator('select').count(),0);await page.getByRole('listbox').waitFor();assert.equal(await page.getByRole('option',{name:'全部修改',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.getByRole('combobox').evaluate(el=>document.activeElement===el),true,'menu keeps focus on the select-only trigger');
 const scopeStyle=await page.getByRole('combobox').evaluate(el=>{const s=getComputedStyle(el);return {tag:el.tagName,cursor:s.cursor,border:s.borderTopWidth,outline:s.outlineWidth}});
 assert.deepEqual(scopeStyle,{tag:'BUTTON',cursor:'default',border:'0px',outline:'0px'},'scope picker is borderless and never shows an insertion cursor');
 await page.getByRole('combobox').press('End');await page.getByRole('combobox').press('Enter');assert.match(await page.locator('.changes-branch-stats').textContent(),/2 次提交/);await pickScope('all');
 await page.getByRole('combobox').click();await page.mouse.click(850,500);assert.equal(await page.getByRole('listbox').count(),0,'outside click closes the themed menu');
 await page.getByRole('combobox').click();await page.setViewportSize({width:500,height:700});await page.getByRole('listbox').waitFor();await page.getByRole('combobox').press('Escape');await page.setViewportSize({width:900,height:800});
 const listTab=page.getByRole('tab',{name:/修改记录/}),detailTab=page.getByRole('tab',{name:'文件对比'});
 assert.equal(await detailTab.isDisabled(),true,'detail needs an open file');
 await rows.first().click();await page.locator('.diff-line-add').first().waitFor();
 assert.equal(await detailTab.getAttribute('aria-selected'),'true','opening a file reveals full-height detail');
 const first=await page.evaluate(()=>window.getSelection());
 await page.locator('.diff-body').evaluate(el=>el.scrollTop=200);const previewScroll=await page.locator('.diff-body').evaluate(el=>el.scrollTop);assert.ok(previewScroll>100);
 await listTab.click();assert.equal(await page.getByRole('searchbox').isVisible(),true);
 const previewReads=await page.evaluate(()=>window.calls.fileReads);await page.evaluate(()=>{window.previewAfter=9;window.dispatchEvent(new CustomEvent('fs-refresh',{detail:{dirPath:'D:/test'}}))});await page.waitForTimeout(950);assert.equal(await page.evaluate(()=>window.calls.fileReads),previewReads,'hidden file preview must not read files on refresh');
 await detailTab.click();await page.waitForFunction(()=>document.querySelector('.diff-line-add')?.textContent.includes('after = 9'));assert.ok(await page.evaluate(()=>window.calls.fileReads)>previewReads,'returning to detail refreshes the preview immediately');assert.equal(await page.locator('.diff-body').evaluate(el=>el.scrollTop),previewScroll,'returning to detail preserves the reading position');await page.evaluate(()=>window.previewAfter=3);await listTab.click();
 await page.evaluate(()=>window.movePreview('tab'));assert.equal(await page.locator('.diff-panel').count(),0);await listTab.click();await page.evaluate(()=>window.movePreview('overlay'));assert.equal(await detailTab.getAttribute('aria-selected'),'true','moving a center preview back to the right reveals its detail tab');await listTab.click();
 await rows.first().click();assert.equal((await page.evaluate(()=>window.getSelection())).path,first.path,'repeat click preserves preview');
 await page.getByRole('button',{name:'下一个文件'}).click();assert.match(await page.locator('.diff-header-name').textContent(),/DiffPanel/);
 await page.getByRole('button',{name:'上一个文件'}).click();assert.match(await page.locator('.diff-header-name').textContent(),/HistoryBoard/);
 await listTab.click();
 await page.getByRole('searchbox').fill('git-status');assert.equal(await rows.count(),1);await rows.first().click();assert.equal(await page.locator('.diff-navigation-position').textContent(),'1 / 1');
 await listTab.click();assert.equal(await page.getByRole('searchbox').inputValue(),'git-status','return preserves filter');
 await page.getByRole('button',{name:'清空筛选'}).click();assert.equal(await page.getByRole('searchbox').inputValue(),'');assert.equal(await page.getByRole('searchbox').evaluate(el=>document.activeElement===el),true,'clearing the filter keeps typing focus');assert.equal(await rows.count(),4);assert.equal(await page.locator('.changes-search-clear').count(),0,'empty search has no clear button');
 await page.locator('.changes-group-header').filter({hasText:'未提交'}).click();assert.equal(await rows.count(),1);await page.locator('.changes-group-header').filter({hasText:'未提交'}).click();assert.equal(await rows.count(),4);
 await pickScope('committed');assert.equal(await rows.count(),0);assert.match(await page.locator('.changes-branch-stats').textContent(),/2 次提交/);
 const commits=page.locator('.changes-commit-row');await commits.nth(0).click();await commits.nth(1).click();await rows.nth(1).waitFor();
 await rows.nth(0).click();assert.equal((await page.evaluate(()=>window.getSelection())).commitHash,'abc1234');await listTab.click();await rows.nth(1).click();assert.equal((await page.evaluate(()=>window.getSelection())).commitHash,'def5678','same path retains commit identity');assert.equal(await page.evaluate(()=>window.calls.commits),2);
 await listTab.click();
 await pickScope('working');await rows.first().click();
 await listTab.click();
 await page.getByRole('button',{name:'PR #42',exact:false}).click();assert.match(await page.evaluate(()=>window.openedUrl),/pull\/42/);
 await detailTab.click();
 for(const [mode,shape,width,height] of [['dark','soft',360,720],['light','soft',280,650],['dark','glass',220,540],['dark','panel',360,720],['light','panel',360,720]]){
  await page.evaluate(({mode,shape,width,height})=>{document.documentElement.dataset.mode=mode;document.documentElement.dataset.shape=shape;document.documentElement.style.setProperty('background-color','var(--bg-terminal)','important');Object.assign(document.getElementById('root').style,{width:width+'px',height:height+'px'})},{mode,shape,width,height});
  await page.waitForFunction(width=>Math.abs(document.getElementById('root').getBoundingClientRect().width-width)<1,width);
  const geometry=await page.evaluate(()=>{const root=document.getElementById('root'),tabs=document.querySelector('.changes-title'),diff=document.querySelector('.diff-panel');return {fits:root.scrollWidth<=root.clientWidth+1,tabsBottom:tabs.getBoundingClientRect().bottom,previewTop:diff.getBoundingClientRect().top,previewHeight:diff.clientHeight,rootHeight:root.clientHeight,background:getComputedStyle(diff).backgroundColor}});
  assert.equal(geometry.fits,true,'narrow panel must fit');assert.ok(Math.abs(geometry.tabsBottom-geometry.previewTop)<=1,'detail starts directly below tabs');assert.ok(geometry.previewHeight>=geometry.rootHeight-55,'detail uses the full right panel');if(shape!=='panel')assert.notEqual(geometry.background,'rgba(0, 0, 0, 0)','glass preview stays opaque');
  const tabLine=await page.locator('.changes-title').evaluate(el=>{const button=el.querySelector('[aria-selected="true"]'),indicator=getComputedStyle(button,'::after');return {border:getComputedStyle(el).borderBottomWidth,offset:Math.abs(button.getBoundingClientRect().bottom-parseFloat(indicator.bottom)-el.getBoundingClientRect().bottom)}});
  assert.equal(tabLine.border,'0px','tab bar has no full-width divider');assert.ok(tabLine.offset<.01,'only the selected tab retains its short indicator at the bar bottom');
  await page.screenshot({path:join(directory,'review-'+mode+'-'+shape+'.png')});
  await listTab.click();await page.getByRole('combobox').click();const menuRect=await page.getByRole('listbox').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,background:s.backgroundImage}});assert.ok(menuRect.left>=0&&menuRect.right<=900&&menuRect.top>=0&&menuRect.bottom<=800,'popup stays inside the viewport');assert.notEqual(menuRect.background,'none','font-picker surface stays opaque in every theme');await page.screenshot({path:join(directory,'scope-'+mode+'-'+shape+'.png')});await page.getByRole('combobox').press('Escape');await detailTab.click();
 }
 await page.getByRole('button',{name:'Expand diff to tab'}).click();assert.equal(await page.locator('.diff-panel').count(),0);await page.getByRole('button',{name:'下一个文件'}).click();assert.match((await page.evaluate(()=>window.getSelection())).path,/DiffPanel/);
 await detailTab.click();await page.locator('.diff-panel').waitFor();assert.equal(await detailTab.getAttribute('aria-selected'),'true','detail tab can bring a center diff back to the right');
 await listTab.click();await listTab.focus();await page.keyboard.press('ArrowRight');assert.equal(await detailTab.getAttribute('aria-selected'),'true','keyboard selects detail');await page.keyboard.press('ArrowLeft');assert.equal(await listTab.getAttribute('aria-selected'),'true');
 const retained=await page.evaluate(()=>window.getSelection());await page.keyboard.press('Escape');assert.deepEqual(await page.evaluate(()=>window.getSelection()),retained,'hidden diff must not handle Escape in the list');
 await page.evaluate(()=>window.setChanges('not_repo'));await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent.includes('暂无 Git'));assert.match(await page.getByRole('status').textContent(),/暂无 Git/);assert.equal(await page.evaluate(()=>window.calls.init),0);assert.equal(await page.locator('.changes-init-btn').count(),0);
 await page.evaluate(()=>window.setChanges('error'));await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent.includes('无法加载'));assert.match(await page.getByRole('status').textContent(),/无法加载/);
 await page.evaluate(()=>window.setChanges('ok'));await rows.first().waitFor();assert.equal(await rows.count(),4,'status recovers after a failed read');
 await page.evaluate(()=>window.makeLongList());await rows.nth(50).waitFor({state:'attached'});
 await page.locator('.changes-scroll').evaluate(el=>{el.scrollTop=245});
 const scrollBefore=await page.locator('.changes-scroll').evaluate(el=>el.scrollTop);assert.ok(scrollBefore>200);
 await rows.nth(8).click();await listTab.click();assert.equal(await page.locator('.changes-scroll').evaluate(el=>el.scrollTop),scrollBefore,'list scroll position survives detail visits');
 const taskTab=page.getByRole('tab',{name:'任务列表'});await taskTab.click();await page.locator('.task-title-text').waitFor();assert.equal(await page.locator('.task-board').count(),1);assert.equal(await page.evaluate(()=>window.calls.taskLoads),1);
 const todoPreviewReads=await page.evaluate(()=>window.calls.fileReads);await page.evaluate(()=>window.dispatchEvent(new CustomEvent('fs-refresh',{detail:{dirPath:'D:/test'}})));await page.waitForTimeout(950);assert.equal(await page.evaluate(()=>window.calls.fileReads),todoPreviewReads,'Todo also suspends hidden preview reads');
 await page.locator('.task-edit-inline').click();await page.locator('.task-title-edit').fill('移到右侧后保留任务');await page.locator('.task-title-edit').press('Enter');
 await listTab.click();await taskTab.click();assert.equal(await page.locator('.task-title-text').textContent(),'移到右侧后保留任务');
 await page.evaluate(()=>window.setFolder('D:/another-workspace'));assert.equal(await taskTab.getAttribute('aria-selected'),'true');assert.equal(await page.evaluate(()=>window.calls.taskLoads),1,'workspace changes must not remount task storage/editors');assert.equal(await page.locator('.task-title-text').textContent(),'移到右侧后保留任务');
 await page.evaluate(()=>window.setTool('terminal'));
 await page.locator('.task-slot-send').click();assert.equal(await page.evaluate(()=>window.pastedTask),'移到右侧后保留任务');await page.waitForFunction(()=>window.savedTasks?.[0]?.status==='working');
 await page.locator('.task-check-btn').click();await page.waitForFunction(()=>window.savedTasks?.[0]?.status==='done');assert.equal(await page.evaluate(()=>window.savedTasks[0].title),'移到右侧后保留任务');
 await page.evaluate(()=>window.setTaskMode('note'));await page.locator('.task-note-body').waitFor();assert.equal(await page.locator('.task-note-body').inputValue(),'移到右侧后保留任务');
 await page.evaluate(()=>window.setTaskMode('prompt'));await page.locator('.task-prompt-group').waitFor();assert.equal(await page.locator('.task-prompt-group').getAttribute('data-category'),'移到右侧后保留任务');
 await page.evaluate(()=>window.setTaskMode('list'));await page.locator('.task-title-text').waitFor();assert.equal(await page.evaluate(()=>window.calls.taskLoads),1,'all task presentations share the same mounted storage');
 const reads=await page.evaluate(()=>window.calls.gitReads);await page.evaluate(()=>window.dispatchEvent(new CustomEvent('fs-refresh',{detail:{dirPath:'D:/another-workspace'}})));await page.waitForTimeout(950);assert.equal(await page.evaluate(()=>window.calls.gitReads),reads,'hidden review does not poll Git while using Todo');
 await page.locator('#root').screenshot({path:join(directory,'right-task-panel.png')});
 await page.evaluate(()=>{localStorage.removeItem('cc-right-tab');localStorage.setItem('cc-left-tab','tasks')});await page.reload();await taskTab.waitFor();assert.equal(await taskTab.getAttribute('aria-selected'),'true','previous left task preference opens the new right task tab');
 await page.waitForFunction(()=>localStorage.getItem('cc-right-tab')==='tasks');await page.evaluate(()=>localStorage.setItem('cc-left-tab','history'));await page.reload();assert.equal(await taskTab.getAttribute('aria-selected'),'true','migrated right preference survives later launches');
 await page.evaluate(()=>localStorage.setItem('cc-left-tab','tasks'));await listTab.click();await page.waitForFunction(()=>localStorage.getItem('cc-right-tab')==='changes');await page.reload();await listTab.waitFor();assert.equal(await listTab.getAttribute('aria-selected'),'true','new right-tab preference takes precedence over the legacy left-tab value');
 assert.deepEqual(errors,[]);console.log('OK: Explorer-matched typography, themed keyboard/resize-safe scope menu, aligned footer dot; Todo persistence and review navigation, retained state, center placement and narrow/light/glass geometry');console.log('Screenshots: '+directory);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
