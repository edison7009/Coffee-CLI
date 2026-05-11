// TitleBar.tsx — Custom draggable titlebar (replaces native OS window chrome)
// Tauri requires this for frameless windows with decorations: false
//
// Layout: [drag-area with layout toggles on the left] … [min / max / close on the right]
//
// Left-side controls mirror VS Code's Activity Bar / Ctrl+B affordance:
//   1. Left panel toggle  (Explorer / directory listing)
//   2. Right panel toggle (TaskBoard / chat history)
//   3. Multi-agent layout mode — only visible when the active tab is a
//      multi-agent quadrant. Two modes: grid (2×2) and columns (1×4).

import { commands, isTauri } from '../../tauri';
import { useAppState, useAppDispatch } from '../../store/app-state';
import './TitleBar.css';

// Match --w-left / --w-right in global.css. Side panels are not
// user-resizable, so this is a true constant — no need to read it
// back through getComputedStyle on every toggle.
const PANEL_WIDTH = 320;

// Physically shrink/grow the OS window by PANEL_WIDTH on the axis
// the panel sits on, so hiding a panel "chops off" that side of the
// app (window edge moves inward; min/max/close ride the new edge).
// Right-panel hide moves the right edge inward (origin x unchanged);
// left-panel hide moves the left edge inward (origin x shifts right
// so the right edge stays put). Reversed on show. If the window is
// maximized, we skip the resize — Tauri would unmaximize it, which
// is more jarring than just leaving the layout alone for that frame.
async function adjustWindowForPanel(side: 'left' | 'right', willHide: boolean) {
  if (!isTauri) return;
  try {
    const { getCurrentWindow, PhysicalSize, PhysicalPosition } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    if (await w.isMaximized()) return;
    const scale = await w.scaleFactor();
    const deltaPx = Math.round(PANEL_WIDTH * scale);
    const size = await w.innerSize();
    const pos = await w.outerPosition();
    const widthDelta = willHide ? -deltaPx : deltaPx;
    await w.setSize(new PhysicalSize(size.width + widthDelta, size.height));
    if (side === 'left') {
      // Hiding left: left edge moves right by deltaPx (origin x += delta).
      // Showing left: left edge moves left (origin x -= delta).
      const xDelta = willHide ? deltaPx : -deltaPx;
      await w.setPosition(new PhysicalPosition(pos.x + xDelta, pos.y));
    }
  } catch {}
}

export function TitleBar() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();

  const minimize = () => isTauri && commands.windowMinimize().catch(() => {});
  const maximize = () => isTauri && commands.windowMaximize().catch(() => {});
  const close    = () => isTauri && commands.windowClose().catch(() => {});

  const toggleLeft = () => {
    const willHide = !state.leftPanelHidden;
    dispatch({ type: 'TOGGLE_LEFT_PANEL' });
    adjustWindowForPanel('left', willHide);
  };
  const toggleRight = () => {
    const willHide = !state.rightPanelHidden;
    dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
    adjustWindowForPanel('right', willHide);
  };
  const setGrid    = () => dispatch({ type: 'SET_MULTI_AGENT_LAYOUT', layout: 'grid' });
  const setColumns = () => dispatch({ type: 'SET_MULTI_AGENT_LAYOUT', layout: 'columns' });

  // Show the 2×2 / 1×4 layout picker when the active tab is either the
  // multi-agent quadrant or the independent four-split view — both use
  // the same multiAgentLayout state and CSS modifier classes.
  const activeTab = state.terminals.find(t => t.id === state.activeTerminalId);
  const showMaLayout = activeTab?.tool === 'multi-agent' || activeTab?.tool === 'four-split';

  // Drag is wired as a single JS path: mousedown anywhere on the bar (except
  // on a child <button>) calls `startDragging()`, double-click toggles
  // maximize. We previously set both `data-tauri-drag-region` and
  // `-webkit-app-region: drag` — two drag mechanisms on the same element —
  // and dropped them both for this single JS path; EchoBird uses the same
  // approach on the same Tauri version and is structurally cleaner.
  const onDragMouseDown = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    } catch {}
  };
  const onDragDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    maximize();
  };

  return (
    <div className="titlebar" onMouseDown={onDragMouseDown} onDoubleClick={onDragDoubleClick}>
      {/* Icons come straight from Lucide (lucide.dev, ISC license). No
          runtime dependency — just the d-paths copied inline so we
          don't pay a 200KB+ import for four glyphs.

          Order (per user design):
            1. Multi-agent layout picker (only while a multi-agent tab is
               active — ephemeral, slides in when useful, out when not)
            2. Left / right panel toggles (always-on, fixed position on
               the right so they're in the same spot every session)

          No separator between groups — VS Code's titlebar uses pure
          proximity to group, which stays clean whether 2 or 4 icons
          are showing. */}
      {/* Sharp-corner 24×24 glyphs — strokeWidth 1.8 so the icons read
          at the same optical weight as Phosphor/Lucide at 16px render.
          Internal dividers are inset (y=4 → y=20) so they STOP before
          the outer border instead of crossing through it — avoids the
          "crossed-lines" look the user flagged. Active signal still travels
          via .is-active background only. */}
      <div className="titlebar-layout-toggles">
        {showMaLayout && (
          <>
            <button
              className={`titlebar-btn titlebar-btn--layout${state.multiAgentLayout === 'grid' ? ' is-active' : ''}`}
              onClick={setGrid}
              aria-label="Multi-agent 2x2 grid"
              aria-pressed={state.multiAgentLayout === 'grid'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter">
                <rect x="3"  y="3"  width="7" height="7" />
                <rect x="14" y="3"  width="7" height="7" />
                <rect x="3"  y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </button>
            <button
              className={`titlebar-btn titlebar-btn--layout${state.multiAgentLayout === 'columns' ? ' is-active' : ''}`}
              onClick={setColumns}
              aria-label="Multi-agent vertical columns"
              aria-pressed={state.multiAgentLayout === 'columns'}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter">
                <rect x="3" y="3" width="18" height="18" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
            </button>
          </>
        )}

        <button
          className={`titlebar-btn titlebar-btn--layout${state.leftPanelHidden ? '' : ' is-active'}`}
          onClick={toggleLeft}
          aria-label="Toggle left panel"
          aria-pressed={!state.leftPanelHidden}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="3" y="3" width="18" height="18" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
        <button
          className={`titlebar-btn titlebar-btn--layout${state.rightPanelHidden ? '' : ' is-active'}`}
          onClick={toggleRight}
          aria-label="Toggle right panel"
          aria-pressed={!state.rightPanelHidden}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="3" y="3" width="18" height="18" />
            <line x1="15" y1="4" x2="15" y2="20" />
          </svg>
        </button>
      </div>

      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={minimize} id="t-min">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="4.5" width="8" height="1" fill="currentColor"/>
          </svg>
        </button>
        <button className="titlebar-btn" onClick={maximize} id="t-max">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/>
          </svg>
        </button>
        <button className="titlebar-btn close" onClick={close} id="t-close">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1.5 1.5 l7 7 M1.5 8.5 l7 -7" fill="none" stroke="currentColor" strokeWidth="1"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
