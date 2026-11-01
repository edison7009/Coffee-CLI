// The composer's usage meter across tab switches: real hook and meter, native transport isolated.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-usage-tabs-'));
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {providerQuotas,useUsageQuota} from './src/lib/usage-quota';
    import {AppProvider} from './src/store/app-state';
    import {UsageMeter} from './src/components/center/UsageMeter';
    function Meter({id}){const u=useUsageQuota(id,'claude','D:/'+id,null);window.refresh=u.refresh;return <output>{u.quotas.map(q=>q.balance).join(',')||'none'}</output>}
    function Fixture(){const [id,setId]=useState('a');window.setTab=setId;return <><Meter id={id}/>
      <div id="left"><UsageMeter quotas={providerQuotas([{balance:3.5,balanceUnit:'CNY'}])}/></div>
      <div id="spent"><UsageMeter quotas={providerQuotas([{balance:3.5,balanceUnit:'CNY',spent:true}])}/></div></>}
    createRoot(document.getElementById('root')).render(<AppProvider><Fixture/></AppProvider>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')],
  loader: { '.webp': 'dataurl', '.webm': 'dataurl', '.gif': 'dataurl', '.png': 'dataurl', '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'event' ? `
      export async function listen(){return()=>{}};
    ` : `
      window.pending=[];window.queries=[];
      window.finish=(index,balance)=>{const [entry]=window.pending.splice(index,1);balance===null?entry.reject(new Error('offline')):entry.resolve({kind:'provider',quotas:[{balance,balanceUnit:'USD'}]})};
      export const isTauri=false,commands=new Proxy({},{get:()=>async()=>undefined});
      export function invoke(name,args){if(name!=='usage_quota_query')return Promise.resolve(null);window.queries.push(args);return new Promise((resolve,reject)=>window.pending.push({cwd:args.cwd,resolve,reject}))}
    ` }));
  } }],
});
const html = `<!doctype html><body><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  if (req.url !== '/fixture.js') return res.writeHead(404).end();
  res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(join(directory, 'fixture.js')));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage();
page.setDefaultTimeout(4000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const shown = value => page.waitForFunction(value => document.querySelector('output')?.textContent === value, value);
const tab = id => page.evaluate(id => window.setTab(id), id);
const finish = (cwd, balance) => page.evaluate(({ cwd, balance }) => window.finish(window.pending.findIndex(p => p.cwd === cwd), balance), { cwd, balance });
const waiting = cwd => page.waitForFunction(cwd => window.pending.some(p => p.cwd === cwd), cwd);
const queries = cwd => page.evaluate(cwd => window.queries.filter(q => q.cwd === cwd).length, cwd);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  // A key that only reports spending is never labelled as having that balance.
  assert.equal(await page.locator('#left .usage-meter-item').getAttribute('aria-label'), '余额 ¥3.50');
  assert.equal(await page.locator('#left .usage-meter-period').textContent(), '余额');
  assert.equal(await page.locator('#spent .usage-meter-item').getAttribute('aria-label'), '已用 ¥3.50');
  assert.equal(await page.locator('#spent .usage-meter-period').textContent(), '已用');

  await waiting('D:/a');
  await finish('D:/a', 11); await shown('11.00'.replace('.00', ''));

  // A second tab never shows the first tab's numbers, and the first keeps its own.
  await tab('b'); await shown('none'); await waiting('D:/b');
  await finish('D:/b', 22); await shown('22');
  await tab('a'); await shown('11');
  assert.equal(await queries('D:/a'), 1, 'a recent answer is reused instead of asked again');
  await tab('b'); await shown('22');

  // Leaving a tab mid-request still lands its answer when the person comes back.
  await tab('c'); await waiting('D:/c');
  await tab('a'); await shown('11');
  await finish('D:/c', 33);
  await tab('c'); await shown('33');
  assert.equal(await queries('D:/c'), 1);

  // A failed refresh keeps the last numbers.
  await page.evaluate(() => window.refresh());
  await waiting('D:/c');
  await finish('D:/c', null);
  await page.waitForFunction(() => !window.pending.length);
  await shown('33');
  // Clicking the meter still refreshes at once.
  await page.evaluate(() => window.refresh());
  await waiting('D:/c');
  await finish('D:/c', 44); await shown('44');
  assert.deepEqual(errors, []);
  console.log('ok usage meter: per tab memory, no cross-tab numbers, requests survive switching, failed refresh and click refresh');
} catch (error) {
  console.error('Errors:', errors, 'Shown:', await page.locator('output').textContent().catch(() => ''));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await unlink(join(directory, 'fixture.js')).catch(() => {});
  await rmdir(directory);
}
