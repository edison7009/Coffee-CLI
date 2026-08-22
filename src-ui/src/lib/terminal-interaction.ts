import { useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { AgentStatus, ToolType } from '../store/app-state';
import { supportsEnhancedTool } from './chat-tools';

// ─────────────────────────────────────────────────────────────────────────────
// Detection of live agent interactions from xterm's already-rendered cells.
// Every tool family below is grounded in its checked-in reference TUI source;
// shared visual similarities never imply a shared input protocol.
//
// This module never guesses from "there are numbered lines + Enter wording".
// It keys off the exact screen structure that Claude's own Ink/Preact TUI
// paints, verified against the installed `claude` binary (v2.1.220, build
// 2026-07-24, GIT_SHA 4073f595):
//
//   • Menu rows render as a consecutive 1..N block. Claude versions/themes
//     have used both `[pointer] [N.]` and `[pointer][N.]`; the focused row's
//     pointer is `❯` (or `›`, `→`, `>` in other renderers/themes).
//     Permission options use layout "compact" (+inline descriptions),
//     AskUserQuestion options use "compact-vertical"; both share this shape.
//
//   • AskUserQuestion (Mdi) always appends a free-text "Other" option whose
//     visible row is `<N>. Type something.` (input placeholder from PRe;
//     value "__other__"). Single-select questions render it through Wr,
//     multi-select through Y4 which additionally paints a "Submit"/"Next"
//     button row.
//
//   • The dialogs paint a footer key-guide (Qt/Ue): `Enter to select`,
//     `↑/↓ to navigate`, `Esc to cancel`, and permission dialogs (Ed) print
//     a prompt line such as "Do you want to proceed?" and a bold title (GAe).
//
//   • The live state machine maps digit keys 1-9 to the corresponding option.
//     For the "Other" input option the digit enters its inline text input
//     instead of submitting. Coffee replays the established numeric shortcut.
//
// The parser requires (1) a consecutive 1..N block of ≥2 option rows,
// (2) exactly one row carrying the ❯ cursor, and (3) at least one structural
// anchor (Other row / key-guide / permission prompt / "press 1-N or type your
// answer" hint). Ordinary numbered prose and multi-line typed input lack the
// ❯-on-a-menu-row + anchor combination and are rejected.
// ─────────────────────────────────────────────────────────────────────────────

export type TerminalInteractionKind = 'permission' | 'question';
export type TerminalInteractionResponseMode = 'digit' | 'vertical' | 'direct-text';

export interface TerminalInteractionOption {
  /** Zero-based visual position in the upstream menu. */
  position: number;
  /** Number Coffee displays. It is sent upstream only in a digit mode. */
  number: number;
  label: string;
  /** Selecting this option opens (or already represents) a text input. */
  acceptsText: boolean;
  /** The upstream TUI's cursor/focus styling is on this row. */
  focused: boolean;
}

export interface TerminalInteraction {
  fingerprint: string;
  kind: TerminalInteractionKind;
  title: string;
  options: TerminalInteractionOption[];
  /** Zero-based position of the focused option, -1 if none observed. */
  focusedPosition: number;
  /** Keystroke protocol implemented by the upstream TUI. Coffee never
   * assumes that a visually numbered row accepts that number as input. */
  responseMode: TerminalInteractionResponseMode;
}

/** A rendered line with its cell attributes, as read from the xterm buffer. */
export interface ScreenLine {
  text: string;
  /** True when any cell in the line carries the bold (SGR 1) attribute. */
  bold: boolean;
}

type Listener = () => void;

const snapshots = new Map<string, TerminalInteraction>();
const listeners = new Map<string, Set<Listener>>();

function emit(sessionId: string): void {
  listeners.get(sessionId)?.forEach(listener => listener());
}

export function setTerminalInteraction(
  sessionId: string,
  interaction: TerminalInteraction | null,
): void {
  const previous = snapshots.get(sessionId);
  if (!interaction) {
    if (!previous) return;
    snapshots.delete(sessionId);
    emit(sessionId);
    return;
  }
  if (
    previous?.fingerprint === interaction.fingerprint
    && previous.focusedPosition === interaction.focusedPosition
  ) return;
  snapshots.set(sessionId, interaction);
  emit(sessionId);
}

export function clearTerminalInteraction(sessionId: string): void {
  setTerminalInteraction(sessionId, null);
}

export function hasTerminalInteraction(sessionId: string): boolean {
  return snapshots.has(sessionId);
}

export function getTerminalInteraction(sessionId: string): TerminalInteraction | null {
  return snapshots.get(sessionId) ?? null;
}

export function subscribeTerminalInteraction(sessionId: string, listener: Listener): () => void {
  let sessionListeners = listeners.get(sessionId);
  if (!sessionListeners) {
    sessionListeners = new Set();
    listeners.set(sessionId, sessionListeners);
  }
  sessionListeners.add(listener);
  return () => {
    const current = listeners.get(sessionId);
    current?.delete(listener);
    if (current?.size === 0) listeners.delete(sessionId);
  };
}

export function useTerminalInteraction(sessionId: string): TerminalInteraction | null {
  return useSyncExternalStore(
    listener => subscribeTerminalInteraction(sessionId, listener),
    () => getTerminalInteraction(sessionId),
    () => null,
  );
}

export function supportsTerminalInteraction(tool: ToolType): boolean {
  return supportsEnhancedTool(tool);
}

// ── Screen-structure constants (verified against the installed bundle) ──────

/** Focus cursors observed across Claude's terminal renderers/themes. */
const FOCUSED_POINTER_GLYPHS = new Set(['❯', '›', '→', '>']);

/** Menu option row. Spacing is deliberately flexible because real Claude
 *  builds have emitted both `❯ 1. Yes` and `❯1. Yes`. Semantic safety comes
 *  from the unique live pointer + consecutive block + dialog footer, not from
 *  a version-specific column offset. */
const OPTION_ROW_RE = /^[ \t]*([❯›→>]?)[ \t]*(\d{1,2})[.)][ \t]?(.*)$/u;

