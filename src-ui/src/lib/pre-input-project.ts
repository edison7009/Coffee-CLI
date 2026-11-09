/** Which project a pre-input note belongs to, read from a session folder. Free of native calls. */

/** The project a folder belongs to: a Coffee worktree under `.claude/worktrees/` counts as its project root. */
export function projectRoot(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(/[\\/]/);
  const at = parts.findIndex((part, i) => part === '.claude' && parts[i + 1] === 'worktrees');
  const root = at > 0 ? parts.slice(0, at).join(path.includes('\\') ? '\\' : '/') : path;
  return root.replace(/[\\/]+$/, '') || root;
}

/** Folder identity across separators, a trailing slash and (on Windows drive paths) letter case. */
function key(path: string): string {
  const unified = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(unified) ? unified.toLowerCase() : unified;
}

export function sameProject(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && key(a) === key(b);
}

/** The folder's last segment, shown on the note. */
export function projectName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}
