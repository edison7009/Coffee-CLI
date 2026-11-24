// A finished turn folds its work into one row and lists the files it changed (src/lib/turn-work.ts).
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/turn-work.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { turnFolds, changedFiles } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));

const user = timestamp => ({ role: 'user', content: 'q', timestamp });
const say = (content, timestamp, extra = {}) => ({ role: 'assistant', content, timestamp, ...extra });
const tool = (toolName, input = {}, toolStatus = 'done', extra = {}) => ({ role: 'tool', toolName, input, toolStatus, timestamp: 0, ...extra });
const think = { role: 'reasoning', content: 'hmm', timestamp: 0 };

// Turn 1: thinking, commentary, calls, then the reply. Turn 2: a plain answer. Turn 3: still running.
const messages = [
  user(1000), think, say('先看一下。', 1100), tool('Read'), tool('Bash', {}, 'failed'), say('已修好。', 46000, { turnStats: { durationMs: 45000 } }),
  user(50000), say('好的。', 51000),
  user(60000), tool('Read'),
];
let folds = turnFolds(messages, true);
assert.deepEqual(plain([...folds.lead]), [[1, { start: 1, end: 4, prompt: 0, reply: 5, durationMs: 45000, failed: true, stopped: false, steps: ['think', 'tool', 'fail'] }]], 'work before the reply folds; a plain answer and the running turn do not');
assert.deepEqual(plain([...folds.hidden]), [2, 3, 4], 'the lead row stays, the rest hide');
folds = turnFolds(messages, false);
assert.deepEqual(plain(folds.lead.get(9)), { start: 9, end: 9, prompt: 8, failed: false, stopped: true, steps: ['tool'] }, 'a finished turn without a reply folds everything, reads as stopped, and a time out of order gives no duration');

// Duration falls back to the reply's time; an interrupted call marks the turn stopped and is not a failure.
folds = turnFolds([user(0), tool('Bash', {}, 'failed', { interrupted: true }), say('停了。', 7000)], false);
assert.deepEqual(plain(folds.lead.get(1)), { start: 1, end: 1, prompt: 0, reply: 2, durationMs: 7000, failed: false, stopped: true, steps: ['tool'] });
// A sub-agent's closing message is not the turn's reply.
folds = turnFolds([user(0), tool('Task'), say('子任务结论', 5, { parentId: 't' }), say('总结', 9)], false);
assert.equal(folds.lead.get(1).end, 2);
assert.deepEqual(plain(folds.lead.get(1).steps), ['tool'], 'a sub-agent\'s own steps are not the turn\'s');
assert.deepEqual(plain(turnFolds([user(0), tool('Edit'), tool('Write', {}, 'failed'), say('ok', 1)], false).lead.get(1).steps), ['edit', 'fail']);
assert.equal(turnFolds([], false).lead.size, 0);
assert.equal(turnFolds([user(0), tool('Bash', {}, 'failed', { interrupted: true }), { role: 'notice', content: 'interrupted', timestamp: 9 }], false).lead.get(1).end, 1, 'the closing status line stays outside the fold');
assert.equal(turnFolds([user(0), tool('Read'), tool('Task', {}, 'running')], false).lead.size, 0, 'a call still running keeps the turn open');
assert.deepEqual(plain([...turnFolds([user(0), tool('Read'), say('等子任务回报。', 5), tool('Task', {}, 'running')], false).lead.keys()]), [1], 'work after the reply stays in sight');
assert.equal(turnFolds([user(0), say('答案', 5), { ...think }], false).lead.size, 0, 'a thought after the reply folds nothing away from it');

const files = changedFiles([
  tool('Edit', { file_path: '/p/a.ts', old_string: 'x\n', new_string: 'y\nz\n' }),
  tool('Write', { file_path: '/p/b.ts', content: '1\n2\n3\n' }),
  tool('Edit', { file_path: '/p/a.ts', old_string: 'q\n', new_string: '' }),
  tool('MultiEdit', { file_path: '/p/c.ts', edits: [{ old_string: 'a\n', new_string: 'b\n' }, { old_string: '', new_string: 'n\n' }] }),
  tool('Edit', { file_path: '/p/failed.ts', old_string: 'a', new_string: 'b' }, 'failed'),
  tool('Read', { file_path: '/p/read.ts' }),
]);
assert.deepEqual(plain(files), [
  { path: '/p/a.ts', added: 2, removed: 2, written: false },
  { path: '/p/b.ts', added: 3, removed: 0, written: true },
  { path: '/p/c.ts', added: 2, removed: 1, written: false },
], 'edits sum per file in first-touched order; failed calls and reads do not count');
console.log('turn work: ok');

const { absoluteToolPath, changedFileSelection } = module.exports;
assert.equal(absoluteToolPath('src/a.ts', '/p/'), '/p/src/a.ts', 'a relative path joins the conversation folder');
assert.equal(absoluteToolPath('./a.ts', 'C:\\w'), 'C:/w/a.ts');
assert.equal(absoluteToolPath('D:\\x\\b.ts', '/p'), 'D:/x/b.ts', 'an absolute path stays');
const git = { state: 'ok', repo_root: '/p', uncommitted: [{ path: '/p/src/a.ts', rel: 'src/a.ts', added: 3, deleted: 1 }], untracked: [{ path: '/p/new.ts', rel: 'new.ts', added: 5, deleted: 0 }] };
assert.deepEqual(plain(changedFileSelection('src/a.ts', '/p', git)), { repoRoot: '/p', folderPath: '/p', path: '/p/src/a.ts', rel: 'src/a.ts', kind: 'uncommitted', added: 3, deleted: 1 }, 'an uncommitted file opens its diff');
assert.equal(changedFileSelection('/p/new.ts', '/p', git).kind, 'untracked');
assert.equal(changedFileSelection('c:/W/A.ts', 'C:/w', { state: 'ok', repo_root: 'C:/w', uncommitted: [{ path: 'C:/w/a.ts', rel: 'a.ts', added: 1, deleted: 0 }], untracked: [] }).kind, 'uncommitted', 'Windows paths match regardless of case');
assert.deepEqual(plain(changedFileSelection('/p/done.ts', '/p', git)), { repoRoot: '/p', folderPath: '/p', path: '/p/done.ts', rel: 'done.ts', kind: 'file' }, 'a committed or untracked-by-git file opens as itself');
assert.equal(changedFileSelection('/p/a.ts', '/p', { state: 'not_repo' }).kind, 'file');
console.log('changed file selection: ok');
