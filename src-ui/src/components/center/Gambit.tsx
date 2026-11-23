// Gambit.tsx — docked compose panel anchored at the bottom of the center panel.
//
// Named for the chess "gambit": a calculated opening move after careful thought.
// Users compose long messages (and paste screenshots) in a real HTML textarea
// where native Ctrl+A/X/Z/Y all work, then send via Ctrl+Enter. The full text
// is forwarded to the tab's xterm as a single bracketed paste + Enter — no
// keystroke-by-keystroke simulation, so IME, newlines, and unicode all round-
// trip correctly.
//
// Image paste behavior: pasted images are saved to a temp file via Rust, and
// the absolute path is inserted directly into the textarea as plain text at
// the cursor position. The attachment row above the input derives from those
// editable path strings. AI CLI agents that support local image paths (e.g.
// Claude Code) will read the file; agents that don't just see the raw path.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCompact, usePhone } from '../../lib/viewport';
import { isWorktreePending } from '../../lib/worktree-pending';
import { createPortal } from 'react-dom';
import { clipboardRead, clipboardWrite } from '../../lib/clipboard';
import { canSharePrompt, sharePrompt } from '../../lib/prompt-link';
import { useHoverTip } from '../common/HoverTip';
import { subscribeGambitHistory, getGambitHistorySnapshot, pushGambitHistory } from '../../lib/gambit-history';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { registerFileDropTarget } from '../../lib/file-drop';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { ClaudeComposerControls, AttachIcon } from './ClaudeComposerControls';
import { CodexComposerControls } from './CodexComposerControls';
import { OpenCodeComposerControls } from './OpenCodeComposerControls';
import { PiComposerControls } from './PiComposerControls';
import { DshComposerControls } from './DshComposerControls';
import { UsageMeter } from './UsageMeter';
import { VoiceInputButton, VoiceUsageSlot } from './VoiceInputButton';
import { useUsageQuota } from '../../lib/usage-quota';
import { attachToDraft, detachFromDraft, draftForSend, gambitAttachments, joinDraft, splitDraft } from '../../lib/gambit-attachments';
import './Gambit.css';
import { OrchestrationPicker } from './OrchestrationPicker';
import { fileToBase64 } from '../../lib/answer-image-paste';
import { pickFiles } from '../../lib/folder-picker';

interface GambitProps {
  sessionId: string;
  draft: string;
  onDraftChange: (text: string) => void;
  onClose: () => void;
  /** Returns true when the text was accepted by the target xterm, false
   *  when the send couldn't complete (no active session, pane not focused
   *  in multi-agent mode, xterm not yet mounted, etc.). Gambit uses this
   *  signal to decide whether to clear the draft — failed sends preserve
   *  the text so the user never loses what they typed. */
  onSend: (text: string) => boolean | Promise<boolean>;
  running?: boolean;
  claude?: boolean;
  /** The agent's guess at the next prompt, offered while the composer is empty; Tab takes it. */
  suggestion?: string;
  codex?: boolean;
  /** DeepSeek Harness desktop conversation (always desktop in Coffee CLI). */
  dsh?: boolean;
  /** OpenCode desktop conversation. */
  opencode?: boolean;
  /** Pi desktop conversation. */
  pi?: boolean;
  /** Local file paths are meaningful to this target (false for SSH tabs). */
  attachable?: boolean;
  onCancel?: () => void;
  sendFailedHint?: string;
  /** Whether the left/right side panels are currently hidden. When Gambit
   *  is docked at the bottom it spans the center panel only, so we need
   *  to know which sides are absent to compute the inset offsets. */
  leftPanelHidden: boolean;
  rightPanelHidden: boolean;
  /** The active tab's Send target label: working-folder basename for local
   *  sessions, connection host for SSH/WebSocket. Rendered in the footer;
   *  switching tabs updates it. '' hides the label. */
  workspaceName: string;
  /** The active tab's tool glyph — same icon its chrome-tab shows. Rendered
   *  left of the target name so the chip reads as "tool + target",
   *  mirroring the tab's icon+name pairing. undefined hides the icon. */
  toolIcon?: React.ReactNode;
  /** Active tab's tool id and folder; the plan-usage meter reads the tool's own configuration. */
  tool?: string;
  cwd?: string;
  orchestration?: boolean;
  computer?: boolean;
  browser?: boolean;
  /** The remote control chip (RemoteControlPicker), for a tab that can operate remote windows. */
  remoteControl?: React.ReactNode;
  /** Where this conversation works (方案 A's tab on the card): a remote computer's name, or null for this one. */
  placeDevice?: string | null;
  /** Controls beside the target label: the worktree switch for desktop conversations, New chat for Coffee Agent. */
  worktreeControl?: React.ReactNode;
}

// Matches any absolute image path inside the compose draft — both our
// own temp-dir clip images AND user-typed paths like
//   说看看图片"C:\Users\eben\Desktop\hermes.png"
//   cat /home/me/screenshot.jpg
// Requires a drive letter (Win) or leading slash (POSIX) so we don't
// false-positive on bare filenames mentioned in prose like ".png 格式".
// Excludes quotes and whitespace from the match body so surrounding
// `"..."` wrappers self-strip; if a path has spaces in a directory
// name, it won't match — edge case we accept.
const IMAGE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;

// Wrap every bare image path with `" ... "` (leading / trailing space
// inside the quotes) on the way out to the PTY. Why: when a path sits at
// the end of a paste, Claude/Codex async-attach the image from disk while
// Gambit schedules the trailing CR 150 ms later — the attach frequently
// takes longer than 150 ms, so by the time `\r` lands the visible path has
// been replaced by a placeholder but the attachment isn't ready, and the
// path silently drops out of the submission. Wrapping inserts buffer
// characters after the path and a clean delimiter the upstream CLI can
// use, defeating the race deterministically. We do NOT mutate the draft —
// the wrap is applied only at send time so the textarea stays clean and
// undo/edit feels natural. IMAGE_PATH_RE excludes quotes from its match
// body, so even paths the user typed already inside quotes match (and we
// skip them via the adjacency check below to avoid double-wrapping).
function wrapImagePathsForSend(text: string): string {
  return text.replace(IMAGE_PATH_RE, (match, offset: number, full: string) => {
    const prev = offset > 0 ? full[offset - 1] : '';
    const next = full[offset + match.length] || '';
    if (prev === '"' || next === '"') return match;
    return `" ${match} "`;
  });
}

