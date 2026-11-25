// The two-column ThemedSelect (usage page tool filter): icons, a wide first row, a group on its own row, and
// keyboard moves that keep the column. No native boundary is involved.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-themed-select-'));
await build({ stdin: { resolveDir: project, loader: 'tsx', contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ThemedSelect}from'./src/components/common/ThemedSelect';
const icon=id=><i data-icon={id} style={{display:'inline-block',width:'1em',height:'1em',background:'currentColor'}}/>;
const options=[{value:'',label:'全部工具',wide:true},...['claude','dsh','codex','opencode','pi'].map(v=>({value:v,label:v,icon:icon(v)})),
  ...['antigravity','cursor','kiro','muse'].map((v,i)=>({value:v,label:v,icon:icon(v),group:i===0}))];
function App(){const[value,setValue]=useState('');window.value=()=>value;return <ThemedSelect label="工具" value={value} onChange={setValue} options={options} columns={2} menuWidth={400}/>}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')] });
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end(`<!doctype html><html data-mode="dark"><style>:root{--accent:#c595a5;--bg-hover:#393236;--border:#444;--text-1:#e5dce1}</style><link rel="stylesheet" href="/fixture.css"><div id="root" style="padding:20px"></div><script src="/fixture.js"></script></html>`);
  if (req.url === '/fixture.css') return res.setHeader('Content-Type', 'text/css').end(await readFile(join(directory, 'fixture.css')));
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 700 } }); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const trigger = page.getByRole('combobox', { name: '工具' });
  await trigger.click();
  const boxes = await page.getByRole('option').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { label: el.textContent, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), icon: !!el.querySelector('[data-icon]') }; }));
  const at = label => boxes.find(b => b.label === label);
  assert.ok(at('全部工具').w > at('claude').w * 1.8, 'the all-tools row spans both columns');
  assert.equal(at('claude').y, at('dsh').y, 'tools sit two to a row');
  assert.ok(at('dsh').x > at('claude').x, 'the second of a row is to the right');
  assert.ok(at('antigravity').y > at('pi').y && at('antigravity').x === at('claude').x, 'a new group starts its own row in the first column');
  assert.equal(await page.locator('.themed-select-divider').count(), 1, 'one divider above the group');
  assert.ok(boxes.filter(b => b.label !== '全部工具').every(b => b.icon), 'every tool shows its icon');
  // Down from the wide row lands on the first column; right moves along; down keeps the column.
  await trigger.press('ArrowDown'); await trigger.press('ArrowRight'); await trigger.press('ArrowDown');
  assert.equal(await page.locator('.is-highlighted').textContent(), 'opencode', 'down keeps the second column');
  await trigger.press('ArrowDown');
  assert.equal(await page.locator('.is-highlighted').textContent(), 'pi', 'a short row takes its nearest option');
  await trigger.press('ArrowDown');
  assert.equal(await page.locator('.is-highlighted').textContent(), 'antigravity', 'down crosses the divider');
  await trigger.press('ArrowRight'); await trigger.press('Enter');
  assert.equal(await page.evaluate(() => window.value()), 'cursor');
  assert.deepEqual(errors, []);
  console.log('themed select grid browser test passed');
} finally { await browser.close(); server.close(); }
