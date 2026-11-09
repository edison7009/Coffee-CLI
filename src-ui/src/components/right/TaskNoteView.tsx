// TaskNoteView — the pre-input board's sticky notes. TaskBoard owns the notes and passes them in sections:
// one unlabelled section for the current project (its notes plus general ones), or one labelled section per
// project, General first, when showing everything. Each card is just the note text with its tools on the right:
//
//   ┌──────────────────────────────────────────────┐
//   │ note text, collapsed to two lines   ⧉ 📌 🗑 ✓ ▶ │  ← copy / general / delete show on hover
//   └──────────────────────────────────────────────┘
//
// A click opens or closes a note, a double-click edits it. Cards drag up and down; in the grouped view,
// dropping a card under another project's heading (or General) moves it there.

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
// Collapsed notes show up to two lines (one-line notes stay one line); an expanded note grows to fit up to
// this cap, then scrolls.
const NOTE_COLLAPSED_HEIGHT = 60;
const NOTE_EXPANDED_CAP = 480;

/** Where a dragged note lands: next to a card, or at the end of an empty section; `folder` is set when it changes section. */
type Drop = ({ after: string } | { before: string } | { append: true }) & { folder?: string | null };

export interface NoteSection {
  key: string;
  // Shown as a heading in the grouped view; null for the current project's single list.
  label: string | null;
  // The folder a note dropped into this section takes: null = general. Only used when the view is grouped.
  folder: string | null;
  items: TaskItem[];
}

interface TaskNoteViewProps {
  sections: NoteSection[];
  // The note just added with the + button: it starts in edit mode.
  addingId: string | null;
  // The note mid-removal — kept rendered for one exit animation before the parent drops it.
  removingId: string | null;
  canSend: boolean;
  // A general note can only be tied back to a project when one is open.
  canTieToProject: boolean;
  onUpdateTitle: (id: string, title: string) => void;
  // Persists a bottom-edge-resized body height (called once on drop).
  onSetHeight: (id: string, height: number) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleGeneral: (id: string) => void;
  onSend: (task: TaskItem) => void;
  // Functional updater (the parent's setTasks) so a reorder computed at drop
  // time still composes against the freshest array — guards against a
  // multi-window sync landing mid-drag.
  onReorder: (updater: (prev: TaskItem[]) => TaskItem[]) => void;
  // Empty-board "view the usage guide" button → (re)adds the welcome note.
  onShowGuide: () => void;
}

const PIN_ICON = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>;

