// Real Explorer, mocked filesystem and app state; no native sessions or user files.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-explorer-filter-'));
const mock = `
  import {useSyncExternalStore} from 'react';
  const listeners=new Set(),dirty=new Set();
  let state={iconTheme:'material',activeTerminalId:'a',terminals:[{id:'a',tool:'claude',folderPath:'D:/project'}]};
  window.calls={reads:[],actions:[]};
  window.changeFolder=folder=>{state={...state,terminals:[{...state.terminals[0],folderPath:folder}]};listeners.forEach(fn=>fn())};
  export function useAppState(){return {state:useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state),dispatch:action=>window.calls.actions.push(action)}}
  export function useAppLanguage(){return 'zh-CN'}
  const file=(name,path='D:/project/'+name)=>({name,path,is_dir:false,size:1024});
  export const commands={async listDirectory(path){window.calls.reads.push(path);return path==='D:/project'?[{name:'src',path:path+'/src',is_dir:true,size:0},file('README.md'),file('index.ts'),file('组件.tsx')]:path.endsWith('/src')?[file('child.ts',path+'/child.ts')]:[file('other.txt',path+'/other.txt')]},async startFsWatcher(){},async stopFsWatcher(){}};
  export function onSelfUpdateProgress(){return()=>{}}
  export function listen(){return Promise.resolve(()=>{})}
  export function getVersion(){throw Error('fixture')}
  export function useFileStats(){return null} export function useDirtyDirs(){return dirty}
  export function refreshHistory(){} export function clipboardWrite(){} export function beginExplorerDrag(){}
  export function HistoryBoard(){return null} export function ChannelConnectionSummary(){return null}
`;
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `import React from 'react';import{createRoot}from'react-dom/client';import{Explorer}from'./src/components/left/Explorer';import'./src/styles/global.css';localStorage.setItem('cc-left-tab','workspace');createRoot(document.getElementById('root')).render(<Explorer/>);` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  nodePaths: [join(project, 'node_modules')], external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
  define: { 'process.env.NODE_ENV': '"development"', __IS_LINUX__: 'false' },
  plugins: [{ name: 'explorer-boundaries', setup(builder) {
    builder.onResolve({ filter: /(?:store\/app-state|tauri|lib\/(?:git-status|history-cache|clipboard|explorer-drag)|right\/HistoryBoard|agent\/AgentPages|@tauri-apps\/api\/(?:event|app))$/ }, () => ({ path: 'mock', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mock, resolveDir: project, loader: 'js' }));
  } }],
});
const html = `<!doctype html><html data-theme="dark" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:650px}#root{width:280px}.panel-left{width:280px!important;height:650px}</style><div id="root"></div><script src="/fixture.js"></script></html>`;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
    const asset = ['/fixture.js', '/fixture.css'].includes(req.url) ? join(directory, req.url.slice(1)) : /^\/(icons|fonts)\//.test(req.url) ? join(project, 'public', req.url.slice(1)) : null;
    if (!asset) return res.writeHead(404).end();
    res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream');
    res.end(await readFile(asset));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const search = page.getByRole('searchbox'), toggle = page.getByRole('button', { name: '筛选文件和文件夹…' });
  await page.locator('.tree-file').first().waitFor();
  await page.locator('.tree-dir-header').click(); await page.getByText('child.ts', { exact: true }).waitFor();
  const pathBox = await page.locator('.workspace-dir-btn').boundingBox();
  await toggle.click(); assert.equal(await search.evaluate(el => document.activeElement === el), true);
  assert.deepEqual(await page.locator('.workspace-dir-btn').boundingBox(), pathBox, 'switching to search does not move the file list');
  await search.fill('  README  '); assert.equal(await page.locator('.tree-file:visible').count(), 1);
  await page.getByText('README.md', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.calls.actions.at(-1).selection.path), 'D:/project/README.md', 'filtered files retain preview behavior');
  await search.press('Escape'); assert.match(await page.locator('.workspace-dir-path').textContent(), /D:\/project/);
  assert.equal(await page.getByText('child.ts', { exact: true }).isVisible(), true, 'closing search preserves expanded directories');
  assert.deepEqual(await page.evaluate(() => window.calls.reads), ['D:/project', 'D:/project/src'], 'typing never rescans or changes directories');
  await toggle.click(); await search.fill('SRC'); assert.equal(await page.locator('.tree-dir-header:visible').count(), 1);
  await search.fill('组件'); assert.equal(await page.locator('.tree-file:visible').count(), 1);
  await search.fill('missing'); assert.match(await page.getByRole('status').textContent(), /没有匹配/);
  await page.screenshot({ path: join(directory, 'empty.png') });
  await search.fill(''); assert.equal(await search.count(), 0, 'clearing the query restores the path');
  await toggle.click(); await search.fill('index'); await search.press('Tab');
  const close = page.getByRole('button', { name: '关闭搜索' }); assert.equal(await close.evaluate(el => document.activeElement === el), true);
  await close.press('Enter'); assert.equal(await search.count(), 0);
  await toggle.click(); await search.fill('README'); await page.evaluate(() => window.changeFolder('D:/other'));
  await page.getByText('other.txt', { exact: true }).waitFor(); assert.equal(await search.count(), 0, 'another workspace does not inherit the filter');
  for (const [mode, shape] of [['dark', 'soft'], ['light', 'panel'], ['dark', 'glass']]) {
    await page.evaluate(({ mode, shape }) => { document.documentElement.dataset.mode = mode; document.documentElement.dataset.shape = shape; }, { mode, shape });
    await toggle.click(); await search.fill('other');
    assert.equal(await search.evaluate(el => getComputedStyle(el).cursor), 'text');
    assert.equal(await page.locator('.workspace-dir-btn').evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: join(directory, mode + '-' + shape + '.png') }); await search.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('OK: current-directory filter, case/whitespace/CJK matching, path/clear/Escape switching, preview, retained expansion and workspace isolation');
  console.log('Screenshots: ' + directory);
} finally { await browser.close(); await new Promise(done => server.close(done)); }
