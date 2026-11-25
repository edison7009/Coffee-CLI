import type { Worktree } from './worktree';

/** Reading Coffee worktree paths, free of native calls so any view can use it. */
const parts = (path: string) => path.split(/[\\/]/);
/** A folder inside some project's `.claude/worktrees/`, where a further worktree would nest. */
export function insideWorktrees(path: string): boolean {
  const p = parts(path);
  return p.some((part, i) => part === '.claude' && p[i + 1] === 'worktrees');
}
/** Where a new conversation opened from `tab` works: the same folder, and with it the same worktree. */
export function sameFolder(tab?: { folderPath: string | null; worktree?: Worktree; worktreeOrigin?: string }) {
  return { folderPath: tab?.folderPath ?? null, worktree: tab?.worktree, worktreeOrigin: tab?.worktreeOrigin };
}
/** The Coffee worktree a folder belongs to, read from its path, for a conversation reopened from history. */
export function worktreeFromPath(path: string): Worktree | undefined {
  const p = parts(path), i = p.findIndex((part, index) => part === '.claude' && p[index + 1] === 'worktrees' && p[index + 2]?.startsWith('coffee-'));
  if (i < 1) return undefined;
  const separator = path.includes('\\') ? '\\' : '/', name = p[i + 2];
  return { root: p.slice(0, i).join(separator), path: p.slice(0, i + 3).join(separator), branch: `coffee/${name.slice('coffee-'.length)}` };
}
