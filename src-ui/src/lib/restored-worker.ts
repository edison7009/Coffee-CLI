// The tab a closed worker reopens in from history: the desktop conversation it ran as, whichever tool it is.
import type { TerminalSession, ToolType } from '../store/app-state';
import { isAcpTool } from './acp-tools';

export interface RestorableWorker { sessionId: string; tool: string; cwd: string; nativeId?: string | null; title?: string | null }

export function restoredWorkerSession(task: RestorableWorker): TerminalSession {
  const tool = task.tool;
  return {
    id: task.sessionId, tool: tool as ToolType, folderPath: task.cwd, resumeToken: task.nativeId ?? undefined, toolTitle: task.title ?? undefined, strictCwd: true,
    claudeMode: tool === 'claude' ? 'conversation' : undefined, codexMode: tool === 'codex' ? 'conversation' : undefined,
    opencodeMode: tool === 'opencode' ? 'conversation' : undefined, piMode: tool === 'pi' ? 'conversation' : undefined,
    acpMode: isAcpTool(tool) ? 'conversation' : undefined,
  };
}
