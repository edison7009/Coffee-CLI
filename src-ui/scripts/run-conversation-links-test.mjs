import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/conversation-links.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { conversationLink: link, findPaths, pathLinkAt } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const cwd = 'D:\\Test Project';
for (const [href, path] of [
  ['simple-web-test/index.html', 'D:/Test Project/simple-web-test/index.html'],
  ['./test%20page.html', 'D:/Test Project/test page.html'],
  ['../shared/readme.md#L12', 'D:/shared/readme.md'],
  ['file:///D:/Test%20Project/index.html', 'D:/Test Project/index.html'],
  ['D:\\Test Project\\src\\app.ts:12:3', 'D:/Test Project/src/app.ts'],
  ['D:/Test%20Project/src/app.ts#L12', 'D:/Test Project/src/app.ts'],
  ['file:///home/user/a%20b.html', '/home/user/a b.html'],
  ['file://server/share/readme.md', '//server/share/readme.md'],
  ['./%2520.html', 'D:/Test Project/%20.html'],
  ['D:/', 'D:/'],
]) assert.deepEqual(link(href, cwd), { target: path, local: true }, href);
assert.deepEqual(link('https://example.com/?a=1&b=2', cwd), { target: 'https://example.com/?a=1&b=2', local: false });
for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'vbscript:open()', 'tauri://localhost', '#heading', '%invalid', '']) assert.equal(link(href, cwd), null, href);
assert.equal(link('relative.html', null), null);
assert.deepEqual(link('/home/user/index.html', null), { target: '/home/user/index.html', local: true });
console.log('ok local, relative, file URL, Windows/POSIX paths, encoding, source lines and unsupported schemes');

const paths = text => findPaths(text).map(path => path.text);
assert.deepEqual(paths('D:\\Coffee-CLI\\target\\release\\bundle\\nsis\\Coffee CLI_3.8.1_x64-setup.exe'), ['D:\\Coffee-CLI\\target\\release\\bundle\\nsis\\Coffee CLI_3.8.1_x64-setup.exe'], 'spaces inside a file name');
assert.deepEqual(paths('C:\\Program Files\\Git\\bin\\git.exe is ready'), ['C:\\Program Files\\Git\\bin\\git.exe']);
// Languages without spaces run into a path and on out of a file name; folders in those languages stay whole.
assert.deepEqual(paths('已修改src/app.ts'), ['src/app.ts']);
assert.deepEqual(paths('修改D:\\a.ts'), ['D:\\a.ts']);
assert.deepEqual(paths('src/app.ts文件已更新'), ['src/app.ts']);
assert.deepEqual(paths('文档/说明.md'), ['文档/说明.md']);
assert.equal(findPaths('已修改src/app.ts')[0].start, 3);
assert.deepEqual(paths('see D:\\repo\\app.ts, then D:/repo/b.ts.'), ['D:\\repo\\app.ts', 'D:/repo/b.ts']);
assert.deepEqual(paths('D:\\repo\\src is a folder'), ['D:\\repo\\src'], 'prose after a folder stays out');
assert.deepEqual(paths('D:\\one and D:\\two.txt'), ['D:\\one', 'D:\\two.txt'], 'a second path is not swallowed');
assert.deepEqual(paths('文件在 D:\\资料\\说明.md这里'), ['D:\\资料\\说明.md'], 'Chinese text running on after the name');
assert.deepEqual(paths('at src/lib/app.ts:12:3 and ./run.sh or /usr/local/bin/tool'), ['src/lib/app.ts:12:3', './run.sh', '/usr/local/bin/tool']);
assert.deepEqual(paths('and/or 10/31/2026 https://example.com/a/b.html file:///D:/a.txt 1.2.3 /help'), [], 'prose, dates, URLs and commands are not paths');
const line = 'open D:\\Coffee-CLI\\Coffee CLI_3.8.1.exe now';
assert.equal(pathLinkAt(line, 12, null).target, 'D:/Coffee-CLI/Coffee CLI_3.8.1.exe');
assert.equal(pathLinkAt(line, 1, null), null);
assert.equal(pathLinkAt('src/app.ts', 3, null), null, 'a relative path needs a folder');
assert.equal(pathLinkAt('src/app.ts', 3, 'D:\\Repo').target, 'D:/Repo/src/app.ts');
console.log('OK: paths in plain text, including spaces, Chinese text and non-paths');

