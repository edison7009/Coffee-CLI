import { invoke } from '../tauri';

/** A conversation's own git worktree: a copy of the project on its own branch, merged back on request. */
export interface Worktree { root: string; path: string; branch: string }
export interface WorktreeStatus { exists: boolean; ahead: number; dirty: boolean; target: string }

export const worktreeAvailable = (cwd: string) => invoke<boolean>('worktree_available', { cwd }).catch(() => false);
export const createWorktree = (cwd: string, title: string) => invoke<{ worktree: Worktree; cwd: string }>('worktree_create', { cwd, title });
export const worktreeStatus = (worktree: Worktree) => invoke<WorktreeStatus>('worktree_status', { worktree });
/** Resolves to the number of commits merged; rejects with `COFFEE_MERGE:conflict` or `COFFEE_MERGE:local_changes` when git refuses. */
export const mergeWorktree = (worktree: Worktree, message: string) => invoke<number>('worktree_merge', { worktree, message });
export const removeWorktree = (worktree: Worktree) => invoke<void>('worktree_remove', { worktree }).catch(() => {});
/** Reclaims the project's worktrees that no tab or worker holds, as a quit leaves them behind. */
export const sweepWorktrees = (cwd: string, inUse: string[]) => invoke<number>('worktree_sweep', { cwd, inUse }).catch(() => 0);

export { insideWorktrees, worktreeFromPath } from './worktree-path';
