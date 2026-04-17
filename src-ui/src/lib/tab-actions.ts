// tab-actions.ts — per-session "how to write to this tab's xterm" registry.
//
// Gambit (the floating compose window) lives at the App level, not inside
// any TierTerminal. When the user hits Send, Gambit needs to forward the
// text into the *active* tab's xterm. It does that by looking up the tab's
// paste function in this registry.
//
// Same pattern as focus-registry.ts: each TierTerminal registers on mount
// and unregisters on unmount, so the map always reflects live tabs.

export interface TabActions {
  /** Paste text into the tab's xterm (handles bracketed paste framing) and
   *  submit with CR, as if the user typed the whole message in-place. */
  paste: (text: string) => void;
  /** Current xterm cursor position in screen coordinates, used by Gambit to
   *  place itself just below the prompt on open. Returns null if the tab's
   *  xterm isn't fully initialized yet. */
  cursorScreenPos: () => { x: number; y: number } | null;
}

const registry = new Map<string, TabActions>();

/**
 * Register a tab's actions. Returns an unregister closure.
 * The identity check in the closure protects against a remount race where
 * a new registration could otherwise be wiped by a previous unmount.
 */
export function registerTabActions(sessionId: string, actions: TabActions): () => void {
  registry.set(sessionId, actions);
  return () => {
    if (registry.get(sessionId) === actions) {
      registry.delete(sessionId);
    }
  };
}

export function getTabActions(sessionId: string): TabActions | undefined {
  return registry.get(sessionId);
}
