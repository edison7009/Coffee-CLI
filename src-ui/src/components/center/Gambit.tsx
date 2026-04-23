// Gambit.tsx — draggable floating compose window for rich input composition.
//
// Named for the chess "gambit": a calculated opening move after careful thought.
// Users compose long messages (and paste screenshots) in a real HTML textarea
// where native Ctrl+A/X/Z/Y all work, then send via Enter. The full text is
// forwarded to the tab's xterm as a single bracketed paste + Enter — no
// keystroke-by-keystroke simulation, so IME, newlines, and unicode all round-
// trip correctly.
//
// Pasted images are saved to a temp file via Rust, and the absolute path is
// inserted into the textarea so AI CLI agents that support local image paths
// (e.g. Claude Code) can read them. If the agent does not support image paths
// it simply sees the raw path string — not our concern, per design.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import './Gambit.css';

interface GambitProps {
  sessionId: string;
  draft: string;
  initialX: number;
  initialY: number;
  onDraftChange: (text: string) => void;
  onClose: () => void;
  /** Returns true when the text was accepted by the target xterm, false
   *  when the send couldn't complete (no active session, pane not focused
   *  in multi-agent mode, xterm not yet mounted, etc.). Gambit uses this
   *  signal to decide whether to clear the draft — failed sends preserve
   *  the text so the user never loses what they typed. */
  onSend: (text: string) => boolean;
}

