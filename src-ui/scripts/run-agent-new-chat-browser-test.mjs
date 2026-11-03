import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-agent-new-chat-'));
const fixtures = {
  'store/app-state': `export function useAppState(){return{state:{agentPageActive:'agent',leftPanelHidden:false,rightPanelHidden:false},dispatch(){}}} export function useAppLanguage(){return 'zh-CN'}`,
  'tauri': `export const commands={}; export const isTauri=true; export async function invoke(){return null}`,
  '/clipboard': `export async function clipboardRead(){return ''} export async function clipboardWrite(){}`,
  'lib/agent-client': `import{useSyncExternalStore}from'react';
    const listeners=new Set();
    window.setAgent=next=>{window.agent={...window.agent,...next};listeners.forEach(listener=>listener());};
    export const useAgentClient=()=>useSyncExternalStore(listener=>{listeners.add(listener);return()=>listeners.delete(listener)},()=>window.agent);
    export async function startNewAgentConversation(){window.started=(window.started||0)+1;window.setAgent({conversationId:'fresh',messages:[]});}
    export const formatAgentError=e=>e; export const formatAgentActivity=()=>''; export const formatAgentMessage=text=>text;
    export const loadOlderAgentMessages=async()=>{}; export const refreshChannels=async()=>{}; export const sendAgentMessage=async()=>{};`,
  'center/Gambit': 'export const Gambit=()=>null;',
  'center/MarkdownContent': `import{jsx}from'react/jsx-runtime'; export const MarkdownContent=({content})=>jsx('p',{children:content});`,
};
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React from'react';import{createRoot}from'react-dom/client';import{AgentChatPage}from'./src/components/agent/AgentPages';import'./src/styles/global.css';
window.agent={conversationId:'desktop',messages:[],hasOlder:false,loadingOlder:false,running:false,activity:'',error:''};
createRoot(document.getElementById('root')).render(<div style={{height:520}}><AgentChatPage/></div>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.webp': 'dataurl' }, external: ['/fonts/*', '/monogram.svg'],
  plugins: [{ name: 'agent-chat-fixtures', setup(b) {
    b.onLoad({ filter: /[/\\]AgentPages\.tsx$/ }, async args => ({ loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { AgentChatPage };` }));
    b.onResolve({ filter: new RegExp(`(?:${Object.keys(fixtures).map(name => name.replace('/', '\\/')).join('|')})$`) }, args => ({ path: Object.keys(fixtures).find(name => args.path.endsWith(name)), namespace: 'fixture', pluginData: args.resolveDir }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: fixtures[args.path], resolveDir: project }));
  } }] });
const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', `${name.endsWith('.js') ? 'text/javascript' : 'text/css'}; charset=utf-8`).end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:var(--bg-terminal)"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const button = page.getByRole('button', { name: '新对话', exact: true });
  await page.locator('.agent-welcome').waitFor();
  assert.equal(await button.count(), 0, 'an empty conversation is already new');

  await page.evaluate(() => window.setAgent({ messages: [{ id: 1, role: 'user', text: '看看现在打开了哪些终端' }, { id: 2, role: 'assistant', text: '现在打开了 3 个终端。' }] }));
  await button.waitFor();
  const [box, thread] = await Promise.all([button.boundingBox(), page.locator('.agent-message-list').boundingBox()]);
  assert.ok(box.x + box.width > 900 - 40 && box.y < 30, `New chat sits in the top-right corner: ${JSON.stringify(box)}`);
  assert.ok(box.x >= thread.x + thread.width || box.y + box.height <= thread.y, 'New chat never covers message text');
  await page.screenshot({ path: join(directory, 'new-chat.png') });

  await page.evaluate(() => window.setAgent({ running: true }));
  assert.equal(await button.isDisabled(), true, 'a running reply cannot be abandoned by starting a new chat');
  await page.evaluate(() => window.setAgent({ running: false }));
  await button.click();
  await page.locator('.agent-welcome').waitFor();
  assert.equal(await page.evaluate(() => window.started), 1);
  assert.equal(await button.count(), 0, 'the fresh chat shows the welcome view without the button');
  assert.deepEqual(errors, []);
  console.log('OK: Coffee Agent New chat appears only with messages, sits top-right clear of the text, waits for a running reply and opens a fresh chat');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
