// Manual native CLI contract check. All configuration and installations stay
// in one temporary directory; no model requests or user project writes occur.
// Run: node scripts/run-agent-capability-flow-test.mjs [--skills] [--graphify] [--helper <Coffee executable>] [--helper-shell]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'coffee-capability-flow-'));
const project = path.join(temporaryRoot, 'project with spaces 项目');
const claudeConfig = path.join(temporaryRoot, 'claude-config');
const codexConfig = path.join(temporaryRoot, 'codex-config');
for (const directory of [project, claudeConfig, codexConfig]) mkdirSync(directory, { recursive: true });

const environment = { ...process.env, CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexConfig,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
  npm_config_cache: path.join(temporaryRoot, 'npm-cache'), npm_config_update_notifier: 'false',
  UV_CACHE_DIR: path.join(temporaryRoot, 'uv-cache'), GRAPHIFY_NO_AUTO_REFRESH: '1' };
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) delete environment[key];

function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(candidate)) return { binary: candidate, prefix: [] };
    if (process.platform === 'win32' && name === 'codex') {
      const entry = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (existsSync(entry)) {
        const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
        const native = path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
          `codex-win32-${process.arch}`, 'vendor', triple, 'bin', 'codex.exe');
        if (existsSync(native)) return { binary: native, prefix: [] };
        return { binary: process.execPath, prefix: [entry] };
      }
    }
  }
  return null;
}

function run(command, args, cwd = project, timeout = 60_000) {
  const result = spawnSync(command.binary, [...command.prefix, ...args], {
    cwd, env: environment, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Command exited ${result.status}: ${(result.stderr + result.stdout).slice(-3000)}`);
  return result.stdout;
}

async function codexSkills(command) {
  const child = spawn(command.binary, [...command.prefix, 'app-server', '--stdio'], {
    cwd: project, env: environment, windowsHide: true,
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 0;
  lines.on('line', line => {
    const response = JSON.parse(line);
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    clearTimeout(waiting.timer);
    if (response.error) waiting.reject(new Error(JSON.stringify(response.error)));
    else waiting.resolve(response.result);
  });
  // No model/provider calls are made; discard diagnostic noise from the CLI.
  child.stderr.resume();
  child.on('error', error => { for (const waiting of pending.values()) waiting.reject(error); });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`Codex ${method} timed out`)), 20_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request('initialize', { clientInfo: { name: 'coffee_capability_contract', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return await request('skills/list', { cwds: [project], forceReload: true });
  } finally {
    for (const waiting of pending.values()) clearTimeout(waiting.timer);
    child.stdin.end();
    child.kill();
    lines.close();
    await closed;
  }
}

const server = path.join(temporaryRoot, 'fixture-server.mjs');
const activity = path.join(temporaryRoot, 'mcp-activity.jsonl');
writeFileSync(server, `import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(process.argv[2], JSON.stringify({ method: request.method }) + '\\n');
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'coffee-isolated-fixture', version: '1.0.0' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: process.argv[3] === 'malformed' ? '' : 'fixture_echo', description: 'Read-only echo', inputSchema: { type: 'object', properties: {} } }] };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture-only' }] };
  else if (request.method === 'resources/list') result = { resources: [] };
  else if (request.method === 'prompts/list') result = { prompts: [] };
  else result = {};
  const reply = JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n';
  if (request.method === 'tools/list' && Number(process.argv[4]) > 0) setTimeout(() => process.stdout.write(reply), Number(process.argv[4]));
  else process.stdout.write(reply);
});
`);

function verifyHelper(binary) {
  assert.ok(path.isAbsolute(binary) && existsSync(binary), 'Pass an existing absolute Coffee executable to --helper');
  const rustc = executable('rustc');
  assert.ok(rustc, 'rustc is required to fingerprint the isolated preexisting configuration');
  const hashSource = path.join(temporaryRoot, 'fixture-fingerprint.rs');
  const hashBinary = path.join(temporaryRoot, process.platform === 'win32' ? 'fixture-fingerprint.exe' : 'fixture-fingerprint');
  writeFileSync(hashSource, `use std::hash::{Hash, Hasher};
