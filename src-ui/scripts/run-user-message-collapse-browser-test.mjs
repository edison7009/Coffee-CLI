import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-user-collapse-'));
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CollapsibleUserMessage}from'./src/components/center/ConversationControls';import'./src/styles/global.css';import'./src/components/center/ClaudeConversation.css';
const long=Array.from({length:40},(_,i)=>'Requirement line '+(i+1)).join('\\n');
function Row({text,sentAt=0}){const[expanded,setExpanded]=useState(false);return <article className="claude-row claude-row--user"><CollapsibleUserMessage sentAt={sentAt} expanded={expanded} onToggle={()=>setExpanded(old=>!old)}><p style={{margin:0,whiteSpace:'pre-wrap'}}>{text}</p></CollapsibleUserMessage></article>}
function App(){return <div className="panel-center"><div className="claude-scroll" style={{height:520,overflow:'auto',padding:16,fontSize:14,lineHeight:1.65}}><div style={{height:300}}/><Row text="Short message"/><Row text={long}/><Row text="Just sent" sentAt={Date.now()}/><div style={{height:900}}/></div></div>}
createRoot(document.getElementById('root')).render(<App/>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, external: ['/fonts/*', '/monogram.svg'],
  plugins: [{ name: 'language', setup(b) {
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'language', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `export function useAppLanguage(){return 'zh-CN'}` }));
  } }] });
const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css').end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:var(--bg-terminal)"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 560 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const toggle = page.getByRole('button', { name: '显示更多', exact: true }), bodies = page.locator('.claude-user-body');
  await toggle.waitFor();
  const animation = (target, index) => target.locator('.claude-row--user').nth(index).evaluate(el => getComputedStyle(el).animationName);
  assert.equal(await animation(page, 2), 'claude-bubble-enter', 'a message just sent unfolds');
  assert.equal(await animation(page, 0), 'none', 'history stays still');
  assert.equal(await toggle.count(), 1, 'a short message has no control');
  assert.equal((await bodies.nth(1).boundingBox()).height, 200);
  await page.locator('.claude-scroll').evaluate(el => { el.scrollTop = 260; });
  await page.screenshot({ path: join(directory, 'collapsed.png') });
  await toggle.click();
  const collapse = page.getByRole('button', { name: '收起', exact: true });
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
  assert.ok((await bodies.nth(1).boundingBox()).height > 500, 'the full message is shown');
  await collapse.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(directory, 'expanded.png') });
  const before = (await collapse.boundingBox()).y;
  await collapse.click();
  await toggle.waitFor();
  assert.ok(Math.abs((await toggle.boundingBox()).y - before) < 1, 'collapsing keeps the control in place');
  await page.locator('.claude-scroll').evaluate(el => { el.scrollTop = 260; });
  for (const shape of ['soft', 'panel', 'glass', 'carbon', 'monogram']) {
    await page.evaluate(value => { document.documentElement.dataset.shape = value; }, shape);
    assert.equal((await bodies.nth(1).boundingBox()).height, 200, shape);
    assert.notEqual(await bodies.nth(1).evaluate(el => getComputedStyle(el).maskImage), 'none', `${shape} keeps the fade`);
    assert.equal(await toggle.isVisible(), true, shape);
    await page.screenshot({ path: join(directory, `shape-${shape}.png`), clip: { x: 500, y: 0, width: 260, height: 400 } });
  }
  const still = await browser.newPage({ reducedMotion: 'reduce' });
  await still.goto(`http://127.0.0.1:${server.address().port}`);
  await still.locator('.claude-row--user').nth(2).waitFor();
  assert.equal(await animation(still, 2), 'none', 'reduced motion skips the entrance');
  console.log('OK: a sent message unfolds; long user messages collapse, expand and keep the control in place; short messages have no control');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
