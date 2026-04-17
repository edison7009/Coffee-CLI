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

import { useCallback, useEffect, useRef, useState } from 'react';
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
  onSend: (text: string) => void;
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

export function Gambit({
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
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

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

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const d = dragRef.current;
        const nextX = d.origX + (e.clientX - d.startX);
        const nextY = d.origY + (e.clientY - d.startY);
        const maxX = window.innerWidth - size.w;
        const maxY = window.innerHeight - size.h;
        setPos({
          x: Math.min(Math.max(0, nextX), Math.max(0, maxX)),
          y: Math.min(Math.max(30, nextY), Math.max(30, maxY)),
        });
      }
      if (resizeRef.current) {
        const r = resizeRef.current;
        const desiredW = r.origW + (e.clientX - r.startX);
        const desiredH = r.origH + (e.clientY - r.startY);
        // Clamp to BOTH minimum and viewport-remaining. The previous code
        // applied Math.min(nextW, remaining) after Math.max(MIN_WIDTH, ...),
        // so when the window sat close to the viewport edge the final width
        // could fall below MIN_WIDTH.
        setSize({
          w: Math.max(MIN_WIDTH, Math.min(desiredW, window.innerWidth - pos.x)),
          h: Math.max(MIN_HEIGHT, Math.min(desiredH, window.innerHeight - pos.y)),
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [pos.x, pos.y, size.w, size.h]);

  const handleSend = useCallback(() => {
    const text = draft.trim();
    const paths = attachments.map(a => a.path);
    if (!text && paths.length === 0) return;
    // Concatenate prose first, then space-separated file paths. Claude Code
    // and similar CLIs auto-recognize file paths as attachment references.
    const combined = paths.length > 0
      ? (text ? `${text} ${paths.join(' ')}` : paths.join(' '))
      : text;
    onSend(combined);
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
          className="gambit-close"
          onClick={onClose}
          onMouseDown={(e) => e.stopPropagation() /* don't start drag when closing */}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 2 L10 10 M2 10 L10 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
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
        <button
          className="gambit-send"
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

