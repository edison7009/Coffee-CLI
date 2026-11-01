// The composer's worktree switch: the real component and styles; only the app store and native calls are isolated.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-worktree-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
    import {WorktreeControl} from './src/components/center/WorktreeControl';
    import {worktreeFromPath} from './src/lib/worktree';window.worktreeFromPath=worktreeFromPath;
    import {subscribe,snapshot} from 'fixture-tab';
    import './src/styles/global.css';import './src/components/center/Gambit.css';
    function Fixture(){const s=useSyncExternalStore(subscribe,snapshot);return <div style={{width:680,margin:30,padding:10,borderRadius:12,background:"var(--bg-panel)",border:"1px solid var(--border)"}}><div className="gambit-footer gambit-footer--claude">
      <span className="gambit-workspace"><span className="gambit-workspace-name">Project</span></span>
      <WorktreeControl tab={s.tab} started={s.started} running={s.running}/></div></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg'], nodePaths: [join(project, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /^fixture-tab$/ }, () => ({ path: 'tab', namespace: 'fixture' }));
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'tab' ? `
      let current={tab:{id:'t1',tool:'claude',folderPath:'D:/Project'},started:false,running:false};const listeners=new Set();
      export const snapshot=()=>current;export const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
      window.setFixture=patch=>{current={...current,...patch,tab:{...current.tab,...(patch.tab??{})}};listeners.forEach(fn=>fn())};
      window.applyAction=action=>{if(action.type==='SET_TERMINAL_WORKTREE')window.setFixture({tab:{id:action.newId,folderPath:action.cwd,worktree:action.worktree,worktreeOrigin:action.worktree?action.origin:undefined}})};
    ` : args.path === 'store' ? `
      import {snapshot} from 'fixture-tab';
      export function useAppLanguage(){return 'en'};
      const dispatch=action=>{(window.actions??=[]).push(action);window.applyAction(action)};
      export function useAppDispatch(){return dispatch};
      export function useAppState(){return {state:{terminals:[snapshot().tab]},dispatch}};
    ` : `
      window.calls=[];
      export const isTauri=false,commands={};
      export async function invoke(name,args){window.calls.push({name,...args});
        if(name==='worktree_available')return window.available??true;
        if(name==='worktree_create'&&window.createGate)await window.createGate;
        if(name==='worktree_create')return {worktree:{root:'D:/Project',path:'D:/Project/.claude/worktrees/coffee-claude-a1b2c3',branch:'coffee/claude-a1b2c3'},cwd:'D:/Project/.claude/worktrees/coffee-claude-a1b2c3'};
        if(name==='worktree_status')return window.wtStatus;
        if(name==='worktree_merge'){if(window.mergeError)throw window.mergeError;window.wtStatus={...window.wtStatus,ahead:0,dirty:false};return 2}
      }
    ` }));
  } }],
});
const page = `<!doctype html><html data-theme="dark" data-mode="dark"><body style="margin:0;background:var(--bg-app)"><div id="root"></div><script src="/fixture.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(join(directory, 'fixture.js'))); return; }
  if (req.url === '/fixture.css') { res.setHeader('content-type', 'text/css'); res.end(await readFile(join(directory, 'fixture.css')).catch(() => '')); return; }
  res.setHeader('content-type', 'text/html'); res.end(page.replace('</body>', '<link rel="stylesheet" href="/fixture.css"></body>'));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE });
try {
  const view = await browser.newPage({ viewport: { width: 760, height: 220 } });
  const errors = []; view.on('pageerror', error => errors.push(String(error)));
  await view.goto(`http://127.0.0.1:${server.address().port}/`);
  const toggle = view.getByRole('checkbox', { name: 'Worktree' });
  await toggle.waitFor(); await view.waitForFunction(() => !document.querySelector('.gambit-worktree-toggle').disabled);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await view.screenshot({ path: join(directory, 'off.png') });

  await toggle.click(); await view.waitForFunction(() => document.querySelector('.gambit-worktree-toggle')?.getAttribute('aria-checked') === 'true');
  const on = await view.evaluate(() => window.actions.at(-1));
  assert.deepEqual([on.cwd, on.origin, on.worktree.branch, on.id], ['D:/Project/.claude/worktrees/coffee-claude-a1b2c3', 'D:/Project', 'coffee/claude-a1b2c3', 't1']);
  assert.ok(on.newId && on.newId !== on.id, 'the conversation restarts as a fresh session in the worktree');
  assert.equal(await view.evaluate(() => window.calls.find(call => call.name === 'worktree_create').cwd), 'D:/Project');
  await view.screenshot({ path: join(directory, 'on.png') });

  await toggle.click(); await view.waitForFunction(() => document.querySelector('.gambit-worktree-toggle')?.getAttribute('aria-checked') === 'false');
  const off = await view.evaluate(() => window.actions.at(-1));
  assert.deepEqual([off.cwd, off.worktree], ['D:/Project', undefined], 'turning it off returns to the original folder');
  assert.ok(await view.evaluate(() => window.calls.some(call => call.name === 'worktree_sweep' && call.cwd === 'D:/Project')), 'opening on a repository reclaims leftover worktrees');

  // A conversation that starts while the worktree is being created keeps its folder; the new worktree is dropped.
  const before = await view.evaluate(() => { window.createGate = new Promise(done => { window.openGate = done; }); return window.actions.length; });
  await toggle.click(); await view.waitForFunction(() => window.calls.filter(call => call.name === 'worktree_create').length === 2);
  await view.evaluate(() => { window.setFixture({ started: true }); window.openGate(); });
  await view.waitForFunction(() => window.calls.some(call => call.name === 'worktree_remove'));
  assert.equal(await view.evaluate(() => window.actions.length), before, 'the started conversation is not moved');
  await view.evaluate(() => { window.createGate = undefined; window.setFixture({ started: false }); });
  assert.deepEqual(await view.evaluate(() => window.worktreeFromPath('D:\\Proj\\.claude\\worktrees\\coffee-fix-a1b2c3\\src')),
    { root: 'D:\\Proj', path: 'D:\\Proj\\.claude\\worktrees\\coffee-fix-a1b2c3', branch: 'coffee/fix-a1b2c3' }, 'history resumes the worktree it ran in');
  assert.equal(await view.evaluate(() => window.worktreeFromPath('D:/Proj/.claude/worktrees/intelligent-b3')), undefined);

  await view.evaluate(() => window.setFixture({ tab: { id: 't-nested', folderPath: 'D:/Proj/.claude/worktrees/intelligent-b3' } }));
  await view.waitForFunction(() => !document.querySelector('.gambit-worktree'));

  await view.evaluate(() => { window.available = false; window.setFixture({ tab: { id: 't-plain', folderPath: 'D:/Plain' } }); });
  await view.waitForFunction(() => document.querySelector('.gambit-worktree-toggle').disabled);
  assert.equal(await view.locator('.gambit-worktree').getAttribute('data-tip'), 'Needs a git repository with at least one commit');
  await view.locator('.gambit-worktree').hover(); await view.screenshot({ path: join(directory, 'unavailable.png') });

  await view.evaluate(() => window.setFixture({ tab: { resumeToken: 'own-1', ownToken: 'own-1' } }));
  assert.equal(await view.locator('.gambit-worktree-toggle').count(), 1, 'a fresh conversation keeps the switch once its own session reports a token');
  await view.evaluate(() => window.setFixture({ tab: { resumeToken: 'old-1', ownToken: undefined } }));
  assert.ok(await view.getByRole('checkbox').isDisabled(), 'a conversation resumed from history keeps the switch locked');
  await view.evaluate(() => window.setFixture({ tab: { resumeToken: undefined } }));

  await view.evaluate(() => window.setFixture({ started: true }));
  await view.waitForFunction(() => document.querySelector('.gambit-worktree-toggle').disabled);
  assert.equal(await view.getByRole('checkbox').getAttribute('aria-checked'), 'false', 'a started conversation without a worktree keeps the switch, off and locked');
  assert.equal(await view.locator('.gambit-worktree').getAttribute('data-tip'), 'Can no longer be switched once the conversation starts');

  await view.evaluate(() => { window.wtStatus = { exists: true, ahead: 2, dirty: false, target: 'main' }; window.setFixture({ started: true, tab: { id: 't2', folderPath: 'D:/Project/.claude/worktrees/coffee-claude-a1b2c3', worktreeOrigin: 'D:/Project', worktree: { root: 'D:/Project', path: 'D:/Project/.claude/worktrees/coffee-claude-a1b2c3', branch: 'coffee/claude-a1b2c3' }, toolTitle: 'Fix login' } }); });
  const merge = view.getByRole('button', { name: 'Merge into main' });
  await merge.waitFor(); assert.equal(await view.locator('.gambit-worktree').getAttribute('data-tip'), 'Working in a worktree on branch coffee/claude-a1b2c3');
  assert.ok(await view.getByRole('checkbox').isDisabled(), 'the switch locks once the conversation has started');
  assert.equal(await view.getByRole('checkbox').getAttribute('aria-checked'), 'true');
  assert.equal(await view.locator('.gambit-worktree-check').count(), 1, 'a worktree conversation shows the check');
  assert.equal(await view.locator('.gambit-worktree-box').count(), 1);
  await view.screenshot({ path: join(directory, 'mergeable.png') });

  await view.evaluate(() => window.setFixture({ running: true }));
  await view.waitForFunction(() => !document.querySelector('.gambit-worktree-merge'));
  await view.evaluate(() => { window.mergeError = 'COFFEE_MERGE:conflict'; window.setFixture({ running: false }); });
  await merge.click(); await view.getByRole('status').waitFor();
  assert.equal(await view.getByRole('status').textContent(), 'Conflicts with the main checkout; the merge was undone and nothing changed there');
  await view.screenshot({ path: join(directory, 'conflict.png') });
  assert.equal(await view.evaluate(() => window.calls.findLast(call => call.name === 'worktree_merge').message), 'Coffee: Fix login');

  await view.evaluate(() => { window.mergeError = undefined; });
  await merge.click(); await view.waitForFunction(() => document.querySelector('[role=status]')?.textContent === 'Merged 2 commits');
  await view.waitForFunction(() => !document.querySelector('.gambit-worktree-merge'), null, { timeout: 3000 });
  await view.screenshot({ path: join(directory, 'merged.png') });

  await view.evaluate(() => Object.assign(document.documentElement.dataset, { theme: 'mint', mode: 'light' }));
  await view.evaluate(() => { window.wtStatus = { exists: true, ahead: 1, dirty: true, target: 'main' }; window.setFixture({ running: true }); });
  await view.waitForTimeout(50); await view.evaluate(() => window.setFixture({ running: false }));
  await merge.waitFor(); await view.screenshot({ path: join(directory, 'mergeable-light.png') });
  assert.deepEqual(errors, []);
  console.log('OK: worktree switch on, off and unavailable; locks once started; branch, merge, conflict and success states; light and dark');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
