/**
 * Fixture verification for the Claude TUI interaction parser.
 *
 * Every positive fixture is reconstructed from the installed Claude Code
 * bundle (v2.1.220): the menu row shape `[pointer] [space] [N.] [label]`,
 * the ❯ (U+276F) focused-row cursor, the "Type something." free-text row,
 * the "escape to cancel" / "enter to select" key-guide, the "Do you want to
 * proceed?" permission prompt, the bold title, and the "press 1-N or type
 * your answer" input hint.
 *
 * Negative fixtures are the false positives the product must never project:
 * markdown numbered prose, test logs, `>`-quoted user text, and — the hard
 * case — a multi-line numbered message typed into the input box, which looks
 * like a menu block but carries none of Claude's dialog anchors.
 *
 * Run with `node scripts/run-terminal-interaction-test.mjs` (esbuild-based).
 */
import { parseTerminalAgentStatus, parseTerminalInteraction, type ScreenLine } from './terminal-interaction';

/** Minimal typed assert helpers (the app's `moduleResolution: bundler`
 *  tsconfig cannot resolve `node:assert` inside `src/`). */
function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function equal<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${msg}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

function line(text: string, bold = false, optionIndexDim = false): ScreenLine {
  return { text, bold, optionIndexDim };
}

/** Claude's real selector paints its complete numeric marker with SGR dim. */
function option(text: string): ScreenLine {
  return line(text, false, true);
}

function backgrounds(text: string, ...runs: Array<[string, string]>): ScreenLine {
  return { text, bold: false, optionIndexDim: false, backgroundRuns: runs.map(([runText, color]) => ({ text: runText, color })) };
}

function screen(...rows: ScreenLine[]): ScreenLine[] {
  return rows;
}

// ── Positive: Bash command permission dialog ────────────────────────────────
const bashPermission = screen(
  line('╭──────────────────────────────────────╮'),
  line('Bash command', true),
  line('git status -s'),
  line('Do you want to proceed?'),
  option('❯ 1. Yes'),
  option('  2. Yes, and don\u2019t ask again for bash commands in D:\\Coffee-CLI'),
  option('  3. No'),
  line('escape to cancel'),
  line('❯'),
);

// ── Positive: permission with focus on the second option ────────────────────
const bashPermissionFocusedSecond = screen(
  line('Bash command', true),
  line('npm run build'),
  line('Do you want to proceed?'),
  option('  1. Yes'),
  option('❯ 2. Yes, and don\u2019t ask again for npm commands in D:\\Coffee-CLI'),
  option('  3. No'),
  line('escape to cancel'),
  line('❯'),
);

// ── Positive: Edit-file permission (different prompt, wrapped label) ────────
const editFilePermission = screen(
  line('Edit file', true),
  line('src/App.tsx'),
  line('Do you want to proceed?'),
  option('❯ 1. Yes'),
  option('  2. Yes, and always allow access to src/ from this project'),
  option('  3. No'),
  line('escape to cancel'),
  line('❯'),
);

// ── Positive: AskUserQuestion single-select ─────────────────────────────────
const askUserQuestion = screen(
  line('☐ Q1'),
  line('Which color?', true),
  option('❯ 1. Red'),
  option('  2. Blue'),
  option('  3. Type something.'),
  option('  4. Chat about this'),
  line('enter to select · ↑↓ to navigate · escape to cancel'),
  line('❯ press 1-2 or type your answer'),
);

// ── Positive: question focus moved via arrows ───────────────────────────────
const questionFocusedOther = screen(
  line('Which color?', true),
  option('  1. Red'),
  option('  2. Blue'),
  option('❯ 3. Type something'),
  line('enter to select · ↑↓ to navigate · escape to cancel'),
  line('❯ press 1-2 or type your answer'),
);

// ── Positive: wrapped permission label (option label wraps to next row) ─────
const wrappedPermission = screen(
  line('Bash command', true),
  line('npx create-tauri-app my-app'),
  line('Do you want to proceed?'),
  option('❯ 1. Yes'),
  option('  2. Yes, and don\u2019t ask again for npx create-tauri-app my-app --'),
  line('force in D:\\Coffee-CLI'),
  option('  3. No'),
  line('escape to cancel'),
  line('❯'),
);

