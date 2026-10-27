// Isolated dev server exercises the real app, menus, session stores and views.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
const directory=await mkdtemp(join(tmpdir(),'coffee-directory-defense-'));
const devServer=await createServer({cacheDir:join(directory,'vite-cache'),logLevel:'error',server:{host:'127.0.0.1',port:0}});
await devServer.listen();
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });

async function prepare(recent, statuses = {}, realViews = false) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (!realViews) await page.route(/\/src\/components\/center\/(TierTerminal|ClaudeConversation|CodexConversation)\.tsx/, route => {
    const name = route.request().url().match(/\/([A-Za-z]+)\.tsx/)[1];
    return route.fulfill({ contentType: 'text/javascript', body: `export function ${name}(){return null} export const TERM_COLOR_SCHEMES=[];` });
  });
  await page.route(/@tauri-apps_plugin-dialog/, route => route.fulfill({ contentType: 'text/javascript', body: 'export async function open(){window.pickCount=(window.pickCount??0)+1;return null}' }));
  await page.route(/@tauri-apps_api_event/, route => route.fulfill({ contentType: 'text/javascript', body: 'export async function listen(){return ()=>{}} export async function emit(){}' }));
  await page.route(/\/src\/tauri\.ts(?:\?|$)/, async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace('async function invoke(cmd, args) {', `async function invoke(cmd, args) {
      if(cmd==='check_project_directories') return window.checkDirectories(args.paths);
      if(cmd.endsWith('_session_start')) {window.startCount=(window.startCount??0)+1;throw window.startupFailure;}
      if(cmd.endsWith('_session_close')) return;
    `);
    assert.notEqual(body, source, 'native transport fixture must be installed');
    await route.fulfill({ response, body });
  });
  await page.addInitScript(({ recent, statuses }) => {
    localStorage.setItem('cc-lang', 'en'); localStorage.setItem('cc-tasks-seeded', '1');
    localStorage.setItem('coffee_pinned_items', JSON.stringify(['agent:claude', 'agent:codex']));
    localStorage.setItem('coffee:recent-folders', JSON.stringify(recent));
    localStorage.setItem('coffee:claude-launch-mode', 'conversation'); localStorage.setItem('coffee:codex-launch-mode', 'conversation');
    window.directoryStatuses = statuses;
    window.checkDirectories = async paths => {
      if (window.holdChecks) await new Promise(resolve => { window.finishCheck = resolve; });
      return paths.map(path => ({ path, status: window.directoryStatuses[path] ?? 'available' }));
    };
  }, { recent, statuses });
  await page.goto(devServer.resolvedUrls.local[0]);
  await page.locator('.launchpad-mode-tabs').first().waitFor();
  return { page, errors };
}
const names = page => page.locator('.folder-menu-item:not(.folder-menu-open) .folder-menu-name').allTextContents();
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('coffee:recent-folders')));
const app = (page, action) => page.evaluate(action => {
  const root = document.getElementById('root'), fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))];
  function walk(f) {
    if (!f) return;
    const value = f.memoizedProps?.value;
    if (value?.state?.terminals && typeof value.dispatch === 'function') return value;
    return walk(f.child) || walk(f.sibling);
  }
  const context = walk(fiber.stateNode.current);
  if (action) context.dispatch(action);
  return context.state.terminals.find(t => t.id === context.state.activeTerminalId);
}, action);
const card = (page, tool) => page.getByRole('group', { name: `${tool} launch mode` }).locator('..');

try {
  let { page, errors } = await prepare(['D:/Gone', 'D:/File', 'D:/Offline', 'D:/Valid'], { 'D:/Gone': 'missing', 'D:/File': 'not_directory', 'D:/Offline': 'unavailable' });
  await card(page, 'Claude').locator('.launchpad-card-info').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('coffee:recent-folders')).length === 2);
  assert.deepEqual(await names(page), ['Offline', 'Valid']); assert.deepEqual(await saved(page), ['D:/Offline', 'D:/Valid']);
  await page.getByText('Valid', { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.launchpad-mode-tabs'));
  assert.equal((await app(page)).folderPath, 'D:/Valid'); assert.equal((await app(page)).tool, 'claude');
  assert.deepEqual(await saved(page), ['D:/Valid', 'D:/Offline']); assert.deepEqual(errors, []); await page.close();

  ({ page, errors } = await prepare(['D:/Race', 'D:/Valid']));
  await card(page, 'Codex').locator('.launchpad-card-info').click(); await page.locator('.folder-menu').waitFor();
  await page.evaluate(() => { window.directoryStatuses['D:/Race'] = 'missing'; });
  await page.getByText('Race', { exact: true }).click(); await page.waitForFunction(() => window.pickCount === 1);
  assert.equal((await app(page)).tool, null, 'deleted after opening the menu: do not launch');
  assert.deepEqual(await saved(page), ['D:/Valid']); assert.deepEqual(errors, []); await page.close();

  ({ page, errors } = await prepare(['D:/Valid']));
  await card(page, 'Claude').locator('.launchpad-card-info').click(); await page.locator('.folder-menu').waitFor();
  await page.evaluate(() => { window.holdChecks = true; });
  await page.getByText('Valid', { exact: true }).click(); await page.waitForFunction(() => !!window.finishCheck);
  await app(page, { type: 'ADD_TERMINAL', session: { id: 'new-tab', tool: null } });
  for (let i = 0; i < 20 && (await app(page)).id !== 'new-tab'; i++) await page.waitForTimeout(10);
  assert.equal((await app(page)).id, 'new-tab', 'tab switch has rendered before the check resolves');
  await page.evaluate(() => window.finishCheck()); await page.waitForTimeout(50);
  assert.equal((await app(page)).id, 'new-tab'); assert.equal((await app(page)).tool, null, 'late check cannot launch into another tab');
  assert.deepEqual(errors, []); await page.close();

  for (const tool of ['Claude', 'Codex']) for (const status of ['missing', 'unavailable']) {
    ({ page, errors } = await prepare(['D:/Valid'], {}, true));
    await page.evaluate(status => { window.startupFailure = `COFFEE_DIRECTORY:${status}:D:/Valid`; }, status);
    await card(page, tool).locator('.launchpad-card-info').click(); await page.getByText('Valid', { exact: true }).click();
    await page.getByRole('alert').filter({ hasText: status === 'missing' ? 'project directory no longer exists' : 'project directory is unavailable' }).waitFor();
    assert.equal(await page.locator('.claude-reconnect').count(), status === 'unavailable' ? 1 : 0); assert.equal(await page.locator('.claude-empty').count(), 0);
    assert.equal(await page.evaluate(() => window.startCount), 1); assert.equal((await app(page)).folderPath, 'D:/Valid');
    assert.deepEqual(errors, []); await page.close();
  }
  console.log('OK deleted recents pruned, unavailable recents retained, launch-time deletion and tab-switch races blocked; both desktop views explain directory errors and allow manual reconnect only for unavailable paths');
} finally { await browser.close();await devServer.close(); }
