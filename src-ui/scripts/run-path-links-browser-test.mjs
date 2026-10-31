// File paths in rendered conversation text: right-click actions, reveal on click, and code block spacing.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-path-links-'));
const content = ['Built it:', '', '```', 'D:\\Coffee-CLI\\target\\nsis\\Coffee CLI_3.8.1_x64-setup.exe', '```', '', '- **File**: 17 MiB', '- Plain words here', '- Inline `src/app.ts` and `npm run build`', '', 'Details are in D:\\Repo\\notes.md today.'].join('\n');
await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import React,{useRef} from 'react';import {createRoot} from 'react-dom/client';
    import {MarkdownContent} from './src/components/center/MarkdownContent';
    import {ConversationDirectory} from './src/lib/conversation-links';
    import {useConversationMenu} from './src/lib/use-conversation-menu';
    import './src/components/center/ClaudeConversation.css';import './src/components/center/TierTerminal.css';
    function Fixture(){const surface=useRef(null),menu=useConversationMenu(surface,'a',true);
      return <ConversationDirectory.Provider value="D:/Repo"><div ref={surface} onContextMenu={menu.onContextMenu} className="claude-row"><MarkdownContent content={${JSON.stringify(content)}}/>{menu.menu}</div></ConversationDirectory.Provider>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', nodePaths: [join(project, 'node_modules')],
  external: ['/fonts/*'], define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'native-boundary', setup(b) {
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/shiki$/ }, () => ({ path: 'syntax', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)clipboard$/ }, () => ({ path: 'clipboard', namespace: 'fixture' }));
    b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: project, loader: 'js', contents: args.path === 'store' ? `
      export function useAppLanguage(){return 'en'};export function useAppState(){return {state:{terminals:[{id:'a',folderPath:'D:/Repo'}]},dispatch(){}}};
    ` : args.path === 'syntax' ? `
      export async function tokenizeFile(){return null};export async function tokenizeByLang(){return null};export function getShikiTheme(){return 'dark'};
    ` : args.path === 'clipboard' ? `
      export async function clipboardWrite(text){window.copied=text};export async function clipboardRead(){return ''};
    ` : `
      window.native=[];export const isTauri=false,commands=new Proxy({},{get:(_,name)=>async(...args)=>{window.native.push([name,...args])}});export async function invoke(){return null};
    ` }));
  } }],
});
const html = `<!doctype html><link rel="stylesheet" href="/fixture.css"><style>body{margin:24px;font:16px/1.6 Arial}:root{--border:#888;--bg-hover:#eee;--accent:#369}</style><body><div id="root"></div><script src="/fixture.js"></script>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end(html);
  const name = req.url.slice(1);
  if (!['fixture.js', 'fixture.css'].includes(name)) return res.writeHead(404).end();
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(join(directory, name)));
});
await new Promise(accept => server.listen(0, '127.0.0.1', accept));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.setDefaultTimeout(4000);
const errors = []; page.on('pageerror', error => errors.push(error.message));
const items = () => page.locator('.term-ctx-item').allInnerTexts();
const native = () => page.evaluate(() => window.native);
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.md-code').waitFor();

  // A path inside a code block has no link, yet offers the file actions, spaces included.
  await page.locator('.md-code').click({ button: 'right', position: { x: 300, y: 18 } });
  await page.locator('.term-ctx-menu').waitFor();
  const offered = await items();
  assert.ok(offered.includes('Reveal in File Explorer') && offered.includes('Copy path') && !offered.includes('Open link or file'), offered.join('|'));
  await page.getByText('Reveal in File Explorer').click();
  assert.deepEqual(await native(), [['showInFolder', 'D:/Coffee-CLI/target/nsis/Coffee CLI_3.8.1_x64-setup.exe']]);

  // Hovering a path in a code block or paragraph marks exactly that path and shows a hand; other text does not.
  const hovered = () => page.evaluate(() => { const set = CSS.highlights.get('conversation-path'); return set ? [...set].map(range => range.toString()).join('') : ''; });
  const cursor = () => page.evaluate(() => document.querySelector('.claude-row').style.cursor);
  await page.locator('.md-code').hover({ position: { x: 300, y: 18 } });
  await page.waitForFunction(() => CSS.highlights.has('conversation-path'));
  assert.equal(await hovered(), 'D:\\Coffee-CLI\\target\\nsis\\Coffee CLI_3.8.1_x64-setup.exe');
  assert.equal(await cursor(), 'pointer');
  await page.getByText('Plain words here').hover();
  await page.waitForFunction(() => !CSS.highlights.has('conversation-path'));
  assert.equal(await cursor(), '');
  await page.getByText('Details are in').hover({ position: { x: 180, y: 8 } });
  await page.waitForFunction(() => CSS.highlights.has('conversation-path'));
  assert.equal(await hovered(), 'D:\\Repo\\notes.md');
  await page.mouse.move(600, 500);
  await page.waitForFunction(() => !CSS.highlights.has('conversation-path'));

  // Clicking reveals; a drag that selects text does not.
  await page.evaluate(() => { window.native.length = 0; });
  await page.locator('.md-code').click({ position: { x: 300, y: 18 } });
  assert.deepEqual(await native(), [['showInFolder', 'D:/Coffee-CLI/target/nsis/Coffee CLI_3.8.1_x64-setup.exe']]);
  await page.evaluate(() => { window.native.length = 0; });
  const code = await page.locator('.md-code').boundingBox();
  await page.mouse.move(code.x + 120, code.y + 18); await page.mouse.down(); await page.mouse.move(code.x + 320, code.y + 18); await page.mouse.up();
  assert.deepEqual(await native(), [], 'a selection is not a click');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  if (process.env.COFFEE_PATH_SCREENSHOT) { await page.locator('.md-code').hover({ position: { x: 300, y: 18 } }); await page.waitForFunction(() => CSS.highlights.has('conversation-path')); await page.screenshot({ path: process.env.COFFEE_PATH_SCREENSHOT }); }

  // Copy path gives the same target, and the same words in a paragraph work too.
  await page.getByText('Details are in').click({ button: 'right', position: { x: 180, y: 8 } });
  await page.getByText('Copy path').click();
  assert.equal(await page.evaluate(() => window.copied), 'D:/Repo/notes.md');

  // Ordinary text offers only the usual items; a selection still enables Copy.
  await page.getByText('Plain words here').click({ button: 'right' });
  await page.locator('.term-ctx-menu').waitFor();
  assert.equal((await items()).includes('Copy path'), false);
  assert.equal(await page.locator('.term-ctx-item.disabled').count(), 1, 'Copy waits for a selection');
  await page.keyboard.press('Escape');
  await page.getByText('Plain words here').dblclick();
  await page.getByText('Plain words here').click({ button: 'right' });
  assert.equal(await page.locator('.term-ctx-item.disabled').count(), 0, 'a selection enables Copy');
  await page.keyboard.press('Escape');

  // Inline paths reveal on click and never run; commands stay plain code.
  await page.evaluate(() => { window.native.length = 0; });
  await page.getByRole('link', { name: 'src/app.ts' }).click();
  assert.deepEqual(await native(), [['showInFolder', 'D:/Repo/src/app.ts']]);
  assert.equal(await page.getByRole('link', { name: 'npm run build' }).count(), 0);

  // The block keeps clear of the list under it.
  const gap = await page.evaluate(() => { const code = document.querySelector('.md-code').getBoundingClientRect(), list = document.querySelector('.md-body ul').getBoundingClientRect(); return list.top - code.bottom; });
  assert.ok(gap >= 12, `gap under the code block is ${gap}px`);
  assert.deepEqual(errors, []);
  console.log('ok path links: code blocks, paragraphs, spaces, reveal on click, selection copy and block spacing');
} catch (error) {
  console.error('Browser errors:', errors, 'Menu:', await items().catch(() => []), 'Native:', await native().catch(() => []));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  for (const name of ['fixture.js', 'fixture.css']) await unlink(join(directory, name)).catch(() => {});
  await rmdir(directory);
}