/** AskUserQuestion's free-text "Other" option — its visible placeholder is
 *  "Type something." (single) / "Type something" (multi), hardcoded in Mdi. */
const OTHER_OPTION_RE = /^type something\.?$/i;
/** Fallback: some layouts may render the option label itself. */
const OTHER_LABEL_RE = /^other$/i;
/** "Chat about this" is a plan-mode side action, not an answer option. */
const CHAT_ACTION_RE = /^chat about this$/i;

/** Dialog footer key-guide (Qt/Ue): `<chord> to <action>`, e.g. "Enter to
 *  select · ↑/↓ to navigate · Esc to cancel", plus the multi-question
 *  "Tab/Arrow keys to navigate" hint. Rendered only by interactive dialogs,
 *  never by assistant prose. */
const CHORD_GUIDE_RE = /(?:(?:enter|return|escape|esc|up|down|tab|space|ctrl\+e)\b|[↑↓←→]).{0,24}\bto\s+(?:select|navigate|cancel|confirm|toggle|submit|save|next|send|amend|explain|hide|show)\b/i;

/** Permission prompt lines printed by the permission dialogs (Ed). */
const PERMISSION_PROMPT_RE = /(?:do you want to\s+.+\?|how (?:would|do) you like to proceed|allow (?:all actions|claude to)|permission needed|is this (?:ok|okay)\?)/i;

/** The input box placeholder that Claude prints while an AskUserQuestion is
 *  active: `press 1-<N> or type your answer`. */
const QUESTION_HINT_RE = /press 1-?\d+ or type your answer/i;

/** Multi-select submit button row (Y4/AQs). The card keeps single-select
 *  flows; multi-select needs toggle + submit semantics we do not project, so
 *  it is detected and left to the native terminal. */
