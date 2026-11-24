// Codex and OpenCode items become the shared step rows (src/lib/step-cards.ts): Claude's tool names and inputs, a
// change per file, status lines as notices, so every tool draws the same step line, fold and changed-files card.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const load = async file => {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
  return module.exports;
};
const { codexStepCards, openCodeStepCard, diffSides, acpToolStep } = await load('../src/lib/step-cards.ts');
const { changedFiles, turnFolds } = await load('../src/lib/turn-work.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const pick = (card, ...keys) => plain(Object.fromEntries(keys.map(key => [key, card[key]])));

assert.deepEqual(plain(diffSides('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n+more')), { old_string: 'keep\nold\n', new_string: 'keep\nnew\nmore\n' });

const codex = (item, extra = {}) => ({ id: 't:' + (item.id ?? 'x'), turnId: 't', item, role: item.type === 'reasoning' ? 'reasoning' : item.type === 'agentMessage' ? 'assistant' : 'tool', content: extra.content ?? '', partial: false, timestamp: 1, toolStatus: 'done', ...extra });
assert.deepEqual(pick(codexStepCards(codex({ type: 'commandExecution', command: 'npm test', commandActions: [{ type: 'unknown' }] }, { content: '24 passed' }))[0], 'role', 'toolName', 'input', 'output', 'toolStatus'),
  { role: 'tool', toolName: 'Bash', input: { command: 'npm test' }, output: '24 passed', toolStatus: 'done' });
assert.deepEqual(pick(codexStepCards(codex({ type: 'commandExecution', command: 'cat a.ts', commandActions: [{ type: 'read', path: 'src/a.ts', name: 'a.ts' }] }))[0], 'toolName', 'input'),
  { toolName: 'Read', input: { file_path: 'src/a.ts' } }, 'a command that only reads a file reads as a read');
assert.equal(codexStepCards(codex({ type: 'commandExecution', command: 'rg x', commandActions: [{ type: 'search', query: 'x', path: 'src' }] }))[0].toolName, 'Grep');
assert.equal(codexStepCards(codex({ type: 'commandExecution', command: 'ls' }, { partial: true, toolStatus: 'running' }))[0].toolStatus, 'running');
const change = codexStepCards(codex({ type: 'fileChange', changes: [
  { path: '/p/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1,2 @@\n-a\n+b\n+c' },
  { path: '/p/new.ts', kind: { type: 'add' }, diff: '+1\n+2' },
] }));
assert.deepEqual(change.map(card => pick(card, 'id', 'toolName')), [{ id: 't:x:0', toolName: 'Edit' }, { id: 't:x:1', toolName: 'Write' }], 'each file a change touched is a step');
assert.deepEqual(plain(changedFiles(change)), [{ path: '/p/a.ts', added: 2, removed: 1, written: false }, { path: '/p/new.ts', added: 2, removed: 0, written: true }]);
assert.equal(codexStepCards(codex({ type: 'mcpToolCall', server: 'coffee-control', tool: 'tab_send', arguments: { text: 'hi' } }))[0].toolName, 'mcp__coffee-control__tab_send');
assert.equal(codexStepCards(codex({ type: 'turnStatus', status: 'completed' }))[0].role, 'notice', 'a turn\'s status line is neither a step nor a reply');
assert.equal(codexStepCards(codex({ type: 'reasoning' }, { content: 'hmm' }))[0].role, 'reasoning');

const open = (extra) => ({ id: 'o', turn: 0, timestamp: 1, partial: false, content: '', role: 'tool', toolStatus: 'done', ...extra });
assert.deepEqual(pick(openCodeStepCard(open({ toolName: 'edit', input: { filePath: '/p/a.ts', oldString: 'x\n', newString: 'y\n' } })), 'toolName', 'input'),
  { toolName: 'Edit', input: { file_path: '/p/a.ts', old_string: 'x\n', new_string: 'y\n' } });
assert.deepEqual(pick(openCodeStepCard(open({ toolName: 'read', input: { filePath: '/p/b.ts' } })), 'toolName', 'input'), { toolName: 'Read', input: { file_path: '/p/b.ts' } });
assert.deepEqual(pick(openCodeStepCard(open({ toolName: 'bash', input: { command: 'ls', description: 'List' }, output: 'a' })), 'toolName', 'input', 'output'), { toolName: 'Bash', input: { command: 'ls', description: 'List' }, output: 'a' });
assert.equal(openCodeStepCard(open({ toolName: 'coffee-control_tab_send', input: { text: 'x' } })).toolName, 'coffee-control_tab_send', 'tools of its own keep their names');
assert.equal(openCodeStepCard(open({ role: 'assistant', kind: 'idle', outcome: 'succeeded' })).role, 'notice');
assert.equal(openCodeStepCard(open({ role: 'assistant', kind: 'notice', content: 'Compacted' })).role, 'notice', 'a notice is not the turn\'s reply');

// The cards fold like Claude's: the work before the reply, the status line after it left alone.
const rows = [{ role: 'user', timestamp: 0 }, ...codexStepCards(codex({ type: 'commandExecution', command: 'ls' })), codexStepCards(codex({ type: 'agentMessage', id: 'r' }, { content: 'Done.', timestamp: 5 }))[0], ...codexStepCards(codex({ type: 'turnStatus', id: 's' }))];
assert.deepEqual(plain([...turnFolds(rows, false).lead.values()].map(fold => [fold.start, fold.end, fold.reply])), [[1, 1, 2]]);
// ACP tool calls (agy acp): the protocol's kind and locations decide the step; a finished edit is its diff.
const loc = path => [{ path }];
assert.deepEqual(plain(acpToolStep({ name: 'read_file', kind: 'read', title: 'File a.txt', locations: loc('/p/a.txt'), rawInput: { Path: '/p/a.txt' } })), { toolName: 'Read', input: { file_path: '/p/a.txt' } }, 'agy\'s read reads as a read, not its title');
assert.deepEqual(plain(acpToolStep({ name: 'write_file', kind: 'edit', locations: loc('/p/b.txt'), rawInput: { Path: '/p/b.txt', Content: 'HELLO\n' } })), { toolName: 'Write', input: { file_path: '/p/b.txt', content: 'HELLO\n' } });
assert.deepEqual(plain(acpToolStep({ name: 'write_file', kind: 'edit', content: [{ type: 'diff', path: '/p/b.txt', newText: 'HELLO\n' }] })), { toolName: 'Write', input: { file_path: '/p/b.txt', content: 'HELLO\n' } }, 'a diff with no old text wrote a new file');
assert.deepEqual(plain(acpToolStep({ name: 'replace_file_content', kind: 'edit', content: [{ type: 'diff', path: '/p/a.ts', oldText: 'a\n', newText: 'b\n' }] })), { toolName: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a\n', new_string: 'b\n' } });
assert.deepEqual(plain(acpToolStep({ name: 'run_command', kind: 'execute', title: 'echo hi', rawInput: { CommandLine: 'echo hi', toolSummary: 'Say hi' } })), { toolName: 'Bash', input: { command: 'echo hi', description: 'Say hi' } });
assert.equal(acpToolStep({ name: 'grep_search', kind: 'search', rawInput: { Query: 'TODO' } }).toolName, 'Grep');
assert.equal(acpToolStep({ name: 'list_dir', kind: 'read', rawInput: { DirectoryPath: '/p' } }).toolName, 'LS');
assert.deepEqual(plain(acpToolStep({ toolCallId: 'x', status: 'completed' }, { toolName: 'Read', input: { file_path: '/p/a.txt' } })), { toolName: 'Read', input: { file_path: '/p/a.txt' } }, 'an update without input keeps what the call was');
assert.equal(acpToolStep({ rawInput: { TargetFile: '/p/a.ts' }, content: [{ type: 'content', content: { type: 'text', text: 'File updated' } }] }, { toolName: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } }).input.old_string, 'a', 'output after the diff keeps the diff');
console.log('step cards: ok');