export function TaskNoteView({
  sections, addingId, removingId, canSend, canTieToProject, onUpdateTitle, onSetHeight, onRemove, onDuplicate, onToggleGeneral, onSend, onReorder, onShowGuide,
}: TaskNoteViewProps) {
  const t = useT();
  const grouped = sections.some(section => section.label !== null);

  // ── Drag (refs to avoid stale closures) ──
  const listRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dragStartedRef = useRef(false);
  const dropTargetRef = useRef<Drop | null>(null);
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
    // A read-only body (not being edited) drags the card; buttons and the resize grip keep their own gestures.
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
    // Layout before the drag (cards and section headings in page order): whatever the card passes slides out of
    // its way, and its dashed outline slides to the drop slot.
    let layout: { el: HTMLElement; id: string | null; folder: string | null; top: number; pitch: number }[] = [];
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
        // cloneNode copies attributes but not the live textarea value; copy it so the preview keeps the text,
        // capped to about two lines so a long note stays easy to place.
        const srcBody = cardEl.querySelector('textarea');
        const ghostBody = ghost.querySelector('textarea');
        if (srcBody && ghostBody) ghostBody.value = srcBody.value;
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
        const els = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-note-id], .task-note-group') ?? [])];
        const rects = els.map(el => el.getBoundingClientRect());
        layout = els.map((el, i) => ({
          el, id: el.dataset.noteId ?? null, folder: el.dataset.folder ?? null, top: rects[i].top,
          pitch: i + 1 < els.length ? rects[i + 1].top - rects[i].top : rects[i].height + 4,
        }));
      }

      if (ghostRef.current) {
        ghostRef.current.style.left = `${me.clientX - offsetX}px`;
        ghostRef.current.style.top = `${me.clientY - offsetY}px`;
      }

      const from = layout.findIndex(item => item.id === id);
      if (from < 0) return;
      const self = layout[from];
      // Slot among everything else by original midpoints; never above the first heading.
      const others = layout.filter(item => item !== self);
      let slot = others.filter(item => me.clientY > item.top + item.pitch / 2).length;
      if (others[0] && !others[0].id) slot = Math.max(1, slot);
      const before = others[slot - 1], after = others[slot];
      const heading = others.slice(0, slot).reverse().find(item => !item.id);
      const drop: Drop = before?.id ? { after: before.id } : after?.id ? { before: after.id } : { append: true };
      if (grouped && heading) drop.folder = heading.folder === '' ? null : heading.folder;
      // Everything between the old and new spot moves by the card's pitch, the card by theirs.
      const at = after ? layout.indexOf(after) : layout.length;
      let travel = 0;
      layout.forEach((item, index) => {
        if (item === self) return;
        const passedDown = at > from && index > from && index < at;
        const passedUp = at <= from && index >= at && index < from;
        if (passedDown) travel += item.pitch;
        if (passedUp) travel -= item.pitch;
        shift(item.el, passedDown ? -self.pitch : passedUp ? self.pitch : 0);
      });
      shift(self.el, travel);
      // Dropping back where it started is a no-op.
      dropTargetRef.current = travel === 0 ? null : drop;
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
      if (dragStartedRef.current && drop) {
        onReorder(prev => {
          const found = prev.find(task => task.id === id);
          if (!found) return prev;
          let dragged = found;
          if (drop.folder !== undefined) {
            dragged = { ...found };
            if (drop.folder) dragged.folder = drop.folder; else delete dragged.folder;
          }
          const without = prev.filter(task => task.id !== id);
          const anchor = 'after' in drop ? drop.after : 'before' in drop ? drop.before : null;
          const index = anchor ? without.findIndex(task => task.id === anchor) : without.length;
          if (index === -1) return prev;
          without.splice('after' in drop ? index + 1 : index, 0, dragged);
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
    // pointer leaves the window or focus is stolen (WebView2).
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

  if (!sections.some(section => section.items.length)) {
    return (
      <div className="task-note-list task-note-list--empty">
        <TaskEmptyState onShowGuide={onShowGuide} />
      </div>
    );
  }

  const card = (task: TaskItem) => {
    const open = expanded.has(task.id) || editingId === task.id || addingId === task.id || resizing?.id === task.id;
    const general = !task.folder;
    return (
      <div
        key={task.id}
        data-note-id={task.id}
        data-folder={task.folder ?? ''}
        className={[
          'task-note-card',
          task.sentAt && 'is-sent',
          !open && 'is-collapsed',
          dragId === task.id && 'dragging',
          removingId === task.id && 'removing',
        ].filter(Boolean).join(' ')}
        style={{ touchAction: 'none' }}
        onPointerDown={e => handlePointerDown(e, task.id)}
      >
        <NoteBody
          value={task.title}
          height={resizing?.id === task.id ? resizing.height : (task.height ?? null)}
          open={open}
          editing={editingId === task.id || addingId === task.id}
          onToggle={() => setOpen(task.id, !expanded.has(task.id))}
          onEdit={() => { setOpen(task.id, true); setEditingId(task.id); }}
          onEditEnd={() => setEditingId(current => current === task.id ? null : current)}
          autoFocus={addingId === task.id}
          placeholder={t('task.note_placeholder')}
          onChange={next => onUpdateTitle(task.id, next)}
        />

        {/* Tools on the right: copy, general and delete show on hover; the sent mark and send always do.
            A span, not a div, so the glass theme's panel rule leaves its backdrop alone. */}
        <span className="task-note-tools">
          <span className="task-note-hover-tools">
            <button type="button" className="task-note-btn task-note-copy" aria-label={t('pre_input.copy')} onClick={() => onDuplicate(task.id)} disabled={!task.title.trim()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            <button type="button" className="task-note-btn task-note-general" aria-label={t('pre_input.general_toggle')} aria-pressed={general} disabled={general && !canTieToProject} onClick={() => onToggleGeneral(task.id)}>{PIN_ICON}</button>
            <button type="button" className="task-note-btn task-note-delete" aria-label={t('pre_input.delete')} onClick={() => onRemove(task.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" /><path d="M14 11v6" />
                <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </span>
          {/* In the current project's list a pin marks the general notes mixed in with the project's own. */}
          {general && !grouped && <span className="task-note-general-mark" role="img" aria-label={t('pre_input.general')}>{PIN_ICON}</span>}
          {task.sentAt ? <span className="task-note-sent" role="img" aria-label={t('pre_input.sent')}>✓</span> : null}
          <button type="button" className="task-note-btn task-note-send" aria-label={t('pre_input.send')} onClick={() => onSend(task)} disabled={!canSend || !task.title.trim()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
              <polygon points="5 3 21 12 5 21" />
            </svg>
          </button>
        </span>

        {/* Bottom-edge resize handle — drag to grow or shrink an open note. */}
        <div
          className={`task-note-resize${resizing?.id === task.id ? ' resizing' : ''}`}
          onPointerDown={e => { setOpen(task.id, true); handleResizeDown(e, task.id); }}
        />
      </div>
    );
  };

  return (
    <div ref={listRef} className={`task-note-list${grouped ? ' is-grouped' : ''}`}>
      {sections.map(section => [
        section.label !== null && (
          <div key={`group-${section.key}`} className="task-note-group" data-folder={section.folder ?? ''}>
            <span className="task-note-group-name">{section.label}</span>
            <span className="task-note-group-count">{section.items.length}</span>
          </div>
        ),
        ...section.items.map(card),
      ])}
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
        el.style.height = `${Math.min(NOTE_COLLAPSED_HEIGHT, el.scrollHeight)}px`;
        el.scrollTop = 0;
      } else {
        // Expanded: show the whole note up to the cap, then scroll. A dragged height only ever makes it taller,
        // so an old small height (or a short drag) never leaves an opened note cramped.
        el.style.height = 'auto';
        const fitted = Math.min(NOTE_EXPANDED_CAP, el.scrollHeight);
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
        rows={1}
        onChange={e => onChange(e.target.value)}
        onPointerDown={e => { if (editing) e.stopPropagation(); }}
        onContextMenu={(e) => openCtxMenu(e, onChange)}
      />
      {ctxMenu}
    </>
  );
}