// ── Source-grounded fixtures for the other supported TUIs ─────────────────
const codexApproval = screen(
  line('Would you like to run the following command?', true),
  line('npm test'),
  line('› 1. Yes, proceed (y)'),
  line('  2. No, and tell Codex what to do differently (esc)'),
  line('Press enter to confirm or esc to cancel'),
);

const codexFreeform = screen(
  line('Question 1/1 (1 unanswered)'),
  line('Share details.', true),
  line('› Type your answer (optional)'),
  line('enter to submit answer | esc to interrupt'),
);

const openCodePermission = screen(
  line('△ Permission required', true),
  line('Run npm test'),
  backgrounds(' Allow once   Allow always   Reject ', [' Allow once ', 'menu'], [' Allow always ', 'menu'], [' Reject ', 'warning']),
  line('⇆ select     enter confirm'),
);

const openCodeQuestion = screen(
  line('Choose a database', true),
  backgrounds('1. SQLite', ['1. SQLite', 'active']),
  line('2. Postgres'),
  line('3. Type your own answer'),
  line('↑↓ select     enter submit     esc dismiss'),
);

const kimiApproval = screen(
  line('────────────────────────'),
  line('▶ Run this command?', true),
  line('$ npm test'),
  line('  ▶ 1. Approve'),
  line('    2. Approve for session'),
  line('    3. Reject with feedback'),
  line('↑/↓ select · 1/2/3 choose · ↵ confirm'),
  line('────────────────────────'),
);

const kimiQuestion = screen(
  line('────────────────────────'),
  line(' question', true),
  line(' ? Which database?'),
  line('  → [1] SQLite'),
  line('    [2] Postgres'),
  line('    [3] Other'),
  line('  ↑↓ select  1-3 / ↵ choose  ←/→/tab switch  esc cancel'),
  line('────────────────────────'),
);

const grokPermission = screen(
  line('┃ Run this command?', true),
  line('┃ npm test'),
  line('┃ 1 (●) Yes, proceed', true),
  line('┃ 2 (○) Always allow: npm test'),
  line('┃ 3 (○) No, reject (type to add feedback)'),
  line('1–3 select   Tab next option   Esc back'),
);

const piSelector = screen(
  line('Use production credentials?', true),
  line('→ Yes'),
  line('  No'),
  line('↑↓ navigate  enter select  esc cancel'),
);

const ompApproval = screen(
  line('╭─ Allow tool: dangerous_tool ─────────╮', true),
  line('│                                      │'),
  line('│ ❯ Approve                            │'),
  line('│   Deny                               │'),
  line('│                                      │'),
  line('│ up/down navigate  enter select  esc cancel │'),
  line('╰──────────────────────────────────────╯'),
);

const codexWorking = screen(
  line('• Working (12s • esc to interrupt)'),
  line('› Write a message'),
);

const openCodeWorking = screen(
  line(' BUILD  ▰▱▱▱  esc interrupt                         kimi-k2.5'),
);

const piWorking = screen(
  line('⠹ Working... (esc to interrupt)'),
  line('> queued prompt'),
);

const kimiWorking = screen(
  line('⠙ working...'),
  line('  Tip: Keep changes focused'),
);

const kimiThinking = screen(
  line('⠸ thinking...'),
  line('  Tip: Keep changes focused'),
);

const kimiMoonWorking = screen(
  line('🌔'),
  line('  Tip: Keep changes focused'),
);

const proseSayingWorking = screen(
  line('Implementation summary:'),
  line('Working... (esc to interrupt) is the status string we now parse.'),
);

const copiedNumbersOnly = screen(
  line('Permission implementation summary', true),
  line('› 1. Added the first branch'),
  line('  2. Added the second branch'),
  line('  3. Added the third branch'),
  line('  4. Added the fourth branch'),
);

