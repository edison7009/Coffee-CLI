// Shared note model for the pre-input board (TaskBoard) and its sticky-note view (TaskNoteView).
// Kept in its own module so both import it without a circular runtime import.

export type TaskStatus = 'todo' | 'working' | 'done';

export interface TaskItem {
  id: string;
  // The note text.
  title: string;
  // Only in data from the removed to-do and prompt views; TaskBoard folds it into the title on load.
  description?: string;
  status: TaskStatus;
  createdAt: number;
  // Sticky-note view only: the user-dragged body height in px (bottom-edge
  // resize). Undefined = auto-grow to fit content from a roomy default. Ignored
  // by the to-do list view. Persisted so a note keeps the size you gave it.
  height?: number;
}

// Builds the welcome/guide note. Shared by the first-launch seed (TaskBoard)
// and the empty-state "show guide" button, so both produce an identical roomy
// note. Caller passes the already-localized guide text.
export function makeWelcomeNote(text: string): TaskItem {
  return {
    id: crypto.randomUUID(),
    title: text,
    status: 'todo',
    createdAt: Date.now(),
    height: 240,
  };
}

// Vertical order: 进行中 (top) → 待办 → 已完成, with no section headers — the
// per-card status dots carry the grouping signal instead.
export const STATUS_ORDER: TaskStatus[] = ['working', 'todo', 'done'];
