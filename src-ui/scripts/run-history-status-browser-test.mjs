// Real HistoryBoard + CSS in an isolated browser. No CLI, account or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-history-status-'));
const mock = `
  import {useSyncExternalStore} from 'react';
  let state={currentLang:'en',terminals:[{id:'a',tool:'claude',resumeToken:'one',agentStatus:'working',folderPath:'D:/same'},{id:'b',tool:'claude',resumeToken:'two',agentStatus:'idle',folderPath:'D:/same'}]};
  const listeners=new Set();
  window.updateStatus=status=>{state={...state,terminals:state.terminals.map(t=>t.id==='a'?{...t,agentStatus:status}:t)};listeners.forEach(fn=>fn())};
  window.updateView=patch=>{state={...state,...patch};listeners.forEach(fn=>fn())};
  export function useAppState(){return {state:useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state),dispatch(action){if(action.type==='REMOVE_TERMINAL')(window.removed??=[]).push(action.id);else window.opened=true}}}
  export function useAppLanguage(){return 'en'};
  export function useAppStateRef(){return {current:state}};
  const sessions=[{id:'one',tool:'claude',session_token:'one',name:'Working on the first task',cwd:'D:/same',saved_at:'2026-10-23T00:00:00Z'},{id:'two',tool:'claude',session_token:'two',name:'Another task in the same folder',cwd:'D:/same',saved_at:'2026-10-22T00:00:00Z'},{id:'other',tool:'codex',session_token:'one',name:'Different tool with the same token',cwd:'D:/same',saved_at:'2026-10-21T00:00:00Z'}];
  if(new URLSearchParams(location.search).has('toolIcons')) {
    state={...state,terminals:[]};
    sessions.splice(0,sessions.length,...['claude','codex','cursor','copilot','antigravity','openclaw','hermes','opencode','pi','cline','goose','aider','omp','crush','qwen','kilo','kiro','kimicode','codebuddy','grok','mimocode','minimax','muse'].map(tool=>({id:tool,tool,name:tool,cwd:'D:/icons',saved_at:'2026-10-23T00:00:00Z'})));
  }
  if(new URLSearchParams(location.search).has('perSession')) {
    sessions[1].git_context={branch:'main',pull_requests:['https://github.com/example/repo/pull/42']};
    sessions[2].git_context={branch:'main',pull_requests:['https://github.com/example/repo/pull/43']};
  }
  const snapshot={sessions,status:'ready'}, emptySet=new Set(), emptyObject={}, agent={conversations:[]};
  export const commands={async gitProjectStatus(folder,context){window.gitReadCount=(window.gitReadCount||0)+1;const p=new URLSearchParams(location.search);let pr=p.get('pr')||'open',number=42;if(p.has('perSession')&&context){number=Number(context.pull_requests[0].split('/').at(-1));pr=number===42?'merged':'closed'}if(p.has('deferGit'))await new Promise(resolve=>{window.resolveGitStatus=resolve});return {repo_root:folder,branch:context?.branch||'feature/ui',github:'ok',pull_request:pr==='branch'?null:{number,url:'https://github.com/example/repo/pull/'+number,state:pr,ci:pr==='open'?(p.get('ci')||'success'):null}}}},isTauri=true;
  export const subscribeHistory=()=>()=>{},getHistorySnapshot=()=>snapshot,prefetchHistory=()=>{},refreshHistory=()=>{},sortByMtime=s=>s;
  export const subscribeHidden=()=>()=>{},getHiddenSnapshot=()=>emptySet,hideSession=()=>{window.deleted=true};
  export const subscribePinned=()=>()=>{},getPinnedSnapshot=()=>emptySet,togglePin=()=>{},isPinned=()=>false;
  export const subscribeRenamed=()=>()=>{},getRenamedSnapshot=()=>emptyObject,setCustomName=()=>{};
  export const useAgentClient=()=>agent,refreshAgentConversations=async()=>{},openAgentConversation=async()=>{};
  export const useTextContextMenu=()=>({menu:null,openMenu(){}});
`;
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {HistoryBoard} from './src/components/right/HistoryBoard';import {useAppState} from './src/store/app-state';import {useSessionReplyVisibility} from './src/lib/use-session-reply-visibility';import {recordSessionReply} from './src/lib/session-replies';window.recordReply=recordSessionReply;function Fixture(){const {state}=useAppState();useSessionReplyVisibility(state);return <HistoryBoard/>}createRoot(document.getElementById('root')).render(<Fixture/>);` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  nodePaths: [join(project, 'node_modules')], loader: { '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'isolated-history', setup(builder) {
    builder.onResolve({ filter: /(?:store\/app-state|tauri|lib\/(?:history-cache|hidden-sessions|pinned-sessions|renamed-sessions|agent-client|use-text-context-menu))$/ }, () => ({ path: 'mock', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mock, resolveDir: project, loader: 'js' }));
    builder.onResolve({ filter: /\.(?:svg|png)\?(?:inline|raw)$/ }, args => ({ path: resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'asset', pluginData: { inline:args.path.endsWith('?inline') } }));
    builder.onLoad({ filter: /.*/, namespace: 'asset' }, async args => ({ contents: `export default ${JSON.stringify(args.pluginData.inline ? 'data:image/'+(args.path.endsWith('.svg')?'svg+xml':'png')+';base64,'+(await readFile(args.path)).toString('base64') : await readFile(args.path,'utf8'))}`, loader: 'js' }));
  } }],
});
const html = `<!doctype html><link rel="stylesheet" href="/fixture.css"><style>
*{box-sizing:border-box}body{margin:0;background:#181419;color:#ddd;font:15px system-ui}:root{--accent:#ce829c;--text-1:#ddd;--text-2:#aba1aa;--bg-hover:#30252d;--font:system-ui}#root{width:260px;padding:8px}
</style><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url.split('?')[0] === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  if (['/icons/tools/qwen.svg','/icons/tools/kilo.svg'].includes(req.url)) return res.setHeader('Content-Type','image/svg+xml').end(await readFile(join(project,'public',req.url)));
  if (!['/fixture.js', '/fixture.css'].includes(req.url)) return res.writeHead(404).end();
  res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
  res.end(await readFile(join(directory, req.url.slice(1))));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const rows = page.locator('.history-card');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 3);
  await rows.nth(1).locator('.history-git-mark').waitFor();
  assert.equal(await page.evaluate(()=>window.gitReadCount),1,'shared folders use one metadata request');
  assert.match(await rows.nth(1).locator('.history-git-mark').getAttribute('title'),/feature\/ui.*#42 Open.*Passed/);
  assert.equal(await rows.nth(2).locator('.history-git-mark').count(),0,'closed history is not assigned the current project PR');
  assert.equal(await page.locator('.history-card-working').count(), 1, 'same folder/cross-tool tokens do not acquire another task status');
  await page.goto(`http://127.0.0.1:${server.address().port}/?deferGit=1`);
  await page.waitForFunction(() => typeof window.resolveGitStatus === 'function');
  const restoredMark = rows.nth(1).locator('.history-git-mark.is-open');
  await restoredMark.waitFor();
  assert.equal(await page.evaluate(() => window.gitReadCount), 1, 'restart checks native status while the restored mark remains visible');
  const restoredNode = await restoredMark.elementHandle();
  await page.evaluate(() => window.resolveGitStatus());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await restoredMark.evaluate((element, previous) => element === previous, restoredNode), true, 'an unchanged refresh retains the same icon element');
  const working = rows.first();
  const circle = working.locator('.history-card-working-indicator');
  assert.equal(await circle.isVisible(), true);
  assert.equal(await circle.locator('span').evaluate(el => getComputedStyle(el).animationName), 'history-working-spin');
  await page.screenshot({ path: join(directory, 'history-working.png') });
  const titleWidth = await working.locator('.history-card-title').evaluate(el => el.getBoundingClientRect().width);
  await working.hover();
  assert.equal(await circle.isVisible(), false);
  assert.equal(await working.locator('.history-card-delete-btn').evaluate(el => getComputedStyle(el).opacity), '1');
  assert.equal(await working.locator('.history-card-title').evaluate(el => el.getBoundingClientRect().width), titleWidth, 'hover swaps actions without moving title');
  await page.mouse.move(500, 300);
  await working.locator('.history-card-delete-btn').focus();
  assert.equal(await circle.isVisible(), false, 'keyboard focus reveals delete');
  await page.locator('.history-search-trigger').focus();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await circle.locator('span').evaluate(el => getComputedStyle(el).animationName), 'none');
  for (const status of ['wait_input', 'idle', undefined]) {
    await page.evaluate(status => window.updateStatus(status), status);
    await page.waitForFunction(() => !document.querySelector('.history-card-working-indicator'));
    assert.equal(await working.locator('.history-card-attention-indicator').count(), status === 'wait_input' ? 1 : 0);
    if (status === 'wait_input') {
      assert.equal(await working.locator('.history-git-mark').count(), 0, 'waiting takes priority over PR status');
      const label = working.locator('.history-card-attention-indicator');
      assert.equal(await label.textContent(), 'Awaiting action');
      assert.equal(await label.locator('svg').count(), 0, 'waiting uses a text badge');
      assert.equal(await label.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(96, 165, 250)');
      assert.equal(await label.evaluate(el => getComputedStyle(el).animationName), 'none', 'reduced motion disables badge entrance');
      const beforeHover = await working.boundingBox();
      const titleBeforeHover = await working.locator('.history-card-title').boundingBox();
      await working.hover();
      assert.equal(await label.isVisible(), true, 'waiting label stays visible on hover');
      assert.equal(await working.locator('.history-card-delete-btn').isVisible(), false, 'waiting shows only its badge in the right-hand slot');
      assert.deepEqual(await working.boundingBox(), beforeHover, 'waiting hover keeps the row geometry');
      assert.deepEqual(await working.locator('.history-card-title').boundingBox(), titleBeforeHover, 'waiting hover does not squeeze the title');
      assert.equal(await page.getByRole('tooltip').getByText('Awaiting action', { exact: false }).count(), 1);
      await page.mouse.move(500, 300);
    }
  }
  await page.evaluate(() => localStorage.removeItem('cc-project-git-status-v1'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?perSession=1&pr=branch`);
  await page.mouse.move(500, 300);
  const unreadRow = page.locator('.history-card').nth(1);
  const geometryBeforeUnread = await unreadRow.boundingBox();
  await page.evaluate(() => window.recordReply('b', 'claude', 'two'));
  const unreadDot = unreadRow.locator('.history-card-unread-indicator');
  await unreadDot.waitFor();
  assert.deepEqual(await unreadRow.boundingBox(), geometryBeforeUnread, 'unread markers do not move or resize a row');
  assert.equal(await unreadRow.locator('.history-git-mark').count(), 0, 'unread replaces the PR mark in the same slot');
  const dotBox = await unreadDot.boundingBox();
  const titleBox = await unreadRow.locator('.history-card-title').boundingBox();
  assert.ok(dotBox.x >= titleBox.x + titleBox.width, 'unread dot sits to the right of the title');
  assert.equal(await unreadDot.evaluate(el => getComputedStyle(el, '::before').backgroundColor), 'rgb(96, 165, 250)', 'unread uses waiting-state blue');
  await unreadRow.hover();
  assert.equal(await unreadDot.isVisible(), false, 'hover swaps the blue dot for the delete action');
  assert.equal(await unreadRow.locator('.history-card-delete-btn').isVisible(), true);
  await page.mouse.move(500, 300);
  assert.equal(await page.locator('.history-card-unread').count(), 1, 'same folder and cross-tool tokens do not share unread state');
  assert.equal(await unreadRow.locator('.history-card-title').evaluate(el => getComputedStyle(el).fontWeight), '600');
  await page.reload();
  await page.locator('.history-card-unread').waitFor();
  assert.equal(await page.locator('.history-card-unread').count(), 1, 'unread survives restart');
  await page.evaluate(() => window.updateView({ activeTerminalId: 'b' }));
  await page.waitForFunction(() => !document.querySelector('.history-card-unread'));
  await unreadRow.locator('.history-git-mark').waitFor();
  await page.evaluate(() => window.recordReply('b', 'claude', 'two'));
  assert.equal(await page.locator('.history-card-unread').count(), 0, 'a visible foreground conversation stays read');
  await page.evaluate(() => { window.updateView({ usageOpen: true }); });
  await page.evaluate(() => window.recordReply('b', 'claude', 'two'));
  await page.locator('.history-card-unread').waitFor();
  await page.evaluate(() => window.updateView({ usageOpen: false }));
  await page.waitForFunction(() => !document.querySelector('.history-card-unread'));
  await page.evaluate(() => window.updateStatus('working'));
  await circle.waitFor({ state: 'visible' });
  await working.hover();
  await working.locator('.history-card-delete-btn').click();
  assert.equal(await page.evaluate(() => window.deleted && !window.opened), true, 'delete does not resume/open a task');
  assert.deepEqual(await page.evaluate(() => window.removed), ['a'], 'row deletion also closes its matching tab');
  await rows.nth(1).click({ button: 'right' });
  await page.locator('.ctx-menu').getByRole('button', { name: 'Delete', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.removed), ['a', 'b'], 'context menu deletion also closes its matching tab');
  for(const [state,ci] of [['open','failure'],['open','pending'],['draft',null],['merged',null],['closed',null]]) {
    await page.evaluate(()=>{localStorage.setItem('cc-history-layout','list');localStorage.removeItem('cc-project-git-status-v1')});
    await page.goto(`http://127.0.0.1:${server.address().port}/?pr=${state}&ci=${ci??''}`);
    await page.mouse.move(500, 300);
    const mark=page.locator('.history-card').nth(1).locator('.history-git-mark');
    await mark.waitFor();
    assert.ok((await mark.getAttribute('class')).includes('is-'+state));
    assert.equal(await mark.locator('.history-git-ci').count(),ci?1:0);
    if(ci) assert.ok((await mark.locator('.history-git-ci').getAttribute('class')).includes('is-'+ci));
    await page.mouse.move(500,300);
    await page.screenshot({path:join(directory,`git-${state}-${ci??'none'}.png`)});
    assert.equal(await page.locator('.history-card').first().locator('.history-git-mark').count(),0,'working spinner wins over PR status');
    await page.locator('.history-layout-toggle').click();
    await page.locator('.history-project-row .history-git-mark').waitFor();
  }
  for (const layout of ['projects', 'list']) {
    for (const [state, ci] of [['branch', null], ['open', 'success'], ['open', 'failure'], ['open', 'pending'], ['draft', null], ['merged', null], ['closed', null]]) {
      await page.evaluate(layout => { localStorage.setItem('cc-history-layout', layout); localStorage.removeItem('cc-project-git-status-v1'); }, layout);
      await page.goto(`http://127.0.0.1:${server.address().port}/?deferGit=1&pr=${state}&ci=${ci ?? ''}`);
      await page.mouse.move(500, 300);
      await page.waitForFunction(() => typeof window.resolveGitStatus === 'function');
      const items = page.locator('.history-project-row, .history-card');
      const geometry = () => items.evaluateAll(nodes => nodes.map(node => {
        const { top, height } = node.getBoundingClientRect();
        return { top, height };
      }));
      const before = await geometry();
      assert.equal(await page.locator('.history-git-mark').count(), 0, 'measure before metadata arrives');
      await page.evaluate(() => window.resolveGitStatus());
      if (state === 'branch') {
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await page.locator('.history-git-mark').count(), 0, 'ordinary branch icons stay absent after metadata resolves');
      } else {
        await page.locator(layout === 'projects' ? '.history-project-row .history-git-mark' : '.history-card .history-git-mark').waitFor();
      }
      assert.deepEqual(await geometry(), before, `${layout}/${state}/${ci}: status arrival must not resize or move any row`);
      await page.locator('.history-card').nth(1).hover();
      assert.deepEqual(await geometry(), before, `${layout}/${state}/${ci}: hover actions must not resize or move any row`);
    }
  }
  for (const layout of ['projects', 'list']) {
    await page.evaluate(layout => { localStorage.setItem('cc-history-layout', layout); localStorage.removeItem('cc-project-git-status-v1'); }, layout);
    await page.goto(`http://127.0.0.1:${server.address().port}/?perSession=1&pr=branch`);
    await page.mouse.move(500, 300);
    const merged = page.locator('.history-card').nth(1).locator('.history-git-mark.is-merged');
    const closed = page.locator('.history-card').nth(2).locator('.history-git-mark.is-closed');
    await merged.waitFor(); await closed.waitFor();
    assert.match(await merged.getAttribute('title'), /main.*#42 Merged/);
    assert.match(await closed.getAttribute('title'), /main.*#43 Closed/);
    assert.equal(await merged.evaluate(el => getComputedStyle(el).color), 'rgb(163, 113, 247)');
    assert.equal(await closed.evaluate(el => getComputedStyle(el).color), 'rgb(248, 81, 73)');
    assert.equal(await page.locator('.history-card-working-indicator').count(), 1);
    if (layout === 'projects') {
      assert.equal(await page.locator('.history-project-row .history-git-mark').count(), 0, 'ordinary project branches stay hidden and do not inherit a session PR');
    }
    await page.screenshot({path:join(directory,`per-session-${layout}.png`)});
  }
  for (const layout of ['projects','list']) {
    await page.evaluate(layout=>localStorage.setItem('cc-history-layout',layout),layout);
    await page.goto(`http://127.0.0.1:${server.address().port}/?toolIcons=1&pr=branch`);
    await page.locator('.history-card-tool-icon').first().waitFor();
    assert.equal(await page.locator('.history-card-tool-icon').count(),23);
    for (const row of await page.locator('.history-card').all()) {
      const name=await row.locator('.history-card-title').innerText(),icon=row.locator('.history-card-tool-icon');
      assert.equal(await icon.locator(':scope > *').count(),1,`${layout}/${name} has a tool icon`);
      assert.equal(await icon.evaluate(el=>{const i=el.getBoundingClientRect(),t=el.nextElementSibling.getBoundingClientRect();return i.height===14&&Math.abs(i.top+i.height/2-t.top-t.height/2)<1}),true,`${name} stays aligned with the title`);
    }
    await page.waitForFunction(()=>[...document.querySelectorAll('.history-card-tool-icon img')].every(img=>img.complete&&img.naturalWidth>0));
    const cursor=page.locator('.history-card').filter({has:page.locator('.history-card-title',{hasText:/^cursor$/})});
    for (const color of ['rgb(221, 221, 221)','rgb(40, 40, 40)']) {
      await page.evaluate(color=>document.documentElement.style.setProperty('--text-2',color),color);
      assert.equal(await cursor.locator('.history-card-tool-icon svg').evaluate(el=>getComputedStyle(el).color),color,'monochrome icons follow the theme text color');
    }
    await page.evaluate(()=>document.documentElement.style.setProperty('--text-2','#aba1aa'));
    await page.screenshot({path:join(directory,`tool-icons-${layout}.png`),fullPage:true});
  }
  assert.deepEqual(errors, []);
  console.log('OK: all 23 tool icons in project/session lists, actual assets, title alignment and theme colors');
  console.log('OK: real history rows, exact status identity, spinner/hover/keyboard actions, reduced motion, state clearing, deletion and Git/PR/CI project marks');
  console.log('OK: project/list row heights and positions stay unchanged across delayed branch/PR/CI marks and hover actions');
  console.log(`Screenshot: ${join(directory, 'history-working.png')}`);
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
