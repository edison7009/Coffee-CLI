import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useT } from '../../i18n/useT';

export interface ConversationNavigationItem {
  id: string;
  sourceMessageId: string;
  content: string;
  messageIndex: number;
  top: number;
  cursor: number | null;
}

// Claude Desktop's limits: a message over 300px shows its first 200px, fading out over the last 3rem.
const COLLAPSE_ABOVE = 300;

/** The user's bubble. The expansion lives with the conversation, as virtual rows unmount off screen. */
export function CollapsibleUserMessage({ expanded, onToggle, children }: { expanded: boolean; onToggle: () => void; children: ReactNode }) {
  const t = useT(), id = useId();
  const content = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null), toggleTop = useRef<number | null>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setOverflows(element.offsetHeight > COLLAPSE_ABOVE);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Collapsing removes the height above the button; keep the button under the pointer.
  useLayoutEffect(() => {
    const top = toggleTop.current, button = toggle.current;
    toggleTop.current = null;
    const scroller = button?.closest('.claude-scroll');
    if (top !== null && button && scroller) scroller.scrollTop += button.getBoundingClientRect().top - top;
  }, [expanded]);
  return <div className="claude-user-content">
    <div id={id} className={`claude-user-body${overflows && !expanded ? ' is-collapsed' : ''}`}><div ref={content}>{children}</div></div>
    {overflows && <button ref={toggle} type="button" className="claude-user-toggle" aria-expanded={expanded} aria-controls={id} onClick={event => {
      if (expanded) toggleTop.current = event.currentTarget.getBoundingClientRect().top;
      onToggle();
    }}>{t(expanded ? 'claude.collapse' : 'conversation.show_more')}</button>}
  </div>;
}

export function MessageCopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`conversation-copy${copied ? ' conversation-copy--copied' : ''}`}
      aria-label={copied ? t('conversation.copied') : t('conversation.copy_message')}
      onClick={onCopy}
    >
      {copied ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="5 13 9 17 19 7" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </svg>
      )}
    </button>
  );
}

export interface ConversationNavigationProps {
  items: ConversationNavigationItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: (item: ConversationNavigationItem) => void;
}

/** Navigation owns every high-frequency hover/scroll state update. Keeping it
 * outside the transcript prevents a tooltip move or active-line change
 * from reconciling the full Markdown transcript. Target positions are measured
 * only when layout changes; scrolling performs an O(log n) lookup over that
 * cache instead of getBoundingClientRect() on every user turn each frame. */
export const ConversationNavigation = memo(function ConversationNavigation({
  items, scrollRef, onJump,
}: ConversationNavigationProps) {
  const t = useT();
  const navigationRef = useRef<HTMLElement>(null);
  const navigationScrollRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tooltipTop, setTooltipTop] = useState(0);

  const hoveredIndex = items.findIndex(item => item.id === hoveredId);
  const hoveredItem = hoveredIndex >= 0 ? items[hoveredIndex] : null;

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || items.length === 0) return;

    let activeFrame: number | null = null;

    const updateActive = () => {
      activeFrame = null;
      const readingTop = scroll.scrollTop + Math.min(120, scroll.clientHeight * 0.24);

      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (items[middle].top < readingTop) low = middle + 1;
        else high = middle;
      }
      let closest = Math.min(low, items.length - 1);
      if (closest > 0 &&
          Math.abs(items[closest - 1].top - readingTop) <=
            Math.abs(items[closest].top - readingTop)) {
        closest -= 1;
      }
      const nextId = items[closest].id;
      setActiveId(current => current === nextId ? current : nextId);
    };

    const scheduleActive = () => {
      if (activeFrame === null) activeFrame = window.requestAnimationFrame(updateActive);
    };

    scroll.addEventListener('scroll', scheduleActive, { passive: true });
    scheduleActive();

    return () => {
      scroll.removeEventListener('scroll', scheduleActive);
      if (activeFrame !== null) window.cancelAnimationFrame(activeFrame);
    };
  }, [items, scrollRef]);

  useEffect(() => {
    const container = navigationScrollRef.current;
    if (!container || !activeId) return;
    const centreActiveItem = () => {
      const item = container.querySelector<HTMLElement>(
        `[data-conversation-navigation-target="${CSS.escape(activeId)}"]`,
      );
      if (!item) return;
      // Use viewport-relative rectangles instead of offsetTop: the navigation
      // wrapper is positioned, so offsetParent changes must not skew the inner
      // scroll coordinate. Re-run when Gambit resizing changes the rail height.
      const containerRect = container.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const itemTop = itemRect.top - containerRect.top + container.scrollTop;
      container.scrollTop = itemTop - (container.clientHeight - itemRect.height) / 2;
    };

    centreActiveItem();
    const observer = new ResizeObserver(centreActiveItem);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeId]);

  const showTooltip = (messageId: string, item: HTMLElement) => {
    const navigation = navigationRef.current;
    if (!navigation) return;
    const itemRect = item.getBoundingClientRect();
    const navigationRect = navigation.getBoundingClientRect();
    setHoveredId(messageId);
    setTooltipTop(itemRect.top + itemRect.height / 2 - navigationRect.top);
  };

  return (
    <nav
      ref={navigationRef}
      className="conversation-navigation"
      aria-label={t('conversation.navigation')}
      onMouseLeave={() => setHoveredId(null)}
    >
      <div
        ref={navigationScrollRef}
        className="conversation-navigation-scroll"
        onScroll={() => {
          if (!hoveredId) return;
          const item = navigationScrollRef.current?.querySelector<HTMLElement>(
            `[data-conversation-navigation-target="${CSS.escape(hoveredId)}"]`,
          );
          if (item) showTooltip(hoveredId, item);
        }}
      >
        {items.map((item, index) => {
          const hoverDistance = hoveredIndex < 0 ? undefined : Math.abs(index - hoveredIndex);
          return (
            <button
              type="button"
              key={item.id}
              className="conversation-navigation-item"
              data-conversation-navigation-target={item.id}
              data-active={activeId === item.id ? 'true' : undefined}
              data-hover-distance={hoverDistance !== undefined && hoverDistance <= 2
                ? hoverDistance
                : undefined}
              aria-label={t('conversation.jump_to_turn', { turn: index + 1 })}
              aria-current={activeId === item.id ? 'step' : undefined}
              aria-describedby={hoveredId === item.id ? tooltipId : undefined}
              onMouseEnter={event => showTooltip(item.id, event.currentTarget)}
              onFocus={event => showTooltip(item.id, event.currentTarget)}
              onBlur={() => setHoveredId(null)}
              onClick={() => onJump(item)}
            >
              <span aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {hoveredItem && (
        <div
          id={tooltipId}
          className="conversation-navigation-tooltip"
          role="tooltip"
          style={{ top: tooltipTop }}
        >
          <span>{hoveredItem.content.replace(/\s+/g, ' ').trim()}</span>
        </div>
      )}
    </nav>
  );
});
