import {
  useCallback, useEffect, useMemo, useRef, useState,
  type RefObject,
} from 'react';
import type { ChatMessage } from '../../lib/chat-transcript';

const OVERSCAN_PX = 480;
const THREAD_TOP_PADDING_PX = 34;
const INITIAL_TAIL_ROWS = 28;

interface VirtualRange {
  start: number;
  end: number;
}

interface VirtualMetrics {
  offsets: number[];
  total: number;
  keys: string[];
}

function measurementKey(message: ChatMessage): string {
  const head = message.content.slice(0, 24);
  const tail = message.content.slice(-24);
  return `${message.id}\u0000${message.role}\u0000${message.content.length}\u0000${head}\u0000${tail}`;
}

function estimatedHeight(message: ChatMessage): number {
  // Height estimation runs for every cold/offscreen row. Sample at most the
  // first 4 KiB instead of splitting a multi-megabyte tool output on every
  // metrics pass; wrapped length below still supplies a conservative cap.
  let explicitLines = 1;
  const sampleLength = Math.min(message.content.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (message.content.charCodeAt(index) === 10) explicitLines += 1;
  }
  const wrappedLines = Math.ceil(message.content.length / (message.role === 'user' ? 58 : 88));
  const lines = Math.max(explicitLines, wrappedLines);
  if (message.role === 'tool') return Math.min(260, 34 + lines * 17);
  if (message.role === 'reasoning') return Math.min(280, 38 + lines * 18);
  if (message.role === 'user') return Math.min(420, 58 + lines * 23);
  return Math.min(720, 48 + lines * 22);
}

function indexAtOffset(offsets: number[], target: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Variable-height window for the conversation transcript. Message Markdown
 * exists only around the viewport; cached measurements keep navigation and
 * scroll offsets stable after rows leave the DOM. */
export function useConversationVirtualizer(
  messages: ChatMessage[],
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  const [heights, setHeights] = useState(() => new Map<string, number>());
  const pendingHeightsRef = useRef(new Map<string, number>());
  const measureFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0 });

  const metrics = useMemo<VirtualMetrics>(() => {
    const offsets = new Array<number>(messages.length + 1);
    const keys = new Array<string>(messages.length);
    offsets[0] = 0;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const key = measurementKey(message);
      keys[index] = key;
      const height = heights.get(key) ?? estimatedHeight(message);
      offsets[index + 1] = offsets[index] + height;
    }
    return { offsets, total: offsets[messages.length] ?? 0, keys };
  }, [messages, heights]);

  const updateRange = useCallback(() => {
    scrollFrameRef.current = null;
    const scroll = scrollRef.current;
    if (!scroll || messages.length === 0) {
      setRange(current => current.start === 0 && current.end === 0
        ? current
        : { start: 0, end: 0 });
      return;
    }
    // display:none reports a zero viewport and scrollTop. Keep the last visible
    // rows mounted so switching back doesn't rebuild the list from its start.
    if (scroll.clientHeight === 0) return;
    const viewportTop = Math.max(0, scroll.scrollTop - THREAD_TOP_PADDING_PX);
    const start = indexAtOffset(metrics.offsets, Math.max(0, viewportTop - OVERSCAN_PX));
    const end = Math.min(
      messages.length,
      indexAtOffset(metrics.offsets, viewportTop + scroll.clientHeight + OVERSCAN_PX) + 1,
    );
    setRange(current => current.start === start && current.end === end
      ? current
      : { start, end });
  }, [messages.length, metrics.offsets, scrollRef]);

  const scheduleRange = useCallback(() => {
    if (scrollFrameRef.current === null) {
      scrollFrameRef.current = window.requestAnimationFrame(updateRange);
    }
  }, [updateRange]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    scroll.addEventListener('scroll', scheduleRange, { passive: true });
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleRange);
    resizeObserver?.observe(scroll);
    scheduleRange();
    return () => {
      scroll.removeEventListener('scroll', scheduleRange);
      resizeObserver?.disconnect();
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [scheduleRange, scrollRef]);

  useEffect(scheduleRange, [messages, scheduleRange]);

  const measureRow = useCallback((messageId: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    pendingHeightsRef.current.set(messageId, height);
    if (measureFrameRef.current === null) {
      measureFrameRef.current = window.requestAnimationFrame(() => {
        measureFrameRef.current = null;
        const pending = pendingHeightsRef.current;
        pendingHeightsRef.current = new Map();
        setHeights(current => {
          let next: Map<string, number> | null = null;
          for (const [id, measured] of pending) {
            const previous = current.get(id);
            if (previous !== undefined && Math.abs(previous - measured) < 0.5) continue;
            if (!next) next = new Map(current);
            next.set(id, measured);
          }
          return next ?? current;
        });
      });
    }
  }, []);

  useEffect(() => () => {
    if (measureFrameRef.current !== null) window.cancelAnimationFrame(measureFrameRef.current);
  }, []);

  const effectiveRange = range.end === 0 && messages.length > 0
    ? { start: Math.max(0, messages.length - INITIAL_TAIL_ROWS), end: messages.length }
    : {
        start: Math.min(range.start, messages.length),
        end: Math.min(Math.max(range.end, range.start), messages.length),
      };

  const scrollToIndex = useCallback((index: number, behavior: ScrollBehavior = 'smooth') => {
    const scroll = scrollRef.current;
    if (!scroll || index < 0 || index >= messages.length) return;
    scroll.scrollTo({
      top: Math.max(0, metrics.offsets[index] + THREAD_TOP_PADDING_PX - 24),
      behavior,
    });
  }, [messages.length, metrics.offsets, scrollRef]);

  return {
    start: effectiveRange.start,
    end: effectiveRange.end,
    topSpacer: metrics.offsets[effectiveRange.start] ?? 0,
    bottomSpacer: Math.max(0, metrics.total - (metrics.offsets[effectiveRange.end] ?? 0)),
    total: metrics.total,
    offsets: metrics.offsets,
    measurementKeys: metrics.keys,
    measureRow,
    scrollToIndex,
  };
}
