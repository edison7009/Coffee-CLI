// Tool Dictionary Loader — resolves panel config + localized data per tool type
//
// Each tool (claude-code, coffeecode, etc.) has its own dictionary under
// src/dictionaries/<tool>/. The _config.json defines panel button triggers,
// and <lang>.json provides slashCommands, hotkeys, guides, and tips.

import type { ToolType } from '../store/app-state';

// ─── Static imports (bundled at compile time) ────────────────────────────────
// We statically import all known dictionaries so Vite can bundle them.
// To add a new tool, add its imports here and register in the maps below.

import claudeConfig from '../../../src/dictionaries/claude-code/_config.json';
import claudeZhCN from '../../../src/dictionaries/claude-code/zh-CN.json';

import coffeecodeConfig from '../../../src/dictionaries/coffeecode/_config.json';
import coffeecodeZhCN from '../../../src/dictionaries/coffeecode/zh-CN.json';

import globalConfig from '../../../src/dictionaries/global/_config.json';
import globalZhCN from '../../../src/dictionaries/global/zh-CN.json';
import globalEn from '../../../src/dictionaries/global/en.json';

import arcadeConfig from '../../../src/dictionaries/arcade/_config.json';
import arcadeZhCN from '../../../src/dictionaries/arcade/zh-CN.json';
import arcadeEn from '../../../src/dictionaries/arcade/en.json';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PanelButtonConfig {
  label: string;
  triggerKey: string; // raw key string sent to PTY (e.g. "/" or "\x10" for Ctrl+P)
  closeKey: string;   // raw key string sent to close (e.g. "\x7f" for Backspace)
  icon: 'menu' | 'help';
  note?: string;      // human-readable hint shown on kbd (e.g. "Ctrl+P")
}

export interface PanelConfig {
  menuButton: PanelButtonConfig;
  helpButton: PanelButtonConfig;
}

export interface SlashCommand {
  key: string;
  command: string;
  title: string;
  desc: string;
  icon: string;
}

export interface Hotkey {
  keys: string;
  desc: string;
  important?: boolean;
}

export interface ToolDictionary {
  panel: PanelConfig;
  slashCommands: SlashCommand[];
  hotkeys: Hotkey[];
  guides: Record<string, string>;
  tips: { title: string; body: string }[];
  articles?: { title: string; content: string }[];
}

// ─── Config Registry ─────────────────────────────────────────────────────────

const configMap: Record<string, any> = {
  'claude-code': claudeConfig,
  'coffeecode': coffeecodeConfig,
  'global': globalConfig,
  'arcade': arcadeConfig,
};

// lang -> { toolDir -> data }
const dataMap: Record<string, Record<string, any>> = {
  'zh-CN': {
    'claude-code': claudeZhCN,
    'coffeecode': coffeecodeZhCN,
    'global': globalZhCN,
    'arcade': arcadeZhCN,
  },
  'en': {
    'global': globalEn,
    'arcade': arcadeEn,
  }
};

// ToolType -> dictionary directory name
const toolDirMap: Record<string, string> = {
  claude: 'claude-code',
  coffeecode: 'coffeecode',
  arcade: 'arcade',
};

// ─── Default Fallback ────────────────────────────────────────────────────────

const DEFAULT_PANEL: PanelConfig = {
  menuButton: { label: 'Menu', triggerKey: '/', closeKey: '\x7f', icon: 'menu' },
  helpButton: { label: 'Hotkeys', triggerKey: '?', closeKey: '\x7f', icon: 'help' },
};

function getGlobalFallback(_lang: string): ToolDictionary {
  const config = configMap['global'];
  const langData = dataMap[_lang]?.['global'] ?? dataMap['zh-CN']?.['global'];
  return {
    panel: config?.panel ?? DEFAULT_PANEL,
    slashCommands: [],
    hotkeys: [],
    guides: {},
    tips: langData?.tips ?? [],
    articles: langData?.articles ?? [],
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the full dictionary for a given tool and language.
 * Falls back gracefully if the tool or language is not found.
 */
export function getToolDictionary(tool: ToolType, _lang: string = 'zh-CN'): ToolDictionary {
  if (!tool) return getGlobalFallback(_lang);

  const dir = toolDirMap[tool];
  if (!dir) return getGlobalFallback(_lang);

  const config = configMap[dir];
  const langData = dataMap[_lang]?.[dir] ?? dataMap['zh-CN']?.[dir];

  if (!config && !langData) return getGlobalFallback(_lang);

  return {
    panel: config?.panel ?? DEFAULT_PANEL,
    slashCommands: langData?.slashCommands ?? [],
    hotkeys: langData?.hotkeys ?? [],
    guides: langData?.guides ?? {},
    tips: langData?.tips ?? [],
    articles: langData?.articles ?? [],
  };
}

/**
 * Get only the panel config for a given tool (lightweight, no lang needed).
 */
export function getToolPanelConfig(tool: ToolType): PanelConfig {
  if (!tool) return DEFAULT_PANEL;
  const dir = toolDirMap[tool];
  if (!dir) return DEFAULT_PANEL;
  return configMap[dir]?.panel ?? DEFAULT_PANEL;
}
