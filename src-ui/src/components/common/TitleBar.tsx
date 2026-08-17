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
import { useAppState, useAppDispatch, schemeLabels } from '../../store/app-state';
import { IS_MACOS } from '../../lib/platform';
import { useT } from '../../i18n/useT';
import './TitleBar.css';

export function TitleBar() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();

  // The active scheme's three combos, shown as persistent hints on the left /
  // Gambit / right buttons — a deliberate memory hook for the product's
  // signature one-hand shortcuts (left=Q · Gambit=W · right=E by default).
  const hk = schemeLabels(state.hotkeyScheme);

  const minimize = () => isTauri && commands.windowMinimize().catch(() => {});
  const maximize = () => isTauri && commands.windowMaximize().catch(() => {});
  const close    = () => isTauri && commands.windowClose().catch(() => {});

  // Toggle just flips the layout flag — the OS window stays put and the
  // center column expands/contracts to fill the freed/reclaimed space,
  // matching VS Code / Cursor / Warp behavior. We previously also shrank
  // the OS window edge by 320px on the panel's axis, but the Tauri resize
  // IPC lands 1-3 frames after React commits, which made the center
  // column visibly squish-then-rebound (or expand-then-shrink) on every
  // toggle. Removing the window-edge move trades a non-standard "trim
  // collapsed window" effect for zero flicker — the right call.
  const toggleLeft  = () => dispatch({ type: 'TOGGLE_LEFT_PANEL' });
  const toggleRight = () => dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
  const setGrid    = () => dispatch({ type: 'SET_MULTI_AGENT_LAYOUT', layout: 'grid' });
  const setColumns = () => dispatch({ type: 'SET_MULTI_AGENT_LAYOUT', layout: 'columns' });

  // Show the 2×2 / 1×4 layout picker only for the independent four-split view.
  const activeTab = state.terminals.find(t => t.id === state.activeTerminalId);
  const showMaLayout = activeTab?.tool === 'four-split';

  // Drag is wired as a single JS path: mousedown anywhere on the bar (except
  // on a child <button>) calls `startDragging()`, double-click toggles
  // maximize. We previously set both `data-tauri-drag-region` and
  // `-webkit-app-region: drag` — two drag mechanisms on the same element —
  // and dropped them both for this single JS path; EchoBird uses the same
  // approach on the same Tauri version and is structurally cleaner.
  const onDragMouseDown = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    // Tool tabs now live in the bar — a press on the tab strip must reach the
    // tab's own click / pointer-reorder handlers, not start a window drag.
    if ((e.target as HTMLElement).closest('.chrome-tabs-header')) return;
    e.preventDefault();
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    } catch {}
  };
  const onDragDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if ((e.target as HTMLElement).closest('.chrome-tabs-header')) return;
    maximize();
  };

  return (
    <div className="titlebar" onMouseDown={onDragMouseDown} onDoubleClick={onDragDoubleClick}>
      {/* Left slot mirrors the left panel's width so the tab strip begins at
          the TOP OF THE CENTER COLUMN, not the window's left edge — that
          far-left strip belongs to the left sidebar (and hosts the macOS
          traffic lights). Collapses in lockstep with the panel via the shared
          --w-left var + the same 250ms curve. */}
      <div id="titlebar-brand-slot" className={`titlebar-left-slot${state.leftPanelHidden ? ' is-collapsed' : ''}`} />
      {/* Tool tabs (Windows-Terminal style) render here — CenterPanel portals
          its .chrome-tabs-header into this slot so the tabs sit on the drag bar
          above the center column, with the layout toggles + window controls to
          their right. The flexible spacer between them stays a draggable handle. */}
      <div className="titlebar-tabs" id="titlebar-tab-slot" />
      <div className="titlebar-drag-spacer" />
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
      <div className="titlebar-layout-toggles" data-toggle-display={state.titlebarToggleDisplay}>
        {/* Left panel · Gambit · right panel — the three hinted chrome toggles,
            adjacent with Gambit in the MIDDLE so the row mirrors the screen
            (left panel on the left, right on the right) and the default Alt+QWE
            keys read left-to-right. */}
        <button
          className={`titlebar-btn titlebar-btn--layout titlebar-btn--hinted${state.leftPanelHidden ? '' : ' is-active'}`}
          onClick={toggleLeft}
          aria-label={`Toggle left panel (${hk.left})`}
          aria-pressed={!state.leftPanelHidden}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="3" y="3" width="18" height="18" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
          <span className="titlebar-hotkey-hint">{hk.left}</span>
        </button>
        {/* Gambit compose (middle) — always visible even when the left panel is
            hidden. Keyboard glyph; open state reads from the .is-active bg, so
            no need to swap the icon to an X. */}
        <button
          className={`titlebar-btn titlebar-btn--layout titlebar-btn--hinted${state.gambitOpen ? ' is-active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_GAMBIT' })}
          aria-label={`Gambit compose (${hk.gambit})`}
          aria-pressed={state.gambitOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M6 8h.001" />
            <path d="M10 8h.001" />
            <path d="M14 8h.001" />
            <path d="M18 8h.001" />
            <path d="M8 12h.001" />
            <path d="M12 12h.001" />
            <path d="M16 12h.001" />
            <path d="M7 16h10" />
          </svg>
          <span className="titlebar-hotkey-hint">{hk.gambit}</span>
        </button>
        <button
          className={`titlebar-btn titlebar-btn--layout titlebar-btn--hinted${state.rightPanelHidden ? '' : ' is-active'}`}
          onClick={toggleRight}
          aria-label={`Toggle right panel (${hk.right})`}
          aria-pressed={!state.rightPanelHidden}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter">
            <rect x="3" y="3" width="18" height="18" />
            <line x1="15" y1="4" x2="15" y2="20" />
          </svg>
          <span className="titlebar-hotkey-hint">{hk.right}</span>
        </button>
        {/* Multi-agent layout mode — only when the active tab is a quadrant.
            After the panel trio so the trio stays anchored when it toggles. */}
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

        {/* Personalization settings — gear opens the consolidated modal that
            replaced the old left-panel theme/language popovers. The `title`
            tooltip matters here: new users reported not finding settings
            because the gear sits unlabeled among the look-alike layout
            toggles (those at least carry hotkey-hint text). */}
        <button
          className={`titlebar-btn titlebar-btn--layout${state.settingsOpen ? ' is-active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
          aria-label={t('settings.title')}
          title={t('settings.title')}
          aria-pressed={state.settingsOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Custom min/max/close — Windows/Linux only. On macOS the OS draws the
          native traffic lights on the LEFT (titleBarStyle: "Overlay" in
          tauri.macos.conf.json), so we omit our own controls; the layout
          toggles above stay on the right and the left drag region hosts the
          native lights. */}
      {!IS_MACOS && (
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
      )}
    </div>
  );
}
