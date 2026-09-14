// Ownership model for conversation scroll positions.
//
// A browser clamp (content shrank under the viewport), a display:none
// restore, and a remount all produce scroll events that are indistinguishable
// from "the user scrolled" by looking at the numbers alone — yet only real
// user-driven scrolling may overwrite the remembered reading position or arm
// the auto-loadOlder trigger. A clamped value recorded over the good position
// destroys the restore target: once the transcript regrows, the view can no
// longer return to where the user was reading.
//
// The decision therefore tracks ownership: a scroll event is user-owned when
// it follows a wheel/pointer/touch/keyboard/scrollbar input within
// SCROLL_OWN_WINDOW_MS, or when it arrives inside a chain of owned events
// (momentum and smooth scrolling keep the chain alive).
//
// Input timing alone cannot rule out a clamp: a tool can rewrite its session
// file a few hundred milliseconds after the user last touched the wheel. A
// transcript clamp is recognised instead by its cause and signature — the
// last transcript commit made the content shorter, and the event shows the
// view moved UP onto the new bottom. Such an event is never owned, whatever
// the input clock says, so it can neither record the clamped bottom over the
// reading position nor flip the pinned flag (the clamped bottom READS as
// pinned). The one exception is a view that was already pinned: its flag must
// survive remounts, and a shrink keeps it pinned anyway.
//
// Only a transcript shrink qualifies. The virtualizer also shortens content
// when rows scrolled into view measure smaller than their estimates — right
// after the user jumped to the bottom (End, a thumb drag, a fling). Those
// clamps follow user intent and must still let the view pin.

export const SCROLL_OWN_WINDOW_MS = 400;
export const SCROLL_PIN_THRESHOLD_PX = 72;
export const SCROLL_AUTO_LOAD_THRESHOLD_PX = 520;
export const SCROLL_SCROLLABLE_SLACK_PX = 80;

export interface ScrollGeometry {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollEventDecision {
  /** Geometry-derived pin state; apply to the pinned flag ONLY when owned. */
  pinned: boolean;
  /** Whether this event is a browser clamp after the transcript shrank. */
  clamped: boolean;
  /** Whether this event is user-driven (input or the momentum chain). */
  owned: boolean;
  /** Carry-forward for the ownership chain; store it for the next event. */
  ownedUntil: number;
  /** Whether this event may overwrite the remembered reading position. */
  record: boolean;
  /** Whether this event may trigger an older-history page load. */
  autoLoadOlder: boolean;
}

export function evaluateScrollEvent(args: ScrollGeometry & {
  now: number;
  lastUserInputAt: number;
  ownedUntil: number;
  previouslyPinned: boolean;
  /** Geometry seen by the previous scroll event (0 before the first one). */
  previousScrollHeight: number;
  previousScrollTop: number;
  /** A transcript commit shortened the content since the previous event. */
  transcriptShrank: boolean;
  isTrusted: boolean;
}): ScrollEventDecision {
  const { now, lastUserInputAt, previouslyPinned, clientHeight, scrollHeight, scrollTop, isTrusted } = args;
  const pinned = scrollHeight - scrollTop - clientHeight < SCROLL_PIN_THRESHOLD_PX;
  const scrollable = scrollHeight > clientHeight + SCROLL_SCROLLABLE_SLACK_PX;
  const clamped = args.transcriptShrank &&
    scrollHeight < args.previousScrollHeight &&
    scrollTop < args.previousScrollTop &&
    scrollTop >= Math.max(0, scrollHeight - clientHeight) - 1;
  const owned = !clamped &&
    (now - lastUserInputAt <= SCROLL_OWN_WINDOW_MS || now <= args.ownedUntil);
  const ownedUntil = owned ? now + SCROLL_OWN_WINDOW_MS : args.ownedUntil;
  return {
    pinned,
    clamped,
    owned,
    ownedUntil,
    record: scrollable && (owned || (pinned && previouslyPinned)),
    autoLoadOlder: isTrusted && scrollTop < SCROLL_AUTO_LOAD_THRESHOLD_PX && owned,
  };
}

/** A restore is warranted when the view sits more than a viewport above the
 * remembered position without any recent user input — the signature of a
 * clamp/display:none/remount losing the position, not of reading. */
export function shouldRestoreScrollPosition(args: {
  savedScrollTop: number;
  scrollTop: number;
  clientHeight: number;
  now: number;
  lastUserInputAt: number;
}): boolean {
  return (
    args.savedScrollTop - args.scrollTop > args.clientHeight &&
    args.now - args.lastUserInputAt > SCROLL_OWN_WINDOW_MS
  );
}

/** Where the layout pass should put an unanchored view: the bottom while
 * pinned, the remembered position when it was lost, otherwise null (leave the
 * reader alone). */
export function planLayoutScrollTop(args: ScrollGeometry & {
  pinned: boolean;
  savedScrollTop: number | null;
  now: number;
  lastUserInputAt: number;
}): number | null {
  if (args.pinned) return args.scrollHeight;
  if (args.savedScrollTop === null || !shouldRestoreScrollPosition({
    savedScrollTop: args.savedScrollTop,
    scrollTop: args.scrollTop,
    clientHeight: args.clientHeight,
    now: args.now,
    lastUserInputAt: args.lastUserInputAt,
  })) {
    return null;
  }
  return Math.min(args.savedScrollTop, Math.max(0, args.scrollHeight - args.clientHeight));
}
