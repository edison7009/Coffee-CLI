import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({ entryPoints: [`${root}src/lib/home-short-path.ts`], bundle: true, platform: 'node', format: 'esm', write: false });
const { homeShortPath } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

assert.equal(homeShortPath('/Users/eben/Downloads', '/Users/eben'), '~/Downloads');
assert.equal(homeShortPath('/Users/eben', '/Users/eben/'), '~');
assert.equal(homeShortPath('/Users/ebenx2/app', '/Users/eben'), '/Users/ebenx2/app', 'a similar name is not the home');
assert.equal(homeShortPath('/Users/Shared/site', '/Users/eben'), '/Users/Shared/site', 'other folders under /Users stay');
assert.equal(homeShortPath('/home/alice/repo', '/home/bob'), '/home/alice/repo', 'another account stays');
assert.equal(homeShortPath('/home/bob/项目/coffee', '/home/bob'), '~/项目/coffee');
assert.equal(homeShortPath('C:\\Users\\eben\\Desktop', 'C:\\Users\\eben'), '~\\Desktop');
assert.equal(homeShortPath('c:/users/eben/Desktop', 'C:\\Users\\eben'), '~/Desktop', 'Windows matches case-insensitively and with either slash');
assert.equal(homeShortPath('D:\\Projects\\app', 'C:\\Users\\eben'), 'D:\\Projects\\app');
assert.equal(homeShortPath('/Volumes/扩展存储/coffee-cli', '/Users/eben'), '/Volumes/扩展存储/coffee-cli');
assert.equal(homeShortPath('/Users/eben/app', null), '/Users/eben/app', 'unknown home leaves paths whole');
console.log('OK: card paths shorten only the current user\'s home folder to ~ on macOS, Linux and Windows');