const MULTI_SELECT_SUBMIT_RE = /^\s*(?:❯\s*)?(?:submit|next)\s*$/i;

/** Progress-row checkboxes painted by GZe for every question flow. */
const CHECKBOX_GLYPH_RE = /[☐☒]/u;

/** Max buffer-row gap between two consecutive menu options. Wrapped labels
 *  and inline description rows may sit between option rows. */
const MAX_OPTION_GAP = 4;
/** The menu's last option must be within this many rows of the viewport
 *  bottom — Claude paints dialogs just above the input box, so a "menu"
 *  deeper in scrollback is a stale frame. */
const MAX_DISTANCE_FROM_BOTTOM = 20;

function cleanLine(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- rendered terminal cells can retain C0 bytes.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trimEnd();
}

/** Collapse internal whitespace and cap length so the fingerprint survives
 *  soft-wrap / resize re-flows of the same logical label. */
function fingerprintToken(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 64);
}

function normalizeTitle(text: string): string {
  return fingerprintToken(text.replace(/^[❯›>→?]\s*/u, ''));
}

interface OptionRow {
  line: number;
  number: number;
  label: string;
  focused: boolean;
}

/**
 * Parse Claude's already-rendered screen (the last rows of the xterm viewport)
 * for a live interactive menu. This intentionally does not inspect raw PTY
 * chunks: xterm has already applied ANSI cursor movement, erases, wrapping
 * and alternate-screen redraws before this function runs.
 */
