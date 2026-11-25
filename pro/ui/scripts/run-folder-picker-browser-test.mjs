// Folder picker against a scripted file system: POSIX and Windows computers, desktop and phone widths.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-folder-picker-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{FolderPickerHost}from'./src/components/common/FolderPicker';import{pickFolder}from'./src/lib/folder-picker';
window.pick=(options)=>{window.picked=undefined;void pickFolder(options).then(p=>{window.picked=p});};
createRoot(document.getElementById('root')).render(<FolderPickerHost/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')], loader: { '.css': 'empty' }, plugins: [{ name: 'folder-picker-fixture', setup(b) {
  b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
  b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'native', namespace: 'fixture' }));
  b.onResolve({ filter: /lib\/viewport$/ }, () => ({ path: 'viewport', namespace: 'fixture' }));
  b.onResolve({ filter: /lib\/project-folders$/ }, () => ({ path: 'projects', namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: {
    store: `export function useAppLanguage(){return 'zh-CN'}`,
    viewport: `export const IS_WEB = false;`,
    projects: `export const getProjectFolders = () => window.fs.recent;`,
    dialog: `export async function open(o){ window.dialogOpened = o; return window.fs.dialogResult; }`,
    native: `
export const commands = {
  async folderPickerPlaces(){ return window.fs.places },
  async listDirectory(path){ window.reads.push(path); const kids = window.fs.tree[path]; if (!kids) throw new Error('denied'); return kids.map(name => ({ name, path: path.endsWith(window.fs.places.separator) ? path + name : path + window.fs.places.separator + name, is_dir: !name.endsWith('.txt'), size: 0 })); },
};`,
  }[args.path] }));
} }] });

const posix = { recent: ['/Users/me/code/coffee'], dialogResult: '/Volumes/NAS/shared', places: { home: '/Users/me', separator: '/', places: [{ name: 'me', path: '/Users/me', kind: 'home' }, { name: 'Desktop', path: '/Users/me/Desktop', kind: 'desktop' }, { name: '/', path: '/', kind: 'drive' }, { name: '扩展存储', path: '/Volumes/扩展存储', kind: 'drive' }] },
  tree: { '/Users/me/code/coffee': ['src', '.git', 'README.txt'], '/Users/me/code': ['coffee', 'site'], '/Users/me': ['code', 'Desktop', '.ssh'], '/Users/me/Desktop': [], '/': ['Users', 'Volumes'], '/Users': ['me'], '/Volumes/扩展存储': ['coffee-cli', 'References'], '/Users/me/code/coffee/src': [] } };
const windows = { recent: [], dialogResult: null, places: { home: 'C:\\Users\\me', separator: '\\', places: [{ name: 'me', path: 'C:\\Users\\me', kind: 'home' }, { name: 'C:', path: 'C:\\', kind: 'drive' }, { name: 'D:', path: 'D:\\', kind: 'drive' }] },
  tree: { 'C:\\Users\\me': ['Documents', 'AppData'], 'D:\\': ['code', '$RECYCLE.BIN', 'System Volume Information'], 'D:\\code': ['app'], 'D:\\code\\app': [], 'C:\\': ['Users'] } };

