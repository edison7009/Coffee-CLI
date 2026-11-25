// Work handed to another computer, through the window that controls it (WindowControlBridge), against scripted
// boundaries on both sides: this computer's IPC and the other computer's pairing connection. It covers delegating
// (with the project found by repository), progress coming back, send / reply / interrupt, showing the worker's tab,
// and a reconnect reporting again. The hub's own rules (a device only reaching its work, reconnect by computer)
// are covered by the Rust tests in src/orchestration.rs.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-remote-team-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{WindowControlBridge}from'./src/components/agent/WindowControlBridge';
createRoot(document.getElementById('root')).render(<WindowControlBridge/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', loader: { '.svg': 'text', '.png': 'dataurl', '.woff2': 'empty', '.css': 'empty' }, nodePaths: [join(project, 'node_modules')], logLevel: 'silent', plugins: [{ name: 'fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /lib\/agent-tools$/ }, () => ({ path: 'tools', namespace: 'fixture' }));
  b.onResolve({ filter: /remote\/local-ipc$/ }, () => ({ path: 'local', namespace: 'fixture' }));
  b.onResolve({ filter: /remote\/bridge$/ }, () => ({ path: 'remote', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onResolve({ filter: /i18n\/useT$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: {
    store: `window.dispatched=[];window.appState={activeTerminalId:'tab-docs',terminals:[{id:'tab-docs',folderPath:'D:/docs'},{id:'tab-app',folderPath:'D:/work/app'}]};
      export const useAppStateRef=()=>({get current(){return window.appState}});export const useAppDispatch=()=>action=>window.dispatched.push(action);`,
    tools: `export const createAgentToolExecutor=()=>async request=>({executed:request.name});`,
    local: `window.local=[];window.localEvents={};
      export function localInvoke(cmd,args){window.local.push([cmd,args]);return Promise.resolve(null)}
      export function onLocalEvent(name,handler){window.localEvents[name]=handler;return()=>{delete window.localEvents[name]}}`,
    remote: `window.remote=[];window.statusListeners=[];
      window.remoteTasks=[{id:'far',phase:'running',sessionId:'tab-far',summary:null}];
      export const remoteComputerName=()=>'Studio';
      export function onRemoteStatus(listener){window.statusListeners.push(listener);return()=>{}}
      export async function remoteRequest(method,params){window.remote.push([method,structuredClone(params)]);
        if(method==='team.delegate')return{task:{id:'far',cwd:params.cwd,sessionId:'tab-far'},parentId:'device:abc'};
        if(method==='team.call'&&params.action==='list')return{tasks:structuredClone(window.remoteTasks)};
        return{ok:true}}`,
    native: `export const commands={async checkToolsInstalled(){return{claude:true,codex:true,pi:false}}};
      export async function invoke(cmd,args){if(cmd==='orchestration_get')return{agents:['claude','codex','pi']};
        if(cmd==='git_repo_key')return args.folder==='D:/work/app'?'github.com/team/app':null;return null}`,
    i18n: `export const useT=()=>key=>key;`,
    event: `window.events={};export async function listen(name,handler){window.events[name]=handler;return()=>{delete window.events[name]}}`,
  }[args.path] }));
} }] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html><div id="root"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const updates = () => page.evaluate(() => window.local.filter(([cmd]) => cmd === 'orchestration_remote_update').map(([, args]) => args));
  const ask = (name, args) => page.evaluate(([name, args]) => { const id = crypto.randomUUID(); window.localEvents['window-control-request']({ requestId: id, name, arguments: args }); return id; }, [name, args]);
  const answer = id => page.waitForFunction(id => window.local.find(([cmd, args]) => cmd === 'window_control_resolve' && args.requestId === id)?.[1].result, id).then(handle => handle.jsonValue());

  // On opening, the window tells this computer what the other one offers: installed helpers and its projects.
  await page.waitForFunction(() => window.local.some(([cmd]) => cmd === 'orchestration_remote_update'));
  const first = (await updates())[0];
  assert.equal(first.computer, 'Studio');
  assert.deepEqual(first.agents, ['claude', 'codex'], 'only helpers installed over there are offered');
  assert.deepEqual(first.projects, [{ path: 'D:/docs', repo: null }, { path: 'D:/work/app', repo: 'github.com/team/app' }]);
  assert.deepEqual(first.tasks.map(task => task.id), ['far']);

  // Delegating without a folder picks the project with this conversation's repository, not the window's current tab.
  let id = await ask('team_delegate', { tool: 'codex', title: 'Run the tests', prompt: 'npm test', cwd: null, repo: 'github.com/team/app' });
  let result = await answer(id);
  assert.equal(result.ok, true);
  const delegated = await page.evaluate(() => window.remote.find(([method]) => method === 'team.delegate')[1]);
  assert.equal(delegated.cwd, 'D:/work/app');
  assert.equal(delegated.repo, undefined, 'the repository key stays on this side');
  assert.equal(result.result.task.sessionId, 'tab-far');
  // With no matching repository, the folder this window shows now.
  id = await ask('team_delegate', { tool: 'codex', title: 'Docs', prompt: 'check', repo: 'github.com/other/x' });
  await answer(id);
  assert.equal(await page.evaluate(() => window.remote.filter(([method]) => method === 'team.delegate')[1][1].cwd), 'D:/docs');

  // Progress over there comes back: a change there reports again with the worker's new state.
  const before = (await updates()).length;
  await page.evaluate(() => { window.remoteTasks[0] = { id: 'far', phase: 'completed', sessionId: 'tab-far', summary: 'All 12 tests pass' }; window.events['orchestration-updated']({ payload: {} }); });
  await page.waitForFunction(count => window.local.filter(([cmd]) => cmd === 'orchestration_remote_update').length > count, before);
  assert.deepEqual((await updates()).at(-1).tasks[0], { id: 'far', phase: 'completed', sessionId: 'tab-far', summary: 'All 12 tests pass' });

  // Steering, answering and stopping go to the other computer unchanged.
  for (const [action, extra] of [['send', { text: 'Also run lint' }], ['reply', { questionId: 'q1', answer: 'main' }], ['interrupt', {}]]) {
    id = await ask('team_call', { action, taskId: 'far', ...extra });
    assert.equal((await answer(id)).ok, true);
    assert.deepEqual(await page.evaluate(action => window.remote.findLast(([method, params]) => method === 'team.call' && params.action === action)[1], action), { action, taskId: 'far', ...extra });
  }

  // This computer showing the worker's tab selects it in the window; a tab that is not there is left alone.
  await page.evaluate(() => { window.localEvents['remote-show-tab']({ sessionId: 'tab-app' }); window.localEvents['remote-show-tab']({ sessionId: 'nowhere' }); });
  assert.deepEqual(await page.evaluate(() => window.dispatched), [{ type: 'SET_ACTIVE_TERMINAL', id: 'tab-app' }]);

  // A reconnect reports again, so work over there is picked up after a drop.
  const beforeReconnect = (await updates()).length;
  await page.evaluate(() => window.statusListeners.forEach(listener => listener('connected')));
  await page.waitForFunction(count => window.local.filter(([cmd]) => cmd === 'orchestration_remote_update').length > count, beforeReconnect);

  assert.deepEqual(errors, []);
  console.log('OK: delegating by repository, progress back, send/reply/interrupt, showing the worker tab and reporting after a reconnect');
} finally { await browser.close(); server.close(); }