function parseClaudeInteraction(screen: ScreenLine[]): TerminalInteraction | null {
  const rows: OptionRow[] = [];
  for (let line = 0; line < screen.length; line += 1) {
    const text = cleanLine(screen[line].text);
    const match = OPTION_ROW_RE.exec(text);
    if (!match) continue;
    let label = match[3].trim();
    if (!label) continue;
    // Strip the multi-select tick glyph so selected rows keep a clean label.
    label = label.replace(/\s*[✓✔]\s*$/u, '').trim();
    if (!label) continue;
    // "Chat about this" is a plan-mode side action, not an answer option.
    if (CHAT_ACTION_RE.test(label)) continue;
    rows.push({
      line,
      number: Number(match[2]),
      label,
      focused: FOCUSED_POINTER_GLYPHS.has(match[1]),
    });
  }

  // Build maximal consecutive 1..N blocks. Options must start at 1 and
  // increment by exactly one; wrapped labels / description rows may sit
  // between them (bounded by MAX_OPTION_GAP).
  const blocks: OptionRow[][] = [];
  for (let start = 0; start < rows.length; start += 1) {
    if (rows[start].number !== 1) continue;
    const block = [rows[start]];
    for (let cursor = start + 1; cursor < rows.length; cursor += 1) {
      const previous = block[block.length - 1];
      const next = rows[cursor];
      if (next.number !== previous.number + 1) break;
      if (next.line - previous.line > MAX_OPTION_GAP) break;
      block.push(next);
    }
    if (block.length >= 2) blocks.push(block);
  }
  if (blocks.length === 0) return null;

  // A live menu has exactly one row carrying the ❯ cursor. Ordinary prose and
  // multi-line typed input may contain consecutive numbering, but they never
  // paint Claude's selector beside the block.
  const liveBlocks = blocks.filter(block => block.filter(row => row.focused).length === 1);
  if (liveBlocks.length === 0) return null;
  // Among live candidates prefer the one lowest on screen (a stale menu
  // higher up in scrollback must not shadow the active one).
  const block = liveBlocks.sort((a, b) => b[b.length - 1].line - a[a.length - 1].line)[0];

  const firstLine = block[0].line;
  const lastLine = block[block.length - 1].line;

  // Stale-frame guard: the menu is drawn above the input box, so its last
  // option sits near the viewport bottom. A numbered list buried deeper in
  // scrollback is not an active prompt.
  if (screen.length - 1 - lastLine > MAX_DISTANCE_FROM_BOTTOM) return null;

  // Multi-select flows render a "Submit"/"Next" button row below the menu.
  // They need toggle + submit semantics the card does not project; leave
  // them to the native terminal.
  const nearRegion = screen
    .slice(Math.max(0, firstLine - 2), Math.min(screen.length, lastLine + 4))
    .map(line => cleanLine(line.text))
    .filter(Boolean);
  if (nearRegion.some(line => MULTI_SELECT_SUBMIT_RE.test(line))) return null;

  // ── Structural anchors ──────────────────────────────────────────────────
  const regionAbove = screen
    .slice(Math.max(0, firstLine - 12), Math.max(0, firstLine))
    .map(line => cleanLine(line.text));
  const regionBelow = screen
    .slice(Math.min(screen.length, lastLine + 1), Math.min(screen.length, lastLine + 8))
    .map(line => cleanLine(line.text));
  // The key-guide is its own line next to the menu — exclude the option rows
  // themselves so a label that happens to read "…enter to select…" cannot act
  // as the anchor.
  const blockLineSet = new Set(block.map(row => row.line));
  const guideRegion = screen
    .slice(Math.max(0, firstLine - 6), Math.min(screen.length, lastLine + 6))
    .map((line, index) => ({
      text: cleanLine(line.text),
      line: index + Math.max(0, firstLine - 6),
    }))
    .filter(({ text, line }) => text && !blockLineSet.has(line));

  const hasOther = block.some(
    row => OTHER_OPTION_RE.test(row.label) || OTHER_LABEL_RE.test(row.label),
  );
  // A live Claude selector always exposes an explicit cancel chord. Requiring
  // that footer prevents ordinary prose such as "press enter to select" from
  // turning a numbered response into a card, while remaining independent of
  // the prompt verb and the renderer's color/spacing choices.
  const hasChordGuide = guideRegion.some(({ text }) => (
    CHORD_GUIDE_RE.test(text)
    && /\b(?:esc|escape)\s+to\s+cancel\b/i.test(text)
  ));
  const hasPrompt = regionAbove.some(line => PERMISSION_PROMPT_RE.test(line));
  const hasQuestionHint = regionBelow.some(line => QUESTION_HINT_RE.test(line));

  if (!hasOther && !hasChordGuide && !hasPrompt && !hasQuestionHint) return null;

  // ── Title: nearest bold line above the menu (GAe titles are bold). ─────
  let title = '';
  for (let line = firstLine - 1; line >= Math.max(0, firstLine - 10); line -= 1) {
    if (!screen[line].bold) continue;
    const candidate = normalizeTitle(screen[line].text);
    if (candidate) {
      title = candidate;
      break;
    }
  }

  // ── Kind: question flows carry the "Other" row / hint / progress
  //    checkboxes; permission flows carry a prompt line or a Yes/No menu. ─
  const hasCheckbox = regionAbove.some(line => CHECKBOX_GLYPH_RE.test(line));
  const firstLabel = block[0].label;
  let kind: TerminalInteractionKind;
  if (hasOther || hasQuestionHint || hasCheckbox) {
    kind = 'question';
  } else if (hasPrompt || /^yes\b/i.test(firstLabel)) {
    kind = 'permission';
  } else {
    kind = 'question';
  }

  if (!title) {
    if (hasPrompt) {
      const promptLine = regionAbove.find(line => PERMISSION_PROMPT_RE.test(line));
      title = promptLine ? normalizeTitle(promptLine) : '';
    }
    if (!title) title = kind === 'permission' ? 'Permission required' : 'Input required';
  }

  const options: TerminalInteractionOption[] = block.map((row, position) => ({
    position,
    number: row.number,
    label: row.label,
    acceptsText: OTHER_OPTION_RE.test(row.label) || OTHER_LABEL_RE.test(row.label),
    focused: row.focused,
  }));
  const focusedPosition = block.findIndex(row => row.focused);

  const fingerprint = [
    'claude',
    kind,
    fingerprintToken(title),
    String(block.length),
    ...block.map(row => `${row.number}:${fingerprintToken(row.label)}`),
  ].join('|');

  return { fingerprint, kind, title, options, focusedPosition, responseMode: 'digit' };
}

