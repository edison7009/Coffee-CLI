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
// Per-tab semantics are preserved: each tab owns its own gambitOpen and
// gambitDraft; switching tabs switches which state Gambit reflects.

import { useCallback, useMemo } from 'react';
import { useAppState } from '../../store/app-state';
import { getTabActions } from '../../lib/tab-actions';
import { Gambit } from './Gambit';

const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 180;

export function ActiveGambit() {
  const { state, dispatch } = useAppState();
  const activeId = state.activeTerminalId;
  const activeSession = activeId
    ? state.terminals.find(t => t.id === activeId)
    : undefined;

  const gambitOpen = activeSession?.gambitOpen ?? false;
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
    if (!activeId) return;
    dispatch({ type: 'TOGGLE_GAMBIT', id: activeId });
  }, [dispatch, activeId]);

  const handleSend = useCallback((text: string) => {
    if (!activeId) return;
    getTabActions(activeId)?.paste(text);
  }, [activeId]);

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
    />
  );
}
