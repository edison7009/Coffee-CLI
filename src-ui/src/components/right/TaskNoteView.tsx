// TaskNoteView — sticky-note presentation of the task board. Same TaskItem
// data as the to-do list (TaskBoard owns the state and passes it down); this
// view just renders each task as a roomy note card:
//
//   ┌─────────────────────────────────────────────┐
//   │ ● ● ●          2026.6.28  21:48  ⧉  🗑  ▶    │   ← traffic-light status
//   │                                               │     dots + timestamp
//   │  (big editable note body — write freely)      │
//   └─────────────────────────────────────────────┘
//
// The three dots ARE the status picker (红=进行中 / 黄=待办 / 绿=已完成); clicking
// one sets the status and the card auto-sorts into that group (working → todo →
// done), exactly like the list view's section order. Cards can be dragged
// up/down to reorder within their group. The note body edits `title` (single
// roomy field — the whole point is escaping the cramped inline input); the
// list view's `description` field is preserved but not surfaced here.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { TaskEmptyState } from './TaskEmptyState';
import { STATUS_ORDER, type TaskItem, type TaskStatus } from './task-types';
import { useTextContextMenu } from '../../lib/use-text-context-menu';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import './TaskNoteView.css';

// Traffic-light dots, top-to-bottom priority. Colors are deliberately the
// literal macOS-window red/amber/green from the user's mockup, not the theme
// accent — the three-light metaphor only reads if the colors are fixed.
const STATUS_DOTS: { status: TaskStatus; color: string }[] = [
  { status: 'working', color: '#ff5f57' },
  { status: 'todo', color: '#febc2e' },
  { status: 'done', color: '#28c840' },
];

// Note body height. Un-resized notes auto-grow from a roomy default; the
// bottom-edge handle clamps a manual height between these bounds.
const DEFAULT_NOTE_HEIGHT = 88;
const NOTE_MIN_HEIGHT = 44;
const NOTE_MAX_HEIGHT = 600;
// Collapsed notes show about two lines; an expanded note grows to fit up to this cap, then scrolls.
const NOTE_COLLAPSED_HEIGHT = 50;
const NOTE_EXPANDED_CAP = 480;

function formatNoteTime(ts: number): { date: string; time: string } {
  const d = new Date(ts);
  const date = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return { date, time };
}

interface DropLine {
  id: string;
  position: 'before' | 'after';
}

interface TaskNoteViewProps {
  tasks: TaskItem[];
  // The task most recently added via the FAB — its note body auto-focuses so
  // the user can start typing immediately (mirrors the list view's inline edit).
  addingId: string | null;
  // The task mid-removal — kept rendered for one exit animation before the
  // parent drops it from the array (shared 300ms window with the list view).
  removingId: string | null;
  canSend: boolean;
  onSetStatus: (id: string, status: TaskStatus) => void;
  onUpdateTitle: (id: string, title: string) => void;
  // Persists a bottom-edge-resized body height (called once on drop).
  onSetHeight: (id: string, height: number) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onSend: (task: TaskItem) => void;
  // Functional updater (the parent's setTasks) so a reorder computed at drop
  // time still composes against the freshest array — guards against a
  // multi-window sync landing mid-drag.
  onReorder: (updater: (prev: TaskItem[]) => TaskItem[]) => void;
  // Empty-board "view the usage guide" button → (re)adds the welcome note.
  onShowGuide: () => void;
}

