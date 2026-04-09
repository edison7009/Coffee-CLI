// Tool Dictionary Loader — resolves panel config + localized data per tool type
//
// Each tool (claude-code, opencode, etc.) has its own dictionary under
// src/dictionaries/<tool>/. The _config.json defines panel button triggers,
// and <lang>.json provides slashCommands, hotkeys, guides, and tips.

import type { ToolType } from '../store/app-state';

// ─── Static imports (bundled at compile time) ────────────────────────────────
// We statically import all known dictionaries so Vite can bundle them.
// To add a new tool, add its imports here and register in the maps below.

import claudeConfig from '../../../src/dictionaries/claude-code/_config.json';
import claudeZhCN from '../../../src/dictionaries/claude-code/zh-CN.json';

import openCodeConfig from '../../../src/dictionaries/opencode/_config.json';
import openCodeZhCN from '../../../src/dictionaries/opencode/zh-CN.json';

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
  'opencode': openCodeConfig,
};

// lang -> { toolDir -> data }
const dataMap: Record<string, Record<string, any>> = {
  'zh-CN': {
    'claude-code': claudeZhCN,
    'opencode': openCodeZhCN,
  },
  'en': {}
};

// ToolType -> dictionary directory name
const toolDirMap: Record<string, string> = {
  claude: 'claude-code',
  opencode: 'opencode',
};

// ─── Default Fallback ────────────────────────────────────────────────────────

const DEFAULT_PANEL: PanelConfig = {
  menuButton: { label: 'Menu', triggerKey: '/', closeKey: '\x7f', icon: 'menu' },
  helpButton: { label: 'Hotkeys', triggerKey: '?', closeKey: '\x7f', icon: 'help' },
};

function getGlobalFallback(_lang: string): ToolDictionary {
  return {
    panel: DEFAULT_PANEL,
    slashCommands: [],
    hotkeys: [],
    guides: {},
    tips: [],
    articles: [],
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
