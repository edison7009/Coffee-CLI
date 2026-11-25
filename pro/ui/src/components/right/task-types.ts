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
  // A body height dragged in older versions; notes now size to their text, so it is ignored.
  height?: number;
}