// Docked height: Gambit lives flush at the bottom of the center panel.
// Height is user-resizable via the top edge and persists across sessions,
// mirroring how VS Code's bottom panel works.
const DOCK_MIN_HEIGHT = 120;
const DOCK_MAX_HEIGHT_RATIO = 0.7; // never let the dock eat more than 70% of viewport height
/** The draft's actions on the composer's top edge: save to pre-input, copy a share link, clear.
 *  Always there while the setting is on; darker (still solid) and inert while the draft is empty. */
function DraftActions({ enabled, canShare, label, shareLabel, clearLabel, tips, onSave, onShare, onClear }: {
  enabled: boolean; canShare: boolean; label: string; shareLabel: string; clearLabel: string;
  /** Hover tips that say what each does; Clear only empties the box, unlike Delete in the pre-input list. */
  tips: { save: string; share: string; clear: string };
  onSave: () => void; onShare: () => void; onClear: () => void;
}) {
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();
  const { tipFor, tip } = useHoverTip();
  // Disabled buttons get no mouse events, so each tip rides on a wrapper that always does.
  return <span className="gambit-draft-actions" data-enabled={enabled || undefined}>
    <span className="gambit-draft-slot" {...tipFor(tips.save)}><button type="button" className="gambit-draft-action gambit-draft-save" disabled={!enabled} onMouseDown={keepFocus} onClick={onSave}>{label}</button></span>
    <span className="gambit-draft-slot" {...tipFor(tips.share)}><button type="button" className="gambit-draft-action gambit-draft-icon" disabled={!enabled || !canShare} aria-label={shareLabel} onMouseDown={keepFocus} onClick={onShare}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" /></svg>
    </button></span>
    <span className="gambit-draft-slot" {...tipFor(tips.clear)}><button type="button" className="gambit-draft-action gambit-draft-icon" disabled={!enabled} aria-label={clearLabel} onMouseDown={keepFocus} onClick={onClear}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /></svg>
    </button></span>
    {tip}
  </span>;
}

const CARD_MIN_HEIGHT = 76; // 方案 A: the card — one line to type, one line of controls
const CLEAR_MIN_HEIGHT = 64; // Clear: the one-line box (36px) and the row of settings under it
const PLACE_TAB_HEIGHT = 26; // the place tab standing on the card's top edge
const DOCK_AUTO_HEIGHT_RATIO = 0.5; // a long draft stops lifting the dock here and scrolls instead
const LS_DOCK_H = 'cc-gambit-dock-h';
/** The strip a phone keeps clear at the bottom (the iPhone home indicator); 0 where there is none. The
 *  composer sits above it, and everything that makes room for the composer makes room for it too. */
const SAFE_BOTTOM = 'env(safe-area-inset-bottom, 0px)';

/** A phone or tablet: focusing a field there raises the on-screen keyboard. */
const isTouchScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/** 方案 A's place tab on the card's top edge: this computer (本机) or the remote one, and the project. */
function PlaceTab({ device, folder, toolIcon, switchable, onPick }: { device: string | null; folder: string; toolIcon?: React.ReactNode; switchable: boolean; onPick: () => void }) {
  const t = useT();
  const monitor = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{device ? <><rect x="2" y="4" width="13" height="9" rx="2" /><rect x="9" y="11" width="13" height="9" rx="2" /></> : <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>}</svg>;
  const inner = <>
    {monitor}<span className="gambit-place-device">{device ?? t('place.local')}</span>
    {folder && <span className="gambit-place-folder">{toolIcon != null && <span className="gambit-place-tool" aria-hidden="true">{toolIcon}</span>}{folder}</span>}
  </>;
  // A conversation that can work on other computers switches there from the tab.
  return switchable
    ? <button type="button" className="gambit-place" onClick={onPick}>{inner}<svg className="gambit-place-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg></button>
    : <div className="gambit-place">{inner}</div>;
}

