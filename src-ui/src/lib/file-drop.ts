// file-drop.ts — routing registry for file drops from two sources:
//
//   (a) OS-external drops (Finder / File Explorer → our window). Tauri
//       captures these at the window level and emits a single global
//       event; DOM `drop` does NOT fire for OS files.
//   (b) Intra-app pointer drags (left Explorer → terminal/Gambit). See
//       explorer-drag.ts — HTML5 drag is captured by Tauri's WebView2
//       drop handler on Windows so we use mousedown/mousemove/mouseup
//       and call routeFileDrop on release.
//
// Both code paths feed routeFileDrop(paths, position). Surfaces (Gambit
// textarea, active TierTerminal) register a drop target with a rect-getter
// and an insert callback. The dispatcher walks targets in priority order
// and fires the first whose rect contains the drop position. No target
// match → drop is ignored (side panels, decorative areas).

export interface FileDropTarget {
  /** Bounding rect in CSS pixels. Return null when the target is hidden /
   *  not ready (e.g. Gambit closed, terminal not active) so it's skipped. */
  rect: () => DOMRect | null;
  /** Called with the absolute paths from the OS drop. */
  insert: (paths: string[]) => void;
  /** Higher = checked first. Gambit textarea (200) outranks the active
   *  terminal (100) so dropping over a Gambit overlapping the terminal
   *  routes into the textarea, not behind it. */
  priority: number;
}

const targets = new Set<FileDropTarget>();

export function registerFileDropTarget(target: FileDropTarget): () => void {
  targets.add(target);
  return () => { targets.delete(target); };
}

/** Dispatch a drop. Returns true if a target accepted it. */
export function routeFileDrop(paths: string[], position: { x: number; y: number }): boolean {
  if (paths.length === 0) return false;
  const sorted = [...targets].sort((a, b) => b.priority - a.priority);
  for (const t of sorted) {
    const r = t.rect();
    if (!r) continue;
    if (position.x >= r.left && position.x <= r.right && position.y >= r.top && position.y <= r.bottom) {
      t.insert(paths);
      return true;
    }
  }
  return false;
}

/** Quote a path with double-quotes if it contains whitespace. Works across
 *  cmd / PowerShell / bash / zsh / fish for path arguments. Names with
 *  literal `"` are rare enough to ignore for now — they'd need shell-
 *  specific escaping that no single rule covers. */
function quoteIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** Format dropped paths for terminal insertion: space-separated, with a
 *  trailing space so the next typed character doesn't collide with the
 *  path. Mirrors macOS Terminal.app and Windows Terminal behavior. */
export function formatPathsForInsert(paths: string[]): string {
  return paths.map(quoteIfNeeded).join(' ') + ' ';
}
