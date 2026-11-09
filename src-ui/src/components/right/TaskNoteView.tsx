// TaskNoteView — the pre-input board's sticky notes. TaskBoard owns the notes and passes them down; each card
// is just the note text with its tools in the top-right corner:
//
//   ┌──────────────────────────────────────────────┐
//   │ note text, collapsed to two lines…   ⧉ 🗑 ▶ │  ← copy / delete show on hover, send always
//   └──────────────────────────────────────────────┘
//
// A click opens or closes a note that has more than two lines; a double-click edits it. Cards drag up and
// down to reorder. The body edits `title`.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { TaskEmptyState } from './TaskEmptyState';
import type { TaskItem } from './task-types';
import { useTextContextMenu } from '../../lib/use-text-context-menu';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import './TaskNoteView.css';


// Note body height. Un-resized notes auto-grow from a roomy default; the
// bottom-edge handle clamps a manual height between these bounds.
const DEFAULT_NOTE_HEIGHT = 88;
const NOTE_MIN_HEIGHT = 44;
const NOTE_MAX_HEIGHT = 600;
// Collapsed notes show about two lines; an expanded note grows to fit up to this cap, then scrolls.
const NOTE_COLLAPSED_HEIGHT = 50;
const NOTE_EXPANDED_CAP = 480;


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
  tasks, addingId, removingId, canSend, onUpdateTitle, onSetHeight, onRemove, onDuplicate, onSend, onReorder, onShowGuide,
}: TaskNoteViewProps) {
  const t = useT();

  // Display order is the array order.
  const ordered = tasks;

  // ── Drag (refs to avoid stale closures, mirrors TaskBoard's approach) ──
  const listRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dragStartedRef = useRef(false);
  const dropTargetRef = useRef<DropLine | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

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
  // A note added with the + button is written straight away; it stays in edit mode until the user clicks away.
  /* eslint-disable react-hooks/set-state-in-effect -- addingId is an explicit parent signal to start editing the new note. */
  useEffect(() => {
    if (!addingId) return;
    setEditingId(addingId);
    setExpanded(prev => new Set(prev).add(addingId));
  }, [addingId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    const target = e.target as HTMLElement;
    // Never start a drag from an interactive control — the note body needs
    // click-to-place-caret + text selection, dots/buttons need clicks, and the
    // bottom-edge handle owns its own resize gesture.
    // A read-only body (not being edited) drags the card; preventDefault keeps it from selecting text.
    const body = target.closest('textarea');
    if ((body && !body.readOnly) || target.closest('button') || target.closest('.task-note-resize')) return;
    // Starting a press here must not begin a text selection that sweeps across other notes.
    e.preventDefault();

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
    // Layout before the drag: other notes slide out of the way and the dashed outline slides to the drop slot.
    let layout: { el: HTMLElement; id: string; top: number; height: number }[] = [];
    let gap = 0;
    const shift = (el: HTMLElement, y: number) => {
      el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = y ? `translateY(${y}px)` : '';
    };
    const swallowClick = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault(); };

    const onMove = (me: PointerEvent) => {
      if (!dragStartedRef.current) {
        if (Math.abs(me.clientX - startX) < THRESHOLD && Math.abs(me.clientY - startY) < THRESHOLD) return;
        dragStartedRef.current = true;
        setDragId(id);
        // The drop's click must not also open or close the note.
        window.addEventListener('click', swallowClick, { capture: true, once: true });
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
        layout = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-note-id]') ?? [])].map(el => {
          const r = el.getBoundingClientRect();
          return { el, id: el.dataset.noteId!, top: r.top, height: r.height };
        });
        gap = layout.length > 1 ? Math.max(0, layout[1].top - (layout[0].top + layout[0].height)) : 0;
      }

      if (ghostRef.current) {
        ghostRef.current.style.left = `${me.clientX - offsetX}px`;
        ghostRef.current.style.top = `${me.clientY - offsetY}px`;
      }

      if (!layout.length) return;
      // Insert among the other notes by their original midpoints, then lay everything out in the new order.
      const self = layout.find(item => item.id === id)!;
      const others = layout.filter(item => item.id !== id);
      const slot = others.filter(item => me.clientY > item.top + item.height / 2).length;
      const order = [...others.slice(0, slot), self, ...others.slice(slot)];
      let top = layout[0].top;
      for (const item of order) { shift(item.el, top - item.top); top += item.height + gap; }
      const next: DropLine | null = slot < others.length ? { id: others[slot].id, position: 'before' } : others.length ? { id: others[slot - 1].id, position: 'after' } : null;
      // Dropping back where it started is a no-op.
      const index = layout.indexOf(self);
      dropTargetRef.current = slot === index ? null : next;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (ghostRef.current) { ghostRef.current.remove(); ghostRef.current = null; }
      // The reorder re-renders notes in their new places; drop the slide offsets without animating back.
      for (const item of layout) { item.el.style.transition = ''; item.el.style.transform = ''; }
      // The click from this release arrives before the timer; drop the guard if none came (released outside the window).
      if (dragStartedRef.current) setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }));

      const drop = dropTargetRef.current;
      if (dragStartedRef.current && drop && drop.id !== id) {
        onReorder(prev => {
          const dragged = prev.find(task => task.id === id);
          const target = prev.find(task => task.id === drop.id);
          if (!dragged || !target) return prev;
          const without = prev.filter(task => task.id !== id);
          const targetIdx = without.findIndex(task => task.id === drop.id);
          if (targetIdx === -1) return prev;
          const insertAt = drop.position === 'before' ? targetIdx : targetIdx + 1;
          without.splice(insertAt, 0, dragged);
          return without;
        });
      }

      setDragId(null);
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
        return (
          <div
            key={task.id}
            data-note-id={task.id}
            className={[
              'task-note-card',
              !(expanded.has(task.id) || editingId === task.id || addingId === task.id || resizing?.id === task.id) && 'is-collapsed',
              dragId === task.id && 'dragging',
              removingId === task.id && 'removing',
            ].filter(Boolean).join(' ')}
            style={{ touchAction: 'none' }}
            onPointerDown={e => handlePointerDown(e, task.id)}
          >
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

            {/* Tools in the top-right corner: copy and delete show on hover over a backdrop, send always shows.
                Spans, not divs, so the glass theme's panel rule leaves the backdrop alone. */}
            <span className="task-note-tools">
              <span className="task-note-hover-tools">
                <button
                  type="button"
                  className="task-note-btn task-note-copy"
                  aria-label={t('pre_input.copy')}
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
                  aria-label={t('pre_input.delete')}
                  onClick={() => onRemove(task.id)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" /><path d="M14 11v6" />
                    <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </span>
                <button
                  type="button"
                  className="task-note-btn task-note-send"
                  aria-label={t('pre_input.send')}
                  onClick={() => onSend(task)}
                  disabled={!canSend || !task.title.trim()}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <polygon points="5 3 21 12 5 21" />
                  </svg>
                </button>
            </span>

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

  // Any press outside the body ends editing, even on spots that take no focus (empty panel, other notes' headers).
  useEffect(() => {
    if (!editing) return;
    const onPress = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) { ref.current.blur(); onEditEnd(); }
    };
    document.addEventListener('pointerdown', onPress, true);
    return () => document.removeEventListener('pointerdown', onPress, true);
  }, [editing, onEditEnd]);

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

  // Collapsed: a two-line preview ending in an ellipsis when there is more (a textarea cannot clamp lines).
  // The textarea stays mounted but hidden, keeping its sizing, scrollbar and edit wiring.
  const preview = !open && !editing;
  // Only a note with more than its two preview lines opens on click; a short one already shows in full.
  const previewRef = useRef<HTMLDivElement>(null);
  const hasMore = () => !!previewRef.current && previewRef.current.scrollHeight > previewRef.current.clientHeight + 1;
  return (
    <>
      {preview && (
        <div
          ref={previewRef}
          className={`task-note-preview${value ? '' : ' is-empty'}`}
          role="button"
          tabIndex={0}
          aria-expanded={false}
          onClick={e => { if (e.detail <= 1 && hasMore()) onToggle(); }}
          onDoubleClick={onEdit}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (hasMore()) onToggle(); } }}
        >{value || placeholder}</div>
      )}
      <textarea
        hidden={preview}
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
        onPointerDown={e => { if (editing) e.stopPropagation(); }}
        onContextMenu={(e) => openCtxMenu(e, onChange)}
      />
      {ctxMenu}
    </>
  );
}