function interaction(
  family: string,
  kind: TerminalInteractionKind,
  title: string,
  options: TerminalInteractionOption[],
  responseMode: TerminalInteractionResponseMode,
): TerminalInteraction {
  const normalizedTitle = fingerprintToken(title) || (kind === 'permission' ? 'Permission required' : 'Input required');
  return {
    fingerprint: [
      family,
      kind,
      normalizedTitle,
      String(options.length),
      ...options.map(option => `${option.number}:${fingerprintToken(option.label)}`),
    ].join('|'),
    kind,
    title: normalizedTitle,
    options,
    focusedPosition: options.findIndex(option => option.focused),
    responseMode,
  };
}

function nearestTitle(screen: ScreenLine[], before: number, fallback: string): string {
  for (let line = before - 1; line >= Math.max(0, before - 12); line -= 1) {
    const text = normalizeTitle(cleanLine(screen[line].text));
    if (!text) continue;
    if (screen[line].bold) return text;
  }
  for (let line = before - 1; line >= Math.max(0, before - 8); line -= 1) {
    const text = normalizeTitle(cleanLine(screen[line].text));
    if (text && !/[─━╭╮╰╯]/u.test(text)) return text;
  }
  return fallback;
}

function hasNearBottom(screen: ScreenLine[], lastLine: number): boolean {
  return screen.length - 1 - lastLine <= MAX_DISTANCE_FROM_BOTTOM;
}

function parseCodexInteraction(screen: ScreenLine[]): TerminalInteraction | null {
  const footerLine = screen.findLastIndex(line => /(?:press enter to confirm|enter to submit answer).*(?:esc|escape)/i.test(cleanLine(line.text)));
  if (footerLine < 0 || !hasNearBottom(screen, footerLine)) return null;

  const rows: OptionRow[] = [];
  const rowRe = /^\s*([› ])\s*(\d{1,2})\.\s+(.+?)\s*$/u;
  for (let line = Math.max(0, footerLine - 18); line < footerLine; line += 1) {
    const match = rowRe.exec(cleanLine(screen[line].text));
    if (!match) continue;
    rows.push({ line, number: Number(match[2]), label: match[3].trim(), focused: match[1] === '›' });
  }
  const block = consecutiveNumberedBlock(rows);
  if (block && block.filter(row => row.focused).length === 1) {
    const title = nearestTitle(screen, block[0].line, 'Input required');
    // Keep this classification tied to Codex's ApprovalRequest variants in
    // approval_overlay.rs. The option/footer grammar already proves that the
    // view is live; these titles decide whether Coffee presents it as a
    // permission (and uses the permission sound) rather than a question.
    const permission = screen.slice(Math.max(0, block[0].line - 12), block[0].line)
      .some(line => /(?:would you like to (?:run the following command|grant these permissions|make the following edits)|do you want to approve network access to|needs your approval\.|permission rule:)/i.test(cleanLine(line.text)));
    return interaction('codex', permission ? 'permission' : 'question', title, block.map((row, position) => ({
      position,
      number: row.number,
      label: row.label.replace(/\s+\([a-z]\)\s*$/i, ''),
      acceptsText: false,
      focused: row.focused,
    })), 'digit');
  }

  // Codex free-form request_user_input has no numbered options.
  const inputLine = screen.findLastIndex((line, index) => index < footerLine && /^\s*›\s*type your answer/i.test(cleanLine(line.text)));
  if (inputLine >= 0) {
    const label = cleanLine(screen[inputLine].text).replace(/^\s*›\s*/u, '').trim();
    return interaction('codex', 'question', nearestTitle(screen, inputLine, 'Input required'), [{
      position: 0, number: 1, label, acceptsText: true, focused: true,
    }], 'direct-text');
  }
  return null;
}

