/**
 * Pi titles its terminal `π - <session name> - <folder>`, or `π - <folder>` before the session
 * has a name. Only a session name is worth a tab title; the folder alone is not, so the tab keeps
 * the conversation's history name instead. Returns the session name, or null when there is none.
 */
export function parsePiTerminalTitle(title: string): string | null {
  const rest = title.match(/^π - (.*)$/s)?.[1];
  if (rest === undefined) return title.trim() || null;
  const cut = rest.lastIndexOf(' - ');
  const name = cut < 0 ? '' : rest.slice(0, cut).trim();
  return name || null;
}
