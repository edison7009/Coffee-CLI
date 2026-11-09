// TaskNoteView — the pre-input board's sticky notes. TaskBoard owns the notes and passes them down.
//
//   collapsed, at rest     │ note text on one line…                  │
//   collapsed, hovered     │ 🗑 │ note text, narrower…           │ ▶ │   ← delete and send slide in
//   open (after a click)   │ the whole note                          │
//                          │ ✎  ⧉  🗑                             ▶ │   ← a row of actions
//
// A click opens or closes a note; a double-click (or ✎) edits it. Cards drag up and down to reorder.
// The body edits `title`.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { TaskEmptyState } from './TaskEmptyState';
import type { TaskItem } from './task-types';
import { useTextContextMenu } from '../../lib/use-text-context-menu';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import './TaskNoteView.css';


// Smallest body while editing, so an empty note still offers room to type.
const NOTE_MIN_HEIGHT = 44;
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
  tasks, addingId, removingId, canSend, onUpdateTitle, onRemove, onDuplicate, onSend, onReorder, onShowGuide,
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
    // Never start a drag from a button or a body being edited (it needs its caret and selection).
    // A read-only body (not being edited) drags the card; preventDefault keeps it from selecting text.
    const body = target.closest('textarea');
    if ((body && !body.readOnly) || target.closest('button')) return;
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
        const open = expanded.has(task.id) || editingId === task.id || addingId === task.id;
        const edit = () => { setOpen(task.id, true); setEditingId(task.id); };
        const deleteButton = (className: string) => (
          <button type="button" className={`task-note-btn task-note-delete ${className}`} aria-label={t('pre_input.delete')} onClick={() => onRemove(task.id)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6" /><path d="M14 11v6" />
              <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        );
        const sendButton = (className: string) => (
          <button type="button" className={`task-note-btn task-note-send ${className}`} aria-label={t('pre_input.send')} onClick={() => onSend(task)} disabled={!canSend || !task.title.trim()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <polygon points="5 3 21 12 5 21" />
            </svg>
          </button>
        );
        return (
          <div
            key={task.id}
            data-note-id={task.id}
            className={[
              'task-note-card',
              !open && 'is-collapsed',
              dragId === task.id && 'dragging',
              removingId === task.id && 'removing',
            ].filter(Boolean).join(' ')}
            style={{ touchAction: 'none' }}
            onPointerDown={e => handlePointerDown(e, task.id)}
          >
            {/* Collapsed: one line, with delete sliding in on the left and send on the right on hover (the text
                narrows to make room, so nothing covers it). Open: the whole note, then a row of actions. */}
            <div className="task-note-row">
              {!open && deleteButton('task-note-side')}
              <NoteBody
                value={task.title}
                open={open}
                editing={editingId === task.id || addingId === task.id}
                onToggle={() => setOpen(task.id, !expanded.has(task.id))}
                onEdit={edit}
                onEditEnd={() => setEditingId(current => current === task.id ? null : current)}
                autoFocus={addingId === task.id}
                placeholder={t('task.note_placeholder')}
                onChange={next => onUpdateTitle(task.id, next)}
              />
              {!open && sendButton('task-note-side')}
            </div>
            {open && (
              <span className="task-note-actions">
                <button type="button" className="task-note-btn task-note-edit" aria-label={t('pre_input.edit')} aria-pressed={editingId === task.id || addingId === task.id} onClick={edit}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
                {/* Duplicate spawns an identical note right after this one; the new card animating in is the feedback. */}
                <button type="button" className="task-note-btn task-note-copy" aria-label={t('pre_input.copy')} onClick={() => onDuplicate(task.id)} disabled={!task.title.trim()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
                {deleteButton('')}
                <span className="task-note-actions-gap" />
                {sendButton('')}
              </span>
            )}
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
  open: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onEditEnd: () => void;
  autoFocus: boolean;
  placeholder: string;
  onChange: (next: string) => void;
}

function NoteBody({ value, open, editing, onToggle, onEdit, onEditEnd, autoFocus, placeholder, onChange }: NoteBodyProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Right-click cut/copy/paste/select menu (same one Gambit/terminal use).
  const { menu: ctxMenu, openMenu: openCtxMenu } = useTextContextMenu();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // An open note fits its text up to a cap and scrolls past it (wheel or the accent slider).
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
        // Expanded: show the whole note up to the cap, then scroll.
        el.style.height = 'auto';
        el.style.height = `${Math.min(NOTE_EXPANDED_CAP, Math.max(NOTE_MIN_HEIGHT, el.scrollHeight))}px`;
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
  }, [value, open]);

  useEffect(() => {
    if (!editing || !ref.current || document.activeElement === ref.current) return;
    // Entering edit mode (double-click or the edit button) puts the caret at the end, ready to keep writing.
    const el = ref.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
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
  // 7px variant, inset a little from the card's rounded bottom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return bindAutoHideScrollbar(el, { slim: true, insetBottom: 6 });
  }, []);

  // Collapsed: a one-line preview ending in an ellipsis when there is more (a textarea cannot clamp lines).
  // The textarea stays mounted but hidden, keeping its sizing, scrollbar and edit wiring.
  const preview = !open && !editing;
  return (
    <>
      {preview && (
        <div
          className={`task-note-preview${value ? '' : ' is-empty'}`}
          role="button"
          tabIndex={0}
          aria-expanded={false}
          onClick={e => { if (e.detail <= 1) onToggle(); }}
          onDoubleClick={onEdit}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
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
