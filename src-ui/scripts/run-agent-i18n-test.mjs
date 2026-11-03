import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      import { en } from './src/i18n/en';
      import { zhCN } from './src/i18n/zh-CN';
      import { zhTW } from './src/i18n/zh-TW';
      import { ja } from './src/i18n/ja';
      import { ko } from './src/i18n/ko';
      import { es } from './src/i18n/es';
      import { fr } from './src/i18n/fr';
      import { de } from './src/i18n/de';
      import { pt } from './src/i18n/pt';
      import { ru } from './src/i18n/ru';
      import { vi } from './src/i18n/vi';
      export const dictionaries = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, fr, de, pt, ru, vi };
      export { useT } from './src/i18n/useT';
      export { AgentPages, ChannelConnectionSummary, AgentHelpModal } from './src/components/agent/AgentPages';
      export { formatAgentActivity, formatAgentError, formatAgentMessage } from './src/lib/agent-client';
    `,
    resolveDir: root,
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'qrcode'],
  loader: { '.css': 'empty' },
  plugins: [{ name: 'agent-render-fixtures', setup(builder) {
    builder.onLoad({ filter: /[/\\]store[/\\]app-state\.tsx$/ }, () => ({ loader: 'ts', contents: `
      export function useAppState() { return { state: globalThis.__agentTestState, dispatch() {} }; }
      export function useAppLanguage() { return globalThis.__agentTestLanguage; }
    ` }));
    builder.onLoad({ filter: /[/\\]Gambit\.tsx$/ }, () => ({ loader: 'js', contents: `
      import React from 'react';
      export const Gambit = ({ sendFailedHint }) => React.createElement('aside', { 'data-send-failed': sendFailedHint });
    ` }));
    builder.onLoad({ filter: /[/\\]MarkdownContent\.tsx$/ }, () => ({ loader: 'js', contents: `
      import React from 'react';
      export const MarkdownContent = ({ content }) => React.createElement('div', null, content);
    ` }));
    builder.onLoad({ filter: /[/\\]AgentPages\.tsx$/ }, async args => ({
      loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { AgentHelpModal };`,
    }));
  } }],
});
const module = { exports: {} };
const context = {
  module, exports: module.exports,
  __agentTestLanguage: 'en', __agentTestState: { agentPageActive: 'config' },
  document: { body: {} }, navigator: { platform: 'Win32' },
  require: name => name === 'react' ? {
    ...React,
    useSyncExternalStore: (subscribe, getSnapshot) => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot),
  } : name === 'react-dom' ? { createPortal: children => children } : require(name),
};
runInNewContext(compiled.outputFiles[0].text, context);
const api = module.exports;
const keys = Object.keys(api.dictionaries.en).filter(key => key.startsWith('agent.')).sort();
assert.ok(keys.length > 0, 'Coffee Agent must have its own translations');
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const escaped = text => renderToStaticMarkup(React.createElement('span', null, text)).slice(6, -7);

