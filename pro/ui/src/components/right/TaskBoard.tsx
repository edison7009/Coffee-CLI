import { useState, useEffect, useRef, useCallback } from 'react';
import { TaskAutomations } from './TaskAutomations';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { isTauri, commands } from '../../tauri';
import { sendSessionPrompt } from '../../lib/send-session-prompt';
import { isClaudeConversation, isCodexConversation, isDshConversation, isOpenCodeConversation, isPiConversation } from '../../lib/chat-tools';
import { useClaudeSession } from '../../lib/claude-session';
import { useCodexSession } from '../../lib/codex-session';
import { useDshSession } from '../../lib/dsh-session';
import { useOpenCodeSession } from '../../lib/opencode-session';
import { usePiSession } from '../../lib/pi-session';
import './TaskBoard.css';
import { TaskNoteView } from './TaskNoteView';
import type { TaskItem } from './task-types';


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
        } catch { /* Best-effort operation; failure is non-fatal. */ }
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
  } catch { /* Best-effort operation; failure is non-fatal. */ }
  return [];
}

function saveTasksToBackend(tasks: TaskItem[]) {
  const data = JSON.stringify(tasks);
  if (isTauri) {
    commands.saveTasks(data).catch(() => {
      // Fallback
      try { localStorage.setItem(LEGACY_STORAGE_KEY, data); } catch { /* Best-effort operation; failure is non-fatal. */ }
    });
  } else {
    try { localStorage.setItem(LEGACY_STORAGE_KEY, data); } catch { /* Best-effort operation; failure is non-fatal. */ }
  }
}

