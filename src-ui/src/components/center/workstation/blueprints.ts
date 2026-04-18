// Seed blueprints for Phase 1 — hardcoded, demo-quality only.
// Phase 2 replaces these with YAML loaded from disk / URL / GitHub.
//
// Per product philosophy: a blueprint ships ONLY names + structure.
// No models, no skills, no prompts. The user configures all of that
// inside each activated container.

import type { Blueprint } from './types';

export const BLUEPRINTS: Blueprint[] = [
  {
    id: 'game-studio',
    name: '游戏工作室',
    icon: '🎮',
    description: '典型独立游戏团队：项目经理协调下的程序、美术、剧情、QA 分工',
    author: '@coffee-cli',
    nodes: [
      { id: 'pm',        name: '项目经理',  hint: '协调进度、决策、与用户对接', position: { x: 240,  y: 0   } },
      { id: 'programmer', name: '主程序',   hint: '引擎、核心系统、性能',        position: { x: -40,  y: 160 } },
      { id: 'artist',    name: '主美术',    hint: '视觉风格、关键资产',          position: { x: 180,  y: 160 } },
      { id: 'writer',    name: '剧情编剧',  hint: '叙事、分支对话、世界观',      position: { x: 400,  y: 160 } },
      { id: 'qa',        name: 'QA 测试',   hint: '复现 bug、回归验证',          position: { x: 620,  y: 160 } },
    ],
    edges: [
      { source: 'pm', target: 'programmer' },
      { source: 'pm', target: 'artist' },
      { source: 'pm', target: 'writer' },
      { source: 'pm', target: 'qa' },
    ],
  },
  {
    id: 'startup-team',
    name: '创业团队',
    icon: '🚀',
    description: '早期创业：CEO 领导下 CTO 与 CMO 并行，CTO 统筹工程',
    author: '@coffee-cli',
    nodes: [
      { id: 'ceo',       name: 'CEO',        hint: '战略、融资、团队方向',           position: { x: 240,  y: 0   } },
      { id: 'cto',       name: 'CTO',        hint: '技术路线、工程决策',             position: { x: 80,   y: 160 } },
      { id: 'cmo',       name: 'CMO',        hint: '营销、增长、品牌',               position: { x: 400,  y: 160 } },
      { id: 'eng-claude', name: '工程师 · Claude', hint: '通用代码、架构',           position: { x: -40,  y: 320 } },
      { id: 'eng-codex',  name: '工程师 · Codex',  hint: '复杂任务、long-context',  position: { x: 200,  y: 320 } },
    ],
    edges: [
      { source: 'ceo', target: 'cto' },
      { source: 'ceo', target: 'cmo' },
      { source: 'cto', target: 'eng-claude' },
      { source: 'cto', target: 'eng-codex' },
    ],
  },
  {
    id: 'writing-team',
    name: '写作小组',
    icon: '✍️',
    description: '内容创作三件套：主编定方向，记者出素材，编辑把关成稿',
    author: '@coffee-cli',
    nodes: [
      { id: 'chief',     name: '主编',       hint: '选题、整体风格、终审',           position: { x: 240,  y: 0   } },
      { id: 'reporter',  name: '记者',       hint: '采访、素材收集、初稿',           position: { x: 80,   y: 160 } },
      { id: 'editor',    name: '编辑',       hint: '润色、结构、事实核查',           position: { x: 400,  y: 160 } },
    ],
    edges: [
      { source: 'chief', target: 'reporter' },
      { source: 'chief', target: 'editor' },
    ],
  },
];

/**
 * Pick a blueprint by id. Used when the user clicks a template card.
 * Returns null instead of throwing so callers can fall back gracefully.
 */
export function findBlueprint(id: string): Blueprint | null {
  return BLUEPRINTS.find(b => b.id === id) ?? null;
}
