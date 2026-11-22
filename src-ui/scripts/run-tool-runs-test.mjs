// Adjacent tool calls fold into one group (src/lib/tool-runs.ts): only runs of two or more under the same
// parent, rows keep their indexes, and the title counts each kind of call in reading order.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/tool-runs.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { toolRuns, toolRunSummary, toolRunStatus, toolKind } = module.exports;

const tool = (toolName, toolStatus = 'done', parentId) => ({ role: 'tool', toolName, toolStatus, parentId });
const text = { role: 'assistant' };
const messages = [text, tool('Read'), tool('Grep'), text, tool('Bash'), text, tool('Edit'), tool('Edit', 'done', 'sub'), tool('Read', 'done', 'sub'), tool('Bash', 'running', 'sub')];
const runs = toolRuns(messages);
assert.deepEqual(JSON.parse(JSON.stringify([...runs.lead])), [[1, 2], [7, 9]], 'runs of two or more, split where the parent changes');
assert.deepEqual(JSON.parse(JSON.stringify([...runs.follower])), [2, 8, 9]);
assert.ok(!runs.lead.has(4) && !runs.lead.has(6), 'a single call stays as it is');
assert.equal(toolRuns([]).lead.size, 0);

const zh = { 'tools.group.read': '读取 {count} 个文件', 'tools.group.search': '搜索 {count} 次', 'tools.group.edit': '修改 {count} 个文件', 'tools.group.run': '运行 {count} 条命令', 'tools.group.remote': '操作远程窗口 {count} 次', 'tools.group.other': '调用 {count} 个工具', 'tools.group.join': '、' };
const t = (key, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), zh[key] ?? key);
assert.equal(toolRunSummary([tool('Bash'), tool('Read'), tool('Read'), tool('Edit')], t), '读取 2 个文件、修改 1 个文件、运行 1 条命令');
assert.equal(toolRunSummary([tool('mcp__coffee-control__tab_send'), tool('coffee-control_tab_key'), tool('SomethingNew')], t), '操作远程窗口 2 次、调用 1 个工具');
const en = { 'tools.group.read': 'read {count} files', 'tools.group.join': ', ' };
assert.equal(toolRunSummary([tool('Read')], (key, vars = {}) => (en[key] ?? key).replace('{count}', vars.count)), 'Read 1 files', 'a sentence starts with a capital');

assert.equal(toolRunStatus([tool('Read'), tool('Bash', 'running')]), 'running');
assert.equal(toolRunStatus([tool('Read'), { role: 'tool', toolName: 'Bash' }]), 'running', 'no status yet means it is still running');
assert.equal(toolRunStatus([tool('Read'), tool('Bash', 'failed')]), 'failed');
assert.equal(toolRunStatus([tool('Read'), tool('Grep')]), 'done');
assert.equal(toolKind('Task'), 'team');
console.log('tool runs: ok');
