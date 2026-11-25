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
  preset:'',policy:'',messages:[],requests:[],jobs:[],backgroundTasks:[],contextTokens:0,contextWindow:0,commands:true};
window.routes=[];window.pending=[];
const publish=()=>listeners.forEach(listener=>listener());
export function useDshSession(id,select=state=>state){return useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>select(window.dsh))}
export function setDshRoute(id,route){window.routes.push(route.effort);return new Promise((resolve,reject)=>window.pending.push(fail=>{if(fail){reject(new Error('restart failed'));return;}window.dsh={...window.dsh,route};publish();resolve();}));}
window.finishRoute=fail=>window.pending.shift()(fail);
window.setDsh=next=>{window.dsh={...window.dsh,...next};publish();};
export function setDshEffort(id,effort){return setDshRoute(id,{...window.dsh.route,effort});}
export async function sendDshMessage(){return true} export async function setDshPreset(){}`;
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React,{useRef}from'react';import{createRoot}from'react-dom/client';import{DshComposerControls}from'./src/components/center/DshComposerControls';import'./src/styles/global.css';
function App(){const keys=useRef(),submit=useRef();return <div style={{position:'absolute',bottom:30,right:30}}><DshComposerControls sessionId="dsh" draft="" onDraftChange={()=>{}} keyHandler={keys} submitHandler={submit}/></div>}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl', '.gif': 'dataurl' }, external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
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

  // Each choice applies when the menu closes; open it again for the next one.
  const choose = async stop => { if (!await slider.isVisible()) await trigger.click(); await dragTo(stop); await page.mouse.click(5, 5); await slider.waitFor({ state: 'detached' }); };
  await dragTo(1); await dragTo(3); await dragTo(1);
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => window.routes), [], 'dragging only previews');
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => window.routes.length === 1);
  assert.deepEqual(await page.evaluate(() => window.routes), ['low'], 'closing applies the final level once');

  // While that switch is still applying, the reopened slider is disabled: no second choice can race it.
  await trigger.click();
  assert.equal(await slider.isDisabled(), true, 'disabled while the previous switch applies');
  await page.evaluate(() => window.finishRoute());
  await page.waitForFunction(() => window.dsh.route.effort === 'low');
  await page.waitForFunction(() => !document.querySelector('.claude-effort-range input').disabled);
  assert.equal(await shown(), 1, 'shows the applied level');
  await page.keyboard.press('Escape');

  // Escape throws the preview away.
  await trigger.click(); await dragTo(3); await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.routes.length), 1, 'Escape applies nothing');

  // Ending on the applied level sends nothing.
  await choose(3); await page.waitForFunction(() => window.routes.length === 2);
  await page.evaluate(() => window.finishRoute());
  await page.waitForFunction(() => window.dsh.route.effort === 'max');
  await trigger.click(); await dragTo(0); await dragTo(3); await page.mouse.click(5, 5);
  await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => window.routes), ['low', 'max']);

  // A failed switch leaves the applied level and re-enables the slider.
  await choose(1); await page.waitForFunction(() => window.routes.length === 3);
  await page.evaluate(() => window.finishRoute(true));
  await trigger.click();
  await page.waitForFunction(() => !document.querySelector('.claude-effort-range input').disabled);
  assert.equal(await shown(), 3, 'a failed switch shows the level actually applied');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors.filter(error => !error.includes('restart failed')), []);
  console.log('OK: DeepSeek Harness effort applies once on close, Escape discards, the slider waits while a switch applies, and a failed switch keeps the applied level');
} finally { await browser.close(); server.close(); }