const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-width="l"><style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#292528} :root{--type-body:14px;--type-label:12px;--type-caption:11px;--text-3:#aaa;--accent:#c595a5;--bg-hover:#393236;--bg-panel:#292528;--text-1:#e5dce1;--text-2:#bcb2b8;--border:#443a40;--border-input:#443a40;--radius-sm:8px;--radius-md:12px;--switch-on:#007aff}</style><link rel="stylesheet" href="/picker.css"><div id="root"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/picker.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(project, 'src/components/common/FolderPicker.css')));
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(fs => { window.fs = fs; window.reads = []; }, posix);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const dialog = page.getByRole('dialog', { name: '选择项目目录' });
  const path = page.getByRole('textbox', { name: '输入或粘贴路径，按回车前往' });
  const choose = page.getByRole('button', { name: '选择此目录' });

  // Opens on the most recent project; hidden folders and files are not listed.
  await page.evaluate(() => window.pick());
  await dialog.waitFor();
  await page.getByRole('listitem').filter({ hasText: 'src' }).waitFor();
  assert.equal(await path.inputValue(), '/Users/me/code/coffee');
  assert.deepEqual(await page.getByRole('listitem').allInnerTexts(), ['src']);
  await page.getByRole('checkbox', { name: '显示隐藏文件夹' }).check();
  assert.deepEqual(await page.getByRole('listitem').allInnerTexts(), ['src', '.git']);

  // Up, breadcrumbs and entering a folder.
  await page.getByRole('button', { name: '上一级' }).click();
  await page.getByRole('listitem').filter({ hasText: 'site' }).waitFor();
  assert.equal(await path.inputValue(), '/Users/me/code');
  assert.deepEqual(await page.locator('.folder-picker-crumbs button').allInnerTexts(), ['/', 'Users', 'me', 'code']);
  await page.locator('.folder-picker-crumbs button', { hasText: 'Users' }).click();
  await page.getByRole('listitem').filter({ hasText: 'me' }).waitFor();
  await page.getByRole('listitem').filter({ hasText: 'me' }).click();
  await page.getByRole('listitem').filter({ hasText: 'code' }).waitFor();

  // A place, a typed path (quotes and trailing slash cleaned), and a folder that cannot be read.
  await page.locator('.folder-picker-place', { hasText: '扩展存储' }).click();
  await page.getByRole('listitem').filter({ hasText: 'References' }).waitFor();
  await path.fill(' "/Users/me/code/coffee/src/" ');
  await path.press('Enter');
  await page.getByText('这里没有子文件夹。').waitFor();
  assert.equal(await path.inputValue(), '/Users/me/code/coffee/src');
  await path.fill('/private/nope');
  await path.press('Enter');
  await page.getByRole('alert').getByText('无法读取这个目录，可能不存在或没有权限。').waitFor();
  assert.equal(await choose.isDisabled(), true, 'an unreadable folder cannot be chosen');
  await page.locator('.folder-picker-place', { hasText: '主目录' }).click();
  await page.getByRole('listitem').filter({ hasText: 'code' }).waitFor();
  await page.screenshot({ path: join(directory, 'picker-desktop.png') });

  // Choose returns the folder shown.
  await choose.click();
  await page.waitForFunction(() => window.picked !== undefined);
  assert.equal(await page.evaluate(() => window.picked), '/Users/me');
  assert.equal(await dialog.count(), 0);

  // A recent project returns at once; Escape and the backdrop cancel; the system dialog hands back its folder.
  await page.evaluate(() => window.pick());
  await page.locator('.folder-picker-place', { hasText: 'coffee' }).first().click();
  await page.waitForFunction(() => window.picked !== undefined);
  assert.equal(await page.evaluate(() => window.picked), '/Users/me/code/coffee');
  await page.evaluate(() => window.pick());
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.picked !== undefined);
  assert.equal(await page.evaluate(() => window.picked), null);
  await page.evaluate(() => window.pick({ start: '/Users/me/code' }));
  await page.getByRole('listitem').filter({ hasText: 'site' }).waitFor();
  await page.getByRole('button', { name: '使用系统对话框…' }).click();
  await page.waitForFunction(() => window.picked !== undefined);
  assert.equal(await page.evaluate(() => window.picked), '/Volumes/NAS/shared');
  assert.deepEqual(await page.evaluate(() => window.dialogOpened), { directory: true, defaultPath: '/Users/me/code' });

  // A Windows computer: drive letters, backslash paths, system folders hidden, typed forward slashes.
  const win = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  win.on('pageerror', e => errors.push(e.message));
  await win.addInitScript(fs => { window.fs = fs; window.reads = []; }, windows);
  await win.goto(`http://127.0.0.1:${server.address().port}`);
  await win.evaluate(() => window.pick());
  await win.getByRole('listitem').filter({ hasText: 'Documents' }).waitFor();
  assert.equal(await win.getByRole('textbox').inputValue(), 'C:\\Users\\me', 'a Windows computer starts at its home');
  await win.locator('.folder-picker-place', { hasText: 'D:' }).click();
  await win.getByRole('listitem').filter({ hasText: 'code' }).waitFor();
  assert.deepEqual(await win.getByRole('listitem').allInnerTexts(), ['code'], 'recycle bin and system folders are hidden');
  await win.getByRole('textbox').fill('D:/code/app/');
  await win.getByRole('textbox').press('Enter');
  await win.getByText('这里没有子文件夹。').waitFor();
  assert.equal(await win.getByRole('textbox').inputValue(), 'D:\\code\\app');
  assert.deepEqual(await win.locator('.folder-picker-crumbs button').allInnerTexts(), ['D:', 'code', 'app']);
  await win.getByRole('button', { name: '上一级' }).click();
  await win.getByRole('listitem').filter({ hasText: 'app' }).waitFor();
  assert.equal(await win.getByRole('textbox').inputValue(), 'D:\\code');

  // Phone width: full screen, places as a row, the list keeps 44px rows.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  phone.on('pageerror', e => errors.push(e.message));
  await phone.addInitScript(fs => { window.fs = fs; window.reads = []; }, posix);
  await phone.goto(`http://127.0.0.1:${server.address().port}`);
  await phone.evaluate(() => { document.documentElement.dataset.width = 'xs'; window.pick(); });
  await phone.getByRole('listitem').filter({ hasText: 'src' }).waitFor();
  const box = await phone.locator('.folder-picker').boundingBox();
  assert.deepEqual([Math.round(box.width), Math.round(box.height)], [390, 844], 'full screen on a phone');
  assert.ok((await phone.getByRole('listitem').first().boundingBox()).height >= 44, 'touch-sized rows');
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'nothing wider than the screen');
  await phone.screenshot({ path: join(directory, 'picker-phone.png') });

  assert.deepEqual(errors, []);
  console.log(`folder picker browser test passed (screenshots: ${directory})`);
} finally { await browser.close(); server.close(); }
