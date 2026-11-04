/** A project path for display, with the user's home folder (macOS, Linux or Windows) shortened to `~`. */
export function homeShortPath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/, '~');
}
