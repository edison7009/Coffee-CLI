// TaskNoteView — sticky-note presentation of the task board. Same TaskItem
// data as the to-do list (TaskBoard owns the state and passes it down); this
// view just renders each task as a roomy note card:
//
//   ┌─────────────────────────────────────────────┐
//   │ ● ● ●            2026.6.28  21:48   🗑  ▶     │   ← traffic-light status
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
import './TaskNoteView.css';

// Traffic-light dots, top-to-bottom priority. Colors are deliberately the
// literal macOS-window red/amber/green from the user's mockup, not the theme
// accent — the three-light metaphor only reads if the colors are fixed.
const STATUS_DOTS: { status: TaskStatus; color: string }[] = [
  { status: 'working', color: '#ff5f57' },
  { status: 'todo', color: '#febc2e' },
  { status: 'done', color: '#28c840' },
];

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
  onRemove: (id: string) => void;
  onSend: (task: TaskItem) => void;
  // Functional updater (the parent's setTasks) so a reorder computed at drop
  // time still composes against the freshest array — guards against a
  // multi-window sync landing mid-drag.
  onReorder: (updater: (prev: TaskItem[]) => TaskItem[]) => void;
}

export function TaskNoteView({
  tasks, addingId, removingId, canSend, onSetStatus, onUpdateTitle, onRemove, onSend, onReorder,
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

  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    const target = e.target as HTMLElement;
    // Never start a drag from an interactive control — the note body needs
    // click-to-place-caret + text selection, and the dots/buttons need clicks.
    if (target.closest('textarea') || target.closest('button')) return;

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

  if (ordered.length === 0) {
    return (
      <div className="task-note-list task-note-list--empty">
        <TaskEmptyState />
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

              <div className="task-note-time">
                <span className="task-note-date">{date}</span>
                <span className="task-note-clock">{time}</span>
              </div>

              <div className="task-note-actions">
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
              autoFocus={addingId === task.id}
              placeholder={t('task.note_placeholder')}
              onChange={next => onUpdateTitle(task.id, next)}
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
  autoFocus: boolean;
  placeholder: string;
  onChange: (next: string) => void;
}

function NoteBody({ value, autoFocus, placeholder, onChange }: NoteBodyProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [autoFocus]);

  return (
    <textarea
      ref={ref}
      className="task-note-body"
      value={value}
      placeholder={placeholder}
      rows={2}
      onChange={e => onChange(e.target.value)}
      onPointerDown={e => e.stopPropagation()}
    />
  );
}
