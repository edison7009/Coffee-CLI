/** Streams many colored glyphs through real xterm/WebGL so the atlas merges pages,
 * then compares every cell with a terminal holding a fresh atlas. The unpatched
 * addon must show corruption here, which proves the comparison can catch it.
 * Color carries the signal, so the result does not depend on installed fonts.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-atlas-browser-'));

const { code: patchModule } = await transform(await readFile(join(project, 'xterm-webgl-atlas-patch.ts'), 'utf8'), {
  loader: 'ts', format: 'esm',
});
const patchFile = join(directory, 'patch.mjs');
await (await import('node:fs/promises')).writeFile(patchFile, patchModule);
const { patchXtermWebglAtlas } = await import(pathToFileURL(patchFile).href);

for (const bundle of ['addon-webgl.mjs', 'addon-webgl.js']) {
  const source = await readFile(join(project, 'node_modules/@xterm/addon-webgl/lib', bundle), 'utf8');
  const patched = patchXtermWebglAtlas(source);
  assert.notEqual(patched, source, `${bundle} should be patched`);
  assert.equal(patchXtermWebglAtlas(patched), patched, 'a bundle carrying the fix is left alone');
  assert.equal(/\bversion\+\+/.test(patched), false, `${bundle} must have no per-page version counter left`);
  assert.equal(patched.includes('generateMipmap'), false, `${bundle} must not regenerate mipmaps on upload`);
}
assert.throws(() => patchXtermWebglAtlas('const unrelated = 1;'), /patch-xterm-webgl-atlas/);

const fixture = `
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
let addon;
window.boot = async () => {
  await document.fonts.ready;
  window.term = new Terminal({ cols: 100, rows: 28, fontSize: 14, lineHeight: 1.3, customGlyphs: true,
    rescaleOverlappingGlyphs: true, cursorBlink: false, allowProposedApi: true, theme: { background: '#141414' } });
  term.open(document.getElementById('root'));
  addon = new WebglAddon(true);
  term.loadAddon(addon);
};
window.fresh = () => { addon.dispose(); addon = new WebglAddon(true); term.loadAddon(addon); };
window.put = data => new Promise(done => term.write(data, () => requestAnimationFrame(() => requestAnimationFrame(done))));
const renderer = () => addon._renderer.value ?? addon._renderer;
window.overfillAtlas = async () => {
  const atlas = renderer()._charAtlas;
  const page = atlas.pages[0];
  const capacity = renderer()._glyphRenderer.value._atlasTextures.length;
  while (atlas.pages.length <= capacity) atlas.pages.push({ canvas: page.canvas, version: page.version, glyphs: [] });
  await put('overfilled ');
  return { pages: atlas.pages.length, capacity };
};
window.exhaustMergeRetries = async () => {
  const current = renderer();
  const atlas = current._charAtlas;
  const glyphs = current._glyphRenderer.value;
  const updateModel = current._updateModel;
  const redrawViewport = current._requestRedrawViewport;
  let merges = 5, redraws = 0;
  current._updateModel = function (...range) {
    if (merges-- > 0) atlas.pageLayoutVersion = (atlas.pageLayoutVersion || 0) + 1;
    return updateModel.apply(this, range);
  };
  current._requestRedrawViewport = function () { redraws++; return redrawViewport.call(this); };
  await put('merging ');
  await new Promise(done => setTimeout(done, 200));
  current._updateModel = updateModel;
  current._requestRedrawViewport = redrawViewport;
  return { redraws, settled: glyphs._lastSeenPageLayoutVersion === atlas.pageLayoutVersion };
};
window.cell = () => term._core._renderService.dimensions.device.cell;
window.pixels = () => {
  const canvas = [...document.querySelectorAll('.xterm-screen canvas')].find(item => !item.classList.contains('xterm-link-layer'));
  const copy = document.createElement('canvas');
  copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return { width: canvas.width, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
};`;

const bundle = async (name, patched) => build({
  stdin: { contents: fixture, resolveDir: project, loader: 'js' },
  bundle: true, format: 'iife', outfile: join(directory, name), logLevel: 'silent',
  plugins: [{
    name: 'atlas-patch',
    setup(context) {
      context.onLoad({ filter: /addon-webgl[\\/]lib[\\/]addon-webgl\.mjs$/ }, async args => {
        const contents = await readFile(args.path, 'utf8');
        return { contents: patched ? patchXtermWebglAtlas(contents) : contents, loader: 'js' };
      });
    },
  }],
});
await Promise.all([bundle('patched.js', true), bundle('unpatched.js', false)]);
const css = await readFile(join(project, 'node_modules/@xterm/xterm/css/xterm.css'));

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://local');
  if (url.pathname.endsWith('.js')) {
    response.setHeader('Content-Type', 'text/javascript');
    return response.end(await readFile(join(directory, url.pathname.slice(1))));
  }
  if (url.pathname === '/xterm.css') { response.setHeader('Content-Type', 'text/css'); return response.end(css); }
  response.setHeader('Content-Type', 'text/html');
  if (url.pathname === '/frame') {
    return response.end(`<!doctype html><link rel=stylesheet href=/xterm.css><body style="margin:0"><div id=root></div><script src=/${url.searchParams.get('bundle')}.js></script>`);
  }
  response.end(`<!doctype html><body style="margin:0">
    <iframe id=streamed src="/frame?bundle=${url.searchParams.get('bundle')}" width=1310 height=620></iframe>
    <iframe id=reference src="/frame?bundle=${url.searchParams.get('bundle')}" width=1310 height=620></iframe>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
async function corruptedCells(name, steps) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1300 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/?bundle=${name}`);
  await page.waitForFunction(() => streamed.contentWindow.boot && reference.contentWindow.boot);
  await page.evaluate(() => Promise.all([streamed.contentWindow.boot(), reference.contentWindow.boot()]));
  const worst = await page.evaluate(async steps => {
    let seed = 168;
    const random = limit => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 * limit | 0;
    const frameText = () => {
      let text = '\x1b[H';
      for (let row = 0; row < 28; row++) {
        for (let column = 0; column < 100; column++) {
          text += `\x1b[38;2;${60 + random(190)};${60 + random(190)};${60 + random(190)}m${String.fromCharCode(33 + random(94))}`;
        }
        if (row < 27) text += '\x1b[0m\r\n';
      }
      return text;
    };
    const compare = () => {
      const left = streamed.contentWindow.pixels(), right = reference.contentWindow.pixels();
      const { width, height } = streamed.contentWindow.cell();
      if (left.width !== right.width || left.data.length !== right.data.length) throw new Error('canvas size differs');
      let corrupted = 0;
      for (let row = 0; row < 28; row++) for (let column = 0; column < 100; column++) {
        const x0 = Math.round(column * width), x1 = Math.round((column + 1) * width);
        const y0 = Math.round(row * height), y1 = Math.round((row + 1) * height);
        let distance = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = (y * left.width + x) * 4;
          distance += Math.abs(left.data[i] - right.data[i]) + Math.abs(left.data[i + 1] - right.data[i + 1])
            + Math.abs(left.data[i + 2] - right.data[i + 2]);
        }
        if (distance / ((x1 - x0) * (y1 - y0)) > 12) corrupted++;
      }
      return corrupted;
    };
    let worst = 0;
    for (let step = 0; step < steps; step++) {
      const text = frameText();
      await streamed.contentWindow.put(text);
      if (step % Math.ceil(steps / 40)) continue; // Each fresh atlas costs a WebGL context.
      reference.contentWindow.fresh();
      await reference.contentWindow.put(text);
      worst = Math.max(worst, compare());
    }
    return worst;
  }, steps);
  await context.close();
  assert.deepEqual(errors, []);
  return worst;
}

async function atlasEdgeCases(name) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1300 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/frame?bundle=${name}`);
  await page.waitForFunction(() => window.boot);
  await page.evaluate(() => window.boot());
  const retries = name === 'patched' ? await page.evaluate(() => window.exhaustMergeRetries()) : undefined;
  const overfill = await page.evaluate(() => window.overfillAtlas());
  await page.waitForTimeout(200);
  await context.close();
  return { retries, overfill, errors };
}

const steps = Number(process.env.COFFEE_ATLAS_STEPS || 40);
try {
  const stock = await atlasEdgeCases('unpatched');
  assert.ok(stock.overfill.pages > stock.overfill.capacity);
  assert.ok(stock.errors.length > 0, 'the unpatched addon should throw past the texture capacity');
  const edge = await atlasEdgeCases('patched');
  assert.deepEqual(edge.errors, [], 'pages past the texture capacity must not break rendering');
  assert.equal(edge.retries.redraws, 1, 'exhausted merge retries must schedule one more frame');
  assert.equal(edge.retries.settled, true, 'the extra frame must rebuild the model');
  const unpatched = await corruptedCells('unpatched', steps);
  const patched = await corruptedCells('patched', steps);
  console.log(JSON.stringify({ steps, unpatched, patched }));
  assert.ok(unpatched > 0, 'the unpatched addon should corrupt cells, otherwise this test proves nothing');
  assert.equal(patched, 0, 'streamed cells must match a fresh atlas');
} finally {
  await browser.close();
  server.close();
  await rm(directory, { recursive: true, force: true });
}
console.log('xterm atlas browser test passed');
