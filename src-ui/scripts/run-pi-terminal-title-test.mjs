import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/pi-terminal-title.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { parsePiTerminalTitle } = module.exports;

// Pi 1.5.0 `interactive-mode.ts`: `${APP_TITLE} - ${sessionName} - ${cwdBasename}` or `${APP_TITLE} - ${cwdBasename}`.
assert.equal(parsePiTerminalTitle('π - Downloads'), null, 'an unnamed session titles only its folder');
assert.equal(parsePiTerminalTitle('π - Fix the build - coffee-cli'), 'Fix the build');
assert.equal(parsePiTerminalTitle('π - a - b - my-app'), 'a - b', 'a name may contain the separator');
assert.equal(parsePiTerminalTitle('π - 制作网页 - 项目'), '制作网页');
assert.equal(parsePiTerminalTitle('my-pi - Downloads'), 'my-pi - Downloads', 'a renamed app title is kept as Pi gave it');
assert.equal(parsePiTerminalTitle('  '), null);
console.log('OK: Pi terminal titles name the tab only with a session name');
