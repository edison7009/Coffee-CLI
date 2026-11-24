// The sidebar's update button: Windows downloads on the first click and installs only on a second
// one; macOS / Linux return to idle after opening the download. Real Explorer, faked native calls.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-self-update-'));
const mock = `
  import {useSyncExternalStore} from 'react';
  const state={iconTheme:'material',activeTerminalId:null,terminals:[],settingsOpen:false};
  export function useAppState(){return {state:useSyncExternalStore(()=>()=>{},()=>state),dispatch(){}}}
  export function useAppLanguage(){return 'zh-CN'}
  const later=name=>new Promise((resolve,reject)=>{window.pending[name]={resolve,reject}});
  const record=(name,args)=>{window.calls.push([name,...args]);return later(name)};
  export const commands={
    downloadUpdate:(...a)=>record('download',a),
    installDownloadedUpdate:(...a)=>record('install',a),
    async isUpdateDownloaded(version){window.calls.push(['ready?',version]);return window.downloaded===version},
    async openUrl(url){window.calls.push(['open',url])},
    async listDirectory(){return []},async startFsWatcher(){},async stopFsWatcher(){},
    async mobileRpcStatus(){return {enabled:false,devices:[],connected:[],hosts:[]}},async remoteWindowList(){return []},
  };
  export async function onSelfUpdateProgress(cb){window.progress=cb;return()=>{window.progress=null}}
  export const isTauri=false; export function useAppDispatch(){return()=>{}}
  export function listen(){return Promise.resolve(()=>{})}
  export async function getVersion(){return '4.0.7'}
  export async function fetchLatestManifest(){return {version:'9.9.9'}}
  export function isNewerVersion(){return true}
  export function useFileStats(){return null} export function useDirtyDirs(){return new Set()}
  export function refreshHistory(){} export function clipboardWrite(){} export function beginExplorerDrag(){}
  export function HistoryBoard(){return null}
  export const BUNDLED_VERSION='4.0.7', RELEASE_NOTES_SEEN='seen'; export function shouldShowReleaseNotes(){return false}
  export function cachedReleaseNotes(){return ''} export function notesForLocale(n){return n}
  export async function loadReleaseNotes(version){window.calls.push(['notes',version]);return '### 新内容 v'+version}
`;
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `import{createRoot}from'react-dom/client';import{Explorer}from'./src/components/left/Explorer';import'./src/styles/global.css';createRoot(document.getElementById('root')).render(<Explorer/>);` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  nodePaths: [join(project, 'node_modules')], external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
  define: { 'process.env.NODE_ENV': '"development"', __IS_LINUX__: 'false' },
  plugins: [{ name: 'self-update-boundaries', setup(builder) {
    builder.onResolve({ filter: /(?:store\/app-state|tauri|(?:lib|\.)\/(?:git-status|history-cache|clipboard|explorer-drag|update-manifest|release-notes)|right\/HistoryBoard|@tauri-apps\/api\/(?:event|app))$/ }, () => ({ path: 'mock', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mock, resolveDir: project, loader: 'js' }));
  } }],
});
const html = `<!doctype html><html data-theme="dark" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:650px}#root{width:280px}.panel-left{width:280px!important;height:650px}</style><div id="root"></div><script src="/fixture.js"></script></html>`;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
    const asset = ['/fixture.js', '/fixture.css'].includes(req.url) ? join(directory, req.url.slice(1)) : null;
    if (!asset) return res.writeHead(404).end();
    res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css');
    res.end(await readFile(asset));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });

async function open(platform, downloaded = null) {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ platform, downloaded }) => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform });
    Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
    window.calls = []; window.pending = {}; window.downloaded = downloaded;
  }, { platform, downloaded });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const button = page.locator('.update-check-btn.update-available');
  await button.waitFor();
  const label = () => button.getAttribute('aria-label');
  const calls = name => page.evaluate(name => window.calls.filter(call => call[0] === name), name);
  const settle = (name, how, value) => page.evaluate(([name, how, value]) => window.pending[name][how](value), [name, how, value]);
  const emit = (status, percent) => page.evaluate(([status, percent]) => window.progress({ status, percent }), [status, percent]);
  return { page, errors, button, label, calls, settle, emit };
}

