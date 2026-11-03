import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-dsh-effort-'));
// Each effort switch restarts the DeepSeek Harness runtime; window.finishRoute() completes the pending one.
const session = `import{useSyncExternalStore}from'react';
const listeners=new Set();
window.dsh={ready:true,busy:false,sessionId:'s1',title:'',route:{provider:'deepseek-account',model:'deepseek-flash',effort:'high'},
  models:[{provider:'deepseek-account',model:'deepseek-flash',name:'DeepSeek-V4.1-Flash',efforts:['off','low','high','max']}],
  preset:'',policy:'',messages:[],requests:[],contextTokens:0,contextWindow:0,commands:true};
window.routes=[];window.pending=[];
const publish=()=>listeners.forEach(listener=>listener());
export function useDshSession(id,select=state=>state){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>select(window.dsh))}
export function setDshRoute(id,route){window.routes.push(route.effort);return new Promise(resolve=>window.pending.push(()=>{window.dsh={...window.dsh,route};publish();resolve();}));}
window.finishRoute=()=>window.pending.shift()();
export async function sendDshMessage(){return true} export async function setDshPreset(){}`;
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React,{useRef}from'react';import{createRoot}from'react-dom/client';import{DshComposerControls}from'./src/components/center/DshComposerControls';import'./src/styles/global.css';
function App(){const keys=useRef(),submit=useRef();return <div style={{position:'absolute',bottom:30,right:30}}><DshComposerControls sessionId="dsh" draft="" onDraftChange={()=>{}} keyHandler={keys} submitHandler={submit}/></div>}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl' }, external: ['/fonts/*', '/monogram.svg'],
  plugins: [{ name: 'dsh-effort-fixtures', setup(b) {
    b.onResolve({ filter: /lib\/dsh-session$/ }, () => ({ path: 'session', namespace: 'fixture' }));
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'app-state', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', resolveDir: project, contents: args.path === 'session' ? session
      : `export function useAppLanguage(){return 'zh-CN'} export function useAppState(){return{state:{terminals:[]},dispatch(){}}}` }));
  } }] });
const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', `${name.endsWith('.js') ? 'text/javascript' : 'text/css'}; charset=utf-8`).end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:var(--bg-terminal)"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const trigger = page.locator('.claude-effort-trigger');
  await trigger.click();
  const slider = page.getByRole('slider', { name: '思考强度' });
  const dragTo = async stop => {
    const box = await slider.boundingBox(), x = fraction => box.x + 9 + (box.width - 18) * fraction;
    await page.mouse.move(x(await slider.evaluate(el => Number(el.value) / Number(el.max))), box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(x(stop / 3), box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  };
  const shown = () => slider.evaluate(el => Number(el.value));

  // Lower the effort, then raise it to max while the first restart is still running.
  await dragTo(1);
  await page.waitForFunction(() => window.routes.length === 1);
  await dragTo(3);
  assert.equal(await shown(), 3, 'the slider keeps showing the latest choice while the earlier one applies');
  await page.evaluate(() => window.finishRoute());
  await page.waitForFunction(() => window.routes.length === 2);
  assert.deepEqual(await page.evaluate(() => window.routes), ['low', 'max'], 'the later choice is applied after the earlier one, not dropped');
  assert.equal(await shown(), 3, 'finishing the earlier switch never jumps back to it');
  await page.evaluate(() => window.finishRoute());
  await page.waitForFunction(() => window.dsh.route.effort === 'max');
  assert.equal(await shown(), 3);
  assert.equal((await trigger.textContent()).trim().length > 0, true);

  // Several moves during one restart apply only the last one.
  await dragTo(0);
  await page.waitForFunction(() => window.routes.length === 3);
  await dragTo(2); await dragTo(1);
  await page.evaluate(() => window.finishRoute());
  await page.waitForFunction(() => window.routes.length === 4);
  await page.evaluate(() => window.finishRoute());
  await page.waitForFunction(() => window.dsh.route.effort === 'low');
  assert.deepEqual(await page.evaluate(() => window.routes), ['low', 'max', 'off', 'low'], 'intermediate choices are skipped; the final one wins');
  assert.equal(await shown(), 1);
  assert.deepEqual(errors, []);
  console.log('OK: DeepSeek Harness effort changes made during a restart are kept, applied in order with the latest winning, and never jump back');
} finally { await browser.close(); server.close(); }
