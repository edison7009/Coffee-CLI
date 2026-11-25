// A tool that isn't installed offers 安装, which sends you to EchoBird (components/center/InstallChip.tsx).
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-install-chip-'));
const mock = `export const commands={async openUrl(url){window.opened.push(url)}};export const isTauri=false;
  export function useAppLanguage(){return 'zh-CN'}`;
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `import{createRoot}from'react-dom/client';import{InstallChip}from'./src/components/center/InstallChip';
    window.opened=[];window.launched=0;
    createRoot(document.getElementById('root')).render(<div className="launchpad-card" onClick={()=>window.launched++}><InstallChip tool="OpenCode"/></div>);` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'boundaries', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)(?:tauri|store\/app-state)$/ }, () => ({ path: 'mock', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: mock, resolveDir: project, loader: 'js' }));
  } }],
});
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
  if (req.url === '/fixture.js') return res.setHeader('Content-Type', 'text/javascript').end(await readFile(join(directory, 'fixture.js')));
  res.writeHead(404).end();
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const chip = page.getByRole('button', { name: '安装 OpenCode' });
  await chip.hover();
  await page.getByRole('tooltip').getByText('还没安装 OpenCode', { exact: false }).waitFor();
  await chip.click();
  assert.deepEqual(await page.evaluate(() => window.opened), ['https://echobird.ai/'], 'it opens EchoBird');
  assert.equal(await page.evaluate(() => window.launched), 0, 'the card behind it does not start the tool');
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'the click leaves no focus to bring the tip back');
  await page.mouse.move(400, 400);
  assert.equal(await page.getByRole('tooltip').count(), 0, 'the tip goes with the pointer');
  assert.deepEqual(errors, []);
  console.log('OK: 安装 names its tool, explains why EchoBird, opens it and never starts the card');
} finally { await browser.close(); server.close(); }