// The board used to offer a to-do list (title + notes) and a prompt library (category + body). Notes are the
// only view now, so fold any second field into the note text once; nothing is lost and the result is stable.
function asNotes(tasks: TaskItem[]): TaskItem[] {
  return tasks.map(task => {
    const extra = task.description?.trim();
    if (task.description === undefined) return task;
    const rest = { ...task };
    delete rest.description;
    return extra ? { ...rest, title: task.title.trim() ? `${task.title}\n\n${extra}` : extra } : rest;
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TaskBoard({ onCountChange }: { onCountChange: (count: number) => void }) {
  const t = useT();
  const { state, dispatch } = useAppState();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  useEffect(() => { onCountChange(tasks.length); }, [tasks.length, onCountChange]);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [sendErrorTarget, setSendErrorTarget] = useState<string | null>(null);
  const activeSession = state.terminals.find(tab => tab.id === state.activeTerminalId);
  const isClaude = isClaudeConversation(activeSession), isCodex = isCodexConversation(activeSession), isDsh = isDshConversation(activeSession), isOpenCode = isOpenCodeConversation(activeSession), isPi = isPiConversation(activeSession);
  const claudeReady = useClaudeSession(isClaude ? state.activeTerminalId ?? '' : '', session => session.ready && !session.requests.length);
  const codexReady = useCodexSession(isCodex ? state.activeTerminalId ?? '' : '', session => session.ready && !session.busy && !session.requests.length);
  const dshReady = useDshSession(isDsh ? state.activeTerminalId ?? '' : '', session => session.ready && !session.busy && !session.requests.length);
  const openCodeReady = useOpenCodeSession(isOpenCode ? state.activeTerminalId ?? '' : '', session => session.ready && !session.busy && !session.permissions.length && !session.forms.length);
  const piReady = usePiSession(isPi ? state.activeTerminalId ?? '' : '', session => session.ready && !session.busy && !session.requests.length);
  const canSend = !!activeSession?.tool && !sending && (isClaude ? claudeReady : isCodex ? codexReady : isDsh ? dshReady : isOpenCode ? openCodeReady : isPi ? piReady : true);

  const skipNextSyncRef = useRef(false); // Used to ignore external/initial load syncs
  const isLoadedRef = useRef(false);
  const pendingEchoesRef = useRef<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  // Load tasks from Rust backend on mount.
  useEffect(() => {
    loadTasksFromBackend().then(data => {
      isLoadedRef.current = true;
      setLoaded(true);
      const notes = asNotes(data);
      // Save once if old to-do or prompt fields were folded in; otherwise skip the echo save.
      skipNextSyncRef.current = notes.every((note, index) => note === data[index]);
      setTasks(notes);
    });
  }, []);

  // Save tasks to Rust backend whenever tasks change
  useEffect(() => {
    if (!isLoadedRef.current) return;
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }

    const dataStr = JSON.stringify(tasks);
    pendingEchoesRef.current.add(dataStr);
    
    // Prevent unbounded memory growth if echoes get dropped
    if (pendingEchoesRef.current.size > 20) {
      pendingEchoesRef.current.clear();
      pendingEchoesRef.current.add(dataStr);
    }
    
    saveTasksToBackend(tasks);
  }, [tasks]);

  // Multi-window sync: listen for tasks-changed events from other windows
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import('@tauri-apps/api/event').then(({ listen }) => {
      if (cancelled) return;
      return listen<string>('tasks-changed', (event) => {
        if (cancelled) return;
        // IGNORE OUR OWN ECHOES to prevent rubber-banding jitter
        if (pendingEchoesRef.current.has(event.payload)) {
          pendingEchoesRef.current.delete(event.payload);
          return;
        }
        
        try {
          const updated: TaskItem[] = JSON.parse(event.payload);
          skipNextSyncRef.current = true; // Mark incoming external data so we don't circularly save it
          setTasks(asNotes(updated));
        } catch { /* Best-effort operation; failure is non-fatal. */ }
      }).then(u => { if (cancelled) u(); else unlisten = u; });
    }).catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Composer drafts saved as pre-input land at the top once the board has loaded. They do not take focus:
  // the user is still writing in the composer.
  const preInputQueue = state.preInputQueue;
  useEffect(() => {
    if (!loaded || !preInputQueue.length) return;
    const items = preInputQueue.map((text): TaskItem => ({ id: crypto.randomUUID(), title: text, status: 'todo', createdAt: Date.now() })).reverse();
    setTasks(prev => [...items, ...prev]);
    dispatch({ type: 'TAKE_PRE_INPUT', count: preInputQueue.length });
  }, [loaded, preInputQueue, dispatch]);

  // ─── Task Actions ─────────────────────────────────────────────────────────
  // Share the composer's existing send route and promote only acknowledged tasks.
  const sendTask = useCallback(async (task: TaskItem, body: string, promote: boolean) => {
    if (!canSend || !activeSession || !body.trim() || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setSendErrorTarget(null);
    try {
      if (!await sendSessionPrompt(activeSession, body)) { setSendErrorTarget(activeSession.id); return; }
      if (promote && task.status !== 'working') setTasks(prev => prev.map(item => item.id === task.id && item.status === task.status && item.title === task.title && item.description === task.description ? { ...item, status: 'working' } : item));
    } finally { sendingRef.current = false; setSending(false); }
  }, [activeSession, canSend]);

  // Desktop conversations always show their composer; a terminal tab shows it while Gambit is open.
  const composerOpen = !!activeSession && (isClaude || isCodex || isDsh || isOpenCode || isPi || state.gambitOpen);
  // A note goes into the current tab's composer, where the user reviews and sends it; a terminal tab's composer
  // opens for it. A tab with no tool yet takes it too: the draft stays when a tool launches in that tab.
  const sendToAgent = useCallback((task: TaskItem) => {
    if (!task.title.trim() || !activeSession) return;
    if (!composerOpen) dispatch({ type: 'TOGGLE_GAMBIT' });
    dispatch({ type: 'APPEND_GAMBIT_DRAFT', id: activeSession.id, text: `${activeSession.gambitDraft?.trim() ? '\n' : ''}${task.title}` });
  }, [composerOpen, activeSession, dispatch]);

  // An automation's prompt goes to the current conversation as is; its own app and folder are for scheduled runs.
  const sendAutomationPrompt = useCallback((prompt: string) => {
    // Like a note's send, it never refuses: no ready session means it lands in the open composer instead.
    if (!prompt.trim() || sendingRef.current) return;
    if (canSend) { void sendTask({ id: 'automation', title: prompt, status: 'todo', createdAt: 0 }, prompt, false); return; }
    if (composerOpen && activeSession) dispatch({ type: 'APPEND_GAMBIT_DRAFT', id: activeSession.id, text: `${activeSession.gambitDraft?.trim() ? '\n' : ''}${prompt}` });
  }, [sendTask, canSend, composerOpen, activeSession, dispatch]);

  const handleRemove = useCallback((id: string) => {
    setRemovingId(id);
    setTimeout(() => {
      setTasks(prev => prev.filter(t => t.id !== id));
      setRemovingId(null);
    }, 300);
  }, []);

  return (
    <div className="task-board" aria-busy={sending}>
          {sendErrorTarget && sendErrorTarget === state.activeTerminalId && <p className="task-send-error" role="alert">{t('task.send_failed')}</p>}
          {/* Running automations on top, each prompt one click from the current conversation. */}
          <TaskAutomations onSend={sendAutomationPrompt} />
          <TaskNoteView
            tasks={tasks}
            removingId={removingId}
            onRemove={handleRemove}
            onSend={sendToAgent}
            onReorder={setTasks}
          />

    </div>
  );
}