export function TaskNoteView({
  tasks, addingId, removingId, canSend, onSetStatus, onUpdateTitle, onSetHeight, onRemove, onDuplicate, onSend, onReorder, onShowGuide,
}: TaskNoteViewProps) {
  const t = useT();

  // Display order: grouped by status (working → todo → done). The array order
  // within each status group is preserved, so drag-reordering the underlying
  // array reorders same-status cards; cross-status drags simply regroup.
  const ordered = STATUS_ORDER.flatMap(s => tasks.filter(task => task.status === s));

  // ── Drag (refs to avoid stale closures, mirrors TaskBoard's approach) ──
  const listRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dragStartedRef = useRef(false);
  const dropTargetRef = useRef<DropLine | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropLine, setDropLine] = useState<DropLine | null>(null);

  // Live preview height while dragging one card's bottom edge; persisted via
  // onSetHeight only on pointer-up, so a resize is one disk write, not a stream.
  const [resizing, setResizing] = useState<{ id: string; height: number } | null>(null);
  // Notes start collapsed: a click opens or closes one, a double-click edits it.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const setOpen = (id: string, open: boolean) => setExpanded(prev => {
    if (prev.has(id) === open) return prev;
    const next = new Set(prev);
    if (open) next.add(id); else next.delete(id);
    return next;
  });

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    const target = e.target as HTMLElement;
    // Never start a drag from an interactive control — the note body needs
    // click-to-place-caret + text selection, dots/buttons need clicks, and the
    // bottom-edge handle owns its own resize gesture.
    if (target.closest('textarea') || target.closest('button') || target.closest('.task-note-resize')) return;

    const cardEl = target.closest('.task-note-card') as HTMLElement;
    if (!cardEl) return;

    const rect = cardEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    dragStartedRef.current = false;
    dropTargetRef.current = null;

    const THRESHOLD = 6;

    const onMove = (me: PointerEvent) => {
      if (!dragStartedRef.current) {
        if (Math.abs(me.clientX - startX) < THRESHOLD && Math.abs(me.clientY - startY) < THRESHOLD) return;
        dragStartedRef.current = true;
        setDragId(id);
        const ghost = cardEl.cloneNode(true) as HTMLDivElement;
        ghost.className = 'task-note-card-ghost';
        // cloneNode copies DOM attributes but not the live textarea `.value`
        // (React drives it as a property), so the clone's note body would be
        // blank. Copy it across so the drag preview keeps the user's text.
        const srcBody = cardEl.querySelector('textarea');
        const ghostBody = ghost.querySelector('textarea');
        if (srcBody && ghostBody) ghostBody.value = srcBody.value;
        // Cap the ghost's body to ~2 lines so a long note's drag preview
        // stays compact and easy to place (the full text isn't needed while
        // dragging - the drop target is what matters).
        if (ghostBody) {
          ghostBody.style.height = '42px';
          ghostBody.style.maxHeight = '42px';
          ghostBody.style.overflow = 'hidden';
        }
        ghost.style.width = `${rect.width}px`;
        ghost.style.left = `${me.clientX - offsetX}px`;
        ghost.style.top = `${me.clientY - offsetY}px`;
        document.body.appendChild(ghost);
        ghostRef.current = ghost;
      }

      if (ghostRef.current) {
        ghostRef.current.style.left = `${me.clientX - offsetX}px`;
        ghostRef.current.style.top = `${me.clientY - offsetY}px`;
      }

      if (!listRef.current) return;
      const cards = listRef.current.querySelectorAll<HTMLElement>('[data-note-id]');
      let next: DropLine | null = null;
      for (const card of cards) {
        const cid = card.dataset.noteId!;
        if (cid === id) continue;
        const r = card.getBoundingClientRect();
        if (me.clientY >= r.top && me.clientY < r.bottom) {
          next = { id: cid, position: me.clientY < r.top + r.height / 2 ? 'before' : 'after' };
          break;
        }
      }
      dropTargetRef.current = next;
      // Only re-render the indicator when the target actually changes.
      setDropLine(prev =>
        prev?.id === next?.id && prev?.position === next?.position ? prev : next
      );
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (ghostRef.current) { ghostRef.current.remove(); ghostRef.current = null; }

      const drop = dropTargetRef.current;
      if (dragStartedRef.current && drop && drop.id !== id) {
        onReorder(prev => {
          const dragged = prev.find(task => task.id === id);
          const target = prev.find(task => task.id === drop.id);
          if (!dragged || !target) return prev;
          // Dropping onto a different-status card adopts that card's status, so
          // dragging across the red/amber/green groups re-files the note (same
          // outcome as clicking its dot) instead of snapping back to its old
          // group. Same-status drags just reorder within the group.
          const moved = dragged.status === target.status
            ? dragged
            : { ...dragged, status: target.status };
          const without = prev.filter(task => task.id !== id);
          const targetIdx = without.findIndex(task => task.id === drop.id);
          if (targetIdx === -1) return prev;
          const insertAt = drop.position === 'before' ? targetIdx : targetIdx + 1;
          without.splice(insertAt, 0, moved);
          return without;
        });
      }

      setDragId(null);
      setDropLine(null);
      dropTargetRef.current = null;
      dragStartedRef.current = false;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ── Bottom-edge resize ──────────────────────────────────────────────────
  const handleResizeDown = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation(); // don't let the card's reorder gesture start
    const handle = e.currentTarget as HTMLElement;
    const body = handle
      .closest('.task-note-card')
      ?.querySelector('.task-note-body') as HTMLElement | null;
    const startHeight = body ? body.getBoundingClientRect().height : DEFAULT_NOTE_HEIGHT;
    const startY = e.clientY;
    // Pointer capture keeps move/up/cancel coming to this element even if the
    // pointer leaves the window or focus is stolen (WebView2) — so a resize
    // can't get stuck mid-gesture and the listeners always tear down. Element
    // listeners (vs window) also go away with the node if the card unmounts.
    try { handle.setPointerCapture(e.pointerId); } catch { /* Best-effort operation; failure is non-fatal. */ }

    const onMove = (me: PointerEvent) => {
      const next = Math.max(NOTE_MIN_HEIGHT, Math.min(NOTE_MAX_HEIGHT, startHeight + (me.clientY - startY)));
      setResizing({ id, height: Math.round(next) });
    };
    const finish = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      setResizing(cur => {
        if (cur && cur.id === id) onSetHeight(id, cur.height);
        return null;
      });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  };

  if (ordered.length === 0) {
    return (
      <div className="task-note-list task-note-list--empty">
        <TaskEmptyState onShowGuide={onShowGuide} />
      </div>
    );
  }

  return (
    <div ref={listRef} className="task-note-list">
      {ordered.map(task => {
        const { date, time } = formatNoteTime(task.createdAt);
        const line = dropLine?.id === task.id ? dropLine.position : null;
        return (
          <div
            key={task.id}
            data-note-id={task.id}
            data-status={task.status}
            className={[
              'task-note-card',
              `status-${task.status}`,
              !(expanded.has(task.id) || editingId === task.id || addingId === task.id || resizing?.id === task.id) && 'is-collapsed',
              dragId === task.id && 'dragging',
              removingId === task.id && 'removing',
              line === 'before' && 'drop-before',
              line === 'after' && 'drop-after',
            ].filter(Boolean).join(' ')}
            style={{ touchAction: 'none' }}
            onPointerDown={e => handlePointerDown(e, task.id)}
          >
            <div className="task-note-head">
              <div className="task-note-dots" role="group">
                {STATUS_DOTS.map(d => (
                  <button
                    key={d.status}
                    type="button"
                    className={`task-note-dot${task.status === d.status ? ' active' : ''}`}
                    style={{ ['--dot' as string]: d.color }}
                    onClick={() => onSetStatus(task.id, d.status)}
                    aria-pressed={task.status === d.status}
                  />
                ))}
              </div>

              <div className="task-note-time">{date} {time}</div>

              <div className="task-note-actions">
                <button
                  type="button"
                  className="task-note-btn task-note-copy"
                  onClick={() => onDuplicate(task.id)}
                  disabled={!task.title.trim()}
                >
                  {/* Duplicate this note — spawns an identical sticky right after
                      it; the new card animating in is the feedback. */}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="task-note-btn task-note-delete"
                  onClick={() => onRemove(task.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" /><path d="M14 11v6" />
                    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="task-note-btn task-note-send"
                  onClick={() => onSend(task)}
                  disabled={!canSend || !task.title.trim()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <polygon points="5 3 21 12 5 21" />
                  </svg>
                </button>
              </div>
            </div>

            <NoteBody
              value={task.title}
              height={resizing?.id === task.id ? resizing.height : (task.height ?? null)}
              open={expanded.has(task.id) || editingId === task.id || addingId === task.id || resizing?.id === task.id}
              editing={editingId === task.id || addingId === task.id}
              onToggle={() => setOpen(task.id, !expanded.has(task.id))}
              onEdit={() => { setOpen(task.id, true); setEditingId(task.id); }}
              onEditEnd={() => setEditingId(current => current === task.id ? null : current)}
              autoFocus={addingId === task.id}
              placeholder={t('task.note_placeholder')}
              onChange={next => onUpdateTitle(task.id, next)}
            />

            {/* Bottom-edge resize handle — drag to grow/shrink the note. The
                `resizing` class drives the CSS deepen+lengthen effect while
                the pointer drags (Coffee-Note pane-resizer style). */}
            <div
              className={`task-note-resize${resizing?.id === task.id ? ' resizing' : ''}`}
              onPointerDown={e => { setOpen(task.id, true); handleResizeDown(e, task.id); }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Note body — auto-growing textarea ───────────────────────────────────────
// Its own component so the grow-to-fit layout effect can key on this card's
// value without a shared ref map across the mapped list.

interface NoteBodyProps {
  value: string;
  // Explicit user-resized height in px, or null to auto-grow with content.
  height: number | null;
  open: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onEditEnd: () => void;
  autoFocus: boolean;
  placeholder: string;
  onChange: (next: string) => void;
}

function NoteBody({ value, height, open, editing, onToggle, onEdit, onEditEnd, autoFocus, placeholder, onChange }: NoteBodyProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Right-click cut/copy/paste/select menu (same one Gambit/terminal use).
  const { menu: ctxMenu, openMenu: openCtxMenu } = useTextContextMenu();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The resized height is a FLOOR, not a fixed size: the note is at least the
    // height you dragged (or a roomy default), and still grows to fit longer
    // content when left un-resized. A manually-shrunk note scrolls instead of
    // clipping — the size you chose wins, and overflow-y:auto (styled with the
    // same accent slider as the terminal, see TaskNoteView.css) keeps the
    // overflow reachable by wheel or drag.
    //
    // scrollHeight depends on the textarea's WIDTH (narrower ⇒ more wrapping ⇒
    // taller). The right panel mounts COLLAPSED (width 0) and animates open
    // (App.tsx useSlidingPanel), so a measure taken at mount reflects width≈0
    // and would blow every note up to full height — and it'd stick, since this
    // effect's deps don't track width. Guard against zero-width measures, and
    // re-fit via a ResizeObserver once the real width arrives (panel finishes
    // expanding) or later changes (panel resized).
    let lastW = -1;
    const fit = () => {
      if (el.offsetWidth === 0) return; // collapsed / not laid out — wait for width
      if (!open) {
        el.style.height = 'auto';
        el.style.height = `${Math.min(NOTE_COLLAPSED_HEIGHT, Math.max(NOTE_MIN_HEIGHT, el.scrollHeight))}px`;
        el.scrollTop = 0;
      } else {
        // Expanded: show the whole note up to the cap, then scroll. A dragged height only ever makes it taller,
        // so an old small height (or a short drag) never leaves an opened note cramped.
        el.style.height = 'auto';
        const fitted = Math.min(NOTE_EXPANDED_CAP, Math.max(NOTE_MIN_HEIGHT, el.scrollHeight));
        el.style.height = `${height != null ? Math.max(fitted, Math.min(NOTE_MAX_HEIGHT, height)) : fitted}px`;
      }
      lastW = el.offsetWidth;
    };
    fit();
    // Only re-fit on an actual WIDTH change — our own height writes don't
    // change width, so they can't loop this observer.
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth !== 0 && el.offsetWidth !== lastW) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, height, open]);

  // Double-click places the caret where the user clicked; entering edit mode from elsewhere focuses the end.
  useEffect(() => {
    if (editing && ref.current && document.activeElement !== ref.current) ref.current.focus();
  }, [editing]);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [autoFocus]);

  // Custom floating scrollbar for the note body. WebView2's native textarea
  // scrollbar keeps re-surfacing its up/down arrow buttons no matter the CSS
  // (see lib/auto-hide-scrollbar.ts for the full story) — so we hide it and
  // draw a DOM slider instead, the proven Coffee-Note approach. slim = the
  // 7px variant; insetBottom 11 clears the bottom-edge resize handle so the
  // slider can't collide with it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return bindAutoHideScrollbar(el, { slim: true, insetBottom: 11 });
  }, []);

  return (
    <>
      <textarea
        ref={ref}
        className={`task-note-body${open ? '' : ' is-collapsed'}${editing ? ' is-editing' : ''}`}
        value={value}
        readOnly={!editing}
        aria-expanded={open}
        onClick={e => { if (!editing && e.detail === 1) onToggle(); }}
        onDoubleClick={() => { if (!editing) onEdit(); }}
        onBlur={onEditEnd}
        placeholder={placeholder}
        rows={2}
        onChange={e => onChange(e.target.value)}
        onPointerDown={e => e.stopPropagation()}
        onContextMenu={(e) => openCtxMenu(e, onChange)}
      />
      {ctxMenu}
    </>
  );
}