const openCodeMultiSelect = screen(
  line('Pick features (select all that apply)', true),
  backgrounds('1. [ ] Search', ['1. [ ] Search', 'active']),
  line('2. [ ] Export'),
  line('↑↓ select     enter toggle     esc dismiss'),
);

const kimiMultiSelect = screen(
  line(' question', true),
  line(' ? Pick features'),
  line('  [ ] Search'),
  line('  [ ] Export'),
  line('  ↑↓ select  1-3 / ↵ toggle  ←/→/tab switch  esc cancel'),
);

// ── Negative: markdown numbered list in assistant reply ─────────────────────
const markdownList = screen(
  line('Here are the steps:'),
  line('1. Install the package'),
  line('2. Run the tests'),
  line('3. Commit the changes'),
  line('Let me know if you need help.'),
);

// ── Negative: indented numbered prose (matches the row shape but no ❯) ──────
const indentedList = screen(
  line('  1. First item'),
  line('  2. Second item'),
  line('  3. Third item'),
  line('The list above is not interactive.'),
);

// ── Negative: test-log numbered output ──────────────────────────────────────
const testLog = screen(
  line('running 3 tests...'),
  line('  1) math add works'),
  line('  2) math sub works'),
  line('  3) math mul works'),
  line('3 passed, 0 failed'),
);

// ── Negative: `>`-quoted user message with numbered items ───────────────────
const quotedUserMessage = screen(
  line('> 1. Check the logs'),
  line('> 2. Restart the service'),
  line('> 3. Re-run the job'),
);

// ── Negative: multi-line numbered message typed into the input box ──────────
// This is the hard case — it looks exactly like a menu block (❯ on the first
// row, consecutive 1..N), but it is ordinary typed input: no "Other" row, no
// key-guide, no permission prompt, no "press 1-N" hint.
const typedInput = screen(
  line('❯ 1. Deploy to prod'),
  line('  2. Roll back'),
);

// ── Negative: "consecutive numbers + Enter wording" but no cursor ───────────
const numberedProseWithEnter = screen(
  line('You can do this:'),
  line('1. Open the file'),
  line('2. Press enter to select'),
  line('3. Done'),
);

// ── Negative: adversarial summary that copies every visible menu token ──────
// Even a summary containing `❯ 1.`, consecutive choices and a key-guide-like
// sentence is not a selector: its numeric markers are ordinary cells, not the
// dim marker cells emitted by Claude's menu component.
const summaryMimickingMenu = screen(
  line('Implementation summary', true),
  line('❯ 1. Restored the bubble card'),
  line('  2. Added keyboard selection'),
  line('  3. Added tests'),
  line('You can press enter to select an item in the real menu.'),
);

// ── Negative: multi-select flow (submit button) — left to native terminal ───
const multiSelect = screen(
  line('Pick all that apply:', true),
  option('❯ 1. Red'),
  option('  2. Blue'),
  option('  3. Type something'),
  line('     Submit'),
  line('enter to select · ↑↓ to navigate · escape to cancel'),
);

// ── Negative: stale menu buried in scrollback (last option > 20 rows up) ────
const staleInScrollback = screen(
  ...[
    option('❯ 1. Yes'),
    option('  2. No'),
    line('escape to cancel'),
    ...Array.from({ length: 40 }, (_, i) => line(`old output line ${i}`)),
  ],
);

function assertInteraction(
  label: string,
  result: ReturnType<typeof parseTerminalInteraction>,
  expected: { kind: string; optionCount: number; focusedPosition: number },
): void {
  ok(result, `${label}: expected an interaction, got null`);
  equal(result.kind, expected.kind, `${label}: kind`);
  equal(result.options.length, expected.optionCount, `${label}: option count`);
  equal(result.focusedPosition, expected.focusedPosition, `${label}: focused position`);
}

