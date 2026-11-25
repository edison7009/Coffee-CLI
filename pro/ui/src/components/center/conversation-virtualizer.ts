import {
  useCallback, useEffect, useMemo, useRef, useState,
  type RefObject,
} from 'react';
import type { ChatMessage } from '../../lib/chat-transcript';

const THREAD_TOP_PADDING_PX = 34;

interface VirtualMetrics {
  offsets: number[];
  total: number;
  keys: string[];
}

// Protocol reducers replace changed messages. Reuse estimates for immutable
// history rows, and let closed conversations be reclaimed with their messages.
const measurements = new WeakMap<ChatMessage, { key: string; height: number }>();

function messageMeasurement(message: ChatMessage) {
  let value = measurements.get(message);
  if (!value) {
    value = { key: measurementKey(message), height: estimatedHeight(message) };
    measurements.set(message, value);
  }
  return value;
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

/** Layout for the conversation transcript. Every message stays mounted: text is cheap, and unmounting rows off
 * screen made scrolling up drop what was below and rebuild what was above. Measured heights still give the
 * navigation its offsets. The window-shaped return (start, end, spacers) keeps the callers unchanged. */
export function useConversationVirtualizer(
  messages: ChatMessage[],
  scrollRef: RefObject<HTMLDivElement | null>,
) {
  const [heights, setHeights] = useState(() => new Map<string, number>());
  const pendingHeightsRef = useRef(new Map<string, number>());
  const measureFrameRef = useRef<number | null>(null);

  const metrics = useMemo<VirtualMetrics>(() => {
    const offsets = new Array<number>(messages.length + 1);
    const keys = new Array<string>(messages.length);
    offsets[0] = 0;
    for (let index = 0; index < messages.length; index += 1) {
      const { key, height: estimate } = messageMeasurement(messages[index]);
      keys[index] = key;
      offsets[index + 1] = offsets[index] + (heights.get(key) ?? estimate);
    }
    return { offsets, total: offsets[messages.length] ?? 0, keys };
  }, [messages, heights]);

  const measureRow = useCallback((messageId: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    pendingHeightsRef.current.set(messageId, height);
    if (measureFrameRef.current !== null) return;
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
  }, []);

  useEffect(() => () => {
    if (measureFrameRef.current !== null) window.cancelAnimationFrame(measureFrameRef.current);
  }, []);

  const scrollToIndex = useCallback((index: number, behavior: ScrollBehavior = 'smooth') => {
    const scroll = scrollRef.current;
    if (!scroll || index < 0 || index >= messages.length) return;
    // Every row is mounted and measured, so the offsets are real heights.
    scroll.scrollTo({ top: Math.max(0, metrics.offsets[index] + THREAD_TOP_PADDING_PX - 24), behavior });
  }, [messages.length, metrics.offsets, scrollRef]);

  return {
    start: 0,
    end: messages.length,
    topSpacer: 0,
    bottomSpacer: 0,
    total: metrics.total,
    offsets: metrics.offsets,
    measurementKeys: metrics.keys,
    measureRow,
    scrollToIndex,
  };
}
