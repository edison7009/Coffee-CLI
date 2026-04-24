// Gambit.tsx — draggable floating compose window for rich input composition.
//
// Named for the chess "gambit": a calculated opening move after careful thought.
// Users compose long messages (and paste screenshots) in a real HTML textarea
// where native Ctrl+A/X/Z/Y all work, then send via Ctrl+Enter. The full text
// is forwarded to the tab's xterm as a single bracketed paste + Enter — no
// keystroke-by-keystroke simulation, so IME, newlines, and unicode all round-
// trip correctly.
//
// Image paste behavior: pasted images are saved to a temp file via Rust, and
// the absolute path is inserted directly into the textarea as plain text at
// the cursor position. No attachment chips, no thumbnails — just a visible,
// editable path string. AI CLI agents that support local image paths (e.g.
// Claude Code) will read the file; agents that don't just see the raw path.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clipboardRead, clipboardWrite } from '../../lib/clipboard';
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
  const [sendEmpty, setSendEmpty] = useState(false);
  useEffect(() => {
    if (!sendFailed) return;
    const t = setTimeout(() => setSendFailed(false), 2500);
    return () => clearTimeout(t);
  }, [sendFailed]);
  useEffect(() => {
    if (!sendEmpty) return;
    const t = setTimeout(() => setSendEmpty(false), 2500);
    return () => clearTimeout(t);
  }, [sendEmpty]);

  // ─── Context menu ─────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  // Windows-style dismiss: ANY interaction outside the menu closes it.
  //   - mousedown anywhere outside  → close (click inside runs the button's onClick)
  //   - Escape key                  → close
  //   - wheel scroll                → close (native OS behavior)
  //   - window blur / resize        → close
  //
  // All listeners are registered in CAPTURE phase so we still fire even
  // though the Gambit root has onMouseDown={e=>e.stopPropagation()} up the
  // React tree (it's synthetic-only, but capture-phase native listeners
  // are immune to any propagation shenanigans either way).
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onDocMouseDown = (e: MouseEvent) => {
      // Click inside the menu → let the button's onClick handler run and
      // close the menu itself. Only dismiss for clicks OUTSIDE.
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onWheel = () => close();
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', onWheel, { capture: true } as any);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [ctxMenu]);

  const onContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const ctxCopy = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = draft.slice(start, end);
    if (selected) clipboardWrite(selected);
    setCtxMenu(null);
  };

  const ctxCut = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = draft.slice(start, end);
    if (selected) {
      clipboardWrite(selected);
      const newDraft = draft.slice(0, start) + draft.slice(end);
      onDraftChange(newDraft);
      requestAnimationFrame(() => {
        textarea.selectionStart = start;
        textarea.selectionEnd = start;
      });
    }
    setCtxMenu(null);
  };

  const ctxPaste = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    setCtxMenu(null);
    clipboardRead().then((text) => {
      if (!text) return;
      const start = textarea.selectionStart ?? draft.length;
      const end = textarea.selectionEnd ?? draft.length;
      const newDraft = draft.slice(0, start) + text + draft.slice(end);
      onDraftChange(newDraft);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = start + text.length;
        textarea.selectionEnd = start + text.length;
      });
    });
  };

  const ctxSelectAll = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    textarea.focus();
    textarea.select();
    setCtxMenu(null);
  };

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) {
      setSendEmpty(true);
      return;
    }
    const ok = onSend(text);
    if (!ok) {
      // Preserve draft so the user doesn't lose what they typed. They
      // likely just need to click the target pane first, then hit Send
      // again.
      setSendFailed(true);
      return;
    }
    onDraftChange('');
  }, [draft, onSend, onDraftChange]);

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
    // Collect all image files first (rare — clipboard normally has ≤1 image).
    // Validate BEFORE preventing default: if getAsFile() returns null
    // (some Windows clipboard sources do this), we must NOT block the
    // native paste or the user loses their clipboard content.
    const imageFiles: { file: File; ext: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      imageFiles.push({ file, ext: (item.type.split('/')[1] || 'png').toLowerCase() });
    }
    if (imageFiles.length === 0) return;

    e.preventDefault();

    const textarea = textareaRef.current;
    const selStart = textarea?.selectionStart ?? draft.length;
    const selEnd = textarea?.selectionEnd ?? draft.length;

    const paths: string[] = [];
    for (const { file, ext } of imageFiles) {
      try {
        const base64 = await fileToBase64(file);
        paths.push(await commands.saveClipboardImage(base64, ext));
      } catch (err) {
        console.error('[Gambit] save image failed', err);
      }
    }
    if (paths.length === 0) return;

    // Insert paths at the cursor as plain text. If there's adjacent
    // non-whitespace text on either side, pad with spaces so AI CLI
    // path detection doesn't glue the path onto surrounding prose.
    const before = draft.slice(0, selStart);
    const after = draft.slice(selEnd);
    const leftPad = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const rightPad = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    const inserted = leftPad + paths.join(' ') + rightPad;
    const newDraft = before + inserted + after;
    onDraftChange(newDraft);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const caret = selStart + inserted.length;
      ta.selectionStart = caret;
      ta.selectionEnd = caret;
    });
  };

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
        // Block the native WebView context menu across the entire Gambit
        // surface — App.tsx's global suppressor is dev-mode-skipped (for
        // DevTools access) so we need an always-on local guard here. The
        // textarea's own onContextMenu opens our custom menu; any other
        // Gambit area (header, resize handle, padding) simply gets no
        // menu, which is the correct desktop-app behavior.
        onContextMenu={(e) => e.preventDefault()}
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
      // Block native WebView context menu across the whole Gambit panel.
      // The textarea's onContextMenu opens our custom cut/copy/paste menu;
      // other areas (header, resize handle, sides) just get no menu.
      onContextMenu={(e) => e.preventDefault()}
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
        onContextMenu={onContextMenu}
        spellCheck={false}
      />

      <div className="gambit-footer">
        {sendFailed && (
          <span className="gambit-send-hint" role="status">
            {t('gambit.send_failed_hint')}
          </span>
        )}
        {sendEmpty && (
          <span className="gambit-send-hint gambit-send-hint--empty" role="status">
            {t('gambit.send_empty_hint')}
          </span>
        )}
        <button
          className={`gambit-send${sendFailed ? ' gambit-send--failed' : ''}${!draft.trim() ? ' gambit-send--empty' : ''}`}
          onClick={handleSend}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 14 V3 M3 8 L8 3 L13 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <div className="gambit-resize-handle" onMouseDown={onResizeStart} />

      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          className="gambit-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button className="gambit-ctx-item" onClick={ctxCut}>{t('gambit.ctx_cut')}</button>
          <button className="gambit-ctx-item" onClick={ctxCopy}>{t('gambit.ctx_copy')}</button>
          <button className="gambit-ctx-item" onClick={ctxPaste}>{t('gambit.ctx_paste')}</button>
          <div className="gambit-ctx-divider" />
          <button className="gambit-ctx-item" onClick={ctxSelectAll}>{t('gambit.ctx_select_all')}</button>
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

