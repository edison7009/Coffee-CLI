// Actual launcher, history and reducer; native views are isolated from CLI accounts.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const directory = await mkdtemp(join(tmpdir(), 'coffee-history-launch-mode-'));
const server = await createServer({ cacheDir: join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/lib\/history-cache\.ts/, route => route.fulfill({ contentType: 'text/javascript', body: `
    const snapshot={status:'ready',sessions:['claude','codex'].map(tool=>({id:tool+'-history',tool,name:tool+' saved conversation',cwd:'D:/history',session_token:tool+'-native',saved_at:'2026-10-28T00:00:00Z'}))};
    export const subscribeHistory=()=>()=>{},getHistorySnapshot=()=>snapshot,prefetchHistory=()=>{},refreshHistory=()=>{},initHistoryAutoRefresh=()=>()=>{},sortByMtime=sessions=>sessions;
  ` }));
  await page.route(/\/src\/components\/center\/(TierTerminal|ClaudeConversation|CodexConversation)\.tsx/, async route => {
    const name = route.request().url().match(/\/([A-Za-z]+)\.tsx/)[1];
    const source = await (await route.fetch()).text();
    const reactUrl = source.match(/from "([^"\n]*\/react\.js\?v=[^"]+)"/)[1];
    await route.fulfill({ contentType: 'text/javascript', body: `
      import React from '${reactUrl}';
      export const TERM_COLOR_SCHEMES=[];
      export function ${name}(props){return React.createElement('div',{'data-native-view':'${name}','data-native-token':props.resumeToken,'data-session-id':props.sessionId},'${name}')}
    ` });
  });
  await page.addInitScript(() => {
    localStorage.setItem('cc-lang', 'en');
    localStorage.setItem('cc-tasks-seeded', '1');
    localStorage.setItem('coffee_pinned_items', JSON.stringify(['agent:claude', 'agent:codex']));
  });
  await page.goto(server.resolvedUrls.local[0]);
  const history = tool => page.locator('.history-card').filter({ hasText: tool + ' saved conversation' });
  const modeGroup = tool => page.getByRole('group', { name: (tool === 'claude' ? 'Claude' : 'Codex') + ' launch mode', exact: true });
  const activeView = () => page.locator('[data-native-view]:visible');
  const closeActive = async () => {
    const id = await activeView().getAttribute('data-session-id');
    const tab = page.locator(`.chrome-tab[data-tab-id="${id}"]`);
    await tab.hover();
    await tab.locator('.tab-close-btn').click();
    await tab.waitFor({ state: 'detached' });
  };
  for (const tool of ['claude', 'codex']) {
    const desktop = tool === 'claude' ? 'ClaudeConversation' : 'CodexConversation';
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    assert.equal(await modeGroup(tool).getByRole('button', { name: 'Desktop', exact: true }).getAttribute('aria-pressed'), 'true', 'fresh preference defaults to Desktop');
    await history(tool).click();
    await page.waitForFunction(name => document.querySelector('[data-native-view="' + name + '"]')?.offsetParent, desktop);
    assert.equal(await activeView().getAttribute('data-native-token'), tool + '-native');
    await closeActive();
    for (const [label, view] of [['Terminal', 'TierTerminal'], ['Desktop', desktop], ['Terminal', 'TierTerminal']]) {
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      await modeGroup(tool).getByRole('button', { name: label, exact: true }).click();
      await history(tool).click();
      await page.waitForFunction(name => [...document.querySelectorAll('[data-native-view]')].some(el => el.offsetParent && el.dataset.nativeView === name), view);
      assert.equal(await activeView().getAttribute('data-native-view'), view, tool + ' history follows the card selection');
      assert.equal(await activeView().getAttribute('data-native-token'), tool + '-native', 'resume the same conversation in either mode');
      assert.equal(await page.locator('[data-native-token="' + tool + '-native"]').count(), 1, 'only one native writer owns the conversation');
      await closeActive();
    }
    await page.reload();
    await history(tool).click();
    await page.waitForFunction(() => document.querySelector('[data-native-view="TierTerminal"]')?.offsetParent);
    assert.equal(await activeView().getAttribute('data-native-token'), tool + '-native', 'saved Terminal preference survives restart');
    await closeActive();
  }
  assert.deepEqual(errors, []);
  console.log('OK: Claude and Codex history render the selected Terminal/Desktop view, preserve native IDs and retain preferences after reload');
} finally {
  await browser.close();
  await server.close();
}