function GambitImpl({
  sessionId,
  draft,
  onDraftChange,
  onClose,
  onSend,
  running = false,
  suggestion: offered,
  claude = false,
  codex = false,
  dsh = false,
  opencode = false,
  pi = false,
  attachable = false,
  onCancel,
  sendFailedHint,
  leftPanelHidden,
  rightPanelHidden,
  workspaceName,
  toolIcon,
  tool,
  cwd,
  orchestration,
  computer,
  browser,
  remoteControl,
  placeDevice,
  worktreeControl,
}: GambitProps) {
  const t = useT();
  // Desktop conversations own their composer controls and send prompts verbatim.
  const desktop = claude || codex || dsh || opencode || pi;
  // 纯净: the one-line box for every conversation, and for the new-conversation page before a tool is picked.
  // 方案 A's card: every desktop conversation in both layouts, and Clear's new conversation before a tool is picked.
  const workLayout = useAppState().state.layoutMode === 'work';
  const cardShell = !!desktop || (workLayout && !tool);
  // Every desktop conversation accepts prompts during a running turn.
  const steerable = claude || codex || dsh || opencode || pi;
  const usage = useUsageQuota(sessionId, tool, cwd, claude ? 'claude' : codex ? 'codex' : dsh ? 'dsh' : null);
  // A selected dictation source can fill any tool's composer.
  const voiceTool = claude ? 'claude' : codex ? 'codex' : tool;
  // While listening the live waveform takes the usage meter's place, wherever the meter is.
  const meter = <UsageMeter quotas={usage.quotas} onRefresh={usage.refresh} compact />;
  const usageMeter = <VoiceUsageSlot waveKey={sessionId}>{meter}</VoiceUsageSlot>;
  const suggestion = draft ? undefined : offered;
  // Whether the draft can go out as a prompt link (some text, within the link limit).
  const canShare = canSharePrompt(draftForSend(draft));
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // When the IME composition ended, for the Enter that confirms a candidate (see onKeyDown).
  const compositionEndRef = useRef(0);
  const claudeKeyHandler = useRef<((event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>(undefined);
  const codexSubmitHandler = useRef<((text: string) => boolean) | undefined>(undefined);
  const sendingRef = useRef(false);
  const latestDraftRef = useRef(draft);
  latestDraftRef.current = draft;
  // The scroll container that owns the vertical scrollbar (the textarea itself
  // is overflow:hidden and auto-grows to its full content height). We need a
  // handle to it so the auto-grow effect can preserve / follow its scrollTop.
  const inputRef = useRef<HTMLDivElement>(null);
  // The draft value the auto-grow effect last sized for. Lets it tell a real
  // content edit (typing / paste) from a non-content trigger (window resize)
  // so only the former is allowed to move the scroll position.
  const lastSizedDraftRef = useRef(draft);

  // ─── Prompt history (↑/↓ recall) ──────────────────────────────────
  // Global, localStorage-persisted, shared across every tab's Gambit
  // (see lib/gambit-history.ts). The navigation cursor + the in-progress
  // draft saved on first ↑ are this instance's interaction state — they
  // reset when the user switches tabs (Gambit unmounts), which is fine:
  // nobody is mid-recall across a tab switch.
  const history = useSyncExternalStore(subscribeGambitHistory, getGambitHistorySnapshot);
  // Index into `history` while navigating, or null at the live prompt.
  // When ↓ scrolls PAST the newest entry the cursor returns to null and we
  // restore `savedDraftRef` — the text the user was typing before they
  // pressed ↑ — standard shell/REPL behavior so you never lose a half-typed
  // prompt by peeking at history.
  const historyCursorRef = useRef<number | null>(null);
  const savedDraftRef = useRef('');
  // Mutations to `draft` that come from history navigation itself set this
  // flag so the effect below knows to leave the cursor alone. Every OTHER
  // draft change (typing, paste, file-drop, cut) ends navigation mode by
  // clearing the cursor — a single, mutation-path-agnostic reset point.
  const isNavMutationRef = useRef(false);
  useEffect(() => {
    if (isNavMutationRef.current) { isNavMutationRef.current = false; return; }
    historyCursorRef.current = null;
  }, [draft]);

  // Docked height (px), user-resizable via the top-edge handle. Persists.
  const [dockedH, setDockedH] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(LS_DOCK_H);
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n >= DOCK_MIN_HEIGHT) return n;
    } catch { /* optional preference */ }
    return DOCK_MIN_HEIGHT;
  });
  // Height the draft needs. The dragged height stays the floor, so clearing the draft returns to it.
  const [contentH, setContentH] = useState(0);
  // 纯净: one line that grows with the draft; the dragged height applies to 专业 only.
  const effectiveH = Math.max(cardShell ? (workLayout ? CLEAR_MIN_HEIGHT : CARD_MIN_HEIGHT) : dockedH, contentH);
  // Caches the latest height written to the DOM during a resize drag, so
  // onUp commits it back to React state once without thrashing intermediate
  // renders. Null when no resize is in progress.
  const dockResizeRef = useRef<{ startY: number; origH: number; lastH?: number; handle?: HTMLElement } | null>(null);

  // A phone has no keyboard shortcuts to advertise; it gets the short placeholder.
  const phone = usePhone();

  // Ready to type on open — except on a touch screen, where focusing the draft raises the on-screen
  // keyboard over the conversation before anyone asked to type.
  useEffect(() => {
    if (!isTouchScreen()) textareaRef.current?.focus();
  }, []);

  // A mouse click on a footer control or its menu leaves the caret in the draft, so Enter still sends instead of
  // pressing that control again. Only the mouse: tabbing to a control still focuses it, and a finger only picks
  // an option — it keeps whatever focus there was, so the on-screen keyboard neither appears nor closes.
  useEffect(() => {
    let finger = false;
    const pointer = (e: PointerEvent) => { finger = e.pointerType !== 'mouse'; };
    const keepCaret = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('button')?.closest('.gambit-footer, .claude-control-menu')) return;
      e.preventDefault();
      if (!finger && !document.querySelector('.claude-control-menu')) textareaRef.current?.focus();
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('mousedown', keepCaret, true);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('mousedown', keepCaret, true); };
  }, []);

  // Floating scrollbar for the input box. A long draft's scroll owner is
  // .gambit-input (the textarea auto-grows and stays overflow:hidden), and
  // native scrollbars are hidden globally (global.css) — WebView2 can't drop
  // its up/down arrow buttons via CSS (same fix as the note panel). Bind the
  // same floating DOM slider here so the overflow scrolls with a visible,
  // auto-fading, draggable accent bar and no arrows. slim matches the note
  // body's slider; no inset needed — the input box already sits between the
  // top resize strip and the footer, so its rect excludes both.
  useEffect(() => {
    const scroller = inputRef.current;
    if (!scroller) return;
    return bindAutoHideScrollbar(scroller, { slim: true });
  }, []);

  // ─── Docked layout side effect ───────────────────────────────
  // Set a body class + CSS var so .panel-center reserves padding-bottom
  // equal to the dock height. The xterm container's ResizeObserver picks
  // up the shrink and refits. Cleared on unmount.
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    body.classList.add('gambit-docked');
    // The card's place tab stands above it, so the conversation keeps clear of the tab too.
    root.style.setProperty('--gambit-dock-h', `calc(${effectiveH + (cardShell && !workLayout ? PLACE_TAB_HEIGHT : 0)}px + ${SAFE_BOTTOM})`);
    return () => {
      body.classList.remove('gambit-docked');
      root.style.removeProperty('--gambit-dock-h');
    };
  }, [effectiveH, cardShell, workLayout]);

  // Persist dock height. Cheap to write — runs only on settle.
  useEffect(() => {
    try { localStorage.setItem(LS_DOCK_H, String(dockedH)); } catch { /* optional preference */ }
  }, [dockedH]);

  // Top-edge vertical drag to resize dock height (constrained to the Y axis).
  const onDockResizeStart = (e: React.MouseEvent) => {
    const handle = e.currentTarget as HTMLElement;
    // Toggle a `resizing` class directly on the DOM node (NOT React state):
    // the drag writes `el.style.height` live on every mousemove, and a React
    // re-render would reset it from the stale `dockedH` prop mid-drag. The
    // class only drives the grip bar's grow/deepen animation.
    handle.classList.add('resizing');
    dockResizeRef.current = {
      startY: e.clientY,
      origH: effectiveH,
      handle,
    };
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dockResizeRef.current) return;
      const r = dockResizeRef.current;
      // Drag UP increases height (dock grows upward), drag DOWN shrinks.
      const dy = r.startY - e.clientY;
      const maxH = Math.floor(window.innerHeight * DOCK_MAX_HEIGHT_RATIO);
      const next = Math.max(DOCK_MIN_HEIGHT, Math.min(r.origH + dy, maxH));
      r.lastH = next;
      const el = rootRef.current;
      if (el) el.style.height = `${next}px`;
      // Update CSS var live so xterm refits during drag, not just on release.
      document.documentElement.style.setProperty('--gambit-dock-h', `calc(${next}px + ${SAFE_BOTTOM})`);
    };
    const onUp = () => {
      if (dockResizeRef.current?.lastH !== undefined) {
        setDockedH(dockResizeRef.current.lastH);
      }
      dockResizeRef.current?.handle?.classList.remove('resizing');
      dockResizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Thumbnails are a pure derived view of the draft text — no separate
  // attachment state. User edits/deletes the path string → thumbnails
  // update automatically. Paths remain the only source of truth; they
  // travel with the text through copy/paste/send.
  const attachments = useMemo(() => Array.from(new Map(gambitAttachments(draft).map(item => [item.path, item])).values()), [draft]);
  // The box shows only the words: attached files sit after an invisible mark at the end of the draft and show as
  // the thumbnails above (lib/gambit-attachments.ts). Edits in the box keep them; sending puts them back as text.
  const { text: shown } = useMemo(() => splitDraft(draft), [draft]);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const setShown = useCallback((text: string) => onDraftChange(joinDraft(text, splitDraft(latestDraftRef.current).tokens)), [onDraftChange]);
  const pastedImagePaths = useMemo(() => attachments.filter(item => item.image).map(item => item.path), [attachments]);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  // Use a stable key so the effect only re-fires when the set of paths
  // actually changes, not on every keystroke that leaves paths intact.
  const pastedImagePathsKey = pastedImagePaths.join('\n');
  useEffect(() => {
    if (pastedImagePaths.length === 0) {
      setThumbUrls({});
      return;
    }
    let cancelled = false;
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const p of pastedImagePaths) next[p] = convertFileSrc(p);
      setThumbUrls(next);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedImagePathsKey]);

  // ── File-drop target ────────────────────────────────────────────────────
  // OS file drops over the Gambit window insert the absolute path(s) at the
  // textarea cursor — same model as image-paste (see header comment): paths
  // are the only source of truth, thumbnails derive from IMAGE_PATH_RE.
  // Priority outranks the terminal so a drop over a Gambit overlapping it
  // routes here, not into the xterm behind.
  const draftRef = useRef(draft);
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { onDraftChangeRef.current = onDraftChange; }, [onDraftChange]);
  const insertPaths = useCallback((paths: string[]) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart, end = textarea?.selectionEnd;
    onDraftChangeRef.current(attachToDraft(draftRef.current, paths));
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      if (start != null && end != null) textarea.setSelectionRange(start, end);
    });
  }, []);
  useEffect(() => registerFileDropTarget({ priority: 200, rect: () => rootRef.current?.getBoundingClientRect() ?? null, insert: insertPaths }), [insertPaths]);
  // Picked files insert exactly like dropped ones: at the caret, quoted only when needed.
  const attachFiles = async () => {
    const picked = await pickFiles();
    if (picked) insertPaths(picked);
  };

  // Click a thumbnail → open a full-size preview overlay AND select the
  // matching path text in the textarea (so once the overlay closes, the
  // caret is conveniently placed at the path for easy Backspace-delete).
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const removeAttachment = (path: string) => {
    onDraftChange(detachFromDraft(latestDraftRef.current, path));
    if (previewPath === path) setPreviewPath(null);
    if (!isTouchScreen()) requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const openThumbPreview = (path: string) => {
    setPreviewPath(path);
    const textarea = textareaRef.current;
    if (!textarea) return;
    const idx = shown.indexOf(path);
    if (idx < 0) return;
    textarea.setSelectionRange(idx, idx + path.length);
  };
  // ESC or click-outside dismisses the overlay.
  useEffect(() => {
    if (!previewPath) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewPath(null); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [previewPath]);

  // sendFailed briefly flashes a subtle hint next to the Send button so
  // the user understands WHY nothing happened (most common cause in
  // multi-agent mode: no pane has been focused yet — a single click on
  // the intended pane fixes it). Auto-clears after 2.5s so it doesn't
  // linger once the user acts.
  const [sendFailed, setSendFailed] = useState(false);
  const [sendEmpty, setSendEmpty] = useState(false);
  useEffect(() => {
    if (!sendFailed) return;
    const t = setTimeout(() => setSendFailed(false), 2500);
    return () => clearTimeout(t);
  }, [sendFailed]);
  useEffect(() => {
    if (!sendEmpty) return;
    const t = setTimeout(() => setSendEmpty(false), 2500);
    return () => clearTimeout(t);
  }, [sendEmpty]);

  const { state: appState, dispatch: appDispatch } = useAppState();
  const compactLayout = useCompact();
  // The card's control row: when it cannot hold every control, the less used ones step behind 「⋯」.
  const footerRef = useRef<HTMLDivElement>(null);
  const [footerTight, setFooterTight] = useState(false);
  const [footerOpen, setFooterOpen] = useState(false);
  useEffect(() => { setFooterOpen(false); }, [sessionId]);
  useLayoutEffect(() => {
    const row = footerRef.current;
    if (!row || !cardShell) { setFooterTight(false); return; }
    const measure = () => {
      // Lay the row out on one line with everything shown, then put it back as it was.
      const open = row.classList.contains('is-open');
      row.classList.remove('is-tight', 'is-open');
      row.classList.add('is-measuring');
      const over = row.scrollWidth > row.clientWidth + 1;
      row.classList.remove('is-measuring');
      row.classList.toggle('is-tight', over);
      row.classList.toggle('is-open', open && over);
      setFooterTight(over);
      if (!over) setFooterOpen(false);
    };
    measure();
    // The row's width changes with the window; its contents change as the session loads (model names, chips).
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    const mutations = new MutationObserver(measure);
    mutations.observe(row, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [cardShell, sessionId]);

  // Switching Clear / Code changes the box around the draft: forget the height measured for the old one,
  // then measure again once the new layout has rendered (or the old height lingers in the new layout).
  const [remeasure, setRemeasure] = useState(0);
  const layoutKey = `${workLayout}:${cardShell}`;
  const lastLayoutKey = useRef(layoutKey);
  useLayoutEffect(() => {
    if (lastLayoutKey.current === layoutKey) return;
    lastLayoutKey.current = layoutKey;
    setContentH(0);
    setRemeasure(n => n + 1);
  }, [layoutKey]);

  // The attachment row settles its height only once its thumbnails load, after the box was sized for the draft:
  // measure again whenever it changes size, or the row squeezes the input below it (Clean's one-line box).
  const attachmentsRef = useRef<HTMLDivElement | null>(null);
  const hasAttachments = attachments.length > 0;
  useEffect(() => {
    const row = attachmentsRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    let last = row.offsetHeight;
    const observer = new ResizeObserver(() => { if (row.offsetHeight !== last) { last = row.offsetHeight; setRemeasure(n => n + 1); } });
    observer.observe(row);
    return () => observer.disconnect();
  }, [hasAttachments]);

  // Auto-grow the textarea to fit its content as the user types.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const scroller = inputRef.current;
    // Did this run come from an actual content edit (typing / paste), or from
    // a window resize? Only a content edit may move the scroll position; a
    // resize must hold the view exactly where the user left it (even if the
    // caret happens to be parked at the very end).
    const contentChanged = lastSizedDraftRef.current !== draft;
    lastSizedDraftRef.current = draft;
    const prevScrollTop = scroller?.scrollTop ?? 0;
    // Auto-grow: collapse to remeasure, then fit the box to its content.
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    if (!scroller) return;
    const dock = rootRef.current;
    if (dock) setContentH(Math.min(dock.offsetHeight - scroller.clientHeight + ta.scrollHeight, Math.floor(window.innerHeight * DOCK_AUTO_HEIGHT_RATIO)));
    // Remeasuring via height:'auto' momentarily collapses the (rows=1) textarea
    // for the synchronous reflow that reading scrollHeight forces; while
    // collapsed the scroll container has almost no content, so the browser
    // clamps its scrollTop to 0 and the clamp sticks once the real height is
    // restored. Re-applying the captured scrollTop undoes that — it's the cure
    // for the "every keystroke jumps the view back to the top" bug. When the
    // user is actively typing at
    // the very end of the draft, follow the caret to the bottom instead so the
    // newest line stays visible.
    //   Known gap: an edit that pushes a MID-text caret below the fold is not
    //   chased (we just hold position) - doing so would need caret-pixel
    //   measurement, which is out of scope here. Still strictly better than
    //   the old jump-to-top, so accepted.
    const followCaretToBottom =
      contentChanged &&
      document.activeElement === ta &&
      ta.selectionStart === ta.value.length &&
      ta.selectionEnd === ta.value.length;
    scroller.scrollTop = followCaretToBottom ? scroller.scrollHeight : prevScrollTop;
  }, [draft, remeasure]);


  // ─── Context menu ─────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const ctxMod = isMac ? '⌘' : 'Ctrl';
  // Send/newline key labels for the placeholder hint — track the user's
  // configured send mode (settings → 妙手) so the hint never lies.
  const sendCombo = appState.gambitEnterToSend ? 'Enter' : `${ctxMod}+Enter`;
  const newlineCombo = appState.gambitEnterToSend ? 'Shift+Enter' : 'Enter';

  // Windows-style dismiss: ANY interaction outside the menu closes it.
  //   - mousedown anywhere outside  → close (click inside runs the button's onClick)
  //   - Escape key                  → close
  //   - wheel scroll                → close (native OS behavior)
  //   - window blur / resize        → close
  //
  // All listeners are registered in CAPTURE phase so we still fire even
  // though the Gambit root has onMouseDown={e=>e.stopPropagation()} up the
  // React tree (it's synthetic-only, but capture-phase native listeners
  // are immune to any propagation shenanigans either way).
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onDocMouseDown = (e: MouseEvent) => {
      // Click inside the menu → let the button's onClick handler run and
      // close the menu itself. Only dismiss for clicks OUTSIDE.
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onWheel = () => close();
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [ctxMenu]);

  // Bound to the whole .gambit-input box, not just the textarea. Docked
  // Gambit stretches the box (flex:1) while the textarea is only as tall as
  // its content, so right-clicking the empty area below line 1 used to land
  // on the container — no handler, no menu, just the root's preventDefault.
  // Left-click already routed anywhere-in-the-box to the textarea (see the
  // container's onMouseDown); right-click now matches.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ta = textareaRef.current;
    const hasSelection = !!ta && (ta.selectionStart ?? 0) !== (ta.selectionEnd ?? 0);
    setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection });
  };

  const ctxCopy = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = shown.slice(start, end);
    if (selected) clipboardWrite(selected);
    setCtxMenu(null);
  };

  const ctxCut = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = shown.slice(start, end);
    if (selected) {
      clipboardWrite(selected);
      setShown(shown.slice(0, start) + shown.slice(end));
      requestAnimationFrame(() => {
        textarea.selectionStart = start;
        textarea.selectionEnd = start;
      });
    }
    setCtxMenu(null);
  };

  const ctxPaste = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    setCtxMenu(null);
    clipboardRead().then((text) => {
      if (!text) return;
      const current = shownRef.current;
      const start = textarea.selectionStart ?? current.length;
      const end = textarea.selectionEnd ?? current.length;
      setShown(current.slice(0, start) + text + current.slice(end));
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = start + text.length;
        textarea.selectionEnd = start + text.length;
      });
    });
  };

  const ctxSelectAll = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    textarea.focus();
    textarea.select();
    setCtxMenu(null);
  };

  // ─── History navigation ──────────────────────────────────────────
  // Walk the global prompt history (lib/gambit-history.ts) with ↑/↓.
  //   • First ↑ from the live prompt: save the in-progress draft and jump
  //     to the newest entry. Subsequent ↑ moves toward older entries.
  //   • ↓ moves toward newer entries; scrolling past the newest restores
  //     the saved in-progress draft (so peeking at history never costs
  //     you the half-typed prompt you were working on).
  //   • ↑ at the oldest / ↓ at the newest is a no-op (cursor clamps).
  // Returns false for no-ops so onKeyDown can leave native caret movement
  // untouched when there's nothing to recall.
  const navigateHistory = useCallback((direction: -1 | 1): boolean => {
    const hist = history;
    const cur = historyCursorRef.current;
    let next: number | null;
    let text: string;
    if (cur === null) {
      // Entering history mode from the live prompt.
      if (direction === 1) return false;     // already at newest — ↓ no-op
      if (hist.length === 0) return false;    // nothing to recall
      next = hist.length - 1;                 // newest entry
      savedDraftRef.current = draft;          // stash what the user was typing
      text = hist[next];
    } else {
      const cand = cur + direction;
      if (cand < 0) return false;             // already at oldest — ↑ clamps
      if (cand >= hist.length) {              // scrolled past newest
        next = null;
        text = savedDraftRef.current;         // restore the in-progress draft
      } else {
        next = cand;
        text = hist[cand];
      }
    }
    historyCursorRef.current = next;
    // Flag this onDraftChange as navigation-driven so the [draft] effect
    // doesn't immediately exit history mode (which would reset the cursor
    // we just set).
    isNavMutationRef.current = true;
    onDraftChange(text);
    // Park the caret at the end of the recalled text so typing continues
    // from the tail — matches shell recall UX. Runs after React commits
    // the controlled value (same rAF pattern as ctxPaste).
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = text.length;
      ta.selectionEnd = text.length;
    });
    return true;
  }, [history, draft, onDraftChange]);

  const handleSend = useCallback(async () => {
    if (running && !steerable) return;
    // A worktree on its way would move the conversation; the message waits in the box until it is ready.
    if (isWorktreePending(sessionId)) return;
    // CRITICAL: the draft text is the ONLY thing that gets sent.
    // Thumbnails rendered from pastedImagePaths are a pure derived view
    // with zero data-side responsibility. DO NOT re-append paths or
    // attach image bytes here — the path already sits inside `draft` and
    // would be sent twice, making the AI see the same image reference
    // duplicated in its prompt.
    const text = draftForSend(draft).trim();
    if (!text) {
      setSendEmpty(true);
      return;
    }
    if ((codex || dsh || opencode || pi) && codexSubmitHandler.current?.(text)) return;
    const body = desktop ? text : wrapImagePathsForSend(text);
    if (sendingRef.current) return;
    sendingRef.current = true;
    let ok = false;
    try { ok = await onSend(body); } finally { sendingRef.current = false; }
    if (!ok) {
      // Preserve draft so the user does not lose what they typed. They
      // likely just need to click the target pane first, then Send again.
      setSendFailed(true);
      return;
    }
    // Record the user prompt so recall shows what they actually typed.
    pushGambitHistory(text);
    // Sent -> leave history navigation mode so the next recall starts from
    // the newest entry (which is the one we just pushed).
    historyCursorRef.current = null;
    if (latestDraftRef.current === draft) onDraftChange('');
  }, [draft, onSend, onDraftChange, running, steerable, codex, dsh, opencode, pi, desktop, sessionId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition in progress — let the IME keep Enter for confirming
    // candidates. nativeEvent.isComposing is the canonical flag.
    if (e.nativeEvent.isComposing) return;
    // macOS WebKit ends the composition before the confirming Enter's keydown, so isComposing is already false there.
    // That keydown still carries keyCode 229, and it lands right after compositionend.
    if (e.key === 'Enter' && (e.nativeEvent.keyCode === 229 || performance.now() - compositionEndRef.current < 50)) return;
    if (desktop && claudeKeyHandler.current?.(e)) return;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && suggestion) {
      e.preventDefault();
      onDraftChange(suggestion);
      return;
    }
    // History recall is gated behind Alt+↑/↓. Bare ↑/↓ stays native caret
    // movement — users complained that hijacking them stole vertical caret
    // positioning inside a multi-line draft. Alt+arrow has no native
    // behavior in a textarea, so it's a conflict-free dedicated gesture
    // (Shift+arrow is off-limits — that's the browser's vertical text
    // selection). The placeholder advertises "Alt+↑↓ 翻历史".
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      if (navigateHistory(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
      return;
    }
    // Send key is user-configurable (settings modal → Keyboard), because the
    // muscle-memory split (chat-app Enter-to-send vs editor Ctrl+Enter) differs
    // per person and per OS.
    //   • enterToSend (default): plain Enter sends; Shift/Ctrl/Cmd+Enter = newline.
    //   • else:                  Ctrl/Cmd+Enter sends; plain Enter = newline.
    if (e.key === 'Enter') {
      const hasMod = e.ctrlKey || e.metaKey;
      if (appState.gambitEnterToSend) {
        if (e.shiftKey || hasMod) return; // newline
        e.preventDefault();
        handleSend();
      } else if (hasMod) {
        e.preventDefault();
        handleSend();
      }
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Collect all image files first (rare — clipboard normally has ≤1 image).
    // Validate BEFORE preventing default: if getAsFile() returns null
    // (some Windows clipboard sources do this), we must NOT block the
    // native paste or the user loses their clipboard content.
    const imageFiles: { file: File; ext: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      imageFiles.push({ file, ext: (item.type.split('/')[1] || 'png').toLowerCase() });
    }
    if (imageFiles.length === 0) return;

    e.preventDefault();

    const paths: string[] = [];
    for (const { file, ext } of imageFiles) {
      try {
        const base64 = await fileToBase64(file);
        paths.push(await commands.saveClipboardImage(base64, ext));
      } catch (err) {
        console.error('[Gambit] save image failed', err);
      }
    }
    if (paths.length === 0) return;

    // Attached, not typed: the image shows as a thumbnail and its path goes out after the words.
    insertPaths(paths);
  };

  // Suppress onClose usage warning — true close is driven by parent (Explorer
  // toggle). The component still accepts onClose in props for API symmetry
  // and future use but doesn't expose it in the UI.
  void onClose;

  // Docked panel: anchored at the bottom of the center panel with 8px of
  // breathing room on left/right/bottom — sits between, never under, the
  // Explorer / right pane. Native chrome (rounded corners, soft glow,
  // backdrop-filter) is preserved.
  const workShell = appState.layoutMode === 'work' && !compactLayout;
  const dockStyle: React.CSSProperties = {
    transform: 'none',
    // Clear: inside the content panel (rail 48px, panel inset 6px on the right), 16px from either panel edge.
    left: workShell ? 64 : leftPanelHidden ? 8 : 'calc(var(--w-left) + 8px)',
    right: workShell ? 22 : rightPanelHidden ? 8 : 'calc(var(--w-right) + 8px)',
    bottom: workShell ? `calc(20px + ${SAFE_BOTTOM})` : `calc(8px + ${SAFE_BOTTOM})`,
    top: 'auto',
    width: 'auto',
    height: effectiveH,
  };

  // 方案 A: a flat card — the draft on top, one quiet row of controls under it — with a tab on its top edge
  // saying where the conversation works. `minimal` is Clear's version (no pre-input actions on the edge).
  const card = cardShell;
  const minimal = card && workLayout;

  const capabilitiesStatus = (orchestration || computer || browser || remoteControl) && <div className="gambit-capabilities" role="status">
    {orchestration && <OrchestrationPicker sessionId={sessionId} />}
    {remoteControl}
    {computer && <span className="gambit-capability is-computer">{t('control.computer_label')}</span>}
    {browser && <span className="gambit-capability is-browser">{t('control.browser_label')}</span>}
  </div>;

  return (
    <div
      ref={rootRef}
      className={`gambit gambit--docked${card ? ' gambit--card' : ''}${minimal ? ' gambit--minimal' : ''}`}
      style={dockStyle}
      onMouseDown={(e) => e.stopPropagation() /* don't let global focus enforcer steal focus back to xterm */}
      // Block native WebView context menu across the whole Gambit panel.
      // The textarea's onContextMenu opens our custom cut/copy/paste menu;
      // other areas (dock-resize strip, padding) just get no menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Top-edge handle for vertical height resize (VS Code bottom-panel style). */}
      <div className="gambit-dock-resize" onMouseDown={onDockResizeStart} />

      {/* Save the draft for later: it goes to the right panel's pre-input tab, which opens to show it. */}
      {appState.preInputButton && !minimal && <DraftActions
        enabled={!!draftForSend(draft).trim()} canShare={canShare}
        label={t('gambit.save_pre_input')} shareLabel={t('prompt_link.copy')} clearLabel={t('gambit.clear_draft')}
        tips={{ save: t('pre_input.tip_save'), share: t('pre_input.tip_share_draft'), clear: t('pre_input.tip_clear') }}
        onSave={() => { appDispatch({ type: 'SAVE_PRE_INPUT', text: draftForSend(draft).trim() }); onDraftChange(''); }}
        onShare={() => { void sharePrompt(draftForSend(draft), t('prompt_link.copied')); }}
        onClear={() => onDraftChange('')} />}

      {attachments.length > 0 && <div className="gambit-attachments" ref={attachmentsRef}>
        {attachments.map(({ path, image }) => <div className="gambit-attachment" key={path}>
          <button className="gambit-attachment-content" aria-label={t(image ? 'gambit.preview_attachment' : 'gambit.attachment', { path })} onClick={() => { if (image) openThumbPreview(path); }}>
            {image && thumbUrls[path] ? <img src={thumbUrls[path]} alt="" draggable={false} onError={e => { e.currentTarget.style.display = 'none'; }} /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M14 2H6v20h12V6zM14 2v5h5M8 12h8M8 16h8" /></svg>}
            <span>{path.split(/[\\/]/).pop()}</span>
          </button>
          <button className="gambit-attachment-remove close-button" aria-label={t('gambit.remove_attachment', { path })} onClick={() => removeAttachment(path)}><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m3 3 6 6m0-6-6 6" /></svg></button>
        </div>)}
      </div>}

      {card && !minimal && <PlaceTab device={placeDevice ?? null} folder={workspaceName} toolIcon={toolIcon} switchable={!!remoteControl} onPick={() => rootRef.current?.querySelector<HTMLButtonElement>('.gambit-capability.is-remote')?.click()} />}

      {/* Input box: the textarea auto-grows to fit its content. */}
      <div
        className="gambit-input"
        ref={inputRef}
        onContextMenu={onContextMenu}
        onMouseDown={(e) => {
          // Click anywhere in the box (padding) -> focus the textarea.
          // preventDefault stops focus from landing on a non-input element,
          // which would let the global focus enforcer (CenterPanel) yank it
          // back to the active terminal.
          const tgt = e.target as HTMLElement;
          if (tgt !== textareaRef.current) {
            e.preventDefault();
            textareaRef.current?.focus();
          }
        }}
      >
        <textarea
          ref={textareaRef}
          className="gambit-textarea"
          value={shown}
          placeholder={suggestion ? undefined : phone || card ? t('gambit.placeholder_short') : t('gambit.placeholder', { send: sendCombo, newline: newlineCombo })}
          onChange={(e) => setShown(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionEnd={() => { compositionEndRef.current = performance.now(); }}
          onPaste={onPaste}
          spellCheck={false}
          rows={1}
          aria-description={suggestion}
        />
        {/* Not the placeholder: that cannot end in an ellipsis, and a long guess would be silently cut. */}
        {suggestion && <div className="gambit-suggestion" aria-hidden="true">{suggestion}</div>}
      </div>

      <div className={`gambit-footer${desktop ? ' gambit-footer--claude' : ''}${!desktop && attachable ? ' gambit-footer--attach' : ''}${capabilitiesStatus ? ' gambit-footer--capabilities' : ''}${card ? ' gambit-footer--card' : ''}${card && footerTight ? ' is-tight' : ''}${card && footerOpen ? ' is-open' : ''}`} ref={footerRef}>

        {/* Target label — leftmost footer item, symmetric to the send button.
            Shows the active tab's folder or remote host so a prompt can't be
            sent to the wrong target; updates as tabs switch.
            Deliberately no hover tooltip — the visible name is the info.
            No folder icon: every directory would get the same glyph, so it's
            pure noise (and read as a different brightness than the text). */}
        {/* 纯净: the box's own ＋; it presses the controls' attach button, so attaching works the same. */}
        {card && (desktop || attachable) && <button type="button" className="gambit-pill-attach" aria-label={t('claude.attach')} onClick={() => { if (desktop) rootRef.current?.querySelector<HTMLButtonElement>('.claude-composer-controls > .claude-control-icon')?.click(); else void attachFiles(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>}
        {/* 纯净: the controls become one quiet line under the box; the wrapper is inert in 专业. */}
        <span className={card ? 'gambit-meta' : 'gambit-meta-off'}>
        {workspaceName && (
          <span className="gambit-workspace">
            {toolIcon != null && <span className="gambit-workspace-icon">{toolIcon}</span>}
            <span className="gambit-workspace-name">{workspaceName}</span>
          </span>
        )}
        {worktreeControl}
        {!desktop && card && capabilitiesStatus}
        {!desktop && card && usageMeter}
        {claude && <ClaudeComposerControls sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} quota={usageMeter}>{capabilitiesStatus}</ClaudeComposerControls>}
        {codex && <CodexComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</CodexComposerControls>}

        {opencode && <OpenCodeComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</OpenCodeComposerControls>}
        {pi && <PiComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</PiComposerControls>}
        {dsh && <DshComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</DshComposerControls>}
        </span>
        {!desktop && attachable && !card && <button type="button" className="gambit-attach" aria-label={t('claude.attach')} onClick={() => { void attachFiles(); }}><AttachIcon /></button>}
        {!desktop && !card && capabilitiesStatus}
        {!desktop && !card && usageMeter}

        {sendFailed && (
          <span className="gambit-send-hint" role="status">
            {sendFailedHint ?? t('gambit.send_failed_hint')}
          </span>
        )}
        {sendEmpty && (
          <span className="gambit-send-hint gambit-send-hint--empty" role="status">
            {t('gambit.send_empty_hint')}
          </span>
        )}



        {/* Controls that do not fit the row wait behind 「⋯」, which opens the row onto a second line (never cut short). */}
        {card && footerTight && <button type="button" className="gambit-more" aria-label={t('gambit.more')} aria-expanded={footerOpen} onClick={() => setFooterOpen(open => !open)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
        </button>}

        <VoiceInputButton key={`${sessionId}:${voiceTool}`} tool={voiceTool ?? ''} cwd={cwd} waveKey={sessionId} draft={draft} onDraftChange={onDraftChange} />

        <button
          className={`gambit-send${sendFailed ? ' gambit-send--failed' : ''}${!running && !draft.trim() ? ' gambit-send--empty' : ''}`}
          aria-label={t(running && (!steerable || !draft.trim()) ? 'gambit.stop' : 'gambit.send')}
          disabled={running && !onCancel}
          onClick={running && (!steerable || !draft.trim()) ? onCancel : handleSend}
        >
          {running && (!steerable || !draft.trim()) ? <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg> : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 14 V3 M3 8 L8 3 L13 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>}
        </button>
      </div>

      {/* Full-size preview overlay. Renders into document.body to escape
          .gambit's transform containing block (otherwise position:fixed
          anchors to the transformed ancestor and clips to overflow:hidden). */}
      {previewPath && thumbUrls[previewPath] && createPortal(
        <div
          className="gambit-preview-overlay"
          onClick={() => setPreviewPath(null)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img
            src={thumbUrls[previewPath]}
            alt=""
            draggable={false}
            onClick={(e) => e.stopPropagation() /* clicking the image itself should NOT close — only blank space does */}
          />
        </div>,
        document.body,
      )}

      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          className="term-ctx-menu"
          style={{
            // Clamp so the menu never overflows off-screen; flips upward when
            // the trigger sits near the bottom edge (matches terminal & Explorer
            // behavior). Width ~164, height ~152 (4 items + separator + padding).
            left: Math.min(ctxMenu.x, window.innerWidth  - 168),
            top:  Math.min(ctxMenu.y, window.innerHeight - 156),
          }}
        >
          <button
            className={`term-ctx-item${ctxMenu.hasSelection ? '' : ' disabled'}`}
            onMouseDown={(e) => { e.preventDefault(); if (ctxMenu.hasSelection) ctxCut(); }}
          >
            <span>{t('menu.cut')}</span><kbd>{ctxMod}+X</kbd>
          </button>
          <button
            className={`term-ctx-item${ctxMenu.hasSelection ? '' : ' disabled'}`}
            onMouseDown={(e) => { e.preventDefault(); if (ctxMenu.hasSelection) ctxCopy(); }}
          >
            <span>{t('menu.copy')}</span><kbd>{ctxMod}+C</kbd>
          </button>
          <button
            className="term-ctx-item"
            onMouseDown={(e) => { e.preventDefault(); ctxPaste(); }}
          >
            <span>{t('menu.paste')}</span><kbd>{ctxMod}+V</kbd>
          </button>
          <div className="term-ctx-sep" />
          <button
            className="term-ctx-item"
            onMouseDown={(e) => { e.preventDefault(); ctxSelectAll(); }}
          >
            <span>{t('menu.select_all')}</span><kbd>{ctxMod}+A</kbd>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// React.memo is CRITICAL here — TierTerminal (our parent) is intentionally
// not memoized (an earlier regression), so it re-renders on every app-wide
// state change, including terminal focus shifts. Without
// this memo wrapper, every parent re-render during a dock-resize drag would
// reset the inline height from React, clobbering the direct DOM writes we
// use for smooth resizing and making the panel visibly snap back.
export const Gambit = memo(GambitImpl);


