// Prompt links in the real app (store, launch handling, composer): only native calls are faked.
// A `coffeecli://new?prompt=…` request fills a draft and never sends; without a tool the
// launchpad stays and the draft waits; a later link never overwrites a typed draft. The
// draft actions on the composer edge (save · share · clear) stay put and only dim while
// empty; Share and the pre-input list's share button copy a link; notes go to the top toast.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const directory = await mkdtemp(join(tmpdir(), 'coffee-prompt-link-'));
const devServer = await createServer({ cacheDir: join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
await devServer.listen();
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });

async function open(pending) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Terminal and conversation views need native sessions; the composer and launchpad are real.
  await page.route(/\/src\/components\/center\/(TierTerminal|ClaudeConversation|CodexConversation)\.tsx/, route => {
    const name = route.request().url().match(/\/([A-Za-z]+)\.tsx/)[1];
    return route.fulfill({ contentType: 'text/javascript', body: `export function ${name}(){return null} export const TERM_COLOR_SCHEMES=[]; export const ClaudeTool=()=>null, ClaudeThinking=()=>null, ToolGroup=()=>null;` });
  });
  await page.addInitScript(pending => {
    for (const [k, v] of Object.entries({ 'cc-pre-input-button': '1', 'cc-lang': 'zh-CN', 'cc-theme': 'sakura', 'cc-mode': 'dark', 'cc-shape': 'soft', 'cc-tasks-seeded': '1', 'cc-gambit-open': '0', 'coffee:codex-launch-mode': 'terminal' })) localStorage.setItem(k, v);
    window.calls = [];
    window.listeners = {};
    let callback = 0;
    const callbacks = {};
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(fn) { const id = ++callback; callbacks[id] = fn; return id; },
      async invoke(name, args) {
        window.calls.push({ name, args });
        if (name === 'plugin:event|listen') { (window.listeners[args.event] ??= []).push(callbacks[args.handler]); return args.handler; }
        if (name === 'take_pending_launch') { const req = window.pending; window.pending = null; return req ?? null; }
        if (name === 'check_tools_installed') return {};
        if (name.startsWith('orchestration_')) return { enabled: false, agents: [], coordinators: [], tasks: [], revision: 0 };
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.pending = pending;
    window.emitLaunch = payload => (window.listeners['launch-request'] ?? []).forEach(fn => fn({ event: 'launch-request', id: 1, payload }));
  }, pending);
  await page.goto(devServer.resolvedUrls.local[0], { waitUntil: 'domcontentloaded', timeout: 90_000 });
  return { page, errors };
}
const active = page => page.evaluate(() => {
  const root = document.getElementById('root'), fiber = root[Object.keys(root).find(k => k.startsWith('__reactContainer$'))];
  let context;
  (function walk(f) { if (!f || context) return; const v = f.memoizedProps?.value; if (v?.state?.terminals && typeof v.dispatch === 'function') { context = v; return; } walk(f.child); walk(f.sibling); })(fiber.stateNode.current);
  const tab = context.state.terminals.find(t => t.id === context.state.activeTerminalId);
  return { tool: tab.tool, draft: tab.gambitDraft ?? '', tabs: context.state.terminals.length, gambitOpen: context.state.gambitOpen };
});
// Share is async (it compresses first): click, then wait for the clipboard write it causes.
const clipboardWrites = page => page.evaluate(() => window.calls.filter(c => c.name === 'plugin:clipboard-manager|write_text').length);
const shareAndWait = async (page, button) => {
  const before = await clipboardWrites(page);
  await button.click();
  await page.waitForFunction(n => window.calls.filter(c => c.name === 'plugin:clipboard-manager|write_text').length > n, before);
};
const sent = page => page.evaluate(() => window.calls.filter(c => /send|raw_write|terminal_input/.test(c.name)).length);

