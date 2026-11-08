/** Automation schedules with `node scripts/run-automations-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/automations.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const store = new Map();
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date, JSON, Math, Number, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
const { nextRunAt, scheduleNext, saveAutomation, dueAutomations, getAutomations } = module.exports;
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const fri = at(2026, 11, 6, 10, 0); // a Friday
assert.equal(nextRunAt({ kind: 'daily', time: '09:00' }, fri), at(2026, 11, 7, 9), 'daily: tomorrow once today has passed');
assert.equal(nextRunAt({ kind: 'daily', time: '18:30' }, fri), at(2026, 11, 6, 18, 30), 'daily: later today');
assert.equal(nextRunAt({ kind: 'weekdays', time: '09:00' }, fri), at(2026, 11, 9, 9), 'weekdays skip the weekend');
assert.equal(nextRunAt({ kind: 'weekly', day: 3, time: '08:00' }, fri), at(2026, 11, 11, 8), 'weekly: the next Wednesday');
assert.equal(nextRunAt({ kind: 'interval', hours: 4 }, fri, fri - 60 * 60 * 1000), fri + 3 * 60 * 60 * 1000, 'interval from its anchor');
assert.equal(nextRunAt({ kind: 'once', at: fri + 1000 }, fri), fri + 1000);
assert.equal(nextRunAt({ kind: 'once', at: fri - 1000 }, fri), undefined, 'a past one-off has no next run');
const once = scheduleNext({ id: 'o', enabled: true, createdAt: fri, schedule: { kind: 'once', at: fri - 1 } }, fri);
assert.equal(once.enabled, false, 'a one-off with nothing left turns itself off');
assert.equal(scheduleNext({ id: 'p', enabled: false, createdAt: fri, schedule: { kind: 'daily', time: '09:00' } }, fri).nextAt, undefined, 'a paused automation has no next run');
// A run missed while closed is due once, not once per missed day.
saveAutomation({ id: 'd', name: 'd', prompt: 'p', tool: 'claude', cwd: '/w', enabled: true, createdAt: fri, schedule: { kind: 'daily', time: '09:00' } });
const saved = getAutomations()[0];
assert.ok(saved.nextAt > Date.now() - 1000);
const late = saved.nextAt + 5 * 24 * 60 * 60 * 1000;
assert.equal(dueAutomations(late).length, 1);
assert.ok(JSON.parse(store.get('cc-automations'))[0].id === 'd', 'automations are saved');
console.log('OK: daily, weekday, weekly, interval and one-off schedules; pausing; a missed run is due once');
