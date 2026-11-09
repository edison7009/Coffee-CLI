import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/pre-input-project.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { projectRoot, sameProject, projectName } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
assert.equal(projectRoot(undefined), undefined);
assert.equal(projectRoot(null), undefined);
assert.equal(projectRoot('/Users/me/app/'), '/Users/me/app', 'a trailing slash is not part of the project');
assert.equal(projectRoot('/Users/me/app/.claude/worktrees/coffee-fix'), '/Users/me/app', 'a worktree belongs to its project');
assert.equal(projectRoot('D:\\work\\app\\.claude\\worktrees\\coffee-fix\\src'), 'D:\\work\\app', 'Windows worktree paths too');
assert.equal(projectRoot('/'), '/', 'the filesystem root stays itself');
assert.ok(sameProject('D:\\Work\\App\\', 'd:/work/app'), 'Windows drive paths ignore separators, trailing slashes and case');
assert.ok(!sameProject('/Users/me/App', '/Users/me/app'), 'other paths keep their case');
assert.ok(!sameProject(undefined, '/a') && !sameProject('/a', undefined), 'a missing folder matches nothing');
assert.equal(projectName('/Users/me/coffee-cli/'), 'coffee-cli');
assert.equal(projectName('D:\\work\\项目'), '项目');
console.log('ok pre-input project roots, worktrees, cross-platform matching and names');
