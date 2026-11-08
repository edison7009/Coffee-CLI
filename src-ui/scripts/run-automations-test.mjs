/** Automation schedules with `node scripts/run-automations-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/automations.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const store = new Map([['cc-automations', JSON.stringify([{ id: 'old', name: 'o', prompt: 'p', tool: 'codex', cwd: '/w', enabled: false, createdAt: 0, schedule: { kind: 'interval', hours: 2 } }, { id: 'week', name: 'w', prompt: 'p', tool: 'pi', cwd: '/w', enabled: false, createdAt: 0, schedule: { kind: 'weekly', day: 2, time: '07:00' } }])]]);
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, Date, JSON, Math, Number, localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } });
const { nextRunAt, scheduleNext, saveAutomation, dueAutomations, getAutomations } = module.exports;
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const fri = at(2026, 11, 6, 10, 0); // a Friday
assert.equal(nextRunAt({ kind: 'daily', time: '09:00' }, fri), at(2026, 11, 7, 9), 'daily: tomorrow once today has passed');
assert.equal(nextRunAt({ kind: 'daily', time: '18:30' }, fri), at(2026, 11, 6, 18, 30), 'daily: later today');
assert.equal(nextRunAt({ kind: 'weekdays', time: '09:00' }, fri), at(2026, 11, 9, 9), 'weekdays skip the weekend');
assert.equal(nextRunAt({ kind: 'weekly', days: [3], time: '08:00' }, fri), at(2026, 11, 11, 8), 'weekly: the next Wednesday');
assert.equal(nextRunAt({ kind: 'weekly', days: [1, 6], time: '08:00' }, fri), at(2026, 11, 7, 8), 'weekly: the nearest of several days');
assert.equal(nextRunAt({ kind: 'interval', minutes: 240 }, fri, fri - 60 * 60 * 1000), fri + 3 * 60 * 60 * 1000, 'interval from its anchor');
assert.equal(nextRunAt({ kind: 'interval', minutes: 90 }, fri, fri), fri + 90 * 60 * 1000, 'interval in minutes');
assert.equal(nextRunAt({ kind: 'interval', minutes: 1 }, fri, fri), fri + 5 * 60 * 1000, 'an interval is at least five minutes');
assert.equal(JSON.stringify(getAutomations()[0].schedule), '{"kind":"interval","minutes":120}', 'an hourly interval saved before becomes minutes');
assert.equal(JSON.stringify(getAutomations()[1].schedule), '{"kind":"weekly","days":[2],"time":"07:00"}', 'a one-day week saved before becomes a list');
assert.equal(nextRunAt({ kind: 'once', at: fri + 1000 }, fri), fri + 1000);
assert.equal(nextRunAt({ kind: 'once', at: fri - 1000 }, fri), undefined, 'a past one-off has no next run');
const once = scheduleNext({ id: 'o', enabled: true, createdAt: fri, schedule: { kind: 'once', at: fri - 1 } }, fri);
assert.equal(once.enabled, false, 'a one-off with nothing left turns itself off');
assert.equal(scheduleNext({ id: 'p', enabled: false, createdAt: fri, schedule: { kind: 'daily', time: '09:00' } }, fri).nextAt, undefined, 'a paused automation has no next run');
// A run missed while closed is due once, not once per missed day.
saveAutomation({ id: 'd', name: 'd', prompt: 'p', tool: 'claude', cwd: '/w', enabled: true, createdAt: fri, schedule: { kind: 'daily', time: '09:00' } });
const saved = getAutomations().find(item => item.id === 'd');
assert.ok(saved.nextAt > Date.now() - 1000);
const late = saved.nextAt + 5 * 24 * 60 * 60 * 1000;
assert.equal(dueAutomations(late).length, 1, 'only the enabled one, once');
assert.ok(JSON.parse(store.get('cc-automations')).some(item => item.id === 'd'), 'automations are saved');
console.log('OK: daily, weekday, weekly (several days, old single day), interval (minutes, old hours) and one-off schedules; pausing; a missed run is due once');
