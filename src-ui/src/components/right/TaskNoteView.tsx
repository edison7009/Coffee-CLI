// TaskNoteView — the pre-input board's notes. TaskBoard owns the notes and passes them down.
//
//   at rest   │ note text, up to three lines…              │
//   hovered   │ note text, up to three li…              🗑 │   ← a glow follows the pointer; the trash slides in
//
// Notes were written in the composer and saved here, so they are read-only: a click puts one back into the current
// conversation's composer, the trash removes it, and cards drag up and down to reorder.

import { useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { TaskEmptyState } from './TaskEmptyState';
import type { TaskItem } from './task-types';
import './TaskNoteView.css';




interface DropLine {
  id: string;
  position: 'before' | 'after';
}

interface TaskNoteViewProps {
  tasks: TaskItem[];
  // The task mid-removal — kept rendered for one exit animation before the
  // parent drops it from the array (shared 300ms window with the list view).
  removingId: string | null;
  onRemove: (id: string) => void;
  onSend: (task: TaskItem) => void;
  // Functional updater (the parent's setTasks) so a reorder computed at drop
  // time still composes against the freshest array — guards against a
  // multi-window sync landing mid-drag.
  onReorder: (updater: (prev: TaskItem[]) => TaskItem[]) => void;
}

export function TaskNoteView({
  tasks, removingId, onRemove, onSend, onReorder,
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

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    const target = e.target as HTMLElement;
    // Never start a drag from the trash; the text itself drags the card.
    if (target.closest('button')) return;
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
        // The drop's click must not also send the note.
        window.addEventListener('click', swallowClick, { capture: true, once: true });
        const ghost = cardEl.cloneNode(true) as HTMLDivElement;
        ghost.className = 'task-note-card-ghost';
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
        <TaskEmptyState />
      </div>
    );
  }

  return (
    <div ref={listRef} className="task-note-list">
      {ordered.map(task => (
        <div
          key={task.id}
          data-note-id={task.id}
          className={['task-note-card', dragId === task.id && 'dragging', removingId === task.id && 'removing'].filter(Boolean).join(' ')}
          style={{ touchAction: 'none' }}
          onPointerDown={e => handlePointerDown(e, task.id)}
          // The hover glow follows the pointer: a CSS variable on the card, no re-render.
          onPointerMove={e => e.currentTarget.style.setProperty('--glow-x', `${Math.round(e.clientX - e.currentTarget.getBoundingClientRect().left)}px`)}
        >
          {/* Up to three lines of text that never move. */}
          <div
            className="task-note-preview"
            role="button"
            tabIndex={0}
            aria-label={`${t('pre_input.insert')}: ${task.title}`}
            onClick={() => onSend(task)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSend(task); } }}
          >{task.title}</div>
          <span className="task-note-quick">
            <button type="button" className="task-note-btn task-note-delete" aria-label={t('pre_input.delete')} onClick={() => onRemove(task.id)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" /><path d="M14 11v6" />
                <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
