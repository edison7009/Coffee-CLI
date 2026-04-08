import { useState, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { isTauri, commands } from '../../tauri';
import './TaskBoard.css';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus = 'todo' | 'working' | 'done';

export interface TaskItem {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
}

// ─── Persistence (Rust file backend with localStorage fallback) ──────────────

const LEGACY_STORAGE_KEY = 'coffee-tasks';

async function loadTasksFromBackend(): Promise<TaskItem[]> {
  if (isTauri) {
    try {
      const raw = await commands.loadTasks();
      const tasks: TaskItem[] = JSON.parse(raw);

      // Auto-migrate: if Rust file is empty but localStorage has data, migrate it
      if (tasks.length === 0) {
        try {
          const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
          if (legacy) {
            const legacyTasks: TaskItem[] = JSON.parse(legacy);
            if (legacyTasks.length > 0) {
              await commands.saveTasks(JSON.stringify(legacyTasks));
              localStorage.removeItem(LEGACY_STORAGE_KEY); // Clean up
              return legacyTasks;
            }
          }
        } catch {}
      }

      return tasks;
    } catch {
      // Fallback to localStorage if Rust backend unavailable
    }
  }

  // Non-Tauri fallback (dev mode in browser)
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveTasksToBackend(tasks: TaskItem[]) {
  const data = JSON.stringify(tasks);
  if (isTauri) {
    commands.saveTasks(data).catch(() => {
      // Fallback
      try { localStorage.setItem(LEGACY_STORAGE_KEY, data); } catch {}
    });
  } else {
    try { localStorage.setItem(LEGACY_STORAGE_KEY, data); } catch {}
  }
}

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'working',
  working: 'done',
  done: 'todo',
};

const STATUS_ORDER: TaskStatus[] = ['working', 'todo', 'done'];
const SECTION_LABEL_KEYS: Record<TaskStatus, 'task.section.working' | 'task.section.todo' | 'task.section.done'> = {
  working: 'task.section.working',
  todo: 'task.section.todo',
  done: 'task.section.done',
};

// ─── Component ───────────────────────────────────────────────────────────────

export function TaskBoard() {
  const t = useT();
  const { state } = useAppState();
  const isZh = state.currentLang.startsWith('zh');
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Inline title editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Drag state — ALL refs to avoid stale closures
  const [dragId, setDragId] = useState<string | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragStartedRef = useRef(false);
  const dropTargetRef = useRef<{ id: string | null; status: TaskStatus | null; position: 'before' | 'after' }>({
    id: null, status: null, position: 'after'
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const skipNextSyncRef = useRef(false); // Prevent echo from our own save

  // Load tasks from Rust backend on mount
  useEffect(() => {
    loadTasksFromBackend().then(setTasks);
  }, []);

  // Save tasks to Rust backend whenever tasks change
  useEffect(() => {
    // Skip saving the initial empty array (before load completes)
    if (tasks.length === 0 && !skipNextSyncRef.current) return;
    skipNextSyncRef.current = false;
    saveTasksToBackend(tasks);
  }, [tasks]);

  // Multi-window sync: listen for tasks-changed events from other windows
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('tasks-changed', (event) => {
        try {
          const updated: TaskItem[] = JSON.parse(event.payload);
          skipNextSyncRef.current = true;
          setTasks(updated);
        } catch {}
      }).then(u => { unlisten = u; });
    });
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  // ─── Task Actions ─────────────────────────────────────────────────────────
  const handleAdd = useCallback(() => {
    const title = inputValue.trim();
    if (!title) return;
    const newTask: TaskItem = {
      id: crypto.randomUUID(), title, status: 'todo', createdAt: Date.now()
    };
    setAddingId(newTask.id);
    setTasks(prev => [newTask, ...prev]);
    setInputValue('');
    setTimeout(() => setAddingId(null), 400);
  }, [inputValue]);

  const handleToggle = useCallback((id: string) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: NEXT_STATUS[t.status] } : t));
  }, []);

  const handleRemove = useCallback((id: string) => {
    setRemovingId(id);
    if (expandedId === id) setExpandedId(null);
    if (editingId === id) setEditingId(null);
    setTimeout(() => {
      setTasks(prev => prev.filter(t => t.id !== id));
      setRemovingId(null);
    }, 300);
  }, [expandedId, editingId]);

  const handleDescChange = useCallback((id: string, desc: string) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, description: desc } : t));
  }, []);

  const startEditing = useCallback((id: string, currentTitle: string) => {
    setEditingId(id);
    setEditingTitle(currentTitle);
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      setTasks(prev => prev.map(t => t.id === editingId ? { ...t, title: trimmed } : t));
    }
    setEditingId(null);
    setEditingTitle('');
  }, [editingId, editingTitle]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingTitle('');
  }, []);

  // ─── Drag System (all via refs, no stale closures) ────────────────────────
  const handlePointerDown = (e: React.PointerEvent, id: string) => {
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('textarea') || target.closest('input')) return;

    const cardEl = target.closest('.task-card') as HTMLElement;
    if (!cardEl) return;

    const rect = cardEl.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    dragStartedRef.current = false;

    const THRESHOLD = 6;

    const onMove = (me: PointerEvent) => {
      const dx = Math.abs(me.clientX - startX);
      const dy = Math.abs(me.clientY - startY);

      if (!dragStartedRef.current) {
        if (dx < THRESHOLD && dy < THRESHOLD) return;
        dragStartedRef.current = true;
        setDragId(id);

        // Create ghost
        const ghost = cardEl.cloneNode(true) as HTMLDivElement;
        ghost.className = 'task-card-ghost';
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

      // Hit test — use ORIGINAL positions, not shifted positions
      // Cache rects on first drag frame to avoid feedback loop
      if (!listRef.current) return;
      const allCards = listRef.current.querySelectorAll<HTMLElement>('[data-task-id]');

      // Build original rects (subtract any existing transform)
      const cardRects: { el: HTMLElement; id: string; top: number; bottom: number; height: number }[] = [];
      for (const card of allCards) {
        const cid = card.dataset.taskId!;
        if (cid === id) continue;
        const r = card.getBoundingClientRect();
        // If card has a transform, get its original position
        const matrix = new DOMMatrix(getComputedStyle(card).transform);
        const offsetY = matrix.m42; // translateY value
        cardRects.push({
          el: card,
          id: cid,
          top: r.top - offsetY,
          bottom: r.bottom - offsetY,
          height: r.height,
        });
      }

      let bestTarget: { id: string | null; status: TaskStatus | null; position: 'before' | 'after' } = {
        id: null, status: null, position: 'after'
      };

      const DEAD_ZONE = 8; // px hysteresis to prevent jitter
      for (const cr of cardRects) {
        if (me.clientY >= cr.top && me.clientY < cr.bottom) {
          const midY = cr.top + cr.height / 2;
          // Only switch position if clearly past the dead zone
          let position: 'before' | 'after';
          if (me.clientY < midY - DEAD_ZONE) {
            position = 'before';
          } else if (me.clientY > midY + DEAD_ZONE) {
            position = 'after';
          } else {
            // In dead zone — keep previous position if same card
            const prev = dropTargetRef.current;
            position = (prev.id === cr.id) ? prev.position : 'after';
          }
          bestTarget = {
            id: cr.id,
            status: cr.el.dataset.taskStatus as TaskStatus,
            position,
          };
          break;
        }
      }

      // Check section headers for empty sections
      if (!bestTarget.id) {
        const sections = listRef.current.querySelectorAll<HTMLElement>('[data-section]');
        for (const sec of sections) {
          const sr = sec.getBoundingClientRect();
          if (me.clientY >= sr.top && me.clientY < sr.bottom + 50) {
            bestTarget = { id: null, status: sec.dataset.section as TaskStatus, position: 'after' };
          }
        }
      }

      dropTargetRef.current = bestTarget;

      // ── Live FLIP: shift cards via direct DOM manipulation (bypasses React) ──
      const draggedHeight = rect.height + 10; // card height + gap
      let shouldShift = false;
      for (const cr of cardRects) {
        if (bestTarget.id && cr.id === bestTarget.id && bestTarget.position === 'before') {
          shouldShift = true;
        }

        if (shouldShift) {
          cr.el.style.transform = `translateY(${draggedHeight}px)`;
          cr.el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
        } else {
          cr.el.style.transform = '';
          cr.el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)';
        }

        if (bestTarget.id && cr.id === bestTarget.id && bestTarget.position === 'after') {
          shouldShift = true;
        }
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);

      // Remove ghost
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }

      if (!dragStartedRef.current) {
        setDragId(null);
        return;
      }

      // Read from ref (not stale state)
      const drop = dropTargetRef.current;

      if (drop.id || drop.status) {
        setTasks(prev => {
          const ordered = STATUS_ORDER.flatMap(s => prev.filter(t => t.status === s));
          const draggedIdx = ordered.findIndex(t => t.id === id);
          if (draggedIdx === -1) return prev;

          const draggedTask = ordered[draggedIdx];
          const newStatus = drop.status || draggedTask.status;
          const updatedTask = { ...draggedTask, status: newStatus };
          const without = ordered.filter(t => t.id !== id);

          if (drop.id) {
            const targetIdx = without.findIndex(t => t.id === drop.id);
            if (targetIdx !== -1) {
              const insertAt = drop.position === 'before' ? targetIdx : targetIdx + 1;
              without.splice(insertAt, 0, updatedTask);
            } else {
              without.push(updatedTask);
            }
          } else {
            // Drop into empty section — append at end of that section
            const sectionEnd = without.filter(t => t.status === newStatus).length;
            let insertAt = 0;
            for (let i = 0; i < without.length; i++) {
              if (without[i].status === newStatus) insertAt = i + 1;
            }
            if (sectionEnd === 0) {
              // Find where this section would be in the order
              const sIdx = STATUS_ORDER.indexOf(newStatus);
              insertAt = 0;
              for (let si = 0; si < sIdx; si++) {
                insertAt += without.filter(t => t.status === STATUS_ORDER[si]).length;
              }
            }
            without.splice(insertAt, 0, updatedTask);
          }

          return without;
        });
      }

      // Clear all inline transforms from FLIP animation
      if (listRef.current) {
        const allCards = listRef.current.querySelectorAll<HTMLElement>('[data-task-id]');
        for (const card of allCards) {
          card.style.transform = '';
          card.style.transition = '';
        }
      }

      setDragId(null);
      dropTargetRef.current = { id: null, status: null, position: 'after' };
      dragStartedRef.current = false;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ─── Render Helpers ───────────────────────────────────────────────────────
  const renderCheckbox = (status: TaskStatus) => (
    <div className={`task-checkbox ${status}`}>
      {status === 'todo' && (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="8" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      )}
      {status === 'working' && (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="8" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="9" cy="9" r="4" fill="currentColor" className="pulse-dot" />
        </svg>
      )}
      {status === 'done' && (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="8" fill="currentColor" />
          <path d="M5.5 9.5L7.5 11.5L12.5 6.5" stroke="#1c1c1e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );

  return (
    <div className="task-board">
      {/* ── Input ── */}
      <div className="task-input-area">
        <input
          ref={inputRef}
          className="task-input"
          type="text"
          placeholder={t('task.input_placeholder')}
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
        />
        <button
          className={`task-add-btn ${inputValue.trim() ? 'active' : ''}`}
          onClick={handleAdd}
          disabled={!inputValue.trim()}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" />
          </svg>
        </button>
      </div>

      {/* ── Task List ── */}
      <div ref={listRef} className="task-list">
        {STATUS_ORDER.map(status => {
          const sectionTasks = tasks.filter(t => t.status === status);
          if (sectionTasks.length === 0 && !dragId) return null;
          const isEmpty = sectionTasks.length === 0 || (sectionTasks.length === 1 && sectionTasks[0].id === dragId);
          return (
            <div key={status} data-section={status} className={`task-section-wrapper ${dragId && isEmpty ? 'empty-drop-zone' : ''}`}>
              <div className="task-section-header">
                <span className={`task-section-dot ${status}`} />
                <span>{t(SECTION_LABEL_KEYS[status])}</span>
                <span className="task-section-count">{sectionTasks.length}</span>
              </div>

              <div className="task-droppable-area">
                {sectionTasks.map(task => {
                  const isExpanded = expandedId === task.id;
                  const hasDesc = !!(task.description && task.description.trim());
                  const isRemoving = removingId === task.id;
                  const isAdding = addingId === task.id;
                  const isEditingThis = editingId === task.id;
                  const isDragging = dragId === task.id;

                  return (
                    <div
                      key={task.id}
                      data-task-id={task.id}
                      data-task-status={task.status}
                      className={[
                        'task-card',
                        task.status,
                        isRemoving && 'removing',
                        isAdding && 'adding',
                        isExpanded && 'expanded',
                        isDragging && 'dragging-placeholder',
                      ].filter(Boolean).join(' ')}
                      style={{ touchAction: 'none', userSelect: 'none' }}
                      onPointerDown={e => handlePointerDown(e, task.id)}
                      onClick={e => {
                        // Ignore if we just finished dragging
                        if (dragStartedRef.current) return;
                        // Ignore clicks on interactive elements
                        const t = e.target as HTMLElement;
                        if (t.closest('button') || t.closest('input') || t.closest('textarea')) return;
                        setExpandedId(prev => prev === task.id ? null : task.id);
                      }}
                    >
                      <div className="task-card-row">
                        <button
                          className="task-check-btn"
                          onClick={e => { e.stopPropagation(); handleToggle(task.id); }}
                        >
                          {renderCheckbox(task.status)}
                        </button>

                        {isEditingThis ? (
                          <input
                            ref={editInputRef}
                            className="task-title-edit"
                            value={editingTitle}
                            onChange={e => setEditingTitle(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
                              if (e.key === 'Escape') cancelEdit();
                            }}
                            onBlur={commitEdit}
                          />
                        ) : (
                          <span className={[
                            'task-title',
                            task.status === 'done' && 'completed',
                            hasDesc && 'has-note',
                          ].filter(Boolean).join(' ')}>
                            {task.title}
                          </span>
                        )}

                        {isEditingThis ? (
                          /* Confirm edit button (checkmark) */
                          <button
                            className="task-confirm-btn"
                            onClick={e => { e.stopPropagation(); commitEdit(); }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </button>
                        ) : (
                          <>
                            {/* Edit title button */}
                            <button
                              className="task-edit-btn"
                              onClick={e => { e.stopPropagation(); startEditing(task.id, task.title); }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                              </svg>
                            </button>
                            {/* Delete button */}
                            <button
                              className="task-delete-btn"
                              onClick={e => { e.stopPropagation(); handleRemove(task.id); }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </>
                        )}
                      </div>

                      <div className={`task-desc-area ${isExpanded ? 'open' : ''}`}>
                        <div className="task-desc-area-inner">
                          <textarea
                            className="task-desc-input"
                            placeholder={t('task.notes_placeholder')}
                            value={task.description || ''}
                            onChange={e => handleDescChange(task.id, e.target.value)}
                            rows={2}
                            onClick={e => e.stopPropagation()}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {tasks.length === 0 && (() => {
          const hour = new Date().getHours();
          let greeting: string;
          let icon: ReactNode;

          const sunIcon = (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
              <circle cx="12" cy="12" r="4"/>
              <path d="M12 2v2"/><path d="M12 20v2"/>
              <path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>
              <path d="M2 12h2"/><path d="M20 12h2"/>
              <path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>
            </svg>
          );
          const moonIcon = (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
            </svg>
          );

          if (hour >= 5 && hour < 12) {
            greeting = t('task.greeting.morning');
            icon = sunIcon;
          } else if (hour >= 12 && hour < 18) {
            greeting = t('task.greeting.afternoon');
            icon = sunIcon;
          } else {
            greeting = t('task.greeting.evening');
            icon = moonIcon;
          }

          return (
            <div className="task-empty">
              <div className="task-empty-icon">{icon}</div>
              <div className="task-empty-text"
                style={isZh ? { fontFamily: 'var(--font, system-ui)', fontStyle: 'normal', fontWeight: 600, letterSpacing: '0.08em' } : undefined}
              >{greeting}</div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
