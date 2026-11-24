// Two shells over one session core: 工作式 (work) is a quiet chat app — an icon rail, the
// conversation, no terminals; 代码式 (code) is the full workspace with tabs, sidebars and terminals.
import type { ToolType } from '../store/app-state';
import { ACP_TOOLS } from './acp-tools';

export type LayoutMode = 'work' | 'code';

const KEY = 'cc-layout';

/** Tools that have a desktop conversation of their own; the only ones 工作式 starts. */
export const WORK_TOOLS: ReadonlySet<string> = new Set(['claude', 'codex', 'opencode', 'pi', 'dsh', ...ACP_TOOLS]);

/**
 * The saved shell. A first start chooses 工作式; someone who already used Coffee CLI (any saved
 * look) keeps the workspace they know. The choice is saved on the spot so it never flips later.
 */
export function readLayoutMode(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage): LayoutMode {
  try {
    const saved = storage?.getItem(KEY);
    if (saved === 'work' || saved === 'code') return saved;
    const returning = !!(storage?.getItem('cc-shape') || storage?.getItem('cc-theme') || storage?.getItem('cc-lang'));
    const mode: LayoutMode = returning ? 'code' : 'work';
    storage?.setItem(KEY, mode);
    return mode;
  } catch { return 'code'; }
}

export function saveLayoutMode(mode: LayoutMode) {
  try { localStorage.setItem(KEY, mode); } catch { /* the in-memory choice still applies */ }
}

/** The launch mode 工作式 uses for a tool: always the conversation. */
export function workLaunchable(tool: ToolType | string | null | undefined): boolean {
  return !!tool && WORK_TOOLS.has(tool);
}

/** Read outside React (launch helpers): the shell currently shown. */
export function currentLayoutMode(): LayoutMode {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-layout') === 'work' ? 'work' : 'code';
}
