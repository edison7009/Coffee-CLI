import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { build } from 'esbuild';

const languages = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'vi'];
const dictionaries = {};
for (const lang of languages) {
  const file = new URL(`../src/i18n/${lang}.ts`, import.meta.url);
  const code = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file.pathname, code, ts.ScriptTarget.Latest, true);
  const keys = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) keys.push(node.name.text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(new Set(keys).size, keys.length, `${lang}: no duplicate dictionary keys`);
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
  dictionaries[lang] = Object.values(module.exports)[0];
}
const keys = Object.keys(dictionaries.en).filter(key => key.startsWith('claude.') || key.startsWith('orchestration.tool.') || key.startsWith('orchestration.close.') || key.startsWith('orchestration.remove.') || ['orchestration.open_history','orchestration.detach','orchestration.history_unavailable','gambit.attachment', 'gambit.preview_attachment', 'gambit.remove_attachment'].includes(key));
const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
for (const lang of languages) {
  for (const key of keys) {
    assert.ok(dictionaries[lang][key]?.trim(), `${lang}: ${key} must not fall back to English`);
    assert.deepEqual(placeholders(dictionaries[lang][key]), placeholders(dictionaries.en[key]), `${lang}: ${key} retains its variables`);
  }
  console.log(`OK: ${lang}, ${keys.length} translated keys and matching interpolation variables`);
}
const result = await build({ entryPoints: ['src/lib/claude-i18n.ts', 'src/lib/claude-protocol.ts', 'src/lib/orchestration-label.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, outdir: 'unused' });
const modules = result.outputFiles.map(file => {
  const module = { exports: {} };
  vm.runInNewContext(file.text, { module, exports: module.exports });
  return module.exports;
});
const { claudeEffortLabel } = modules.find(module => module.claudeEffortLabel);
const { orchestrationToolLabel, orchestrationSearchLabel } = modules.find(module => module.orchestrationToolLabel);
for (const lang of languages) {
  const t = key => dictionaries[lang][key];
  for (const action of ['start','list','wait','read','send','reply','interrupt']) {
    const name = 'worker_' + action, expected = t('orchestration.tool.' + action);
    assert.equal(orchestrationToolLabel('mcp__coffee-team__' + name, t), expected, lang + ': namespaced tool label');
    assert.equal(orchestrationToolLabel(name, t, 'coffee-team'), expected, lang + ': structured server/tool label');
    assert.equal(orchestrationToolLabel(name, t, 'another-server'), undefined, 'other servers retain their own names');
    assert.equal(orchestrationToolLabel(name, t), undefined, 'bare names require the exact server identity');
  }
  for (const name of ['Bash','Read','mcp__other__worker_wait','mcp__coffee-team__unknown','mcp__coffee-team__constructor']) assert.equal(orchestrationToolLabel(name,t),undefined);
  const query='select:mcp__coffee-team__worker_start,mcp__coffee-team__worker_list,mcp__coffee-team__worker_wait';
  const search=orchestrationSearchLabel('ToolSearch',query,t);
  assert.equal(search.title,t('orchestration.tool.search'));
  assert.equal(search.description,['start','list','wait'].map(action=>t('orchestration.tool.'+action)).join(' · '));
  assert.equal(orchestrationSearchLabel('ToolSearch',query+',mcp__coffee-team__',t).description,search.description,'streaming namespace suffix does not expose internal identifiers');
  for (const [name,input] of [['Read',query],['ToolSearch','browser search'],['ToolSearch','select:mcp__other__worker_start'],['ToolSearch',query+',mcp__other__worker_wait'],['ToolSearch','select:mcp__coffee-team__unknown'],['ToolSearch','select:mcp__coffee-team__constructor'],['ToolSearch','select:mcp__coffee-team__']]) assert.equal(orchestrationSearchLabel(name,input,t),undefined,'ordinary searches and unrecognized tools remain unchanged');
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(claudeEffortLabel(level, t), t(`claude.effort.${level}`));
  assert.equal(claudeEffortLabel('ultracode', t), 'Ultracode');
  assert.equal(claudeEffortLabel('provider-custom-level', t), 'provider-custom-level');
}
const { emptyClaudeState, reduceClaudeEvent } = modules.find(module => module.reduceClaudeEvent);
const failed = reduceClaudeEvent(emptyClaudeState(), { type: 'result', is_error: true, errors: [] });
assert.equal(failed.errorKey, 'claude.error.request_failed');
const exited = reduceClaudeEvent(emptyClaudeState(), { type: 'coffee_exit', code: 1 });
assert.equal(exited.errorKey, 'claude.error.process_exited');
const nativeError = reduceClaudeEvent(failed, { type: 'assistant', error: 'Provider diagnostic: E123', message: {} });
assert.equal(nativeError.errorKey, undefined);
assert.equal(nativeError.error, 'Provider diagnostic: E123', 'native diagnostics never get replaced with stale translated errors');
console.log('OK: six localized effort labels, unknown provider values and native diagnostics preserved');
