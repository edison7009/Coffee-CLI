// Actual app/store/sidebar/layout with isolated native view lifetimes. No CLI or account calls.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
const directory = await mkdtemp(join(tmpdir(), 'coffee-session-split-'));
const devServer = await createServer({ cacheDir: join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await devServer.listen();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  if (process.env.COFFEE_TEST_CPU_RATE) {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.COFFEE_TEST_CPU_RATE) });
  }
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/src\/main\.tsx/, async route => { const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replaceAll('StrictMode', 'Fragment') }); });
  await page.route(/\/src\/components\/center\/(TierTerminal|ClaudeConversation|CodexConversation)\.tsx/, async route => {
    const name = route.request().url().match(/\/([A-Za-z]+)\.tsx/)[1];
    const original = await (await route.fetch()).text();
    const reactUrl = original.match(/from "([^"\n]*\/react\.js\?v=[^"]+)"/)[1];
    return route.fulfill({ contentType: 'text/javascript', body: `
      import React from '${reactUrl}'; const {useEffect,useState,createElement:h}=React;
      export const TERM_COLOR_SCHEMES=[];
      export function ${name}(p){const [draft,setDraft]=useState('');useEffect(()=>{window.lifetimes??=[];window.lifetimes.push(['mount',p.sessionId]);return()=>window.lifetimes.push(['unmount',p.sessionId])},[p.sessionId]);return h('div',{'data-fixture-view':p.sessionId,'data-active':String(p.isActive),'data-visible':String(p.isVisible??p.isActive),style:{padding:32,flex:1}},h('h3',null,'${name}'),h('p',null,p.cwd??p.folderPath),h('input',{value:draft,onChange:e=>setDraft(e.target.value),'aria-label':'draft '+p.sessionId}))}
    ` });
  });
  await page.addInitScript(() => {
    for (const [key, value] of Object.entries({ 'cc-lang': 'en', 'cc-theme': 'sakura', 'cc-mode': 'dark', 'cc-shape': 'soft', 'cc-tasks-seeded': '1', 'coffee_pinned_items': JSON.stringify(['agent:claude', 'agent:codex', 'agent:four-split', 'agent:installer', 'agent:terminal']) })) localStorage.setItem(key, value);
  });
  await page.goto(devServer.resolvedUrls.local[0]);
  await page.locator('.launchpad-mode-tabs').first().waitFor().catch(async error => { console.error(errors); console.error((await page.locator('body').innerText()).slice(0, 1500)); throw error; });
  await page.waitForTimeout(500);
  // Test-only access to the actual provider; production exports no debug bridge.
  await page.evaluate(() => {
    function context() {
      const host = document.querySelector('.panel-center');
      let root = host[Object.keys(host).find(key => key.startsWith('__reactFiber$'))];
      while (root.return) root = root.return;
      function walk(fiber) {
        if (!fiber) return null;
        const value = fiber.memoizedProps?.value;
        if (value?.state?.terminals && typeof value.dispatch === 'function') return value;
        return walk(fiber.child) || walk(fiber.sibling);
      }
      return walk(root.stateNode.current);
    }
    window.testState = () => context().state;
    window.testDispatch = action => context().dispatch(action);
  });
  assert.equal(await page.getByText('Independent Quad', { exact: true }).count(), 0, 'fixed split launcher is retired');
  assert.equal(await page.getByText('Coffee 101', { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('coffee_pinned_items'))), ['agent:claude', 'agent:codex', 'agent:terminal']);
  assert.equal(await page.getByRole('button', { name: 'Open library', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Agent configuration', exact: true }).click();
  assert.equal(await page.getByText('Agent Tools', { exact: true }).count(), 0, 'retired category is removed');
  assert.equal(await page.getByText('Coffee 101', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  for (const session of [
    { id: 'a', tool: 'claude', claudeMode: 'conversation', resumeToken: 'thread-a', toolTitle: 'Claude desktop task' },
    { id: 'b', tool: 'codex', codexMode: 'conversation', resumeToken: 'thread-b', toolTitle: 'Codex desktop task' },
    { id: 'c', tool: 'terminal', toolTitle: 'Shell task' },
    { id: 'd', tool: 'claude', claudeMode: 'terminal', toolTitle: 'Claude terminal task' },
    { id: 'e', tool: 'terminal', toolTitle: 'Fifth task' },
  ]) await page.evaluate(session => window.testDispatch({ type: 'ADD_TERMINAL', session: { ...session, folderPath: 'D:/' + session.id, startedAt: Date.now() } }), session);
  await page.evaluate(() => window.testDispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'a' }));
  await page.locator('[data-fixture-view="a"]').waitFor();
  const pane = id => page.locator(`.terminal-wrapper[data-session-id="${id}"]`);
  const row = name => page.locator('.history-card').filter({ has: page.getByText(name, { exact: true }) });
  const drag = async (name, id, edge, beforeDrop) => {
    const from = await row(name).boundingBox(), to = await pane(id).boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 70, from.y + from.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + to.width * (edge === 'left' ? .08 : edge === 'right' ? .92 : .5), to.y + to.height * (edge === 'top' ? .08 : edge === 'bottom' ? .92 : .5), { steps: 12 });
    if (beforeDrop) await beforeDrop();
    await page.mouse.up();
  };
  const count = async expected => { await page.waitForFunction(n => [...document.querySelectorAll('.session-split-pane')].filter(el => el.offsetParent).length === n, expected, { timeout: 5000 }).catch(async error => { console.error(await page.evaluate(() => ({split:window.testState().sessionSplit,active:window.testState().activeTerminalId,views:[...document.querySelectorAll('.terminal-wrapper')].map(el=>({id:el.dataset.sessionId,display:getComputedStyle(el).display}))}))); console.error(errors); await page.screenshot({path:join(directory,'failure.png')}); throw error; }); };
  await page.getByRole('textbox', { name: 'draft a', exact: true }).fill('Draft survives splitting');
  await drag('Codex desktop task', 'a', 'right', async () => assert.equal(await page.locator('.session-split-drop-target').isVisible(), true));
  await count(2);
  const a2 = await pane('a').boundingBox(), b2 = await pane('b').boundingBox();
  assert.ok(b2.x > a2.x && Math.abs(a2.width - b2.width) < 2);
  await drag('Shell task', 'a', 'bottom', async () => assert.equal(await page.locator('.session-split-drop-target').isVisible(), true)); await count(3);
  const a3 = await pane('a').boundingBox(), c3 = await pane('c').boundingBox(), b3 = await pane('b').boundingBox();
  assert.ok(c3.y > a3.y && b3.height > a3.height, 'third pane splits the chosen side, preserving the other column');
  await drag('Claude terminal task', 'b', 'bottom'); await count(4);
  assert.equal(await page.locator('[data-fixture-view][data-active="true"]').count(), 1, 'only focused pane owns keyboard actions');
  assert.equal(await page.locator('[data-fixture-view][data-visible="true"]:visible').count(), 4, 'all visible views remain active for scrolling and rendering');
  await page.getByRole('button', { name: 'Usage statistics', exact: true }).click();
  await page.getByRole('region', { name: 'Usage statistics', exact: true }).waitFor();
  const navigationStyles = await page.evaluate(() => ['.explorer-tabs .explorer-new-session', '.explorer-usage', '.history-search-trigger'].map(selector => {
    const button = document.querySelector(selector), style = getComputedStyle(button), icon = button.querySelector('svg').getBoundingClientRect();
    return { font: style.font, padding: style.padding, iconX: icon.x, iconWidth: icon.width, iconHeight: icon.height };
  }));
  assert.deepEqual(navigationStyles[1], navigationStyles[0], 'statistics use the same typography and icon alignment as New session');
  assert.deepEqual(navigationStyles[1], navigationStyles[2], 'statistics use the same typography and icon alignment as Search');
  assert.equal(await page.locator('[data-fixture-view]:visible').count(), 0, 'statistics hide native surfaces without ending their sessions');
  assert.equal(await page.locator('.gambit').count(), 0, 'statistics do not leave the composer over the charts');
  await row('Claude desktop task').click(); await count(4);
  assert.equal(await page.getByRole('textbox', { name: 'draft a', exact: true }).inputValue(), 'Draft survives splitting');
  await page.getByRole('button', { name: 'Usage statistics', exact: true }).click();
  await page.locator('.chrome-tab').filter({ hasText: 'Claude desktop task' }).click(); await count(4);
  assert.equal(await page.locator('.usage-dashboard').count(), 0, 'selecting a session leaves statistics');
  await page.evaluate(() => window.testDispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'd' }));
  await page.screenshot({ path: join(directory, 'four-sessions.png') });
  for (const shape of ['glass', 'carbon', 'panel', 'soft']) {
    await page.evaluate(shape => window.testDispatch({ type: 'SET_SHAPE', shape }), shape);
    assert.notEqual(await pane('d').evaluate(el => getComputedStyle(el).borderTopColor), 'rgba(0, 0, 0, 0)', 'focused pane stays identifiable in ' + shape);
  }
  await drag('Fifth task', 'a', 'right', async () => assert.equal(await page.locator('.session-split-drop-target').count(), 0));
  await count(4);
  assert.equal(await page.evaluate(() => window.testState().activeTerminalId), 'd', 'invalid drop does not focus or open another session');
  await pane('a').click({ position: { x: 35, y: 35 } });
  assert.equal(await page.evaluate(() => window.testState().activeTerminalId), 'a');
  assert.equal(await pane('a').getAttribute('class').then(value => value.includes('is-focused')), true);
  const activeFolder = await page.evaluate(async () => { const { resolveDiffContext } = await import('/src/store/app-state.tsx'); const state = window.testState(); return resolveDiffContext(state.terminals.find(tab => tab.id === state.activeTerminalId)).folderPath; });
  assert.equal(activeFolder, 'D:/a', 'right-side diff context follows the actual focused session');
  const divider = page.locator('.session-split-divider.is-horizontal').first(), line = await divider.boundingBox();
  await page.mouse.move(line.x + line.width / 2, line.y + 35); await page.mouse.down(); await page.mouse.move(line.x + 100, line.y + 35, { steps: 8 }); await page.mouse.up();
  assert.ok(await page.evaluate(() => window.testState().sessionSplit.ratio > .55));
  await divider.focus(); await page.keyboard.press('ArrowLeft');
  assert.ok(await page.evaluate(() => window.testState().sessionSplit.ratio < .6), 'separator retains keyboard focus');
  await divider.dblclick({ position: { x: 3, y: 35 } }); assert.equal(await page.evaluate(() => window.testState().sessionSplit.ratio), .5);
  await page.getByRole('textbox', { name: 'draft b', exact: true }).focus();
  assert.equal(await page.evaluate(() => window.testState().activeTerminalId), 'b', 'keyboard focus routes input to the new pane');
  await pane('b').getByRole('button', { name: /Close split view/ }).click(); await count(3);
  assert.equal(await page.evaluate(() => window.testState().terminals.some(tab => tab.id === 'b')), true, 'closing a pane retains its session');
  await row('Codex desktop task').click({ button: 'right' });
  await page.getByRole('button', { name: 'Open in split view', exact: true }).click(); await count(4);
  assert.equal(await page.getByRole('textbox', { name: 'draft a', exact: true }).inputValue(), 'Draft survives splitting');
  // Duplicate native history resumes must resolve before inserting into layout.
  await page.evaluate(() => { window.testDispatch({ type: 'ADD_TERMINAL', session: { id: 'duplicate-b', tool: 'codex', codexMode: 'conversation', resumeToken: 'thread-b', folderPath: 'D:/wrong' }, split: { targetId: 'a', edge: 'right' } }); });
  await count(4);
  assert.equal(await page.evaluate(() => window.testState().terminals.some(tab => tab.id === 'duplicate-b')), false);
  // Escape cancels the drag before a native conversation's interrupt shortcut.
  await drag('Fifth task', 'b', 'bottom', async () => { await page.keyboard.press('Escape'); assert.equal(await page.locator('.session-split-drop-target').count(), 0); });
  await count(4);
  const lives = await page.evaluate(() => window.lifetimes);
  assert.deepEqual(lives.filter(([kind]) => kind === 'unmount'), [], 'add/remove/focus/resize never unmount an existing native view');
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal(lives.filter(([kind, sessionId]) => kind === 'mount' && sessionId === id).length, 1, 'start each view once: ' + id);
  for (const [id, expected] of [['b', 3], ['c', 2]]) {
    const focused=await page.evaluate(()=>window.testState().activeTerminalId);
    await pane(id).getByRole('button', { name: /Close split view/ }).click(); await count(expected);
    if(focused!==id)assert.equal(await page.evaluate(()=>window.testState().activeTerminalId),focused,'closing an unfocused pane does not first move the composer or steal focus');
  }
  await pane('d').getByRole('button', { name: /Close split view/ }).click(); await count(0);
  assert.equal(await pane('a').isVisible(), true);
  assert.ok((await pane('a').boundingBox()).width > 700, 'last pane expands to the whole area');
  // Real deletion and restart update layout references, unlike detach-only pane close.
  await page.evaluate(() => window.testDispatch({ type: 'OPEN_SESSION_SPLIT', id: 'c', targetId: 'a', edge: 'right' })); await count(2);
  await page.evaluate(() => window.testDispatch({ type: 'REMOVE_TERMINAL', id: 'c' })); await count(0);
  await page.evaluate(() => window.testDispatch({ type: 'OPEN_SESSION_SPLIT', id: 'b', targetId: 'a', edge: 'right' })); await count(2);
  await page.evaluate(() => window.testDispatch({ type: 'RESTART_TERMINAL', id: 'b', newId: 'b-restarted' }));
  await pane('b-restarted').waitFor(); assert.equal(await pane('b').count(), 0);
  await page.evaluate(async () => {
    const { receiveOrchestration } = await import('/src/lib/orchestration.ts');
    window.pauseTabEntry = event => {
      if (event.animationName === 'orchestration-tab-enter') for (const animation of event.target.getAnimations()) {
        if (animation.animationName === event.animationName) { animation.pause(); animation.currentTime = 100; }
      }
    };
    document.addEventListener('animationstart', window.pauseTabEntry);
    const tasks = ['codex', 'opencode'].map((tool, index) => ({ id: 'task-' + index, parentId: 'a', parentNativeId: 'thread-a', parentTool: 'claude', sessionId: 'worker-' + index, nativeId: 'worker-native-' + index, tool, title: index ? '检查交互' : '实现页面', cwd: 'D:/a', phase: 'starting', question: null, activity: 'working' }));
    for (const task of tasks) window.testDispatch({ type: 'ADD_TERMINAL', session: { id: task.sessionId, parentId: 'a', tool: task.tool, resumeToken: task.nativeId, folderPath: task.cwd, toolTitle: 'You are a worker assigned to a task', agentStatus: 'working' } });
    window.testDispatch({ type: 'REORDER_TAB', tabId: 'worker-0', beforeId: 'b-restarted' });
    window.testDispatch({ type: 'REORDER_TAB', tabId: 'worker-1', beforeId: 'b-restarted' });
    receiveOrchestration({ enabled: true, tasks, revision: 10 });
    window.testDispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'worker-0' });
  });
  const parentTab = page.locator('.chrome-tab[data-tab-id="a"]'), childTab = page.locator('.chrome-tab[data-tab-id="worker-0"]'), siblingTab = page.locator('.chrome-tab[data-tab-id="worker-1"]');
  await childTab.waitFor();
  const tabReveal = await childTab.evaluate(el => {
    const animation = el.getAnimations().find(animation => animation.animationName === 'orchestration-tab-enter');
    const sample = time => { animation.currentTime = time; return { width: el.getBoundingClientRect().width, opacity: Number(getComputedStyle(el).opacity) }; };
    const start = sample(0), middle = sample(100), end = sample(200);
    document.querySelectorAll('.orchestration-child').forEach(tab => tab.getAnimations().filter(animation=>animation.animationName==='orchestration-tab-enter').forEach(animation=>animation.finish()));
    document.removeEventListener('animationstart', window.pauseTabEntry);
    return { start, middle, end };
  });
  assert.ok(tabReveal.start.width < tabReveal.middle.width && tabReveal.middle.width <= tabReveal.end.width,'child tabs reveal horizontally');
  assert.ok(tabReveal.start.opacity < tabReveal.middle.opacity && tabReveal.middle.opacity < tabReveal.end.opacity,'child titles fade in with their tab');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await childTab.evaluate(el=>getComputedStyle(el).animationName),'none','reduced motion disables child tab entry');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>['orchestration-tab-enter','orchestration-worker-enter'].includes(animation.animationName)).map(animation=>animation.finished)));
  await page.evaluate(async()=>{const {receiveOrchestration,getOrchestrationSnapshot}=await import('/src/lib/orchestration.ts');const current=getOrchestrationSnapshot();receiveOrchestration({...current,revision:current.revision+1,tasks:current.tasks.map(task=>({...task,phase:'running'}))})});
  await page.evaluate(async()=>{
    const {receiveOrchestration,getOrchestrationSnapshot}=await import('/src/lib/orchestration.ts');
    const current=getOrchestrationSnapshot();receiveOrchestration({...current,revision:current.revision+1,tasks:current.tasks.map(task=>task.id==='task-0'?{...task,title:'Updated child title'}:task)});
  });
  await page.waitForFunction(()=>document.querySelector('.chrome-tab[data-tab-id="worker-0"] .tab-title')?.textContent==='Updated child title');
  assert.equal(await childTab.evaluate(el=>el.getAnimations().filter(animation=>animation.animationName==='orchestration-tab-enter').length),0,'updating a title does not replay tab entry');
  await page.evaluate(async()=>{
    const {receiveOrchestration,getOrchestrationSnapshot}=await import('/src/lib/orchestration.ts');
    const current=getOrchestrationSnapshot();receiveOrchestration({...current,revision:current.revision+1,tasks:current.tasks.map(task=>task.id==='task-0'?{...task,title:'实现页面'}:task)});
  });
  const nested = page.locator('.history-worker').filter({ hasText: '实现页面' });
  assert.equal(await nested.locator('.history-worker-title').innerText(), await childTab.locator('.tab-title').innerText(), 'sidebar and top tab share the task title');
  assert.equal(await page.locator('.history-card-title').filter({ hasText: 'You are a worker' }).count(), 0, 'live workers never appear as peer history rows');
  await nested.click();
  assert.equal(await page.evaluate(() => window.testState().activeTerminalId), 'worker-0');
  await page.mouse.move(1500, 950);
  for (const shape of ['soft', 'panel', 'sharp', 'glass', 'monogram']) {
    await page.evaluate(shape => window.testDispatch({ type: 'SET_SHAPE', shape }), shape);
    await page.waitForFunction(shape => document.documentElement.dataset.shape === shape, shape);
    assert.equal(await parentTab.evaluate(el => el.classList.contains('orchestration-family-active')), true, shape + ': child selection retains the parent highlight');
    assert.equal(await page.locator('.chrome-tab.active').count(), 1, 'family styling preserves a single actual focused tab');
    const parentSurface = await parentTab.evaluate(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.boxShadow]; });
    await parentTab.click();
    assert.deepEqual(await parentTab.evaluate(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.color, s.boxShadow]; }), parentSurface, shape + ': family highlight matches the normal parent selection');
    await childTab.click();
    await page.mouse.move(1500, 950);
    const p = await parentTab.boundingBox(), c = await childTab.boundingBox(), s = await siblingTab.boundingBox();
    assert.ok(c.height < p.height, shape + ': child tab is shorter than its parent');
    if (shape === 'panel') {
      const content = await page.locator('.main-content').boundingBox();
      for (const tab of [c, s]) assert.ok(tab.y + tab.height < content.y, 'panel child tabs stay separate from the content frame');
      await page.screenshot({ path: join(directory, 'orchestration-tab-family-panel.png') });
    }
    assert.ok(c.x - p.x - p.width >= 3.5 && s.x - c.x - c.width >= 3.5, shape + ': child tabs keep their own gap and corners');
    assert.equal(await childTab.evaluate(el=>{const probe=document.createElement('span');probe.style.background='color-mix(in srgb,var(--text-1) 20%,var(--bg-app))';probe.style.color='var(--text-1)';document.body.append(probe);const s=getComputedStyle(el),p=getComputedStyle(probe),matches=s.backgroundColor===p.backgroundColor&&s.color===p.color;probe.remove();return matches}),true,shape+': child surface and text follow the theme');
    assert.equal(await childTab.evaluate(el => { const ctx = document.createElement('canvas').getContext('2d'); ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3]; }), 255, shape + ': child has a solid theme surface');
    assert.deepEqual(await childTab.locator('.orchestration-status').evaluate(el => { const s = getComputedStyle(el); return [s.backgroundColor, s.boxShadow, s.outlineWidth, s.borderWidth]; }), ['rgb(217, 119, 87)', 'none', '0px', '0px'], shape + ': working child status matches the ordinary tab orange with no ring');
  }
  for(const [status,expected,color] of [['idle','idle','rgb(52, 211, 153)'],['working','working','rgb(217, 119, 87)'],['wait_input','waiting','rgb(96, 165, 250)']]) {
    await page.evaluate(status=>{for(const id of ['a','worker-0'])window.testDispatch({type:'SET_AGENT_STATUS',id,status})},status);
    await page.waitForFunction(expected=>document.querySelector('.chrome-tab[data-tab-id="worker-0"] .orchestration-status')?.dataset.state===expected,expected);
    assert.equal(await childTab.locator('.orchestration-status').evaluate(el=>getComputedStyle(el).backgroundColor),color,'child tab uses the standard '+expected+' color');
    assert.equal(await parentTab.locator('.tab-status-dot').first().evaluate(el=>getComputedStyle(el).backgroundColor),color,'ordinary and child tabs share '+expected+' colors');
  }
  await page.evaluate(()=>{for(const id of ['a','worker-0'])window.testDispatch({type:'SET_AGENT_STATUS',id,status:'working'})});
  for(const mode of ['light','dark']) {
    await page.evaluate(mode=>window.testDispatch({type:'SET_THEME_MODE',mode}),mode);
    await page.waitForFunction(mode=>document.documentElement.dataset.mode===mode,mode);
    await page.evaluate(()=>Promise.allSettled(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished)));
    const tone=await siblingTab.evaluate(el=>{const context=document.createElement('canvas').getContext('2d');const sample=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);const p=context.getImageData(0,0,1,1).data;return p[0]*.2126+p[1]*.7152+p[2]*.0722};return {child:sample(getComputedStyle(el).backgroundColor),base:sample(getComputedStyle(document.documentElement).getPropertyValue('--bg-app'))}});
    assert.ok(mode==='dark'?tone.child>tone.base:tone.child<tone.base,mode+': child surface lifts at night and deepens in daylight');
    await page.screenshot({path:join(directory,'separate-blue-child-tabs-'+mode+'.png')});
  }
  await page.screenshot({ path: join(directory, 'orchestration-tab-family.png') });
  await page.locator('.chrome-tab[data-tab-id="b-restarted"]').click();
  assert.equal(await parentTab.evaluate(el => el.classList.contains('orchestration-family-active')), false, 'selecting an unrelated session clears the family highlight');
  assert.equal(await page.locator('.history-card-active .history-card-title').filter({ hasText: 'Claude desktop task' }).count(), 0, 'unrelated selection also clears sidebar family highlighting');
  await page.evaluate(() => window.testDispatch({ type: 'REORDER_TAB', tabId: 'worker-0', beforeId: null }));
  assert.equal(await childTab.evaluate(el => el.classList.contains('orchestration-attached')), false, 'moving a child away never joins it visually to an unrelated tab');
  assert.equal(await parentTab.evaluate(el => el.classList.contains('orchestration-has-child')), false, 'parent corners remain independent of child tabs');
  await page.evaluate(async () => {
    const { commands } = await import('/src/tauri.ts');
    const { getOrchestrationSnapshot } = await import('/src/lib/orchestration.ts');
    window.groupCloses=[];
    commands.orchestrationCloseGroup=async(id,keepChildren)=>{
      if(window.failGroupClose)throw new Error('Test close failed');
      window.groupCloses.push({id,keepChildren});
      const s=getOrchestrationSnapshot();return {...s,revision:s.revision+1,tasks:s.tasks.map(task=>task.parentId===id&&!task.detached?{...task,detached:keepChildren,phase:keepChildren?task.phase:['starting','running','uncertain'].includes(task.phase)?'closed':task.phase}:task)};
    };
  });
  await parentTab.hover();await parentTab.locator('.tab-close-btn').click();
  const closeDialog=page.getByRole('dialog',{name:'Close session group'});
  await closeDialog.waitFor();
  assert.equal(await parentTab.count(),1,'running tasks are not closed before choosing');
  await page.keyboard.press('Escape');assert.equal(await closeDialog.count(),0,'Escape cancels the group close');
  assert.deepEqual(await page.evaluate(()=>window.groupCloses),[]);
  await parentTab.hover();await parentTab.locator('.tab-close-btn').click();
  await closeDialog.getByRole('button',{name:'Keep child sessions',exact:true}).click();
  await parentTab.waitFor({state:'detached'});
  assert.equal(await childTab.count(),1);assert.equal(await siblingTab.count(),1);
  assert.equal(await childTab.evaluate(el=>el.classList.contains('orchestration-child')),false,'retained workers become independent tabs');
  assert.equal(await page.locator('.history-card-title').filter({hasText:/^实现页面$/}).count(),1,'retained child has its own accessible history row and task title');
  assert.equal(await page.evaluate(()=>window.testState().terminals.find(tab=>tab.id==='worker-0').parentId),undefined);
  assert.deepEqual(await page.evaluate(()=>window.lifetimes.filter(([kind,id])=>kind==='unmount'&&id.startsWith('worker-'))),[],'detaching never restarts or unmounts worker views');
  const addGroup=async(phase)=>{await page.evaluate(async phase=>{
    const {receiveOrchestration,getOrchestrationSnapshot}=await import('/src/lib/orchestration.ts');
    for(const session of [{id:'group-parent',tool:'claude',claudeMode:'conversation',toolTitle:'Group parent'},{id:'group-child',parentId:'group-parent',tool:'codex',codexMode:'conversation',toolTitle:'Internal instructions',agentStatus:phase==='completed'?'idle':'working'}])window.testDispatch({type:'ADD_TERMINAL',session:{...session,folderPath:'D:/group'}});
    const s=getOrchestrationSnapshot();receiveOrchestration({...s,revision:s.revision+1,tasks:[...s.tasks.filter(task=>task.id!=='group-task'),{id:'group-task',sessionId:'group-child',parentId:'group-parent',parentTool:'claude',tool:'codex',title:'Visible child result',phase}]});
  },phase);await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.animationName==='orchestration-tab-enter').map(animation=>animation.finished)));};
  const groupParent=page.locator('.chrome-tab[data-tab-id="group-parent"]');
  await addGroup('completed');
  assert.equal(await page.locator('.chrome-tab[data-tab-id="group-child"]').count(),1,'completed tasks remain available until their parent is explicitly closed');
  await groupParent.hover();await groupParent.locator('.tab-close-btn').click();
  await groupParent.waitFor({state:'detached'});
  assert.equal(await closeDialog.count(),0,'settled groups close without a prompt');
  assert.equal(await page.locator('.chrome-tab[data-tab-id="group-child"]').count(),0);
  assert.equal(await childTab.count(),1,'closing another group leaves previously detached sessions alone');
  await addGroup('running');
  await groupParent.hover();await groupParent.locator('.tab-close-btn').click();
  await page.evaluate(()=>window.failGroupClose=true);
  await closeDialog.getByRole('button',{name:'End group',exact:true}).click();
  await closeDialog.getByRole('alert').waitFor();assert.equal(await groupParent.count(),1,'native failure leaves every session available for retry');
  await page.evaluate(()=>window.failGroupClose=false);
  await closeDialog.getByRole('button',{name:'End group',exact:true}).click();
  await groupParent.waitFor({state:'detached'});
  assert.equal(await page.locator('.chrome-tab[data-tab-id="group-child"]').count(),0,'end group closes the running child together with its parent');
  assert.equal(await childTab.count(),1,'unrelated sessions survive end group');
  console.log('OK: completed groups, running-task choice, Escape, detach without restart, independent history, native failure/retry and scoped group shutdown');
  await page.evaluate(async()=>{
    const {commands}=await import('/src/tauri.ts');const {receiveOrchestration,getOrchestrationSnapshot}=await import('/src/lib/orchestration.ts');
    window.restoredHistory=[];
    commands.orchestrationRestoreWorker=async(taskId,parentId,sessionId)=>{window.restoredHistory.push({taskId,parentId,sessionId});const s=getOrchestrationSnapshot();return {...s,revision:s.revision+1,tasks:s.tasks.map(task=>task.id===taskId?{...task,parentId:task.detached?task.parentId:parentId,sessionId}:task)}};
    commands.orchestrationDetachWorker=async taskId=>{const s=getOrchestrationSnapshot();return {...s,revision:s.revision+1,tasks:s.tasks.map(task=>task.id===taskId?{...task,detached:true}:task)}};
    window.testDispatch({type:'ADD_TERMINAL',session:{id:'history-parent',tool:'claude',claudeMode:'conversation',resumeToken:'root-native',folderPath:'D:/history',toolTitle:'History parent'}});
    const s=getOrchestrationSnapshot();receiveOrchestration({...s,revision:s.revision+1,tasks:[...s.tasks,{id:'saved-history-task',parentId:'history-parent',parentTool:'claude',parentNativeId:'root-native',sessionId:'saved-history-child',tool:'codex',nativeId:'original-native-thread',cwd:'D:/history',title:'Original child history',phase:'completed',question:null}]});
  });
  const historyChild=page.locator('.history-worker').filter({hasText:'Original child history'}),restoredTab=page.locator('.chrome-tab[data-tab-id="saved-history-child"]');
  await historyChild.hover();
  assert.equal(await page.getByRole('tooltip').locator('.history-card-preview-title').innerText(),'Original child history');assert.equal(await page.getByRole('tooltip').locator('.history-card-meta').count(),1);
  await historyChild.locator('.history-worker-open').click();await restoredTab.waitFor();
  assert.equal(await restoredTab.evaluate(el=>getComputedStyle(el).animationName),'none','restoring child history opens its tab without a new-task entrance animation');
  assert.equal(await page.evaluate(()=>window.testState().terminals.find(tab=>tab.id==='saved-history-child').resumeToken),'original-native-thread','history restore passes the original native conversation ID');
  assert.equal(await page.evaluate(()=>window.testState().terminals.find(tab=>tab.id==='saved-history-child').parentId),'history-parent');
  const relatedOrder=await page.evaluate(()=>window.testState().tabOrder);
  assert.equal(relatedOrder.indexOf('saved-history-child'),relatedOrder.indexOf('history-parent')+1,'restored child joins its existing parent in the tab strip');
  await restoredTab.hover();await restoredTab.locator('.tab-close-btn').click();await restoredTab.waitFor({state:'detached'});
  await historyChild.locator('.history-worker-open').dblclick();await restoredTab.waitFor();
  assert.equal(await restoredTab.evaluate(el=>getComputedStyle(el).animationName),'none','reopening an existing child cannot replay the creation animation');
  assert.equal(await page.evaluate(()=>window.testState().terminals.filter(tab=>tab.resumeToken==='original-native-thread').length),1,'repeated clicks keep exactly one writer for the original history');
  assert.equal(await page.evaluate(()=>window.restoredHistory.length),2,'active child clicks select the tab without another restore request');
  const savedDraft=page.getByRole('textbox',{name:'draft saved-history-child',exact:true});await savedDraft.fill('Draft survives becoming independent');
  const lifetimeBeforeDetach=await page.evaluate(()=>window.lifetimes.filter(([,id])=>id==='saved-history-child'));
  await historyChild.click({button:'right'});await page.getByRole('button',{name:'Make independent',exact:true}).click();
  await historyChild.waitFor({state:'detached'});
  assert.equal(await restoredTab.evaluate(el=>el.classList.contains('orchestration-child')),false,'independent sessions leave the family styling');
  assert.equal(await savedDraft.inputValue(),'Draft survives becoming independent');
  assert.deepEqual(await page.evaluate(()=>window.lifetimes.filter(([,id])=>id==='saved-history-child')),lifetimeBeforeDetach,'detaching never remounts or restarts the child transport');
  assert.equal(await page.locator('.history-card-title').filter({hasText:/^Original child history$/}).count(),1,'detached session keeps a normal history entry');
  assert.equal(await page.locator('.chrome-tab[data-tab-id="history-parent"]').count(),1,'parent session stays open');
  console.log('OK: two-level child previews, original native history restore, repeated-click dedupe, family tab order and detach without losing process or draft');
  assert.deepEqual(errors, []);
  console.log('OK: nested orchestration history, shared titles, compact icons, attached/detached child tabs and solid theme surfaces');
  console.log('OK: actual sidebar pointer drops/context menu, nested 1→4→1, focus, resizing, deduplication, cancellation, stable view lifetimes, deletion and restart');
  console.log('Screenshot: ' + join(directory, 'four-sessions.png'));
} finally { await browser.close(); await devServer.close(); }
