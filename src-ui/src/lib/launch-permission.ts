// The permission a tool's start-page card launches it with (方案一): Coffee CLI remembers the choice per tool and passes
// it when it starts the tool, so the tool's own settings files are never written. Unset (`''`) means the tool's own
// default. A terminal tab gets it as launch flags (src/server.rs reads `permission` from the tab's tool data); a desktop
// conversation applies it once its session is ready, through the same control its composer uses.

export type LaunchTool = 'claude' | 'codex';
export interface LaunchPermission { value: string; labelKey: string }

/** The choices each tool's composer offers, in the same words; the tool default first. */
export const LAUNCH_PERMISSIONS: Record<LaunchTool, LaunchPermission[]> = {
  claude: [
    { value: 'default', labelKey: 'claude.permission.manual' },
    { value: 'plan', labelKey: 'claude.permission.plan' },
    { value: 'acceptEdits', labelKey: 'claude.permission.edit' },
    { value: 'bypassPermissions', labelKey: 'claude.permission.bypass' },
  ],
  codex: [
    { value: 'readOnly', labelKey: 'codex.read_only' },
    { value: 'workspaceWrite', labelKey: 'codex.workspace' },
    { value: 'dangerFullAccess', labelKey: 'codex.full_access' },
  ],
};

export const isLaunchTool = (tool: string | null | undefined): tool is LaunchTool => tool === 'claude' || tool === 'codex';
const key = (tool: LaunchTool) => `coffee:${tool}-launch-permission`;

export function launchPermission(tool: LaunchTool): string {
  try {
    const value = localStorage.getItem(key(tool)) ?? '';
    return LAUNCH_PERMISSIONS[tool].some(option => option.value === value) ? value : '';
  } catch { return ''; }
}
export function setLaunchPermission(tool: LaunchTool, value: string) {
  try { if (value) localStorage.setItem(key(tool), value); else localStorage.removeItem(key(tool)); } catch { /* best effort */ }
}

/** Tool data for a terminal tab started with the card's choice (none when the tool keeps its own default). */
export function launchToolData(tool: LaunchTool): string | undefined {
  const permission = launchPermission(tool);
  return permission ? JSON.stringify({ permission }) : undefined;
}

// Desktop conversations: the choice waits for the tab's session to be ready, then is applied once.
const pending = new Map<string, string>();
export function markLaunchPermission(tabId: string, tool: LaunchTool) {
  const permission = launchPermission(tool);
  if (permission) pending.set(tabId, permission); else pending.delete(tabId);
}
export function takeLaunchPermission(tabId: string): string | undefined {
  const permission = pending.get(tabId);
  pending.delete(tabId);
  return permission;
}
/** Codex's composer sets a sandbox together with its approval policy. */
export const codexApproval = (sandbox: string) => sandbox === 'dangerFullAccess' ? 'never' : 'on-request';
