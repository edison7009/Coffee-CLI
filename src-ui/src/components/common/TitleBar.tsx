// TitleBar.tsx — Custom draggable titlebar (replaces native OS window chrome)
// Tauri requires this for frameless windows with decorations: false
//
// Layout: [drag-area with layout toggles on the left] … [min / max / close on the right]
//
// Left-side controls mirror VS Code's Activity Bar / Ctrl+B affordance:
//   1. Left panel toggle  (Explorer / 目录列表)
//   2. Right panel toggle (TaskBoard / 历史对话)
//   3. Multi-agent layout mode — only visible when the active tab is a
//      multi-agent quadrant. Two modes: grid (2×2) and columns (1×4).

import { commands, isTauri } from '../../tauri';
import { useAppState, useAppDispatch } from '../../store/app-state';
import './TitleBar.css';

export function TitleBar() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();

  const minimize = () => isTauri && commands.windowMinimize().catch(() => {});
  const maximize = () => isTauri && commands.windowMaximize().catch(() => {});
  const close    = () => isTauri && commands.windowClose().catch(() => {});

  const toggleLeft = () => dispatch({ type: 'TOGGLE_LEFT_PANEL' });
  const toggleRight = () => dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
  const setGrid    = () => dispatch({ type: 'SET_MULTI_AGENT_LAYOUT', layout: 'grid' });
  const setColumns = () => dispatch({ type: 'SET_MULTI_AGENT_LAYOUT', layout: 'columns' });

  // Show multi-agent layout picker only when the active tab IS multi-agent —
  // otherwise the control is noise.
  const activeTab = state.terminals.find(t => t.id === state.activeTerminalId);
  const showMaLayout = activeTab?.tool === 'multi-agent';

  return (
    // data-tauri-drag-region tells WebView2 this div is draggable
    <div className="titlebar" data-tauri-drag-region>
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
      <div className="titlebar-layout-toggles" data-tauri-drag-region="false">
        {showMaLayout && (
          <>
            <button
              className={`titlebar-btn titlebar-btn--layout${state.multiAgentLayout === 'grid' ? ' is-active' : ''}`}
              onClick={setGrid}
              aria-label="Multi-agent 2x2 grid"
              aria-pressed={state.multiAgentLayout === 'grid'}
            >
              {/* lucide layout-grid */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3"  y="3"  width="7" height="7" rx="1" />
                <rect x="14" y="3"  width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3"  y="14" width="7" height="7" rx="1" />
              </svg>
            </button>
            <button
              className={`titlebar-btn titlebar-btn--layout${state.multiAgentLayout === 'columns' ? ' is-active' : ''}`}
              onClick={setColumns}
              aria-label="Multi-agent 4 vertical columns"
              aria-pressed={state.multiAgentLayout === 'columns'}
            >
              {/* lucide columns-3 */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9"  y1="3" x2="9"  y2="21" />
                <line x1="15" y1="3" x2="15" y2="21" />
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
          {/* lucide panel-left */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <button
          className={`titlebar-btn titlebar-btn--layout${state.rightPanelHidden ? '' : ' is-active'}`}
          onClick={toggleRight}
          aria-label="Toggle right panel"
          aria-pressed={!state.rightPanelHidden}
        >
          {/* lucide panel-right */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        </button>
      </div>

      <div className="titlebar-controls" data-tauri-drag-region="false">
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
