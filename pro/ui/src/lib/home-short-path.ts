/** A project path for display, with the current user's home folder shortened to `~`.
 *  Paths elsewhere, other accounts' homes included, stay as they are. */
export function homeShortPath(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const windows = /^[A-Za-z]:[\\/]/.test(home);
  const trim = (value: string) => value.replace(/[\\/]+$/, '');
  const base = trim(home), same = (a: string, b: string) => windows ? a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase() : a === b;
  if (same(trim(path), base)) return '~';
  const head = path.slice(0, base.length), next = path.charAt(base.length);
  return same(head, base) && (next === '/' || (windows && next === '\\')) ? '~' + path.slice(base.length) : path;
}
