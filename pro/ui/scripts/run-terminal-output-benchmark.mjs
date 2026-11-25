/** Optional local A/B benchmark. Requires Python Playwright and installed Edge.
 * node scripts/run-terminal-output-benchmark.mjs [baseline-git-ref]
 * Uses real xterm in isolated headless Edge pages, not live PTYs or the user's app.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ref = process.argv[2] ?? 'HEAD';
const baseline = execFileSync('git', ['show', `${ref}:src-ui/src/lib/terminal-output-scheduler.ts`], {
  cwd: root, encoding: 'utf8',
});
const candidate = readFileSync(join(root, 'src/lib/terminal-output-scheduler.ts'), 'utf8');
const out = mkdtempSync(join(tmpdir(), 'coffee-output-benchmark-'));
const harness = String.raw`
import { Terminal } from '@xterm/xterm';
import * as scheduler from 'scheduler';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
window.runScenario = async (count, visibleCount, streaming) => {
  document.body.style.cssText = 'display:grid;grid-template-columns:repeat(2,650px);gap:4px;';
  const terms = [];
  const ids = [];
  const done = [];
  const frames = [], heartbeat = [];
  const pending = Array(count).fill(0);
  let peakPending = 0, peakSessionPending = 0, maxChunk = 0, submitted = 0;
  let previousFrame = performance.now(), previousBeat = performance.now();
  let running = true, raf;
  const frame = now => {
    frames.push(now - previousFrame); previousFrame = now;
    if (running) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const beat = setInterval(() => {
    const now = performance.now(); heartbeat.push(Math.max(0, now - previousBeat - 8)); previousBeat = now;
  }, 8);
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.style.cssText = 'width:650px;height:400px;';
    document.body.append(el);
    const term = new Terminal({ cols: 80, rows: 24, scrollback: 5000 });
    term.open(el);
    if (i >= visibleCount) el.style.display = 'none';
    terms.push(term);
    const id = String(i); ids.push(id);
    scheduler.registerSession(id, { write(data, callback) {
      maxChunk = Math.max(maxChunk, data.length);
      submitted += data.length;
      pending[i] += data.length;
      peakPending = Math.max(peakPending, pending.reduce((a, b) => a + b, 0));
      peakSessionPending = Math.max(peakSessionPending, pending[i]);
      term.write(data, () => { pending[i] -= data.length; callback?.(); });
    } });
    scheduler.setActive(id, i < visibleCount);
    done.push(new Promise(resolve => term.onTitleChange(title => { if (title === 'done') resolve(); })));
  }
  await pause(50);
  frames.length = 0; heartbeat.length = 0;
  previousFrame = previousBeat = performance.now();
  const start = performance.now();
  const line = '\x1b[32magent output 中文 😀\x1b[0m\r\n';
  const payload = line.repeat(Math.ceil((streaming ? 16 : 512) * 1024 / line.length));
  try {
    for (let round = 0; round < (streaming ? 6 : 1); round++) {
      for (const id of ids) scheduler.enqueue(id, payload);
      if (streaming) await pause(200);
    }
    for (const id of ids) scheduler.enqueue(id, '\r\nEND-' + id + '\x1b]0;done\x07');
    let timeout;
    await Promise.race([
      Promise.all(done),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('parse timeout')), 15000); }),
    ]).finally(() => clearTimeout(timeout));
    const elapsedMs = performance.now() - start;
    const valid = terms.every((t, i) => {
      const b = t.buffer.active;
      return b.getLine(b.baseY + b.cursorY).translateToString(true) === 'END-' + i;
    });
    await pause(40);
    return {
      count, visibleCount, streaming, valid, elapsedMs, submitted,
      peakPending, peakSessionPending, maxChunk,
      heartbeatP95Ms: percentile(heartbeat, .95), heartbeatMaxMs: Math.max(0, ...heartbeat),
      frameP95Ms: percentile(frames, .95), frameMaxMs: Math.max(0, ...frames),
    };
  } finally {
    running = false; cancelAnimationFrame(raf); clearInterval(beat);
    for (const id of ids) scheduler.unregisterSession(id);
    for (const term of terms) term.dispose();
    document.body.replaceChildren();
  }
};
`;
for (const [name, source] of [['baseline', baseline], ['candidate', candidate]]) {
  await build({
    stdin: { contents: harness, resolveDir: root, sourcefile: 'benchmark.js' },
    bundle: true, format: 'iife', outfile: join(out, `${name}.js`), logLevel: 'warning',
    plugins: [{
      name: 'scheduler-source',
      setup(builder) {
        builder.onResolve({ filter: /^scheduler$/ }, () => ({ path: 'scheduler', namespace: 'source' }));
        builder.onLoad({ filter: /.*/, namespace: 'source' }, () => ({ contents: source, loader: 'ts' }));
      },
    }],
  });
  writeFileSync(join(out, `${name}.html`), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"><script src="${name}.js"></script>`);
}
copyFileSync(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(out, 'xterm.css'));
const runner = String.raw`
import json, pathlib, sys
from playwright.sync_api import sync_playwright
out = pathlib.Path(sys.argv[1])
results = []
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    try:
        for repeat in range(3):
            for count, visible, streaming in [(1,1,False),(4,1,False),(8,1,False),(16,1,False),(16,4,False),(16,4,True)]:
                for version in (['baseline','candidate'] if repeat % 2 == 0 else ['candidate','baseline']):
                    page = browser.new_page(viewport={'width':1400,'height':950})
                    errors = []
                    page.on('pageerror', lambda err: errors.append(str(err)))
                    page.goto((out / (version + '.html')).as_uri())
                    cdp = page.context.new_cdp_session(page)
                    cdp.send('Emulation.setCPUThrottlingRate', {'rate':4})
                    result = page.evaluate('(args) => window.runScenario(...args)', [count, visible, streaming])
                    result.update(version=version, repeat=repeat, errors=errors)
                    results.append(result)
                    (out / 'results.json').write_text(json.dumps({'browser':browser.version, 'cpuThrottle':4, 'results':results}, indent=2), encoding='utf-8')
                    print(json.dumps(result), flush=True)
                    page.close()
                    if not result['valid'] or errors:
                        raise RuntimeError('terminal correctness failed')
    finally:
        browser.close()
`;
writeFileSync(join(out, 'run.py'), runner);
const digest = source => createHash('sha256').update(source).digest('hex');
writeFileSync(join(out, 'metadata.json'), JSON.stringify({
  baseline: ref, baselineSha256: digest(baseline), candidateSha256: digest(candidate),
  xterm: '6.0.0', out,
}, null, 2));
console.log(`Artifacts: ${out}`);
execFileSync('python', [join(out, 'run.py'), out], { stdio: 'inherit', timeout: 300000 });
