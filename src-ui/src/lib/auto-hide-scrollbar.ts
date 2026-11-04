// auto-hide-scrollbar.ts — hides the native WebView2 scrollbar (which keeps
// re-surfacing its up/down arrow buttons no matter what CSS you apply: both
// `::-webkit-scrollbar-button` and the modern `scrollbar-width`/`scrollbar-color`
// paths fail on textareas) and draws a floating DOM slider instead. This is the
// same approach Coffee-Note uses for its skill menus (see its App.tsx
// bindAutoHideScrollbar) and mirrors how the terminal surfaces its xterm bar.
//
// The rail is appended to <body> as position:fixed and re-positioned at the
// element's current screen rect whenever the element scrolls, the window
// resizes, OR any ancestor scrolls (capture-phase document scroll) — so it
// follows the element even though the note cards live in a scrolling list.
//
// The slider fades in on interaction and auto-hides after a quiet period;
// it can be dragged to scroll. Returns a cleanup function (remove listeners,
// drop the rail) — call from useEffect's return.

interface AutoHideScrollbarOptions {
  /** ms of no interaction before the slider fades out. Default 450. */
  hideDelay?: number;
  /** Slimmer 7px rail / 4px slider. Default false. */
  slim?: boolean;
  /** Wider 12px rail / 8px slider for conversation scrolling. */
  wide?: boolean;
  /** px inset from the element's top edge. Default 0. */
  insetTop?: number;
  /** px inset from the element's bottom edge — e.g. clear a resize handle. */
  insetBottom?: number;
  /** Called when the user starts dragging the slider, before it moves. */
  onDragStart?: () => void;
}