// ── Run ─────────────────────────────────────────────────────────────────────
export function main(): void {
  // Positives
  const bash = parseTerminalInteraction(bashPermission, 'claude');
  assertInteraction('bash permission', bash, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  equal(bash!.title, 'Bash command', 'bash title');
  equal(bash!.options[0].number, 1, 'option 1 number');
  equal(bash!.options[2].number, 3, 'option 3 number');
  ok(!bash!.options.some(o => o.acceptsText), 'bash permission has no free-text option');

  const bash2 = parseTerminalInteraction(bashPermissionFocusedSecond, 'claude');
  assertInteraction('bash permission focused #2', bash2, { kind: 'permission', optionCount: 3, focusedPosition: 1 });
  ok(bash2!.options[1].focused, 'option 1 is focused');

  const edit = parseTerminalInteraction(editFilePermission, 'claude');
  assertInteraction('edit-file permission', edit, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  equal(edit!.title, 'Edit file', 'edit title');

  const question = parseTerminalInteraction(askUserQuestion, 'claude');
  assertInteraction('ask user question', question, { kind: 'question', optionCount: 3, focusedPosition: 0 });
  equal(question!.title, 'Which color?', 'question title');
  equal(question!.options[2].label, 'Type something.', 'other label');
  ok(question!.options[2].acceptsText, 'Other row accepts text');
  ok(!question!.options.some(o => o.label === 'Chat about this'), 'Chat about this is filtered out');

  const question2 = parseTerminalInteraction(questionFocusedOther, 'claude');
  assertInteraction('question focused Other', question2, { kind: 'question', optionCount: 3, focusedPosition: 2 });
  ok(question2!.options[2].acceptsText, 'Other row accepts text');

  const wrapped = parseTerminalInteraction(wrappedPermission, 'claude');
  assertInteraction('wrapped permission label', wrapped, { kind: 'permission', optionCount: 3, focusedPosition: 0 });

  const codex = parseTerminalInteraction(codexApproval, 'codex');
  assertInteraction('Codex approval', codex, { kind: 'permission', optionCount: 2, focusedPosition: 0 });
  equal(codex!.responseMode, 'digit', 'Codex uses verified digit shortcuts');
  const codexText = parseTerminalInteraction(codexFreeform, 'codex');
  assertInteraction('Codex freeform', codexText, { kind: 'question', optionCount: 1, focusedPosition: 0 });
  equal(codexText!.responseMode, 'direct-text', 'Codex freeform writes directly');

  for (const tool of ['opencode', 'mimocode', 'kilo'] as const) {
    const parsed = parseTerminalInteraction(openCodePermission, tool);
    assertInteraction(`${tool} permission`, parsed, { kind: 'permission', optionCount: 3, focusedPosition: 2 });
    equal(parsed!.responseMode, 'horizontal', `${tool} uses horizontal buttons`);
  }
  const ocQuestion = parseTerminalInteraction(openCodeQuestion, 'opencode');
  assertInteraction('OpenCode single question', ocQuestion, { kind: 'question', optionCount: 3, focusedPosition: 0 });
  equal(ocQuestion!.responseMode, 'vertical', 'OpenCode question uses arrows');

  const kimi = parseTerminalInteraction(kimiApproval, 'kimicode');
  assertInteraction('Kimi approval', kimi, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  ok(kimi!.options[2].acceptsText, 'Kimi feedback option accepts text');
  const kimiAsk = parseTerminalInteraction(kimiQuestion, 'kimicode');
  assertInteraction('Kimi question', kimiAsk, { kind: 'question', optionCount: 3, focusedPosition: 0 });

  const grok = parseTerminalInteraction(grokPermission, 'grok');
  assertInteraction('Grok permission', grok, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  ok(grok!.options[2].acceptsText, 'Grok reject option accepts feedback');

  const pi = parseTerminalInteraction(piSelector, 'pi');
  assertInteraction('Pi extension selector', pi, { kind: 'permission', optionCount: 2, focusedPosition: 0 });
  equal(pi!.responseMode, 'vertical', 'Pi uses vertical navigation');

  const omp = parseTerminalInteraction(ompApproval, 'omp');
  assertInteraction('Oh-My-Pi tool approval', omp, { kind: 'permission', optionCount: 2, focusedPosition: 0 });

  // Shared Dynamic Island state comes from the same rendered screen. Working
  // matches require each tool's TUI chrome, while a verified interaction is
  // always the stronger wait_input state.
  equal(parseTerminalAgentStatus(codexWorking, 'codex'), 'working', 'Codex screen working');
  equal(parseTerminalAgentStatus(openCodeWorking, 'opencode'), 'working', 'OpenCode screen working');
  equal(parseTerminalAgentStatus(openCodeWorking, 'mimocode'), 'working', 'Mimo screen working');
  equal(parseTerminalAgentStatus(openCodeWorking, 'kilo'), 'working', 'Kilo screen working');
  equal(parseTerminalAgentStatus(piWorking, 'pi'), 'working', 'Pi screen working');
  equal(parseTerminalAgentStatus(piWorking, 'omp'), 'working', 'Oh-My-Pi screen working');
  equal(parseTerminalAgentStatus(kimiWorking, 'kimicode'), 'working', 'Kimi screen working');
  equal(parseTerminalAgentStatus(kimiThinking, 'kimicode'), 'working', 'Kimi screen thinking');
  equal(parseTerminalAgentStatus(kimiMoonWorking, 'kimicode'), 'working', 'Kimi label-less moon frame');
  equal(parseTerminalAgentStatus(bashPermission, 'claude'), 'wait_input', 'Claude interaction waits');
  equal(parseTerminalAgentStatus(codexApproval, 'codex'), 'wait_input', 'Codex interaction waits');
  equal(parseTerminalAgentStatus(proseSayingWorking, 'pi'), null, 'working prose is not TUI chrome');

  // Negatives
  equal(parseTerminalInteraction(markdownList, 'claude'), null, 'markdown numbered list');
  equal(parseTerminalInteraction(indentedList, 'claude'), null, 'indented numbered prose');
  equal(parseTerminalInteraction(testLog, 'claude'), null, 'test log');
  equal(parseTerminalInteraction(quotedUserMessage, 'claude'), null, '> quoted user message');
  equal(parseTerminalInteraction(typedInput, 'claude'), null, 'multi-line input box text');
  equal(parseTerminalInteraction(numberedProseWithEnter, 'claude'), null, 'numbered prose + enter wording');
  equal(parseTerminalInteraction(summaryMimickingMenu, 'claude'), null, 'summary mimicking a menu');
  equal(parseTerminalInteraction(multiSelect, 'claude'), null, 'multi-select flow');
  equal(parseTerminalInteraction(staleInScrollback, 'claude'), null, 'stale menu in scrollback');

  // The central safety rule: prose containing 1/2/3/4 is never actionable
  // without that tool's live footer, pointer/style, and structural anchors.
  for (const tool of ['claude', 'codex', 'opencode', 'mimocode', 'kilo', 'grok', 'pi', 'omp', 'kimicode'] as const) {
    equal(parseTerminalInteraction(copiedNumbersOnly, tool), null, `${tool}: copied 1/2/3/4 summary`);
  }
  equal(parseTerminalInteraction(openCodeMultiSelect, 'opencode'), null, 'OpenCode multi-select stays native');
  equal(parseTerminalInteraction(kimiMultiSelect, 'kimicode'), null, 'Kimi multi-select stays native');

  // A Claude-shaped prompt must not be accepted by another tool family.
  equal(parseTerminalInteraction(bashPermission, 'codex'), null, 'cross-family Claude prompt');

  // Same logical question re-flows to a stable fingerprint under resize (the
  // second is the same content re-wrapped at a narrower column).
  const resized = screen(
    line('Which color?', true),
    option('❯ 1. Red'),
    option('  2. Blue'),
    option('  3. Type something.'),
    line('enter to select · ↑↓ to navigate · escape to cancel'),
  );
  equal(
    parseTerminalInteraction(askUserQuestion, 'claude')!.fingerprint,
    parseTerminalInteraction(resized, 'claude')!.fingerprint,
    'resize re-flow keeps the fingerprint stable',
  );

  console.log('OK: terminal-interaction fixtures pass');
}