for (const [language, dictionary] of Object.entries(api.dictionaries)) {
  assert.deepEqual(Object.keys(dictionary).filter(key => key.startsWith('agent.')).sort(), keys, `${language}: incomplete Agent translations`);
  for (const key of keys) {
    assert.ok(dictionary[key].trim(), `${language}: empty ${key}`);
    assert.deepEqual(placeholders(dictionary[key]), placeholders(api.dictionaries.en[key]), `${language}: missing interpolation in ${key}`);
  }
  context.__agentTestLanguage = language;
  context.__agentTestState.currentLang = language;
  context.__agentTestState.agentPageActive = 'config';
  const settings = renderToStaticMarkup(React.createElement(api.AgentPages, { page: 'config' }));
  for (const key of ['agent.settings.intro', 'agent.settings.help', 'agent.model.title', 'agent.model.provider', 'agent.modes.title', 'agent.delegation.title', 'agent.modes.sentinel.title', 'agent.modes.project_manager.title', 'agent.modes.expert_config.title', 'agent.channels.title']) {
    assert.ok(settings.includes(escaped(dictionary[key])), `${language}: settings did not render ${key}`);
  }
  assert.equal((settings.match(/role="switch"/g) ?? []).length, 4, `${language}: all four work modes need their own switch`);
  assert.equal((settings.match(/aria-describedby=/g) ?? []).length, 4, `${language}: switches need accessible descriptions`);
  for (const key of ['agent.delegation.description', 'agent.modes.sentinel.description', 'agent.modes.project_manager.description', 'agent.modes.expert_config.description']) {
    assert.ok(settings.includes(escaped(dictionary[key])), `${language}: switch description did not render ${key}`);
  }
  const sidebar = renderToStaticMarkup(React.createElement(api.ChannelConnectionSummary));
  const defaultChannel = language.startsWith('zh') ? dictionary['agent.channels.weixin'] : 'Telegram';
  assert.ok(sidebar.includes(escaped(`${defaultChannel} · ${dictionary['agent.channels.status.disconnected']}`)), `${language}: sidebar must show the locale's default channel`);
  assert.ok(settings.includes(`class="settings-font-current">${escaped(defaultChannel)}</span>`), `${language}: channel selector must use the same default as the sidebar`);
  const help = renderToStaticMarkup(React.createElement(api.AgentHelpModal, { onClose() {} }));
  for (const key of ['agent.help.title', 'agent.help.workflow_intro', 'agent.help.delegation_description', 'agent.help.delegation_tip', 'agent.help.sentinel_description', 'agent.help.project_manager_description', 'agent.help.expert_config_description', 'agent.help.examples_hint']) {
    assert.ok(help.includes(escaped(dictionary[key])), `${language}: help did not render ${key}`);
  }
  assert.ok(help.includes('href="https://github.com/edison7009/Coffee-CLI/issues"'), `${language}: feedback link was lost`);
  assert.ok(help.includes('/new') && help.includes('/cancel'), `${language}: channel commands were translated`);
  context.__agentTestState.agentPageActive = 'agent';
  const chat = renderToStaticMarkup(React.createElement(api.AgentPages, { page: 'agent' }));
  for (const key of ['agent.chat.welcome', 'agent.chat.suggestion.terminals', 'agent.chat.suggestion.progress', 'agent.chat.suggestion.history']) {
    assert.ok(chat.includes(escaped(dictionary[key])), `${language}: chat did not render ${key}`);
  }
}

for (const language of ['zh-CN', 'zh-TW']) {
  for (const key of ['agent.delegation.title', 'agent.modes.sentinel.title', 'agent.modes.project_manager.title', 'agent.modes.expert_config.title']) {
    assert.equal([...api.dictionaries[language][key]].length, 4, `${language}: work mode titles should use four characters`);
  }
}

// An existing activity/error must switch language on the next render, too.
for (const language of ['en', 'zh-CN', 'ja']) {
  context.__agentTestLanguage = language;
  let translate;
  function TranslationProbe() { translate = api.useT(); return null; }
  renderToStaticMarkup(React.createElement(TranslationProbe));
  assert.equal(api.formatAgentActivity('正在思考…', translate), api.dictionaries[language]['agent.activity.thinking']);
  assert.equal(api.formatAgentActivity('正在整理前文，完整历史仍保留…', translate), api.dictionaries[language]['agent.activity.context']);
  assert.equal(api.formatAgentActivity('正在操作：sessions_open', translate), translate('agent.activity.operating', { tool: 'sessions_open' }));
  assert.equal(api.formatAgentError('Error: Agent 正在处理上一条消息', translate), api.dictionaries[language]['agent.error.busy']);
  assert.equal(api.formatAgentError('请先在 Agent 配置中填写服务地址', translate), api.dictionaries[language]['agent.error.url_required']);
  assert.equal(api.formatAgentError('请先在 Agent 配置中填写模型 ID', translate), api.dictionaries[language]['agent.error.model_required']);
  assert.equal(api.formatAgentError('HTTP 401: Invalid API key', translate), 'HTTP 401: Invalid API key');
  assert.equal(api.formatAgentMessage('Agent 请求已取消；已经提交的终端任务可能继续运行。', translate), api.dictionaries[language]['agent.chat.cancelled']);
  assert.equal(api.formatAgentMessage('Agent 请求未完成：请先在 Agent 配置中填写模型 ID', translate), translate('agent.chat.incomplete', { error: translate('agent.error.model_required') }));
  assert.equal(api.formatAgentMessage('Read E:\\MyProject and report in Chinese.', translate), 'Read E:\\MyProject and report in Chinese.');
}
console.log(`OK: Coffee Agent rendering, ${keys.length} translation keys in 11 languages, placeholders, help links, and live activity language changes`);
