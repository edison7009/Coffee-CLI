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
import { TaskNoteView, type NoteSection } from './TaskNoteView';
import { makeWelcomeNote, type TaskItem } from './task-types';
import { projectRoot, projectName, sameProject } from '../../lib/pre-input-project';


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
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
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

  // Notes belong to the project they were written in and show only there; general notes (no folder) show in
  // every project. "All" groups every note by project, General first, and dragging between groups moves a note.
  const project = projectRoot(activeSession?.folderPath);
  const [showAll, setShowAll] = useState(() => { try { return localStorage.getItem('cc-pre-input-all') === '1'; } catch { return false; } });
  const chooseScope = (all: boolean) => {
    setShowAll(all);
    try { localStorage.setItem('cc-pre-input-all', all ? '1' : '0'); } catch { /* Best-effort operation; failure is non-fatal. */ }
  };
  const visible = showAll ? tasks : tasks.filter(task => !task.folder || sameProject(task.folder, project));
  useEffect(() => { onCountChange(visible.length); }, [visible.length, onCountChange]);
  const sections: NoteSection[] = (() => {
    if (!showAll) return [{ key: 'current', label: null, folder: null, items: visible }];
    const folders: string[] = [];
    for (const task of tasks) if (task.folder && !folders.some(folder => sameProject(folder, task.folder))) folders.push(task.folder);
    // General first, then the open project, then the rest by name.
    folders.sort((a, b) => Number(sameProject(b, project)) - Number(sameProject(a, project)) || projectName(a).localeCompare(projectName(b)));
    return [
      { key: '', label: t('pre_input.general'), folder: null, items: tasks.filter(task => !task.folder) },
      ...folders.map(folder => ({ key: folder, label: projectName(folder), folder, items: tasks.filter(task => sameProject(task.folder, folder)) })),
    ];
  })();

  const skipNextSyncRef = useRef(false); // Used to ignore external/initial load syncs
  const isLoadedRef = useRef(false);
  const pendingEchoesRef = useRef<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  // Load tasks from Rust backend on mount. A first-ever launch (no tasks AND
  // never seeded) drops one roomy welcome/guide note; existing users are just flagged seeded
  // (so they never get it). The seed is allowed to persist (no skip).
  useEffect(() => {
    loadTasksFromBackend().then(data => {
      isLoadedRef.current = true;
      setLoaded(true);
      let seeded = false;
      try { seeded = localStorage.getItem('cc-tasks-seeded') === '1'; } catch { /* Best-effort operation; failure is non-fatal. */ }

      if (data.length === 0 && !seeded) {
        try { localStorage.setItem('cc-tasks-seeded', '1'); } catch { /* Best-effort operation; failure is non-fatal. */ }
        setTasks([makeWelcomeNote(t('task.welcome_note'))]);
        return;
      }

      if (!seeded) { try { localStorage.setItem('cc-tasks-seeded', '1'); } catch { /* Best-effort operation; failure is non-fatal. */ } }
      const notes = asNotes(data);
      // Save once if old to-do or prompt fields were folded in; otherwise skip the echo save.
      skipNextSyncRef.current = notes.every((note, index) => note === data[index]);
      setTasks(notes);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const items = preInputQueue.map(({ text, folder }): TaskItem => ({ id: crypto.randomUUID(), title: text, status: 'todo', createdAt: Date.now(), ...(folder ? { folder } : {}) })).reverse();
    setTasks(prev => [...items, ...prev]);
    dispatch({ type: 'TAKE_PRE_INPUT', count: preInputQueue.length });
  }, [loaded, preInputQueue, dispatch]);

  // ─── Task Actions ─────────────────────────────────────────────────────────
  // A new note starts empty and in edit mode (the note view keeps editing until the user clicks away).
  const handleAdd = useCallback(() => {
    const newTask: TaskItem = { id: crypto.randomUUID(), title: '', status: 'todo', createdAt: Date.now(), ...(project ? { folder: project } : {}) };
    setAddingId(newTask.id);
    setTasks(prev => [newTask, ...prev]);
    setTimeout(() => setAddingId(null), 400);
  }, [project]);

  // Duplicate a note — spawns an identical sticky right AFTER the original
  // (same title/description/status/height, fresh id) so a long note can be
  // reused as a template without retyping. Deliberately does NOT set addingId:
  // that drives the note's autoFocus + select-all, which is right for a blank
  // new note (the user will type into it) but wrong for a duplicate — clicking
  // "copy" is a SAVE-EFFORT gesture, not an edit. The copy just appears in place.
  const duplicateTask = useCallback((id: string) => {
    const newId = crypto.randomUUID();
    setTasks(prev => {
      const idx = prev.findIndex(t => t.id === id);
      if (idx < 0) return prev;
      const copy: TaskItem = { ...prev[idx], id: newId, createdAt: Date.now() };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, []);

  // Share the composer's existing send route and promote only acknowledged tasks.
  const sendTask = useCallback(async (task: TaskItem, body: string, promote: boolean) => {
    if (!canSend || !activeSession || !body.trim() || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setSendErrorTarget(null);
    try {
      if (!await sendSessionPrompt(activeSession, body)) { setSendErrorTarget(activeSession.id); return; }
      // Mark the note sent only if its text is still what went out.
      if (promote) setTasks(prev => prev.map(item => item.id === task.id && item.title === task.title ? { ...item, sentAt: Date.now() } : item));
    } finally { sendingRef.current = false; setSending(false); }
  }, [activeSession, canSend]);

  const sendToAgent = useCallback((task: TaskItem) => {
    void sendTask(task, task.title, true);
  }, [sendTask]);

  // An automation's prompt goes to the current conversation as is; its own app and folder are for scheduled runs.
  const sendAutomationPrompt = useCallback((prompt: string) => {
    void sendTask({ id: 'automation', title: prompt, status: 'todo', createdAt: 0 }, prompt, false);
  }, [sendTask]);

  // Live text edit, written through on every keystroke. Changed text has not been sent, so it loses its sent mark.
  const updateTitle = useCallback((id: string, title: string) => {
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t;
      const next = { ...t, title };
      delete next.sentAt;
      return next;
    }));
  }, []);

  // The pin makes a note general (shown in every project), or ties a general one to the open project.
  const toggleGeneral = useCallback((id: string) => {
    setTasks(prev => prev.map(task => {
      if (task.id !== id) return task;
      if (!task.folder) return project ? { ...task, folder: project } : task;
      const next = { ...task };
      delete next.folder;
      return next;
    }));
  }, [project]);

  // Note-view body height (bottom-edge resize). Persisted on the task so the
  // note keeps its size; the note view drives live preview locally and only
  // calls this once on drop.
  const setHeight = useCallback((id: string, height: number) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, height } : t));
  }, []);

  // Manually (re)add the welcome guide note — wired to the empty-state button.
  // Switches to the sticky-note view so the long guide reads as a note, not a
  // long title row. (New users still get it auto-seeded once; this is the

  // Manually (re)add the welcome guide note — wired to the empty-state button.
  // Idempotent: only seed onto an empty board, so a fast double-click can't stack duplicate guide notes.
  const handleShowGuide = () => {
    setTasks(prev => prev.length > 0 ? prev : [makeWelcomeNote(t('task.welcome_note'))]);
  };

  const handleRemove = useCallback((id: string) => {
    setRemovingId(id);
    setTimeout(() => {
      setTasks(prev => prev.filter(t => t.id !== id));
      setRemovingId(null);
    }, 300);
  }, []);

  return (
    <div className={`task-board${__IS_LINUX__ ? ' task-board--static' : ''}`} aria-busy={sending}>
          {sendErrorTarget && sendErrorTarget === state.activeTerminalId && <p className="task-send-error" role="alert">{t('task.send_failed')}</p>}
          {/* Automations on top: on or off at a glance, and each prompt one click from the current conversation. */}
          <TaskAutomations canSend={canSend} onSend={sendAutomationPrompt} />
          <div className="pre-input-scope" role="group" aria-label={t('pre_input.scope')}>
            <button type="button" aria-pressed={showAll} onClick={() => chooseScope(true)}>{t('pre_input.scope.all')}</button>
            <button type="button" aria-pressed={!showAll} onClick={() => chooseScope(false)}>{project ? projectName(project) : t('pre_input.general')}</button>
          </div>
          <TaskNoteView
            sections={sections}
            canTieToProject={!!project}
            onToggleGeneral={toggleGeneral}
            addingId={addingId}
            removingId={removingId}
            canSend={canSend}
            onUpdateTitle={updateTitle}
            onSetHeight={setHeight}
            onRemove={handleRemove}
            onDuplicate={duplicateTask}
            onSend={sendToAgent}
            onReorder={setTasks}
            onShowGuide={handleShowGuide}
          />

      {/* ── Floating Action Button (FAB) ── */}
      <div className="task-fab-container">
        <button className="task-fab-simple" onClick={handleAdd}>
          <div className="task-fab-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </div>
        </button>
      </div>
    </div>
  );
}
