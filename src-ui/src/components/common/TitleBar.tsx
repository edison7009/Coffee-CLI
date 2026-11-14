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

import { useEffect } from 'react';
import { commands, isTauri } from '../../tauri';
import { useAppState, useAppDispatch, schemeLabels } from '../../store/app-state';
import { IS_MACOS } from '../../lib/platform';
import { IS_WEB, useCompact } from '../../lib/viewport';
import { useT } from '../../i18n/useT';
import { isConversationSession } from '../../lib/chat-tools';
import { Changelog } from './Changelog';
import './TitleBar.css';

export function TitleBar() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();

  // The active scheme's three combos, shown as persistent hints on the left /
  // Gambit / right buttons — a deliberate memory hook for the product's
  // signature one-hand shortcuts (left=Q · Gambit=W · right=E by default).
  const hk = schemeLabels(state.hotkeyScheme);
  // ⌘, (Ctrl+, elsewhere) opens and closes settings, as in most desktop apps.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ',' || event.altKey || event.shiftKey || !(IS_MACOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      dispatch({ type: 'TOGGLE_SETTINGS' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch]);

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
  // Narrow: the panels are drawers, so the buttons show and toggle the open drawer instead.
  const compact = useCompact();
  const leftShown = compact ? state.drawer === 'left' : !state.leftPanelHidden;
  const rightShown = compact ? state.drawer === 'right' : !state.rightPanelHidden;
  const toggleLeft  = () => dispatch({ type: 'TOGGLE_LEFT_PANEL' });
  const toggleRight = () => dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
  const activeTab = state.terminals.find(t => t.id === state.activeTerminalId);
  const claudeComposerLocked = isConversationSession(activeTab) && !state.diffTabActive;
  const gambitOpen = claudeComposerLocked || state.gambitOpen;

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
    } catch { /* Best-effort operation; failure is non-fatal. */ }
  };
  const onDragDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if ((e.target as HTMLElement).closest('.chrome-tabs-header')) return;
    maximize();
  };

  return (
    <div className={`titlebar${state.settingsOpen ? ' titlebar--settings' : ''}`} onMouseDown={onDragMouseDown} onDoubleClick={onDragDoubleClick}>
      {/* While settings covers the window, the bar keeps only the window controls; Back is on the settings page. */}
      {/* Left slot mirrors the left panel's width so the tab strip begins at
          the TOP OF THE CENTER COLUMN, not the window's left edge — that
          far-left strip belongs to the left sidebar (and hosts the macOS
          traffic lights). Collapses in lockstep with the panel via the shared
          --w-left var + the same 250ms curve. */}
      <div id="titlebar-brand-slot" className={`titlebar-left-slot${!leftShown || compact ? ' is-collapsed' : ''}`} />
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
      {/* Rounded 24×24 glyphs (rx=2, strokeWidth 2, round caps) shared by
          all layout toggles so the panels and the keyboard read as one set.
          Active signal travels via .is-active background only. */}
      <div className="titlebar-layout-toggles" data-toggle-display={state.titlebarToggleDisplay}>
        <Changelog />
        {/* Left panel · Gambit · right panel — the three hinted chrome toggles,
            adjacent with Gambit in the MIDDLE so the row mirrors the screen
            (left panel on the left, right on the right) and the default Alt+QWE
            keys read left-to-right. */}
        <button
          className={`titlebar-btn titlebar-btn--layout titlebar-btn--hinted${leftShown ? ' is-active' : ''}`}
          onClick={toggleLeft}
          aria-label={`Toggle left panel (${hk.left})`}
          aria-pressed={leftShown}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M9 4v16" />
          </svg>
          <span className="titlebar-hotkey-hint">{hk.left}</span>
        </button>
        {/* Gambit compose (middle) — always visible even when the left panel is
            hidden. Keyboard glyph; open state reads from the .is-active bg, so
            no need to swap the icon to an X. */}
        <button
          className={`titlebar-btn titlebar-btn--layout titlebar-btn--hinted${gambitOpen ? ' is-active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_GAMBIT' })}
          disabled={claudeComposerLocked}
          aria-label={`Gambit compose (${hk.gambit})`}
          aria-pressed={gambitOpen}
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
          className={`titlebar-btn titlebar-btn--layout titlebar-btn--hinted${rightShown ? ' is-active' : ''}`}
          onClick={toggleRight}
          aria-label={`Toggle right panel (${hk.right})`}
          aria-pressed={rightShown}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M15 4v16" />
          </svg>
          <span className="titlebar-hotkey-hint">{hk.right}</span>
        </button>
        {/* Personalization settings — gear opens the consolidated modal that
            replaced the old left-panel theme/language popovers. It joins the
            configured titlebar display mode, except "hidden" intentionally
            degrades to icon-only so Settings always remains reachable. */}
        {/* Settings lives at the left sidebar's bottom; here only while that sidebar is hidden, so it stays reachable. */}
        {(state.leftPanelHidden || compact) && <button
          className={`titlebar-btn titlebar-btn--layout titlebar-btn--hinted titlebar-btn--settings${state.settingsOpen ? ' is-active' : ''}`}
          onClick={() => dispatch({ type: 'TOGGLE_SETTINGS' })}
          aria-label={t('settings.title')}
          aria-pressed={state.settingsOpen}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span className="titlebar-hotkey-hint titlebar-settings-label">{t('settings.title')}</span>
        </button>}
      </div>

      {/* Custom min/max/close — Windows/Linux only. On macOS the OS draws the
          native traffic lights on the LEFT (titleBarStyle: "Overlay" in
          tauri.macos.conf.json), so we omit our own controls; the layout
          toggles above stay on the right and the left drag region hosts the
          native lights. */}
      {/* A browser or phone has its own window controls. */}
      {!IS_MACOS && !IS_WEB && (
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
