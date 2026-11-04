import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({ entryPoints: [`${root}src/lib/home-short-path.ts`], bundle: true, platform: 'node', format: 'esm', write: false });
const { homeShortPath } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

assert.equal(homeShortPath('/Users/eben/Downloads'), '~/Downloads');
assert.equal(homeShortPath('/Users/eben'), '~');
assert.equal(homeShortPath('/home/eben/项目/coffee'), '~/项目/coffee');
assert.equal(homeShortPath('C:\\Users\\eben\\Desktop'), '~\\Desktop');
assert.equal(homeShortPath('c:\\Users\\eben'), '~');
assert.equal(homeShortPath('/Volumes/扩展存储/coffee-cli'), '/Volumes/扩展存储/coffee-cli', 'other volumes stay as they are');
assert.equal(homeShortPath('D:\\Projects\\app'), 'D:\\Projects\\app');
assert.equal(homeShortPath('/Users/ebenx2/app'), '~/app');
assert.equal(homeShortPath('/Usersfoo/app'), '/Usersfoo/app', 'only a real home prefix is shortened');
console.log('OK: card paths shorten the home folder to ~ on macOS, Linux and Windows and leave other paths untouched');
