// focus-registry.ts — singleton focus map for terminal sessions.
//
// Every TierTerminal used to add its own window-level focusin + mouseup
// listeners to "steal focus back" whenever the user clicked around. With N
// tabs open, that was 2N global listeners — every click or focus change
// fired N callbacks that each did a visibility check.
//
// Now: a single pair of window listeners lives in CenterPanel. When fired,
// they look up the active terminal's focus function in this registry and
// call it once. Per-tab cost is zero.

const focusFns = new Map<string, () => void>();

/**
 * Register a focus function for a terminal session.
 * Returns an unregister closure to call on unmount.
 */
export function registerTerminalFocus(sessionId: string, focusFn: () => void): () => void {
  focusFns.set(sessionId, focusFn);
  return () => {
    // Only delete if it's still the one we registered — protects against a
    // remount replacing the entry before the previous unmount clean-up runs.
    if (focusFns.get(sessionId) === focusFn) {
      focusFns.delete(sessionId);
    }
  };
}

/**
 * Focus the terminal with the given session id, if one is registered.
 */
export function focusTerminal(sessionId: string): void {
  const fn = focusFns.get(sessionId);
  if (fn) fn();
}
