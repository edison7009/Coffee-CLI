// Shared task model — consumed by both the to-do list view (TaskBoard) and
// the sticky-note view (TaskNoteView). Kept in its own module so the two
// views import the same types/constants without a circular runtime import
// (TaskBoard imports the TaskNoteView component; both import from here).

export type TaskStatus = 'todo' | 'working' | 'done';

export interface TaskItem {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  createdAt: number;
}

// Click-to-advance order for the to-do checkbox (todo → working → done → todo).
export const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'working',
  working: 'done',
  done: 'todo',
};

// Vertical grouping order shared by both views: 进行中 (top) → 待办 → 已完成.
// The sticky-note view renders this same order with no section headers — the
// per-card status dots carry the grouping signal instead.
export const STATUS_ORDER: TaskStatus[] = ['working', 'todo', 'done'];