fn main() {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    std::fs::read(std::env::args().nth(1).unwrap()).unwrap().hash(&mut hash);
    print!("{:x}", hash.finish());
}
`);
  run(rustc, [hashSource, '--crate-name', 'coffee_fixture_fingerprint', '-o', hashBinary]);
  const storage = path.join(temporaryRoot, "helper agent's data 项目");
  const plans = path.join(storage, 'capability-plans');
  mkdirSync(plans, { recursive: true });
  const prepare = (malformed, label = malformed ? 'failure' : 'success', delay = 0) => {
    const cwd = path.join(temporaryRoot, `helper ${label} 项目`);
    mkdirSync(cwd);
    const canonical = realpathSync(cwd);
    const target = path.join(canonical, '.mcp.json');
    const original = '{"mcpServers":{"existing":{"command":"keep-existing"}},"keep":true}\n';
    if (malformed) writeFileSync(target, original);
    const id = randomUUID();
    const log = path.join(temporaryRoot, `helper-activity-${id}.jsonl`);
    const specification = { type: 'stdio', command: process.execPath, args: [server, log, malformed ? 'malformed' : 'valid', String(delay)], env: {} };
    const file = path.join(plans, `${id}.json`);
    writeFileSync(file, JSON.stringify({ planId: id, identity: 'isolated-helper-test', tool: 'claude', cwd: canonical,
      kind: 'mcp', source: 'local-fixture/coffee-self-test', name: 'coffee-helper-fixture', scope: 'project', state: 'approved',
      sourceEvidence: { kind: 'mcp', source: 'local-fixture/coffee-self-test', fixtureOnly: true },
      targetPaths: [target], fingerprints: [malformed ? run({ binary: hashBinary, prefix: [] }, [target]).trim() : 'absent'],
      installArgv: [], server: specification, receipt: null }));
    return { id, cwd: canonical, target, original, log, specification, file };
  };
  const invokeHelper = (fixture, shell = false) => {
    const values = [binary, '__capability-apply', storage, fixture.id];
    const script = `& ${values.map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}`;
    const args = shell ? ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : values.slice(1);
    const result = spawnSync(shell ? 'powershell.exe' : binary, args, {
      cwd: fixture.cwd, env: environment, encoding: 'utf8', timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    assert.ifError(result.error);
    const saved = JSON.parse(readFileSync(fixture.file, 'utf8'));
    return { ...result, receipt: saved.receipt, state: saved.state };
  };
  const success = prepare(false);
  const installed = invokeHelper(success);
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  assert.equal(installed.state, 'verified');
  assert.equal(installed.receipt.configurationVerified, true);
  assert.equal(installed.receipt.protocolVerified, true);
  assert.equal(installed.receipt.exitCode, 0);
  assert.equal(installed.receipt.targetCliLoaded, null);
  assert.equal(installed.receipt.scope, 'project');
  assert.deepEqual(JSON.parse(readFileSync(success.target, 'utf8')).mcpServers['coffee-helper-fixture'], success.specification);
  assert.deepEqual(readFileSync(success.log, 'utf8').trim().split('\n').map(line => JSON.parse(line).method),
    ['initialize', 'notifications/initialized', 'tools/list']);
  console.log('  ok  real Coffee helper installs project MCP, verifies initialize/tools/list and persists an honest receipt');

  const failure = prepare(true);
  const failed = invokeHelper(failure);
  assert.notEqual(failed.status, 0, 'A malformed protocol must make the actual helper exit nonzero');
  assert.equal(failed.state, 'failed-rolled-back');
  assert.equal(failed.receipt.protocolVerified, false);
  assert.equal(failed.receipt.rolledBack, true);
  assert.equal(failed.receipt.exitCode, 0, 'Configuration write succeeded; protocol validation caused the action failure');
  assert.equal(readFileSync(failure.target, 'utf8'), failure.original);
  assert.equal(readFileSync(path.join(failed.receipt.backupPath, '0'), 'utf8'), failure.original);
  console.log('  ok  real Coffee helper exits nonzero on malformed MCP and restores the exact original project configuration');

  const before = readFileSync(failure.log, 'utf8');
  const replay = invokeHelper(failure);
  assert.notEqual(replay.status, 0);
  assert.equal(readFileSync(failure.log, 'utf8'), before, 'Replayed plan must not launch its server again');
  assert.equal(readFileSync(failure.target, 'utf8'), failure.original);
  assert.deepEqual(replay.receipt, failed.receipt);
  console.log('  ok  replayed failed plan never executes again or replaces its persisted failure receipt');
  if (process.argv.includes('--helper-shell')) {
    assert.equal(process.platform, 'win32', '--helper-shell checks the Windows PowerShell wrapper');
    const fixture = prepare(false, "shell-success user's", 800);
    const result = invokeHelper(fixture, true);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.state, 'verified', 'PowerShell must wait for the helper, not return an approved/running plan');
    assert.equal(result.receipt.protocolVerified, true);
    assert.equal(result.receipt.configurationVerified, true);
    assert.equal(result.receipt.exitCode, 0);
    assert.match(result.stdout, /Coffee action result:/, 'The exact PowerShell wrapper must expose the helper result in terminal stdout');
    assert.deepEqual(JSON.parse(readFileSync(fixture.target, 'utf8')).mcpServers['coffee-helper-fixture'], fixture.specification);
    console.log('  ok  exact PowerShell EncodedCommand waits for the GUI helper and exposes its output with space/Unicode/apostrophe paths');
    return 4;
  }
  return 3;
}

let passed = 0;
try {
  const helperIndex = process.argv.indexOf('--helper');
  if (helperIndex !== -1) passed += verifyHelper(process.argv[helperIndex + 1] ?? '');
  const claude = executable('claude');
  if (claude) {
    console.log(`Claude: ${run(claude, ['--version']).trim()}`);
    run(claude, ['mcp', 'add', '--scope', 'local', 'coffee-fixture', '--', process.execPath, server, activity]);
    const details = run(claude, ['mcp', 'get', 'coffee-fixture']);
    assert.match(details, /Connected/i);
    assert.match(readFileSync(activity, 'utf8'), /"method":"initialize"/);
    console.log('  ok  Claude local MCP is written only to isolated config and really initialized');
    passed++;
    run(claude, ['mcp', 'remove', '--scope', 'local', 'coffee-fixture']);
    run(claude, ['mcp', 'add', '--scope', 'project', 'coffee-pending', '--', process.execPath, server, activity]);
    const before = readFileSync(activity, 'utf8');
    const pending = run(claude, ['mcp', 'get', 'coffee-pending']);
    assert.match(pending, /Pending approval/i);
    assert.equal(readFileSync(activity, 'utf8'), before, 'Unapproved project MCP must not be launched');
    assert.equal(JSON.parse(readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers['coffee-pending'].command, process.execPath);
    console.log('  ok  Claude project MCP registration does not silently grant workspace approval');
    passed++;
  } else console.log('  skip  Claude CLI not installed');

  const codex = executable('codex');
  if (codex) {
    console.log(`Codex: ${run(codex, ['--version']).trim()}`);
    const before = existsSync(activity) ? readFileSync(activity, 'utf8') : '';
    run(codex, ['mcp', 'add', 'coffee-fixture', '--', process.execPath, server, activity]);
    const details = JSON.parse(run(codex, ['mcp', 'get', 'coffee-fixture', '--json']));
    assert.equal(details.name, 'coffee-fixture');
    assert.equal(details.transport.command, process.execPath);
    const list = JSON.parse(run(codex, ['mcp', 'list', '--json']));
    assert.ok(list.some(entry => entry.name === 'coffee-fixture'));
    assert.equal(existsSync(activity) ? readFileSync(activity, 'utf8') : '', before,
      'Codex configuration listing must not be mistaken for an MCP health check');
    assert.ok(existsSync(path.join(codexConfig, 'config.toml')));
    console.log('  ok  Codex list/get proves registration but never proves MCP connectivity');
    passed++;
    run(codex, ['mcp', 'remove', 'coffee-fixture']);
  } else console.log('  skip  Codex CLI not installed');

  if (process.argv.includes('--skills')) {
    const npxEntry = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    assert.ok(existsSync(npxEntry), 'Expected npm next to Node for the optional Skills CLI check');
    const skills = { binary: process.execPath, prefix: [npxEntry, '--yes', '--package', 'skills@1.7.2', 'skills'] };
    const source = path.join(temporaryRoot, 'own-skill-fixture');
    mkdirSync(source);
    writeFileSync(path.join(source, 'SKILL.md'), '---\nname: coffee-fixture-skill\ndescription: Isolated Coffee installation contract test.\n---\nReturn the word fixture.\n');
    run(skills, ['add', source, '--agent', 'claude-code', '--skill', 'coffee-fixture-skill', '--copy', '--yes']);
    assert.ok(existsSync(path.join(project, '.claude', 'skills', 'coffee-fixture-skill', 'SKILL.md')));
    assert.ok(!existsSync(path.join(project, '.agents', 'skills', 'coffee-fixture-skill', 'SKILL.md')),
      'Claude-only copy must not accidentally install to all agents');
    console.log('  ok  fixed official Skills CLI installs own fixture only to selected Claude project');
    passed++;
    run(skills, ['add', source, '--agent', 'codex', '--skill', 'coffee-fixture-skill', '--copy', '--yes']);
    assert.ok(existsSync(path.join(project, '.agents', 'skills', 'coffee-fixture-skill', 'SKILL.md')));
    assert.ok(!existsSync(path.join(project, '.codex', 'skills', 'coffee-fixture-skill', 'SKILL.md')));
    console.log('  ok  Codex selected installation uses .agents/skills, not legacy .codex/skills');
    passed++;
    if (codex) {
      const loaded = await codexSkills(codex);
      const fixture = loaded.data.flatMap(entry => entry.skills).find(entry => entry.name === 'coffee-fixture-skill');
      assert.ok(fixture, 'The real Codex skills loader did not discover the installed project Skill');
      assert.equal(fixture.enabled, true);
      assert.ok(fixture.path.replaceAll('\\', '/').endsWith('/.agents/skills/coffee-fixture-skill/SKILL.md'));
      console.log('  ok  actual Codex app-server Skills loader discovers the enabled installed fixture');
      passed++;
    }
  }
  if (process.argv.includes('--graphify')) {
    const uv = executable('uv');
    assert.ok(uv, 'uv is required for the optional isolated Graphify check');
    const virtualEnvironment = path.join(temporaryRoot, 'graphify-venv');
    run(uv, ['venv', '--python', '3.11', virtualEnvironment]);
    const python = path.join(virtualEnvironment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    run(uv, ['pip', 'install', '--python', python, 'graphifyy==0.9.85'], project, 180_000);
    const graphify = { binary: path.join(virtualEnvironment, process.platform === 'win32' ? 'Scripts/graphify.exe' : 'bin/graphify'), prefix: [] };
    const source = path.join(project, 'src');
    mkdirSync(source);
    writeFileSync(path.join(source, 'helper.py'), 'def greet():\n    return "hello"\n');
    writeFileSync(path.join(source, 'main.py'), 'from helper import greet\ndef run():\n    return greet()\n');
    writeFileSync(path.join(source, 'tokenizer.py'), 'def tokenize():\n    return "fixture"\n');
    writeFileSync(path.join(source, 'password-reset.ts'), 'export function resetPassword() { return "fixture"; }\n');
    writeFileSync(path.join(source, 'secret-token.json'), '{"fixture": "no-real-credentials"}\n');
    const output = path.join(temporaryRoot, 'private-graph-output');
    const production = readFileSync(fileURLToPath(new URL('../../src/agent_graphify.rs', import.meta.url)), 'utf8');
    const strings = name => {
      const found = production.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`));
      assert.ok(found, `Graphify production ${name} constant was not found`);
      return [...found[1].matchAll(/"([^"\\]*)"/g)].map(match => match[1]);
    };
    const exclusions = [...strings('EXCLUDES'), ...strings('SECRET_WORDS')
      .flatMap(word => strings('SECRET_CONFIG_EXTENSIONS').map(extension => `*${word}*.${extension}`))];
    run(graphify, ['extract', project, '--code-only', '--no-cluster', '--max-workers', '2', '--out', output,
      ...exclusions.flatMap(exclusion => ['--exclude', exclusion])]);
    const graphDirectory = path.join(output, 'graphify-out');
    const graph = JSON.parse(readFileSync(path.join(graphDirectory, 'graph.json'), 'utf8'));
    assert.ok(graph.nodes.some(node => node.label === 'greet' || node.id.includes('greet')));
    assert.ok(graph.nodes.some(node => String(node.source_file).includes('tokenizer.py')));
    assert.ok(graph.nodes.some(node => String(node.source_file).includes('password-reset.ts')));
    assert.ok(!graph.nodes.some(node => String(node.source_file).includes('secret-token.json')));
    assert.ok(Array.isArray(graph.edges ?? graph.links));
    assert.equal(realpathSync(readFileSync(path.join(graphDirectory, '.graphify_root'), 'utf8').trim()), realpathSync(project));
    console.log(`  ok  Graphify 0.9.85 creates a real local code graph (${graph.nodes.length} nodes); private --out and --exclude contracts match`);
    passed++;
  }
  assert.ok(passed > 0, 'No native CLI tests were run');
  console.log(`${passed} isolated native capability contracts passed. Runtime skill invocation was not tested.`);
} finally {
  const resolved = realpathSync(temporaryRoot);
  assert.ok(resolved.startsWith(`${realpathSync(tmpdir())}${path.sep}`)
    && path.basename(resolved).startsWith('coffee-capability-flow-'), 'Refuse cleanup outside the created temporary directory');
  rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
