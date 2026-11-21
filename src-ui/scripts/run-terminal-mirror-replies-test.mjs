/** A mirrored terminal must never answer the program's queries: the desktop's own terminal already did. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  stdin: { contents: 'export * from "./src/lib/terminal-mirror-replies";', resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'warning',
});
const module = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports });
const { muteTerminalReplies } = module.exports;
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm');

const ESC = '\x1b', ST = `${ESC}\\`, BEL = '\x07';
const QUERIES = {
  'primary device attributes': `${ESC}[c`,
  'secondary device attributes': `${ESC}[>c`,
  'device status': `${ESC}[5n`,
  'cursor position': `${ESC}[6n`,
  'private cursor position': `${ESC}[?6n`,
  'ANSI mode request': `${ESC}[4$p`,
  'private mode request': `${ESC}[?25$p`,
  'window size report': `${ESC}[18t`,
  'status string request': `${ESC}P$qr${ST}`,
  'foreground color': `${ESC}]10;?${BEL}`,
  'background color': `${ESC}]11;?${ST}`,
  'cursor color': `${ESC}]12;?${BEL}`,
  'indexed color': `${ESC}]4;1;?${BEL}`,
};

function terminal(muted) {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24, windowOptions: { getWinSizeChars: true } });
  // Color reports are written out only by an opened (DOM) terminal; count xterm's report requests instead.
  const replies = [];
  term.onData(data => replies.push(data));
  term._core._inputHandler.onColor(events => { for (const event of events) if (event.type === 0) replies.push(`color report ${event.index}`); });
  const dispose = muted ? muteTerminalReplies(term) : () => {};
  return { term, replies, dispose };
}
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`  ok  ${name}`); }

for (const [name, query] of Object.entries(QUERIES)) {
  await test(`${name} is answered normally and never by a mirror`, async () => {
    const plain = terminal(false);
    await write(plain.term, query);
    assert.ok(plain.replies.length > 0, `xterm answers ${name} on its own`);
    const mirror = terminal(true);
    await write(mirror.term, query);
    assert.deepEqual(mirror.replies, []);
  });
}

await test('a replayed snapshot full of queries produces no input', async () => {
  const mirror = terminal(true);
  await write(mirror.term, `PowerShell 7.7.0\r\n${Object.values(QUERIES).join('')}PS D:\\Test> `);
  assert.deepEqual(mirror.replies, []);
  assert.match(mirror.term.buffer.active.getLine(1).translateToString(true), /PS D:\\Test>/);
});

await test('setting colors and other sequences still take effect', async () => {
  const mirror = terminal(true);
  const colors = [];
  mirror.term._core._inputHandler.onColor(event => colors.push(...event));
  await write(mirror.term, `${ESC}]10;#ff0000${BEL}${ESC}]4;1;#00ff00${BEL}${ESC}[?25l${ESC}[5;5Hx`);
  assert.equal(colors.filter(event => event.type === 1).length, 2, 'both colors were set');
  assert.equal(mirror.term.buffer.active.cursorY, 4);
  assert.deepEqual(mirror.replies, []);
});

await test('a mixed color set-and-query still sets the color', async () => {
  const mirror = terminal(true);
  const colors = [];
  mirror.term._core._inputHandler.onColor(event => colors.push(...event));
  await write(mirror.term, `${ESC}]4;1;#00ff00;2;?${BEL}`);
  assert.ok(colors.some(event => event.type === 1 && event.index === 1));
});

await test('dispose restores normal answering', async () => {
  const mirror = terminal(true);
  mirror.dispose();
  await write(mirror.term, `${ESC}[c`);
  assert.ok(mirror.replies.length > 0);
});

await test('typed input still reaches onData', async () => {
  const mirror = terminal(true);
  mirror.term.input('echo hi\r');
  assert.deepEqual(mirror.replies, ['echo hi\r']);
});

console.log(`\n${passed} terminal mirror reply tests passed`);
