// ActiveGambit.tsx — app-level host for the floating compose window.
//
// Gambit is a global overlay: it can be dragged to any corner of the
// application window, and its Send target is always the currently active
// tab. To keep it isolated from per-tab re-renders (xterm output, agent
// status events, etc.), it lives at the App level instead of inside any
// TierTerminal.
//
// This wrapper:
// - Reads the active tab's gambit state (open / draft) from the reducer
// - Derives the initial window position from that tab's xterm cursor via
//   the tab-actions registry
// - Wires Send through the registry so the text ends up in the right xterm
// - Hands a stable set of props to the memoized Gambit component so parent
//   re-renders don't ripple into the draggable element.
//
// Visibility is global (state.gambitOpen) so the panel doesn't flicker
// in/out when the user switches tabs. Draft content remains per-tab —
// switching tabs swaps what's shown inside the (still-open) panel so
// text can't be misdirected to the wrong terminal.

import { useCallback, useEffect, useMemo } from 'react';
import { useAppState, isSplitTool, paneSessionId, matchesGambitHotkey } from '../../store/app-state';
import { getTabActions } from '../../lib/tab-actions';
import { getFocusedPane } from '../../lib/pane-focus';
import { Gambit } from './Gambit';

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 180;

export function ActiveGambit() {
  const { state, dispatch } = useAppState();
  const activeId = state.activeTerminalId;
  const activeSession = activeId
    ? state.terminals.find(t => t.id === activeId)
    : undefined;

  const gambitOpen = state.gambitOpen;
  const gambitDraft = activeSession?.gambitDraft ?? '';

  // Anchored to primitives only — a new `activeSession` object reference on
  // every dispatch would otherwise thrash the memoization downstream.
  const initialPos = useMemo(() => {
    if (!gambitOpen || !activeId) return { x: 120, y: 120 };
    const cursor = getTabActions(activeId)?.cursorScreenPos();
    if (!cursor) return { x: 120, y: 120 };
    return {
      x: Math.max(8, Math.min(cursor.x, window.innerWidth - DEFAULT_WIDTH - 8)),
      y: Math.max(40, Math.min(cursor.y, window.innerHeight - DEFAULT_HEIGHT - 8)),
    };
    // Recompute only when visibility toggles or the active tab changes.
  }, [gambitOpen, activeId]);

  const handleDraftChange = useCallback((draft: string) => {
    if (!activeId) return;
    dispatch({ type: 'SET_GAMBIT_DRAFT', id: activeId, draft });
  }, [dispatch, activeId]);

  const handleClose = useCallback(() => {
    dispatch({ type: 'TOGGLE_GAMBIT' });
  }, [dispatch]);

  // Route Send to the correct xterm. For a plain single-terminal tab the
  // sessionId is just activeId. For a multi-pane tab, no xterm registers
  // under activeId itself — each pane registers under a suffixed id and
  // Gambit has to pick one. Two families of multi-pane tabs exist:
  //
  //   - Orchestrated multi-agent (`multi-agent` / `two-agent` /
  //     `three-agent`, rendered by MultiAgentGrid) uses the `::pane-N`
  //     suffix; backend treats that prefix as "hands-free mode" and
  //     injects auto-approve flags.
  //
  //   - Independent split (`two-split` / `three-split` / `four-split`,
  //     rendered by FourSplitGrid) uses the `::split-N` suffix; each
  //     pane is a plain user-interactive PTY with no auto-approve.
  //
  // Both write to the same `pane-focus` registry on click (tab-scoped
  // 1..N), so routing only has to pick the right prefix.
  //
  // If no pane has been focused yet, return false so Gambit preserves
  // the draft rather than dropping text into the void.
  const handleSend = useCallback((text: string): boolean => {
    if (!activeId) return false;
    const tool = activeSession?.tool ?? null;
    let targetId = activeId;
    if (isSplitTool(tool)) {
      const paneIdx = getFocusedPane(activeId);
      if (!paneIdx) return false;
      targetId = paneSessionId(activeId, paneIdx, 'split');
    }
    const actions = getTabActions(targetId);
    if (!actions) return false;
    return actions.paste(text);
  }, [activeId, activeSession?.tool]);

  // Global open/close hotkey (settings → 妙手). Registered in the CAPTURE
  // phase on document so it fires BEFORE the focused xterm's own keydown —
  // preventDefault then stops the combo (e.g. Ctrl+~) from leaking a control
  // byte into the terminal. NOT gated on gambitOpen: ActiveGambit stays
  // mounted app-wide even while the panel is closed, so the same key both
  // opens and closes. Auto-repeat events are still suppressed (preventDefault)
  // but don't re-toggle, so holding the key neither flickers nor leaks a byte.
  const hotkey = state.gambitHotkey;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // IME composition in progress — let the IME keep the key (same guard
      // every other keydown handler in this app uses, e.g. Gambit.tsx).
      if (e.isComposing) return;
      if (!matchesGambitHotkey(e, hotkey)) return;
      // Suppress the combo for EVERY matching event — including auto-repeat —
      // so a held key never leaks a byte into the xterm during the ~1 frame
      // before Gambit grabs focus. Only the initial (non-repeat) press toggles.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      dispatch({ type: 'TOGGLE_GAMBIT' });
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [hotkey, dispatch]);

  if (!gambitOpen || !activeId) return null;

  return (
    <Gambit
      sessionId={activeId}
      draft={gambitDraft}
      initialX={initialPos.x}
      initialY={initialPos.y}
      onDraftChange={handleDraftChange}
      onClose={handleClose}
      onSend={handleSend}
      leftPanelHidden={state.leftPanelHidden}
      rightPanelHidden={state.rightPanelHidden}
    />
  );
}
