import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['src/lib/welcome-greeting.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { welcomeGreeting } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
for (const [hour, greeting] of [[0, 'Good evening'], [4, 'Good evening'], [5, 'Good morning'], [11, 'Good morning'], [12, 'Good afternoon'], [17, 'Good afternoon'], [18, 'Good evening'], [23, 'Good evening']]) {
  assert.equal(welcomeGreeting(hour, ' TEST-DESKTOP '), `${greeting}, TEST-DESKTOP`);
  assert.equal(welcomeGreeting(hour, ''), greeting, 'a pending computer name does not produce a trailing comma');
}
assert.equal(welcomeGreeting(9, '工作电脑'), 'Good morning, 工作电脑', 'computer names retain their actual spelling');
console.log('ok English greetings, local time boundaries, computer name formatting and missing-name fallback');
