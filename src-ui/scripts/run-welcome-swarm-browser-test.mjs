import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-welcome-swarm-'));
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import{createRoot}from'react-dom/client';import{ToolSwarm}from'./src/components/center/ToolSwarm';import{SWARM_TOOLS}from'./src/lib/swarm-tools';
const only=new URLSearchParams(location.search).get('only');const tools=only?only.split(','):SWARM_TOOLS;const active=!location.search.includes('hidden');
createRoot(document.getElementById('root')).render(<>{['dark','light'].map(mode=><div key={mode} data-mode={mode} style={{display:'flex',flexWrap:'wrap',background:mode==='dark'?'#141414':'#fafafa',color:mode==='dark'?'#ececec':'#1f1f1f'}}>{tools.map(t=><div key={t} style={{width:200,height:190,paddingTop:44}}><ToolSwarm tool={t} isActive={active}/></div>)}</div>)}</>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'svg-raw', setup(b) {
    b.onResolve({ filter: /\.svg\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?raw', '')), namespace: 'svg' }));
    b.onLoad({ filter: /.*/, namespace: 'svg' }, async args => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }));
    b.onResolve({ filter: /\.png\?inline$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace('?inline', '')), namespace: 'png' }));
    b.onLoad({ filter: /.*/, namespace: 'png' }, async args => ({ contents: `export default ${JSON.stringify(`data:image/png;base64,${(await readFile(args.path)).toString('base64')}`)}`, loader: 'js' }));
  } }] });
const server = http.createServer(async (req, res) => {
  const name = req.url.split('?')[0].slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css').end(await readFile(join(directory, name)).catch(() => ''));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html><link rel="stylesheet" href="/fixture.css"><body style="margin:0"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
// Mean colour of a canvas's lit pixels, and how many there are.
const ink = canvas => { const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let n = 0, r = 0, g = 0, b = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) { n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; } return { n, r: r / n, g: g / n, b: b / n }; };
try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  const count = await (async () => { const p = await browser.newPage(); await p.goto(url); await p.locator('canvas.tool-swarm').first().waitFor(); const n = await p.locator('canvas.tool-swarm').count(); await p.close(); return n; })();
  assert.ok(count >= 34, `every swarm tool draws in both themes (${count})`);
  // A paused swarm draws the fully formed icon, so its pixels can be checked exactly.
  const still = await browser.newPage({ viewport: { width: 1700, height: 900 }, reducedMotion: 'reduce' });
  await still.goto(url);
  await still.waitForFunction(n => document.querySelectorAll('canvas.tool-swarm').length === n, count);
  await still.waitForFunction(() => [...document.querySelectorAll('canvas.tool-swarm')].every(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }));
  const colours = await still.evaluate(source => { const ink = eval(source); return [...document.querySelectorAll('[data-mode]')].map(row => [row.dataset.mode, [...row.querySelectorAll('canvas')].map(c => ({ tool: c.dataset.tool, paused: c.dataset.paused, ...ink(c) }))]); }, ink.toString());
  for (const [mode, list] of colours) for (const c of list) {
    assert.equal(c.paused, 'true', `${c.tool} pauses for reduced motion`);
    assert.ok(c.n > 400, `${mode} ${c.tool} draws its icon (${c.n} px)`);
  }
  const at = (mode, tool) => colours.find(([m]) => m === mode)[1].find(c => c.tool === tool);
  for (const tool of ['codex', 'opencode', 'cursor', 'grok', 'cline', 'copilot', 'kilo', 'goose', 'codebuddy']) {
    assert.ok(at('dark', tool).r > 180, `${tool} is light on the dark theme`);
    assert.ok(at('light', tool).r < 90, `${tool} turns dark on the light theme`);
  }
  assert.ok(at('dark', 'claude').r > at('dark', 'claude').b + 60, 'Claude keeps its orange');
  assert.ok(at('light', 'dsh').b > at('light', 'dsh').r + 60, 'DeepSeek keeps its blue in both themes');
  for (const mode of ['dark', 'light']) {
    assert.ok(at(mode, 'kiro').b > at(mode, 'kiro').g + 60, `${mode}: Kiro keeps its purple without the plate`);
    assert.ok(at(mode, 'muse').b > at(mode, 'muse').r + 60, `${mode}: Muse keeps its blue`);
    assert.ok(at(mode, 'qwen').b > at(mode, 'qwen').r + 60, `${mode}: Qwen keeps its blue`);
  }
  // Kimi: the K in the text colour, the dot in blue, so its mean sits between the two in each theme.
  assert.ok(at('dark', 'kimicode').r > 150 && at('light', 'kimicode').r < 110, 'Kimi\'s K follows the theme');
  assert.ok(at('dark', 'kimicode').n > 400 && at('light', 'kimicode').n > 400, 'Kimi draws its mark');
  await still.screenshot({ path: join(directory, 'welcome-swarm.png') });
  const live = await browser.newPage({ viewport: { width: 1700, height: 900 } });
  await live.goto(url);
  const swarm = live.locator('canvas.tool-swarm').first();
  await swarm.waitFor();
  assert.equal(await swarm.getAttribute('data-paused'), null, 'an active tab plays the swarm');
  const frames = new Set();
  for (let i = 0; i < 3; i++) { await live.waitForTimeout(300); frames.add(await swarm.evaluate(c => c.toDataURL())); }
  assert.ok(frames.size > 1, 'the swarm moves');
  const hidden = await browser.newPage();
  await hidden.goto(`${url}?hidden`);
  await hidden.locator('canvas.tool-swarm').first().waitFor();
  assert.equal(await hidden.locator('canvas.tool-swarm[data-paused="true"]').count(), count, 'an inactive tab keeps the swarm still');
  console.log('OK: every tool swarm forms its icon, follows light and dark, animates, and pauses for reduced motion and inactive tabs');
  const acp = await browser.newPage({ viewport: { width: 1200, height: 940 }, reducedMotion: 'reduce' });
  await acp.goto(`${url}?only=antigravity,cursor,kiro,muse,goose,kilo,kimicode,grok,cline,codebuddy,copilot,qwen`);
  await acp.waitForTimeout(800);
  await acp.screenshot({ path: join(directory, 'welcome-swarm-acp.png') });
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
