// pane-focus.ts — which pane (1..4) inside a multi-agent Tab has
// keyboard focus right now.
//
// Why a module-level map instead of reducer state: this value changes on
// every pane click and is read only at send time (Gambit submit). Pushing
// it through React's dispatch pipeline would re-render the whole app tree
// on every click for no rendering benefit. A plain Map is O(1) read/write
// and has zero reconciliation cost.
//
// MultiAgentGrid writes here on click/focus; ActiveGambit reads here when
// routing text to a pane.

const focused = new Map<string, number>();

export function setFocusedPane(tabId: string, paneIdx: number | null): void {
  if (paneIdx == null) {
    focused.delete(tabId);
  } else {
    focused.set(tabId, paneIdx);
  }
}

export function getFocusedPane(tabId: string): number | undefined {
  return focused.get(tabId);
}