export function bindAutoHideScrollbar(
  element: HTMLElement,
  options: AutoHideScrollbarOptions = {},
): () => void {
  const { hideDelay = 450, slim = false, wide = false, insetTop = 0, insetBottom = 0, onDragStart } = options;
  // Hide the native bar entirely (CSS in global.css: .auto-hide-scrollbar).
  element.classList.add('auto-hide-scrollbar');

  const rail = document.createElement('div');
  rail.className = slim ? 'cc-scrollbar cc-scrollbar-slim' : wide ? 'cc-scrollbar cc-scrollbar-wide' : 'cc-scrollbar';
  const railWidth = slim ? 7 : wide ? 12 : 10;
  rail.setAttribute('aria-hidden', 'true');
  const slider = document.createElement('div');
  slider.className = 'cc-scrollbar-slider';
  rail.append(slider);
  document.body.append(rail);

  let hideTimer: number | null = null;
  let updateFrame: number | null = null;
  let maxScroll = 0;
  let thumbTravel = 0;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  const updatePosition = () => {
    if (updateFrame != null) return;
    updateFrame = window.requestAnimationFrame(() => {
      updateFrame = null;
      const rect = element.getBoundingClientRect();
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const viewportHeight = Math.max(0, bottom - top);
      maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);

      // No overflow (or collapsed/off-screen, e.g. the panel mid-open at
      // width 0) → hide the rail. is-empty also disables pointer events.
      if (maxScroll <= 1 || viewportHeight < 24 || rect.width <= 0) {
        rail.classList.add('is-empty');
        return;
      }

      rail.classList.remove('is-empty');
      rail.style.top = `${Math.round(top + insetTop)}px`;
      rail.style.left = `${Math.round(Math.min(window.innerWidth - railWidth, rect.right - railWidth))}px`;
      rail.style.height = `${Math.round(viewportHeight - insetTop - insetBottom)}px`;

      const trackHeight = Math.max(0, viewportHeight - insetTop - insetBottom - 4);
      // Long conversations made a proportional thumb a hard-to-grab nub; keep
      // it at least a quarter of the track (min 64px) like the desktop apps.
      // A barely overflowing list made it fill almost the whole track instead:
      // like native scrollbars, it never grows past half the track (the minimum still wins on short tracks).
      const minThumb = Math.min(trackHeight, Math.max(64, trackHeight / 4));
      const thumbHeight = Math.max(minThumb, Math.min(trackHeight / 2, trackHeight * (element.clientHeight / element.scrollHeight)));
      thumbTravel = Math.max(0, trackHeight - thumbHeight);
      const thumbTop = maxScroll > 0 ? (element.scrollTop / maxScroll) * thumbTravel : 0;
      slider.style.height = `${Math.round(thumbHeight)}px`;
      slider.style.transform = `translateY(${Math.round(thumbTop + 2)}px)`;
    });
  };

  let hovered = false;
  const reveal = () => {
    updatePosition();
    rail.classList.add('is-visible');
    if (hideTimer != null) window.clearTimeout(hideTimer);
    hideTimer = null;
    // The rail lives outside the element, so hovering it fires no element
    // events; hold it visible until the pointer leaves so it can be grabbed.
    if (hovered || rail.classList.contains('is-dragging')) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      rail.classList.remove('is-visible');
    }, hideDelay);
  };

  const handleDragMove = (event: PointerEvent) => {
    if (thumbTravel <= 0) return;
    const scrollDelta = ((event.clientY - dragStartY) / thumbTravel) * maxScroll;
    element.scrollTop = Math.max(0, Math.min(maxScroll, dragStartScrollTop + scrollDelta));
  };

  const handleDragEnd = () => {
    rail.classList.remove('is-dragging');
    document.removeEventListener('pointermove', handleDragMove);
    document.removeEventListener('pointerup', handleDragEnd);
    document.removeEventListener('pointercancel', handleDragEnd);
    reveal();
  };

  const handleDragStart = (event: PointerEvent) => {
    if (event.button !== 0 || maxScroll <= 0) return;
    event.preventDefault();
    onDragStart?.();
    dragStartY = event.clientY;
    dragStartScrollTop = element.scrollTop;
    rail.classList.add('is-dragging', 'is-visible');
    if (hideTimer != null) window.clearTimeout(hideTimer);
    document.addEventListener('pointermove', handleDragMove);
    document.addEventListener('pointerup', handleDragEnd);
    document.addEventListener('pointercancel', handleDragEnd);
  };

  element.addEventListener('scroll', reveal, { passive: true });
  element.addEventListener('wheel', reveal, { passive: true });
  element.addEventListener('pointermove', reveal, { passive: true });
  element.addEventListener('touchstart', reveal, { passive: true });
  element.addEventListener('keydown', reveal);
  element.addEventListener('focusin', reveal);
  const handleRailEnter = () => { hovered = true; reveal(); };
  const handleRailLeave = () => { hovered = false; reveal(); };
  slider.addEventListener('pointerdown', handleDragStart);
  rail.addEventListener('pointerenter', handleRailEnter);
  rail.addEventListener('pointerleave', handleRailLeave);
  window.addEventListener('resize', updatePosition);
  document.addEventListener('scroll', updatePosition, true);
  const resizeObserver = new ResizeObserver(updatePosition);
  resizeObserver.observe(element);
  updatePosition();

  return () => {
    if (hideTimer != null) window.clearTimeout(hideTimer);
    if (updateFrame != null) window.cancelAnimationFrame(updateFrame);
    element.removeEventListener('scroll', reveal);
    element.removeEventListener('wheel', reveal);
    element.removeEventListener('pointermove', reveal);
    element.removeEventListener('touchstart', reveal);
    element.removeEventListener('keydown', reveal);
    element.removeEventListener('focusin', reveal);
    slider.removeEventListener('pointerdown', handleDragStart);
    rail.removeEventListener('pointerenter', handleRailEnter);
    rail.removeEventListener('pointerleave', handleRailLeave);
    window.removeEventListener('resize', updatePosition);
    document.removeEventListener('scroll', updatePosition, true);
    document.removeEventListener('pointermove', handleDragMove);
    document.removeEventListener('pointerup', handleDragEnd);
    document.removeEventListener('pointercancel', handleDragEnd);
    resizeObserver.disconnect();
    rail.remove();
    element.classList.remove('auto-hide-scrollbar');
  };
}