try {
  // Windows: download, then wait for the user's click before installing.
  {
    const { page, errors, button, label, calls, settle, emit } = await open('Win32');
    assert.equal(await label(), '下载更新 v9.9.9');
    await button.click();
    await page.waitForFunction(() => window.pending.download && window.progress);
    await emit('downloading', 40);
    assert.equal(await label(), '正在下载更新 40%');
    assert.equal(await button.isDisabled(), true, 'a running download cannot be started twice');
    await button.dispatchEvent('click');
    assert.deepEqual(await calls('download'), [['download', '9.9.9']]);
    await emit('downloaded', 100);
    await settle('download', 'resolve', '9.9.9');
    await page.locator('.update-check-btn.is-ready').waitFor();
    assert.equal(await label(), '安装更新 v9.9.9');
    // Downloaded and waiting is an icon like the rest of the row; the words are its tip and its name.
    assert.deepEqual(await button.evaluate(el => [el.innerText.trim(), el.querySelectorAll('svg').length]), ['', 1], 'the ready step shows an icon, not a word');
    assert.equal(await button.isDisabled(), false);
    assert.deepEqual(await calls('install'), [], 'a finished download never installs by itself');
    await page.screenshot({ path: join(directory, 'ready-dark.png'), clip: { x: 0, y: 560, width: 300, height: 90 } });
    await page.evaluate(() => { document.documentElement.dataset.mode = 'light'; document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({ path: join(directory, 'ready-light.png'), clip: { x: 0, y: 560, width: 300, height: 90 } });
    const box = await button.boundingBox(), panel = await page.locator('.panel-left').boundingBox();
    assert.ok(box.x + box.width <= panel.x + panel.width, 'the wider Install button stays inside the sidebar');

    // The install step shows the new version's notes first; only 开始更新 installs.
    await button.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('从 v4.0.7 更新到 v9.9.9', { exact: false }).waitFor();
    await dialog.getByText('新内容 v9.9.9').waitFor();
    assert.deepEqual(await calls('install'), [], 'opening the notes installs nothing');
    await dialog.getByRole('button', { name: '开始更新' }).click();
    await page.waitForFunction(() => window.pending.install);
    assert.deepEqual(await calls('install'), [['install', '9.9.9']]);
    assert.equal(await dialog.getByRole('button', { name: '开始更新' }).isDisabled(), true, 'the notes stay, waiting, while the app closes');
    assert.equal(await label(), '正在重启');
    await settle('install', 'resolve', true);
    await page.waitForTimeout(50);
    assert.equal(await label(), '正在重启', 'the button keeps restarting while the app closes');
    assert.deepEqual(await calls('open'), []);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`OK Windows downloads first; the second click shows the notes and 开始更新 installs (screenshots: ${directory})`);
  }

  // Windows: an installer that disappeared goes back to Download; a failed download opens the website.
  {
    const { page, errors, button, label, calls, settle } = await open('Win32', '9.9.9');
    await page.locator('.update-check-btn.is-ready').waitFor();
    assert.deepEqual(await calls('download'), [], 'an earlier download is offered for installation straight away');
    await button.click();
    await page.getByRole('dialog').getByRole('button', { name: '开始更新' }).click();
    await page.waitForFunction(() => window.pending.install);
    await page.evaluate(() => { window.downloaded = null; });
    await settle('install', 'resolve', false);
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    await page.evaluate(() => { window.pending = {}; });
    await page.waitForFunction(() => document.querySelector('.update-check-btn').getAttribute('aria-label') === '下载更新 v9.9.9');

    await button.click();
    await page.waitForFunction(() => window.pending.download);
    await settle('download', 'reject', 'no download source reachable');
    await page.waitForFunction(() => !document.querySelector('.update-check-btn').disabled);
    assert.equal(await label(), '下载更新 v9.9.9');
    assert.deepEqual(await calls('open'), [['open', 'https://coffeecli.com']]);

    // A source with a newer release than the check found: install that one.
    await page.evaluate(() => { window.pending = {}; });
    await button.click();
    await page.waitForFunction(() => window.pending.download);
    await settle('download', 'resolve', '9.9.10');
    await page.waitForFunction(() => document.querySelector('.update-check-btn').getAttribute('aria-label') === '安装更新 v9.9.10');
    assert.deepEqual(errors, []);
    await page.close();
    console.log('OK Windows recovers from a missing installer and a failed download');
  }

  // macOS: the DMG opens after downloading and the button returns to idle; nothing to install here.
  {
    const { page, errors, button, label, calls, settle } = await open('MacIntel');
    // Here the download opens the installer, so the notes come first: Close keeps it from starting.
    await button.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '开始更新' }).waitFor();
    await dialog.getByRole('button', { name: '关闭' }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    assert.deepEqual(await calls('download'), [], 'closing the notes starts nothing');
    await button.click();
    await page.getByRole('dialog').getByRole('button', { name: '开始更新' }).click();
    await page.waitForFunction(() => window.pending.download && !document.querySelector('[role="dialog"]'));
    await settle('download', 'resolve', null);
    await page.waitForFunction(() => !document.querySelector('.update-check-btn').disabled);
    assert.equal(await label(), '下载更新 v9.9.9');
    assert.deepEqual(await calls('ready?'), [], 'only Windows keeps a download waiting');
    assert.deepEqual(await calls('install'), []);
    assert.deepEqual(errors, []);
    await page.close();
    console.log('OK macOS / Linux show the notes first, then download and open it');
  }
} finally {
  await browser.close();
  server.close();
}