interface Attachment {
  id: string;
  path: string;        // Absolute OS path — sent to the AI CLI when submitting.
  previewUrl: string;  // Blob URL from the paste-time File object; cheap thumbnail render.
  name: string;        // Display name shown on hover.
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 120;
const DEFAULT_WIDTH = 520;
const DEFAULT_HEIGHT = 180;

// Anchor geometry used to keep the collapse dot (top-right of the expanded
// card) and the collapsed ball at the same screen coordinate during the
// transition — so the user's eye doesn't jump when they click collapse or
// click-to-expand. These mirror the CSS: header padding-right 8px + collapse
// button 24×24, header height 28px.
const BALL_SIZE = 48;
const DOT_CENTER_FROM_RIGHT = 20;
const DOT_CENTER_FROM_TOP = 14;

function GambitImpl({
  draft,
  initialX,
  initialY,
  onDraftChange,
  onClose,
  onSend,
}: GambitProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const [size, setSize] = useState({ w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  // Collapsed state: full window shrinks into a small draggable ball,
  // reminiscent of Messenger chat heads. True close lives only in the
  // Explorer toggle button (open origin = close origin).
  const [collapsed, setCollapsed] = useState(false);
  // lastX/Y/W/H cache the latest values written to the DOM during drag/resize,
  // so onUp can commit them back to React state once without any intermediate
  // renders thrashing the effect that registers these very listeners.
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; lastX?: number; lastY?: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number; lastW?: number; lastH?: number } | null>(null);
  // Tracks whether the last mousedown -> mouseup sequence actually moved,
  // so a click on the collapsed ball can be distinguished from a drag.
  const movedRef = useRef(false);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Blob URL cleanup on unmount. handleSend and removeAttachment revoke
  // eagerly; this catches the path where Gambit is closed with attachments
  // still staged (onClose → parent sets gambitOpen=false → component unmounts).
  // A ref holds the latest array so the empty-deps effect sees live data.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(a => URL.revokeObjectURL(a.previewUrl));
    };
  }, []);

  const onDragStart = (e: React.MouseEvent) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    };
    movedRef.current = false;
    // Toggle a class directly — bypasses React re-render so backdrop-filter
    // is suppressed starting from the very first mousemove.
    rootRef.current?.classList.add('gambit--dragging');
    e.preventDefault();
  };

  const onResizeStart = (e: React.MouseEvent) => {
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origW: size.w,
      origH: size.h,
    };
    e.stopPropagation();
    e.preventDefault();
  };

  // Drag + resize use direct DOM mutation instead of setState on every
  // mousemove event. Rationale: the React render pass (re-run effect →
  // rebind listeners → commit transform) costs 10-20ms per event, making
  // the dragged element visibly lag behind the cursor at 144Hz. Writing
  // straight to rootRef.current.style keeps the node GPU-composited and
  // sub-frame responsive; we only sync back to React state on mouseup.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (dragRef.current) {
        const d = dragRef.current;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!movedRef.current && Math.abs(dx) + Math.abs(dy) > 3) {
          movedRef.current = true;
        }
        // When collapsed the window is a 48px ball, not 520x180 — clamp to
        // the appropriate extent so the ball can't be dragged off-screen.
        const w = collapsed ? 48 : size.w;
        const h = collapsed ? 48 : size.h;
        const nextX = Math.min(Math.max(0, d.origX + dx), Math.max(0, window.innerWidth - w));
        const nextY = Math.min(Math.max(30, d.origY + dy), Math.max(30, window.innerHeight - h));
        el.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
        d.lastX = nextX;
        d.lastY = nextY;
      }
      if (resizeRef.current) {
        const r = resizeRef.current;
        const desiredW = r.origW + (e.clientX - r.startX);
        const desiredH = r.origH + (e.clientY - r.startY);
        const nextW = Math.max(MIN_WIDTH, Math.min(desiredW, window.innerWidth - pos.x));
        const nextH = Math.max(MIN_HEIGHT, Math.min(desiredH, window.innerHeight - pos.y));
        el.style.width = `${nextW}px`;
        el.style.height = `${nextH}px`;
        r.lastW = nextW;
        r.lastH = nextH;
      }
    };
    const onUp = () => {
      // Commit any pending drag/resize values back to React state so the
      // next render and any consumers (e.g. collapseAtDot math) see them.
      if (dragRef.current && dragRef.current.lastX !== undefined) {
        setPos({ x: dragRef.current.lastX!, y: dragRef.current.lastY! });
      }
      if (resizeRef.current && resizeRef.current.lastW !== undefined) {
        setSize({ w: resizeRef.current.lastW!, h: resizeRef.current.lastH! });
      }
      dragRef.current = null;
      resizeRef.current = null;
      rootRef.current?.classList.remove('gambit--dragging');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pos.x, pos.y, size.w, size.h, collapsed]);

  // sendFailed briefly flashes a subtle hint next to the Send button so
  // the user understands WHY nothing happened (most common cause in
  // multi-agent mode: no pane has been focused yet — a single click on
  // the intended pane fixes it). Auto-clears after 2.5s so it doesn't
  // linger once the user acts.
  const [sendFailed, setSendFailed] = useState(false);
  useEffect(() => {
    if (!sendFailed) return;
    const t = setTimeout(() => setSendFailed(false), 2500);
    return () => clearTimeout(t);
  }, [sendFailed]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    const paths = attachments.map(a => a.path);
    if (!text && paths.length === 0) return;
    // Concatenate prose first, then space-separated file paths. Claude Code
    // and similar CLIs auto-recognize file paths as attachment references.
    const combined = paths.length > 0
      ? (text ? `${text} ${paths.join(' ')}` : paths.join(' '))
      : text;
    const ok = onSend(combined);
    if (!ok) {
      // Preserve draft + attachments so the user doesn't lose what they
      // typed. They likely just need to click the target pane first, then
      // hit Send again.
      setSendFailed(true);
      return;
    }
    onDraftChange('');
    attachments.forEach(a => URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
  }, [draft, attachments, onSend, onDraftChange]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition in progress — let the IME keep Enter for confirming
    // candidates. nativeEvent.isComposing is the canonical flag.
    if (e.nativeEvent.isComposing) return;
    // Ctrl+Enter (or Cmd+Enter on macOS) sends. Plain Enter inserts a newline
    // — matches office/editor expectation. Shift+Enter also inserts a newline
    // (native textarea behavior).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file') continue;
      if (!item.type.startsWith('image/')) continue;

      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;

      const ext = (item.type.split('/')[1] || 'png').toLowerCase();
      const base64 = await fileToBase64(file);
      try {
        const path = await commands.saveClipboardImage(base64, ext);
        // Blob URL is generated in-memory from the paste-time File — renders
        // instantly without re-reading the saved temp file.
        const previewUrl = URL.createObjectURL(file);
        setAttachments(prev => [...prev, {
          id: crypto.randomUUID(),
          path,
          previewUrl,
          name: `clip.${ext}`,
        }]);
      } catch (err) {
        console.error('[Gambit] save image failed', err);
      }
      return;
    }
  };

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => {
      const att = prev.find(a => a.id === id);
      if (att) URL.revokeObjectURL(att.previewUrl);
      return prev.filter(a => a.id !== id);
    });
  }, []);

  // Anchor the collapse dot and the ball at the same screen coordinate:
  // when collapsing, move the ball's top-left so its center lands on the
  // dot's current screen position; when expanding, do the inverse so the
  // dot reappears exactly where the ball was. Keeps the visual center stable.
  const collapseAtDot = () => {
    setPos({
      x: pos.x + size.w - DOT_CENTER_FROM_RIGHT - BALL_SIZE / 2,
      y: pos.y + DOT_CENTER_FROM_TOP - BALL_SIZE / 2,
    });
    setCollapsed(true);
  };

  const expandAtBall = () => {
    const targetX = pos.x + BALL_SIZE / 2 - (size.w - DOT_CENTER_FROM_RIGHT);
    const targetY = pos.y + BALL_SIZE / 2 - DOT_CENTER_FROM_TOP;
    // Clamp so the expanded window doesn't spill off-screen if the ball sat
    // near an edge.
    setPos({
      x: Math.max(8, Math.min(targetX, window.innerWidth - size.w - 8)),
      y: Math.max(30, Math.min(targetY, window.innerHeight - size.h - 8)),
    });
    setCollapsed(false);
    // Return focus to the textarea once it's mounted again.
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // Suppress onClose usage warning — true close is driven by parent (Explorer
  // toggle). The component still accepts onClose in props for API symmetry
  // and future use but doesn't expose it in the UI.
  void onClose;

  if (collapsed) {
    return (
      <div
        ref={rootRef}
        className="gambit gambit--ball"
        style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
        onMouseDown={(e) => {
          e.stopPropagation();
          onDragStart(e);
        }}
        onClick={() => {
          // Distinguish click from drag: only expand if the mouse didn't
          // move meaningfully between mousedown and mouseup.
          if (!movedRef.current) expandAtBall();
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="gambit"
      style={{
        /* translate3d + will-change (in CSS) keeps drag on the GPU compositor —
           avoids layout thrash that left/top would cause on every mousemove. */
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        width: size.w,
        height: size.h,
      }}
      onMouseDown={(e) => e.stopPropagation() /* don't let global focus enforcer steal focus back to xterm */}
    >
      <div className="gambit-header" onMouseDown={onDragStart}>
        <span className="gambit-title">{t('gambit.title')}</span>
        <button
          className="gambit-collapse"
          onClick={collapseAtDot}
          onMouseDown={(e) => e.stopPropagation() /* don't start drag when collapsing */}
        >
          <svg width="20" height="20" viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="7" fill="currentColor" />
          </svg>
        </button>
      </div>

      <textarea
        ref={textareaRef}
        className="gambit-textarea"
        value={draft}
        placeholder={t('gambit.placeholder')}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        spellCheck={false}
      />

      <div className="gambit-footer">
        <div className="gambit-attachments">
          {attachments.map((att, idx) => (
            <div
              key={att.id}
              className="gambit-attachment"
              onClick={() => setPreviewIndex(idx)}
            >
              <img src={att.previewUrl} alt={att.name} draggable={false} />
              <button
                className="gambit-attachment-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  removeAttachment(att.id);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M2 2 L8 8 M2 8 L8 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
        {sendFailed && (
          <span className="gambit-send-hint" role="status">
            {t('gambit.send_failed_hint')}
          </span>
        )}
        <button
          className={`gambit-send${sendFailed ? ' gambit-send--failed' : ''}`}
          onClick={handleSend}
          disabled={!draft.trim() && attachments.length === 0}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 14 V3 M3 8 L8 3 L13 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <div className="gambit-resize-handle" onMouseDown={onResizeStart} />

      {/* Preview portal renders into document.body to escape .gambit's
          transform containing block — otherwise `position: fixed` would
          anchor to .gambit (transformed ancestor) and clip to overflow:hidden. */}
      {previewIndex !== null && attachments[previewIndex] && createPortal(
        <div
          className="gambit-preview-overlay"
          onClick={() => setPreviewIndex(null)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img
            src={attachments[previewIndex].previewUrl}
            alt={attachments[previewIndex].name}
            draggable={false}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

// React.memo is CRITICAL here — TierTerminal (our parent) is intentionally
// not memoized (an earlier regression), so it re-renders on every app-wide
// state change: agent-status events, terminal focus shifts, etc. Without
// this memo wrapper, every parent re-render during drag would reset the
// inline `transform` style from React, clobbering the direct DOM writes we
// use for smooth dragging and making the element visibly snap back.
export const Gambit = memo(GambitImpl);

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // data:image/png;base64,xxxx — strip the prefix so Rust gets pure base64.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

