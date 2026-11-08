// The sound rows in General settings: the real modal, store and styles; only native calls and the file dialog are isolated.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-sound-settings-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';
    import {AppProvider,useAppDispatch} from './src/store/app-state';
    import {SettingsModal} from './src/components/common/SettingsModal';
    import './src/styles/global.css';
    function Open(){const dispatch=useAppDispatch();useEffect(()=>{dispatch({type:'SET_SETTINGS_OPEN',open:true})},[dispatch]);return <SettingsModal/>}
    createRoot(document.getElementById('root')).render(<AppProvider><Open/></AppProvider>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic',
  external: ['/fonts/*', '/monogram.svg'], nodePaths: [join(project, 'node_modules')], loader: { '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export const open=async()=>window.chosenPath??null;` }));
  } }],
});
const page = `<!doctype html><html data-theme="lavender" data-mode="dark"><head><meta charset="utf-8"></head><body style="margin:0;background:var(--bg-app)"><div id="root"></div>
<script>
  localStorage.setItem('cc-lang','zh-CN');
  window.calls=[];window.files={done:null,wait:null};
  window.__TAURI_INTERNALS__={transformCallback:()=>0,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},async invoke(name,args){
    window.calls.push({name,...args});
    if(name==='notify_sound_files')return window.files;
    if(name==='notify_sound_choose'){if(window.chooseFails)throw new Error('Sound file is too large');return args.path.split('/').pop()}
    if(name==='plugin:app|version')return '3.8.3';
    return null;
  }};
</script><link rel="stylesheet" href="/fixture.css"><script src="/fixture.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(await readFile(join(directory, 'fixture.js'))); return; }
  if (req.url === '/fixture.css') { res.setHeader('content-type', 'text/css'); res.end(await readFile(join(directory, 'fixture.css')).catch(() => '')); return; }
  res.setHeader('content-type', 'text/html'); res.end(page);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE });
try {
  const view = await browser.newPage({ viewport: { width: 760, height: 580 }, deviceScaleFactor: 2 });
  const errors = []; view.on('pageerror', error => errors.push(String(error)));
  await view.goto(`http://127.0.0.1:${server.address().port}/`);
  // Sounds are one-line rows in General, the section settings opens on.
  const change = view.getByRole('button', { name: '更换', exact: true }), preview = view.getByRole('button', { name: '试听', exact: true });
  const name = view.locator('.settings-sound-name');
  await change.first().waitFor();
  assert.equal(await change.count(), 2); assert.equal(await preview.count(), 2);
  assert.deepEqual(await name.allTextContents(), ['默认声音', '默认声音']);
  await view.screenshot({ path: join(directory, 'default.png') });

  await view.evaluate(() => { window.chosenPath = 'D:/Music/done chime.mp3'; });
  await change.first().click();
  await view.waitForFunction(() => document.querySelector('.settings-sound-name')?.textContent === 'done chime.mp3');
  const remove = view.getByRole('button', { name: '移除自定义提示音' });
  assert.equal(await remove.count(), 1, 'only a custom sound can be removed');
  assert.deepEqual(await view.evaluate(() => window.calls.find(call => call.name === 'notify_sound_choose')), { name: 'notify_sound_choose', kind: 'done', path: 'D:/Music/done chime.mp3' });

  await view.evaluate(() => { window.chosenPath = 'D:/Music/a very long name for the waiting sound of a tool.wav'; });
  await change.nth(1).click();
  await view.waitForFunction(() => document.querySelectorAll('.settings-sound-remove').length === 2);
  assert.equal(await name.nth(1).textContent(), 'a very long name…a tool.wav', 'a long name keeps its ending');
  await remove.first().hover(); await view.waitForTimeout(200);
  assert.equal(await remove.first().evaluate(el => getComputedStyle(el).color), await view.evaluate(() => { const probe = document.createElement('i'); probe.style.color = 'var(--text-1)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }), 'the X brightens to the text colour');
  await view.screenshot({ path: join(directory, 'chosen.png') });

  await preview.first().click();
  assert.equal(await view.evaluate(() => window.calls.at(-1).kind), 'done');
  await remove.first().click();
  await view.waitForFunction(() => document.querySelector('.settings-sound-name')?.textContent === '默认声音');
  assert.equal(await view.evaluate(() => window.calls.findLast(call => call.name === 'notify_sound_clear').kind), 'done');

  await view.evaluate(() => { window.chooseFails = true; window.chosenPath = 'D:/Music/huge.wav'; });
  await change.first().click();
  await view.getByRole('alert').waitFor();
  assert.equal(await name.first().textContent(), '默认声音', 'a refused file changes nothing');
  await view.screenshot({ path: join(directory, 'refused.png') });

  // Off hides the sound, Change and Preview; the switch stays.
  await view.getByRole('switch', { name: '任务完成提示音' }).click();
  await view.waitForFunction(() => document.querySelectorAll('.settings-sound-name').length === 1);
  assert.equal(await change.count(), 1); assert.equal(await preview.count(), 1);
  assert.deepEqual(errors, []);
  console.log('OK: sound rows in General choose, shorten, preview, remove, refuse and switch off');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
