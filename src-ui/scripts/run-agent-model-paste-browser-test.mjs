import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-agent-paste-'));
const fixtures = {
  'store/app-state': `export function useAppState(){return{state:{agentPageActive:'config'}}} export function useAppLanguage(){return 'zh-CN'}`,
  'tauri': `export const commands={}; export const isTauri=true; export async function invoke(name,args){window.invokes.push([name,args]); if(name==='agent_save_model')window.stored=args.config; if(name==='agent_get_model')return{...window.stored}; return null}`,
  '/clipboard': `export async function clipboardRead(){return window.clipboardText} export async function clipboardWrite(text){window.copiedText=text}`,
  'lib/agent-client': `export const formatAgentError=e=>e; export const formatAgentActivity=()=>''; export const formatAgentMessage=()=>''; export const loadOlderAgentMessages=async()=>{}; export const refreshChannels=async()=>{}; export const sendAgentMessage=async()=>{}; export const startNewAgentConversation=async()=>{}; export const useAgentClient=()=>({})`,
  'center/Gambit': 'export const Gambit=()=>null;',
  'center/MarkdownContent': 'export const MarkdownContent=()=>null;',
};
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React from'react';import{createRoot}from'react-dom/client';import{AgentModelSection}from'./src/components/agent/AgentPages';import'./src/styles/global.css';import'./src/components/center/TierTerminal.css';
window.invokes=[];window.clipboardText='';window.stored={provider:'openai',baseUrl:'https://api.openai.com/v1',model:'',apiKey:'sk-saved-plain'};
createRoot(document.getElementById('root')).render(<div className="agent-page-config"><div className="agent-settings-content" style={{width:720,padding:20}}><AgentModelSection/></div></div>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
  plugins: [{ name: 'agent-model-fixtures', setup(b) {
    b.onLoad({ filter: /[/\\]AgentPages\.tsx$/ }, async args => ({ loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { AgentModelSection };` }));
    b.onResolve({ filter: new RegExp(`(?:${Object.keys(fixtures).map(name => name.replace('/', '\\/')).join('|')})$`) }, args => ({ path: Object.keys(fixtures).find(name => args.path.endsWith(name)), namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: fixtures[args.path] }));
  } }] });
const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css').end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:var(--bg-terminal)"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 360 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const url = page.getByLabel('服务地址', { exact: true }), model = page.getByLabel('模型 ID', { exact: true }), key = page.getByLabel('API 密钥', { exact: true });
  const pasteButton = name => page.getByRole('button', { name: `粘贴 ${name}`, exact: true });
  await page.waitForFunction(() => !document.querySelector('fieldset').disabled);
  const menuItem = name => page.locator('.term-ctx-menu').getByRole('button', { name: new RegExp(`^${name}`) });
  const setClipboard = text => page.evaluate(value => { window.clipboardText = value; }, text);
  const pasteButtonsSitInsideFields = async minimum => {
    for (const [field, name] of [[url, '服务地址'], [model, '模型 ID'], [key, 'API 密钥']]) {
      const [input, button] = await Promise.all([field.boundingBox(), pasteButton(name).boundingBox()]);
      assert.ok(input.width > minimum, `${name} stays usable: ${input.width}`);
      assert.ok(button.x > input.x + input.width / 2 && button.x + button.width <= input.x + input.width - 2
        && button.y >= input.y && button.y + button.height <= input.y + input.height, `${name} paste sits inside the right edge of its field`);
      const padding = await field.evaluate(el => parseFloat(getComputedStyle(el).paddingInlineEnd));
      assert.ok(padding >= button.width, `${name} text never runs under the paste button`);
    }
  };

  // The saved API key is ordinary visible text.
  assert.equal(await key.getAttribute('type'), null);
  assert.equal(await key.inputValue(), 'sk-saved-plain');

  // Each field pastes from a button inside its right edge, replacing the value and trimming newlines.
  await setClipboard('  https://example.test/v1\n');
  await pasteButton('服务地址').click();
  assert.equal(await url.inputValue(), 'https://example.test/v1');
  await setClipboard('gpt-test\n');
  await pasteButton('模型 ID').click();
  assert.equal(await model.inputValue(), 'gpt-test');
  await setClipboard('sk-test-key\n');
  await pasteButton('API 密钥').click();
  assert.equal(await key.inputValue(), 'sk-test-key');
  await setClipboard('');
  await pasteButton('模型 ID').click();
  assert.equal(await model.inputValue(), 'gpt-test', 'an empty clipboard keeps the field');
  await pasteButtonsSitInsideFields(200);
  await page.screenshot({ path: join(directory, 'filled.png') });

  // Right-click offers the shared text menu: copy a selection, paste at the caret, cut.
  await model.evaluate(el => { el.focus(); el.setSelectionRange(0, 3); });
  await model.click({ button: 'right', position: { x: 16, y: 17 } });
  await menuItem('复制').dispatchEvent('mousedown');
  assert.equal(await page.evaluate(() => window.copiedText), 'gpt');
  await setClipboard('-mini');
  await model.click({ button: 'right', position: { x: 160, y: 17 } });
  await menuItem('粘贴').dispatchEvent('mousedown');
  await page.waitForFunction(() => document.querySelector('input[aria-label="模型 ID"]').value === 'gpt-test-mini');
  await url.evaluate(el => { el.focus(); el.select(); });
  await url.click({ button: 'right', position: { x: 16, y: 17 } });
  await menuItem('剪切').dispatchEvent('mousedown');
  assert.equal(await page.evaluate(() => window.copiedText), 'https://example.test/v1');
  assert.equal(await url.inputValue(), '');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
  await key.evaluate(el => { el.focus(); el.select(); });
  await key.click({ button: 'right', position: { x: 16, y: 17 } });
  await page.screenshot({ path: join(directory, 'key-menu.png') });
  await menuItem('复制').dispatchEvent('mousedown');
  assert.equal(await page.evaluate(() => window.copiedText), 'sk-test-key', 'the plain API key can be copied like any text');

  // Pasted values are what gets saved, and the key is saved as plain text.
  await setClipboard('https://example.test/v1');
  await pasteButton('服务地址').click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.waitForFunction(() => window.invokes.some(([name]) => name === 'agent_save_model'));
  assert.deepEqual(await page.evaluate(() => window.invokes.findLast(([name]) => name === 'agent_save_model')[1]), { config: { provider: 'openai', baseUrl: 'https://example.test/v1', model: 'gpt-test-mini', apiKey: 'sk-test-key' } });

  // An empty key is a valid setting and stays empty after saving.
  await key.fill('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('模型配置已保存').waitFor();
  assert.equal(await page.evaluate(() => window.invokes.findLast(([name]) => name === 'agent_save_model')[1].config.apiKey), '');
  assert.equal(await key.inputValue(), '');
  assert.equal(await key.getAttribute('placeholder'), 'API 密钥（可留空）');

  // The narrow single-column layout keeps every button inside its field.
  await page.setViewportSize({ width: 420, height: 420 });
  await page.evaluate(() => { document.querySelector('.agent-settings-content').style.width = '380px'; });
  await pasteButtonsSitInsideFields(200);
  await page.screenshot({ path: join(directory, 'narrow.png') });
  console.log('OK: Coffee Agent model fields paste from buttons inside the fields, use the shared right-click menu, and keep the API key as optional plain text');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
