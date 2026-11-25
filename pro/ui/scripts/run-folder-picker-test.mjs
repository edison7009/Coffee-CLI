// Folder picker paths, the computer's way: Windows drives and shares, POSIX roots.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/folder-picker.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', external: ['react'] });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: () => ({ useSyncExternalStore: () => null }) });
const { crumbs, parentOf, normalizeTypedPath, isHiddenFolder, pickFolder } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));

// POSIX
assert.deepEqual(plain(crumbs('/Volumes/扩展存储/coffee-cli', '/')), [{ name: '/', path: '/' }, { name: 'Volumes', path: '/Volumes' }, { name: '扩展存储', path: '/Volumes/扩展存储' }, { name: 'coffee-cli', path: '/Volumes/扩展存储/coffee-cli' }]);
assert.equal(parentOf('/Users/me', '/'), '/Users');
assert.equal(parentOf('/', '/'), null);
assert.equal(normalizeTypedPath('  "/Users/me/code/"  ', '/'), '/Users/me/code');
assert.equal(normalizeTypedPath('/', '/'), '/');

// Windows drives
assert.deepEqual(plain(crumbs('D:\\code\\app', '\\')), [{ name: 'D:', path: 'D:\\' }, { name: 'code', path: 'D:\\code' }, { name: 'app', path: 'D:\\code\\app' }]);
assert.equal(parentOf('D:\\code', '\\'), 'D:\\');
assert.equal(parentOf('D:\\', '\\'), null);
assert.equal(normalizeTypedPath('d:/Users/me/', '\\'), 'd:\\Users\\me', 'forward slashes typed on Windows');
assert.equal(normalizeTypedPath('C:\\', '\\'), 'C:\\', 'a drive root keeps its separator');
assert.equal(plain(crumbs('C:', '\\'))[0].path, 'C:\\');

// Windows network shares
assert.deepEqual(plain(crumbs('\\\\nas\\share\\proj', '\\')).map(c => c.path), ['\\\\nas\\share\\', '\\\\nas\\share\\proj']);
assert.equal(parentOf('\\\\nas\\share\\proj', '\\'), '\\\\nas\\share\\');

// Relative or empty input has no root to walk.
assert.deepEqual(plain(crumbs('code/app', '/')), []);

// Hidden folders
assert.ok(isHiddenFolder('.git', '/') && !isHiddenFolder('src', '/'));
assert.ok(isHiddenFolder('$Recycle.Bin', '\\') && isHiddenFolder('System Volume Information', '\\') && !isHiddenFolder('$Recycle.Bin', '/'));

// A second request cancels the first.
const first = pickFolder();
const second = pickFolder();
assert.equal(await first, null);
void second;
console.log('ok folder picker paths: POSIX, Windows drives and shares, hidden folders, one request at a time');