try {
  // Cold start, no tool: the launchpad stays, the composer opens with the draft and says to pick a tool.
  {
    const { page, errors } = await open({ prompt: '帮我修复构建\n然后跑测试' });
    const textarea = page.locator('.gambit textarea');
    await textarea.waitFor();
    await page.locator('.launchpad-mode-tabs').first().waitFor();
    assert.equal(await textarea.inputValue(), '帮我修复构建\n然后跑测试');
    let tab = await active(page);
    assert.equal(tab.tool, null, 'a link without a tool never picks one');
    assert.equal(tab.gambitOpen, true, 'the composer opens even though it was closed');
    await page.locator('.app-toast').filter({ hasText: '已填入分享的提示词，选好工具后发送' }).waitFor();
    const toast = await page.locator('.app-toast').boundingBox();
    assert.ok(toast.y < 120 && Math.abs(toast.x + toast.width / 2 - 700) < 2, 'the note shows at the top center, not in the composer');
    assert.equal(await page.locator('.gambit-send-hint').count(), 0, 'the composer footer stays free');
    assert.equal(await sent(page), 0, 'nothing is sent');
    assert.ok(page.url().startsWith(devServer.resolvedUrls.local[0]));
    console.log('OK cold-start link fills the launchpad draft, opens the composer, says to pick a tool, sends nothing');

    // A later link with hidden text: the typed draft is kept and the link opens its own tab.
    await textarea.fill('我自己写的草稿');
    const before = (await active(page)).tabs;
    await page.evaluate(() => window.emitLaunch({ prompt: '第二个链接', promptHadHidden: true }));
    await page.waitForFunction(() => document.querySelector('.gambit textarea')?.value === '第二个链接');
    tab = await active(page);
    assert.equal(tab.tool, null, 'links never pick a tool');
    assert.equal(tab.tabs, before + 1, 'the tab with a typed draft is not reused');
    await page.locator('.app-toast').filter({ hasText: '并移除了隐藏字符' }).waitFor();
    assert.equal(await sent(page), 0);

    // The draft actions: one group on the composer edge; Share copies a link for the draft and tool.
    const actions = page.locator('.gambit-draft-actions');
    const share = actions.getByRole('button', { name: '复制分享链接' });
    assert.deepEqual(await actions.locator('button').evaluateAll(els => els.map(el => el.getAttribute('aria-label') ?? el.textContent)), ['保存到预输入', '复制分享链接', '清空'], 'save · share · clear in one group');
    await textarea.fill('第二个链接 改过了');
    await shareAndWait(page, share);
    await page.locator('.app-toast').filter({ hasText: '已复制分享链接' }).waitFor();
    // Share copies just the link (it works pasted into an address bar); the prompt rides compressed in the fragment.
    const copied = async () => {
      const text = await page.evaluate(() => {
        const args = window.calls.filter(c => c.name === 'plugin:clipboard-manager|write_text').at(-1)?.args ?? {};
        return Object.values(args).find(v => typeof v === 'string' && v.includes('https://'));
      });
      const url = new URL(text);
      const packed = new URLSearchParams(url.hash.slice(1)).get('z');
      const prompt = await page.evaluate(async z => {
        const bin = atob(z.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(z.length / 4) * 4, '='));
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        return new TextDecoder().decode(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      }, packed);
      return { text, url, prompt };
    };
    let shared = await copied();
    assert.equal(shared.url.origin + shared.url.pathname, 'https://coffeecli.com/p');
    assert.equal(shared.url.search, '', 'nothing the server would see');
    assert.equal(shared.prompt, '第二个链接 改过了');
    assert.match(shared.text, /^https:\/\/coffeecli\.com\/p#z=[A-Za-z0-9_-]+$/, 'only the link, nothing around it');
    assert.equal(await textarea.inputValue(), '第二个链接 改过了', 'sharing keeps the draft');

    // Empty draft: the group stays where it is, darker but solid (never see-through), and its buttons do nothing.
    const box = await actions.boundingBox();
    await textarea.fill('');
    assert.deepEqual(await actions.boundingBox(), box, 'the group never moves or flips');
    const look = () => actions.evaluate(el => { const c = getComputedStyle(el); return { opacity: c.opacity, background: c.backgroundColor }; });
    await page.waitForTimeout(250);
    const dark = await look();
    assert.equal(dark.opacity, '1', 'never translucent');
    assert.doesNotMatch(dark.background, /rgba\(.*, 0(\.\d+)?\)$/, 'a solid background');
    assert.equal(await actions.locator('button:disabled').count(), 3);
    await textarea.fill('x');
    await page.waitForTimeout(250);
    assert.notEqual((await look()).background, dark.background, 'a draft brings back the bright pill');

    // Each edge button explains itself in our own tip (never title=), even while disabled.
    assert.equal(await page.locator('.gambit-draft-actions [title], .task-note-quick [title]').count(), 0, 'no native tooltips');
    // Like the heatmap's tip: a small card just under the pointer that follows it, kept inside the window.
    const tipOn = async (target, text) => {
      const b = await target.boundingBox();
      const px = b.x + b.width / 2, py = b.y + b.height / 2;
      await page.mouse.move(px, py);
      const tip = page.locator('.hover-tip');
      await tip.filter({ hasText: text }).waitFor();
      const t = await tip.boundingBox();
      assert.ok(t.x >= 7.5 && t.x + t.width <= 1392.5 && t.y + t.height <= 900, `${text}: inside the window`);
      assert.ok(t.y >= py + 15 || t.y + t.height <= py - 7, `${text}: under the pointer (above it only when there is no room)`);
      assert.ok(t.x <= px && px <= t.x + t.width, `${text}: lined up with the pointer`);
      assert.ok(t.height < 56, `${text}: at most two lines, never squeezed near the window edge`);
      // It follows the pointer (unless it is already held in at the window's edge).
      if (t.x > 8 && t.x + t.width < 1392) {
        await page.mouse.move(px - 4, py);
        await page.waitForFunction(x => { const r = document.querySelector('.hover-tip')?.getBoundingClientRect(); return r && r.x < x; }, t.x, { timeout: 3000 });
      }
    };
    await tipOn(actions.locator('.gambit-draft-slot').nth(0), '保存到右侧的预输入列表');
    await tipOn(actions.locator('.gambit-draft-slot').nth(1), '把这段提示词分享给朋友');
    await textarea.fill('');
    await tipOn(actions.locator('.gambit-draft-slot').nth(2), /^清空$/);
    await page.screenshot({ path: join(directory, 'edge-tip.png') });
    await page.mouse.move(10, 450);
    await page.locator('.hover-tip').waitFor({ state: 'detached' });

    // Save it, then share it from the pre-input list.
    await textarea.fill('存一句好用的话');
    await actions.getByRole('button', { name: '保存到预输入' }).click();
    const card = page.locator('.task-note-card').filter({ hasText: '存一句好用的话' });
    await card.waitFor();
    await card.hover();
    await shareAndWait(page, card.getByRole('button', { name: '复制分享链接' }));
    await page.locator('.app-toast').filter({ hasText: '已复制分享链接' }).waitFor();
    shared = await copied();
    assert.equal(shared.prompt, '存一句好用的话');
    assert.match(shared.text, /^https:\/\/coffeecli\.com\/p#z=[A-Za-z0-9_-]+$/);
    const [shareBox, deleteBox] = await Promise.all([card.getByRole('button', { name: '复制分享链接' }).boundingBox(), card.getByRole('button', { name: '删除' }).boundingBox()]);
    assert.ok(shareBox.x + shareBox.width <= deleteBox.x, 'share sits left of delete');
    await tipOn(card.getByRole('button', { name: '复制分享链接' }), '把这段提示词分享给朋友');
    await tipOn(card.getByRole('button', { name: '删除' }), /^删除$/);
    await page.screenshot({ path: join(directory, 'note-tip.png') });
    // Corners follow the shape setting, like the Send button.
    for (const [shape, radius] of [['sharp', '0px'], ['slab', '4px']]) {
      await page.evaluate(shape => document.documentElement.setAttribute('data-shape', shape), shape);
      assert.equal(await actions.evaluate(el => getComputedStyle(el).borderTopLeftRadius), radius, `${shape} draft actions`);
      assert.equal(await actions.evaluate(el => getComputedStyle(el).borderTopLeftRadius), await page.locator('.gambit-send').evaluate(el => getComputedStyle(el).borderTopLeftRadius), `${shape}: same corner as Send`);
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-shape', 'soft'));
    await page.screenshot({ path: join(directory, 'prompt-link.png') });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`OK a warm link never overwrites a typed draft and notes hidden text at the top; the edge group shares, darkens in place when empty; pre-input cards share without a tool (screenshot: ${join(directory, 'prompt-link.png')})`);
  }

  // A link without a prompt is a plain tool launch.
  {
    const { page, errors } = await open(null);
    await page.locator('.launchpad-mode-tabs').first().waitFor();
    await page.evaluate(() => window.emitLaunch({ tool: 'codex' }));
    assert.equal((await active(page)).tool, 'codex', 'a tool-only launch still opens the tool');
    await page.evaluate(() => window.emitLaunch({ tool: 'not-a-tool' }));
    assert.equal((await active(page)).tabs, 1, 'an unknown tool without a prompt does nothing');
    assert.deepEqual(errors, []);
    await page.close();
    console.log('OK tool-only launches still work and unknown tools are ignored');
  }
} finally {
  await browser.close();
  await devServer.close();
}
