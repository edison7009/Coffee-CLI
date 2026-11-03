import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// The copyable resume command mirrors AGENT_PRESETS in src/terminal.rs; every preset
// that can resume must produce the same program and flags here.
const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({ entryPoints: [`${root}src/lib/resume-command.ts`], bundle: true, platform: 'node', format: 'esm', write: false });
const { buildResumeCommand } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const rust = await readFile(new URL('../../src/terminal.rs', import.meta.url), 'utf8');
const block = rust.slice(rust.indexOf('pub const AGENT_PRESETS'), rust.indexOf('pub fn find_preset'));
const presets = [...block.matchAll(/AgentPreset \{([\s\S]*?)\n    \}/g)].map(([, body]) => ({
  tool: body.match(/tool_name: "([^"]+)"/)[1],
  program: body.match(/resume_program: Some\("([^"]+)"\)/)?.[1] ?? null,
  before: [...(body.match(/resume_args_before: &\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(match => match[1]),
}));
assert.ok(presets.length >= 10, `parsed the Rust presets: ${presets.length}`);
for (const preset of presets) {
  const expected = preset.program ? [preset.program, ...preset.before, 'TOKEN'].join(' ') : null;
  assert.equal(buildResumeCommand(preset.tool, 'TOKEN'), expected, `${preset.tool} copy command matches its Rust resume preset`);
}
assert.equal(buildResumeCommand('antigravity', 'f99ca1a5-1184-4740-8c60-5c28d2252186'), 'agy --conversation f99ca1a5-1184-4740-8c60-5c28d2252186');
assert.equal(buildResumeCommand('antigravity', null), null);
console.log(`OK: copyable resume commands match all ${presets.length} Rust resume presets, including Antigravity CLI`);