function consecutiveNumberedBlock(rows: OptionRow[]): OptionRow[] | null {
  let best: OptionRow[] | null = null;
  for (let start = 0; start < rows.length; start += 1) {
    if (rows[start].number !== 1) continue;
    const block = [rows[start]];
    for (let cursor = start + 1; cursor < rows.length; cursor += 1) {
      const previous = block[block.length - 1];
      const next = rows[cursor];
      if (next.number !== previous.number + 1 || next.line - previous.line > MAX_OPTION_GAP) break;
      block.push(next);
    }
    if (block.length >= 2 && (!best || block[block.length - 1].line > best[best.length - 1].line)) best = block;
  }
  return best;
}

function parseKimiInteraction(screen: ScreenLine[]): TerminalInteraction | null {
  const approvalFooter = screen.findLastIndex(line => /↑\/↓ select.*\bchoose.*↵ confirm/i.test(cleanLine(line.text)));
  if (approvalFooter >= 0 && hasNearBottom(screen, approvalFooter)) {
    const rows: OptionRow[] = [];
    for (let line = Math.max(0, approvalFooter - 20); line < approvalFooter; line += 1) {
      const match = /^\s*(▶)?\s*(\d{1,2})\.\s+(.+?)\s*$/u.exec(cleanLine(screen[line].text));
      if (match) rows.push({ line, number: Number(match[2]), label: match[3].trim(), focused: Boolean(match[1]) });
    }
    const block = consecutiveNumberedBlock(rows);
    if (block && block.filter(row => row.focused).length === 1) {
      const title = nearestTitle(screen, block[0].line, 'Permission required');
      return interaction('kimi', 'permission', title, block.map((row, position) => ({
        position, number: row.number, label: row.label,
        acceptsText: /feedback|tell kimi|differently|revise/i.test(row.label), focused: row.focused,
      })), 'digit');
    }
  }

  const questionFooter = screen.findLastIndex(line => /↑↓ select.*(?:\d(?:-\d)?\s*\/\s*↵|1\/2 choose)/i.test(cleanLine(line.text)));
  if (questionFooter >= 0 && hasNearBottom(screen, questionFooter)) {
    const near = screen.slice(Math.max(0, questionFooter - 24), questionFooter + 1).map(line => cleanLine(line.text)).join(' ');
    if (/\[[✓ ]\]|\btoggle\b/i.test(near)) return null;
    const rows: OptionRow[] = [];
    for (let line = Math.max(0, questionFooter - 20); line < questionFooter; line += 1) {
      const match = /^\s*(→)?\s*\[(\d{1,2})\]\s+(.+?)\s*$/u.exec(cleanLine(screen[line].text));
      if (match) rows.push({ line, number: Number(match[2]), label: match[3].trim(), focused: Boolean(match[1]) });
    }
    const block = consecutiveNumberedBlock(rows);
    if (block && block.filter(row => row.focused).length === 1) {
      return interaction('kimi', 'question', nearestTitle(screen, block[0].line, 'Input required'), block.map((row, position) => ({
        position, number: row.number, label: row.label,
        acceptsText: /^other\b/i.test(row.label), focused: row.focused,
      })), 'digit');
    }
  }

  const pickerFooter = screen.findLastIndex(line => /↑↓ navigate.*Enter select.*Esc cancel/i.test(cleanLine(line.text)));
  if (pickerFooter >= 0 && screen.some(line => /select permission mode/i.test(cleanLine(line.text)))) {
    const labels = ['Manual', 'YOLO', 'Auto'];
    const options = labels.map((label, position) => {
      const row = screen.find(line => new RegExp(`^\\s{2}([❯ ])\\s+${label}(?:\\s|$)`, 'u').test(cleanLine(line.text)));
      const match = row ? /^\s{2}([❯ ])\s+/u.exec(cleanLine(row.text)) : null;
      return { position, number: position + 1, label, acceptsText: false, focused: match?.[1] === '❯' };
    });
    if (options.filter(option => option.focused).length === 1) {
      return interaction('kimi', 'permission', 'Select permission mode', options, 'vertical');
    }
  }
  return null;
}

