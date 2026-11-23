// A sub-task's first message is Coffee CLI's instruction to the worker (src/orchestration.rs, worker_prompt): a
// fixed English preamble naming the task id, then "TASK" and the task as the coordinator wrote it. The conversation
// shows that task as a card instead of passing the whole instruction off as something the user typed.
const PREFIX = 'You are a worker assigned from the parent session inside Coffee CLI. Task ID: ';
const MARK = '\n\nTASK\n';

export interface WorkerPrompt { id: string; task: string; instructions: string }

export function parseWorkerPrompt(text: string): WorkerPrompt | null {
  if (!text.startsWith(PREFIX)) return null;
  const at = text.indexOf(MARK); // the preamble never contains it; the task may
  const id = /^(.+?)\. Work only/.exec(text.slice(PREFIX.length))?.[1];
  if (at < 0 || !id) return null;
  const task = text.slice(at + MARK.length).trim();
  return task ? { id, task, instructions: text.slice(0, at).trim() } : null;
}
