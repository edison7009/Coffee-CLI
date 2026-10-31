// Real configuration modal and shared dropdown; configuration I/O is isolated.
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import {useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ToolConfigModal} from './src/components/center/ToolConfigModal';
    import './src/styles/global.css';import './src/components/center/CenterPanel.css';
    function Fixture(){const [tool,setTool]=useState(null);window.openTool=key=>setTool({key,id:crypto.randomUUID()});return tool&&<ToolConfigModal key={tool.id} toolKey={tool.key} toolLabel={tool.key} onClose={()=>setTool(null)}/>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, write: false, outfile: 'fixture.js', jsx: 'automatic', external: ['/fonts/*', '/monogram.svg'],
  plugins: [{ name: 'isolated-config', setup(builder) {
    builder.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'language', namespace: 'fixture' }));
    builder.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'config', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'language' ? `
      export function useAppLanguage(){return 'en'}
    ` : `
      window.entries={};window.writes=[];
      const empty={command:'',extra_args:[],default_cwd:'',history_path:''};
      export const commands={async getToolConfig(tool){return structuredClone(window.entries[tool]??empty)},async setToolConfig(tool,entry){window.writes.push({tool,entry:structuredClone(entry)});window.entries[tool]=structuredClone(entry)}};
    ` }));
  } }],
});
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js', file.contents]));
const server = http.createServer((req, res) => {
  if (files[req.url]) return res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript').end(files[req.url]);
  if (req.url !== '/') return res.writeHead(404).end();
  res.setHeader('Content-Type', 'text/html').end('<!doctype html><html data-mode="dark" data-theme="obsidian" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(() => window.openTool);
  for (const tool of ['claude', 'codex', 'opencode']) {
    const open = async () => { await page.evaluate(tool => window.openTool(tool), tool);await page.locator('.tool-config-body').waitFor(); };
    await open();
    const command = page.getByLabel('Launch command', { exact: true });
    const trigger = page.getByRole('combobox', { name: 'Command presets', exact: true });
    const expected = tool === 'claude' ? [
      ['claude', 'claude'], ['Plan', 'claude --permission-mode plan'],
      ['Edit automatically', 'claude --permission-mode acceptEdits'], ['Bypass permissions', 'claude --dangerously-skip-permissions'],
    ] : tool === 'opencode' ? [
      ['opencode', 'opencode'], ['Bypass permissions', 'opencode --auto'],
    ] : [
      ['codex', 'codex'], ['Read only', 'codex -c sandbox_mode=read-only -c approval_policy=on-request'],
      ['Workspace', 'codex -c sandbox_mode=workspace-write -c approval_policy=on-request'], ['Full access', 'codex -c sandbox_mode=danger-full-access -c approval_policy=never'],
    ];
    assert.equal(await command.inputValue(), tool);
    const initialWrites = await page.evaluate(() => window.writes.length);
    await page.getByLabel(/^Extra arguments/).fill('--model\ntest-model');
    await page.getByLabel('Launch directory', { exact: true }).fill('D:/Keep');
    await page.getByLabel('Session history directory', { exact: true }).fill('D:/History');
    for (const [label, value] of expected) {
      await trigger.click();const menu = page.getByRole('listbox', { name: 'Command presets', exact: true });
      const bounds = await menu.boundingBox();assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 900 && bounds.y >= 0 && bounds.y + bounds.height <= 680, 'menu stays inside the viewport');
      const anchor = await trigger.boundingBox();assert.ok(Math.abs(bounds.x + bounds.width - anchor.x - anchor.width) < 1, 'preset menu aligns with the right edge of its trigger');
      await menu.getByRole('option', { name: label, exact: true }).click();
      assert.equal(await command.inputValue(), value);assert.equal(await menu.count(), 0);
      assert.equal(await page.locator('.tool-config-modal').count(), 1, 'selecting a preset keeps the modal open');
      assert.equal(await page.evaluate(() => window.writes.length), initialWrites, 'selection never saves automatically');
    }
    assert.equal(await page.getByLabel(/^Extra arguments/).inputValue(), '--model\ntest-model');
    assert.equal(await page.getByLabel('Launch directory', { exact: true }).inputValue(), 'D:/Keep');
    assert.equal(await page.getByLabel('Session history directory', { exact: true }).inputValue(), 'D:/History');
    await trigger.focus();await trigger.press('ArrowDown');await trigger.press('Home');await trigger.press('Enter');
    assert.equal(await command.inputValue(), tool, 'keyboard navigation selects the default command');
    await command.fill('/custom/wrapper --custom-flag');await trigger.click();await trigger.press('Escape');
    assert.equal(await command.inputValue(), '/custom/wrapper --custom-flag', 'Escape preserves custom input');
    await trigger.click();await page.mouse.click(5, 5);
    assert.equal(await page.getByRole('listbox').count(), 0);assert.equal(await page.locator('.tool-config-modal').count(), 1, 'outside click dismisses only the dropdown');
    await page.getByRole('button', { name: 'Save', exact: true }).click();await page.locator('.tool-config-modal').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.writes.at(-1)), {tool,entry:{command:'/custom/wrapper --custom-flag',extra_args:['--model','test-model'],default_cwd:'D:/Keep',history_path:'D:/History'}});
    await open();assert.equal(await command.inputValue(), '/custom/wrapper --custom-flag', 'saved custom command is restored');
    await trigger.click();await page.getByRole('option', { name: tool === 'claude' ? 'Plan' : tool === 'opencode' ? 'Bypass permissions' : 'Read only', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();await open();
    assert.equal(await command.inputValue(), '/custom/wrapper --custom-flag', 'cancel does not persist a selected preset');
    await page.getByRole('button', { name: 'Reset', exact: true }).click();await page.waitForFunction(tool => document.querySelector('#tool-launch-command')?.value === tool, tool);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    console.log(`ok ${tool}: presets, keyboard, viewport, custom editing, other fields preserved, save, restore, cancel and reset`);
  }
  await page.evaluate(() => window.openTool('kilo'));await page.locator('.tool-config-body').waitFor();
  assert.equal(await page.getByRole('combobox').count(), 0, 'other tools keep their existing editable launch command');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
