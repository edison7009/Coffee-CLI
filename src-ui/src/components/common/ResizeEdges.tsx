// ResizeEdges.tsx — 8 transparent edge/corner strips that initiate
// window resize-drag.
//
// Why this exists: tauri.conf.json has `decorations: false`, which kicks
// the OS-supplied window chrome. Edge resize then depends entirely on
// what each platform does for borderless windows:
//   • Windows  — Tauri shims WM_NCHITTEST so the OS still handles edge
//                resize + draws the directional cursor. Works without
//                this component, BUT the component is harmless because
//                the OS shim preempts our DOM handlers.
//   • macOS    — WindowServer detects edges of any resizable NSWindow
//                and draws cursors at the OS layer; same story, OS wins.
//   • Linux    — GTK/WebKit2GTK does NOT auto-handle edge cursors or
//                edge-drag for borderless windows. Without this component
//                Linux users get a default arrow cursor at edges and only
//                a compositor-level resize fallback (if any). This
//                component fills that gap by:
//                  (a) CSS `cursor: ${dir}-resize` shows the right glyph
//                  (b) `startResizeDragging(dir)` initiates the drag
//
// Three-platform unified: no platform gating. The Win/macOS shims
// preempt our handlers (the OS never delivers the mousedown to WebView)
// so the only place this code's effects are visible is Linux.
//
// Hidden when the window is maximized (no resize drag should fire when
// the window already fills the screen).

import { useEffect, useState } from 'react';
import './ResizeEdges.css';

type Dir =
  | 'North' | 'South' | 'East' | 'West'
  | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

const EDGES: ReadonlyArray<{ d: Dir; cls: string }> = [
  { d: 'NorthWest', cls: 'nw' },
  { d: 'North',     cls: 'n'  },
  { d: 'NorthEast', cls: 'ne' },
  { d: 'East',      cls: 'e'  },
  { d: 'SouthEast', cls: 'se' },
  { d: 'South',     cls: 's'  },
  { d: 'SouthWest', cls: 'sw' },
  { d: 'West',      cls: 'w'  },
];

export function ResizeEdges() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const sync = async () => {
        try { setMaximized(await win.isMaximized()); } catch {}
      };
      sync();
      const fn = await win.onResized(sync);
      if (cancelled) fn();
      else unlisten = fn;
    })().catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  if (maximized) return null;

  const onDown = (dir: Dir) => async (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startResizeDragging(dir);
    } catch {}
  };

  return (
    <div className="resize-edges" aria-hidden="true">
      {EDGES.map(({ d, cls }) => (
        <div
          key={d}
          className={`resize-edge resize-edge--${cls}`}
          onMouseDown={onDown(d)}
        />
      ))}
    </div>
  );
}