/** Parse only protocols verified in each tool's checked-in TUI source. */
export function parseTerminalInteraction(screen: ScreenLine[], tool: ToolType): TerminalInteraction | null {
  switch (tool) {
    case 'claude': return parseClaudeInteraction(screen);
    case 'codex': return parseCodexInteraction(screen);
    case 'kimicode': return parseKimiInteraction(screen);
    default: return null;
  }
}

const BRAILLE_SPINNER_RE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
const MOON_SPINNER_RE = /^[🌑🌒🌓🌔🌕🌖🌗🌘]/u;
/**
 * Extract the coarse agent state that powers Coffee's Dynamic Island from the
 * same rendered cells used by the interaction card. A verified interaction is
 * always authoritative. Working patterns intentionally require TUI chrome
 * (spinner/status line + interrupt hint), never a prose keyword by itself.
 * `null` means the current frame carries no conclusive state; TierTerminal
 * settles to idle only after the rendered screen stops changing.
 */
export function parseTerminalAgentStatus(
  screen: ScreenLine[],
  tool: ToolType,
  liveInteraction: TerminalInteraction | null = parseTerminalInteraction(screen, tool),
): AgentStatus | null {
  if (liveInteraction) return 'wait_input';

  const recent = screen
    .slice(-24)
    .map(line => cleanLine(line.text).trim())
    .filter(Boolean);

  switch (tool) {
    case 'codex':
      // codex-rs StatusIndicatorWidget: `• Working (0s • esc to interrupt)`;
      // the activity label is dynamic, so anchor on elapsed + interrupt chrome.
      return recent.some(line => /^[•●]?[ ]*.+\(\d+(?:\.\d+)?[smh]\s*[•·].*\b(?:esc|ctrl\s*\+\s*c|cmd\s*\+\s*c)\s+to\s+interrupt\b/i.test(line))
        ? 'working'
        : null;

    case 'kimicode':
      // Kimi uses braille `working...` / `thinking...` while composing and
      // moon frames for waiting/tool phases. Source permits an empty moon-row
      // label, so the exact spinner cell itself is the authoritative chrome.
      return recent.some(line => (
        BRAILLE_SPINNER_RE.test(line) && /\b(?:working|thinking)\.\.\./i.test(line)
      ) || (
        MOON_SPINNER_RE.test(line)
      )) ? 'working' : null;

    // Claude retains its authoritative native-title working fallback.
    default:
      return null;
  }
}

/**
 * Read the live bottom screen of the given xterm instance, preserving the cell
 * attributes used by source-verified selectors (bold/dim). Use
 * `baseY`, not the user's scrolled viewportY: inspecting scrollback must not
 * make the Dynamic Island lose the agent that is still running at the bottom.
 */
export function readTerminalScreen(term: Terminal): ScreenLine[] {
  const buffer = term.buffer.active;
  const viewportStart = buffer.baseY;
  const viewportEnd = Math.min(buffer.length - 1, viewportStart + term.rows - 1);
  const start = Math.max(viewportStart, viewportEnd - 59);
  const screen: ScreenLine[] = [];
  const cell = buffer.getNullCell(); // scratch cell reused by getCell()
  for (let row = start; row <= viewportEnd; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      screen.push({ text: '', bold: false });
      continue;
    }
    const text = line.translateToString(true);
    let bold = false;
    // Terminal columns are not JavaScript string indices: CJK/wide glyphs
    // can occupy two cells, while astral glyphs use two UTF-16 code units.
    // Walk the actual xterm cells so a bold title is never missed.
    for (let col = 0; col < line.length; col += 1) {
      const current = line.getCell(col, cell);
      if (!current) continue;
      if (current.isBold()) bold = true;
    }

    screen.push({ text, bold });
  }
  return screen;
}
