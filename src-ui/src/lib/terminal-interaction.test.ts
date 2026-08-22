/**
 * Fixture verification for the Claude TUI interaction parser.
 *
 * Every positive fixture is reconstructed from the installed Claude Code
 * bundle (v2.1.220): the menu row shape `[pointer][N.] [label]`,
 * the ❯ (U+276F) focused-row cursor, the "Type something." free-text row,
 * the "Esc to cancel" / "Enter to select" key-guide, the "Do you want to
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
import { supportsConversationTool } from './chat-tools';
import {
  parseTerminalAgentStatus,
  parseTerminalInteraction,
  supportsTerminalInteraction,
  type ScreenLine,
} from './terminal-interaction';

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

function line(text: string, bold = false): ScreenLine {
  return { text, bold };
}

function option(text: string): ScreenLine {
  return line(text);
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
  option('❯1. Yes'),
  option(' 2. Yes, and don\u2019t ask again for bash commands in D:\\Coffee-CLI'),
  option(' 3. No'),
  line('Esc to cancel'),
  line('❯'),
);

// ── Positive: permission with focus on the second option ────────────────────
const bashPermissionFocusedSecond = screen(
  line('Bash command', true),
  line('npm run build'),
  line('Do you want to proceed?'),
  option(' 1. Yes'),
  option('❯2. Yes, and don\u2019t ask again for npm commands in D:\\Coffee-CLI'),
  option(' 3. No'),
  line('Esc to cancel'),
  line('❯'),
);

// ── Positive: Edit-file permission (different prompt, wrapped label) ────────
const editFilePermission = screen(
  line('Edit file', true),
  line('src/App.tsx'),
  line('Do you want to proceed?'),
  option('❯1. Yes'),
  option(' 2. Yes, and always allow access to src/ from this project'),
  option(' 3. No'),
  line('Esc to cancel'),
  line('❯'),
);

// ── Positive: AskUserQuestion single-select ─────────────────────────────────
const askUserQuestion = screen(
  line('☐ Q1'),
  line('Which color?', true),
  option('❯1. Red'),
  option(' 2. Blue'),
  option(' 3. Type something.'),
  option(' 4. Chat about this'),
  line('Enter to select · ↑/↓ to navigate · Esc to cancel'),
  line('❯ press 1-2 or type your answer'),
);

// ── Positive: question focus moved via arrows ───────────────────────────────
const questionFocusedOther = screen(
  line('Which color?', true),
  option(' 1. Red'),
  option(' 2. Blue'),
  option('❯3. Type something'),
  line('Enter to select · ↑/↓ to navigate · Esc to cancel'),
  line('❯ press 1-2 or type your answer'),
);

// ── Positive: wrapped permission label (option label wraps to next row) ─────
const wrappedPermission = screen(
  line('Bash command', true),
  line('npx create-tauri-app my-app'),
  line('Do you want to proceed?'),
  option('❯1. Yes'),
  option(' 2. Yes, and don\u2019t ask again for npx create-tauri-app my-app --'),
  line('force in D:\\Coffee-CLI'),
  option(' 3. No'),
  line('Esc to cancel'),
  line('❯'),
);

// ── Positive: real Claude 2.1.220 simple_expansion permission layout ───────
const bashSimpleExpansion = screen(
  line('Bash command', true),
  line('CODEX="$HOME/.codex/sessions"; find "$CODEX" -name "rollout-*.jsonl"'),
  line('Look for real Codex Desktop sessions with attachment markers'),
  line(''),
  line('Contains simple_expansion'),
  line(''),
  line('Do you want to proceed?'),
  option('❯1. Yes'),
  option(' 2. Yes, allow reading from sessions\\ from this project'),
  line('   Authorize this operation'),
  option(' 3. No'),
  line('Esc to cancel · Tab to amend · ctrl+e to explain'),
  line('❯'),
);

// Claude's accessibility/ASCII theme replaces U+276F with `>`; the parser
// accepts both gap and no-gap spacing variants.
const bashAsciiPointer = screen(
  line('Bash command', true),
  line('npm test'),
  line('Do you want to proceed?'),
  option('>1. Yes'),
  option(' 2. No'),
  line('Esc to cancel · ctrl+e to hide'),
  line('>'),
);

const permissionExplainVisible = screen(
  line('Bash command', true),
  line('git status -s'),
  line('Do you want to proceed?'),
  option('❯1. Yes'),
  option(' 2. No'),
  line('Esc to cancel · ctrl+e to hide'),
);

// Real screen captured from Coffee on 2026-08-22. This is the layout that
// regressed when the parser assumed no gap after the focus cursor and only
// accepted the verb "proceed" in Claude's permission question.
const writeCreatePermission = screen(
  line('Write(test-permission.txt)'),
  line('Create file', true),
  line('test-permission.txt'),
  line('1 permission test file'),
  line('Do you want to create test-permission.txt?'),
  option('❯ 1. Yes'),
  option('  2. Yes, allow all edits during this session (shift+tab)'),
  option('  3. No'),
  line('Esc to cancel · Tab to amend'),
);

// ── Source-grounded fixtures for the other supported TUIs ─────────────────
const codexApproval = screen(
  line('Would you like to run the following command?', true),
  line('npm test'),
  line('› 1. Yes, proceed (y)'),
  line('  2. No, and tell Codex what to do differently (esc)'),
  line('Press enter to confirm or esc to cancel'),
);

const codexEditApproval = screen(
  line('Would you like to make the following edits?', true),
  line('src/app.ts | 2 +'),
  line('› 1. Yes, proceed (y)'),
  line('  2. No, continue without applying (esc)'),
  line('Press enter to confirm or esc to cancel'),
);

const codexNetworkApproval = screen(
  line('Do you want to approve network access to "api.example.com"?', true),
  line('› 1. Yes, just this once (y)'),
  line('  2. No, continue without network access (esc)'),
  line('Press enter to confirm or esc to cancel'),
);

const codexMcpApproval = screen(
  line('linear needs your approval.', true),
  line('List project issues'),
  line('› 1. Yes, proceed (y)'),
  line('  2. No, continue without running it (esc)'),
  line('Press enter to confirm or esc to cancel'),
);

const codexFreeform = screen(
  line('Question 1/1 (1 unanswered)'),
  line('Share details.', true),
  line('› Type your answer (optional)'),
  line('enter to submit answer | esc to interrupt'),
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

const kimiPlanApproval = screen(
  line('────────────────────────'),
  line('▶ Ready to build with this plan?', true),
  line('  ▶ 1. Approve'),
  line('    2. Reject'),
  line('    3. Revise'),
  line('↑/↓ select · 1/2/3 choose · ↵ confirm'),
  line('────────────────────────'),
);

const kimiPermissionSelector = screen(
  line('────────────────────────'),
  line(' Select permission mode', true),
  line(' ↑↓ navigate · Enter select · Esc cancel'),
  line(''),
  line('  ❯ Manual ← current'),
  line('    Approve every action yourself.'),
  line('    YOLO'),
  line('    Auto'),
  line('────────────────────────'),
);

const codexWorking = screen(
  line('• Working (12s • esc to interrupt)'),
  line('› Write a message'),
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

const copiedNumbersOnly = screen(
  line('Permission implementation summary', true),
  line('› 1. Added the first branch'),
  line('  2. Added the second branch'),
  line('  3. Added the third branch'),
  line('  4. Added the fourth branch'),
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
  line('❯1. Deploy to prod'),
  line(' 2. Roll back'),
);

// ── Negative: "consecutive numbers + Enter wording" but no cursor ───────────
const numberedProseWithEnter = screen(
  line('You can do this:'),
  line('1. Open the file'),
  line('2. Press enter to select'),
  line('3. Done'),
);

// ── Negative: adversarial summary that copies every visible menu token ──────
// Even a summary containing `❯1.`, consecutive choices and a key-guide-like
// sentence is not a selector: its numeric markers are ordinary cells, not the
// dim marker cells emitted by Claude's menu component.
const summaryMimickingMenu = screen(
  line('Implementation summary', true),
  line('❯1. Restored the bubble card'),
  line(' 2. Added keyboard selection'),
  line(' 3. Added tests'),
  line('You can press enter to select an item in the real menu.'),
);

// Documented stage-two adversarial case: a verbatim copied dialog contains
// every stable live-screen token. We intentionally keep dim styling out of
// the hard gate because real Claude renderers disagree on it; diagnostics
// retain that metadata for a future discriminator that does not regress the
// working prompt again.
const proseWithExactMenuText = screen(
  line('The terminal displayed this permission prompt:', true),
  line('Contains simple_expansion'),
  line('Do you want to proceed?'),
  line('❯1. Yes'),
  line(' 2. Yes, allow reading from sessions\\ from this project'),
  line(' 3. No'),
  line('Esc to cancel · Tab to amend · ctrl+e to explain'),
);

// ── Negative: multi-select flow (submit button) — left to native terminal ───
const multiSelect = screen(
  line('Pick all that apply:', true),
  option('❯1. Red'),
  option(' 2. Blue'),
  option(' 3. Type something'),
  line('     Submit'),
  line('Enter to select · ↑/↓ to navigate · Esc to cancel'),
);

// ── Negative: stale menu buried in scrollback (last option > 20 rows up) ────
const staleInScrollback = screen(
  ...[
    option('❯1. Yes'),
    option(' 2. No'),
    line('Esc to cancel'),
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
  equal(bash!.responseMode, 'digit', 'Claude uses its numeric shortcut');
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

  const simpleExpansion = parseTerminalInteraction(bashSimpleExpansion, 'claude');
  assertInteraction('bash simple_expansion', simpleExpansion, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  equal(simpleExpansion!.title, 'Bash command', 'simple_expansion title');
  equal(simpleExpansion!.options[1].label, 'Yes, allow reading from sessions\\ from this project', 'wrapped option label');

  const ascii = parseTerminalInteraction(bashAsciiPointer, 'claude');
  assertInteraction('Claude ASCII pointer', ascii, { kind: 'permission', optionCount: 2, focusedPosition: 0 });

  const explain = parseTerminalInteraction(permissionExplainVisible, 'claude');
  assertInteraction('permission explanation visible', explain, { kind: 'permission', optionCount: 2, focusedPosition: 0 });

  const create = parseTerminalInteraction(writeCreatePermission, 'claude');
  assertInteraction('Claude create-file permission', create, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  equal(create!.title, 'Create file', 'create-file title');

  const codex = parseTerminalInteraction(codexApproval, 'codex');
  assertInteraction('Codex approval', codex, { kind: 'permission', optionCount: 2, focusedPosition: 0 });
  equal(codex!.responseMode, 'digit', 'Codex uses verified digit shortcuts');
  for (const [name, fixture] of [
    ['edit', codexEditApproval],
    ['network', codexNetworkApproval],
    ['MCP', codexMcpApproval],
  ] as const) {
    assertInteraction(`Codex ${name} approval`, parseTerminalInteraction(fixture, 'codex'), {
      kind: 'permission', optionCount: 2, focusedPosition: 0,
    });
  }
  const codexText = parseTerminalInteraction(codexFreeform, 'codex');
  assertInteraction('Codex freeform', codexText, { kind: 'question', optionCount: 1, focusedPosition: 0 });
  equal(codexText!.responseMode, 'direct-text', 'Codex freeform writes directly');

  const kimi = parseTerminalInteraction(kimiApproval, 'kimicode');
  assertInteraction('Kimi approval', kimi, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  ok(kimi!.options[2].acceptsText, 'Kimi feedback option accepts text');
  const kimiAsk = parseTerminalInteraction(kimiQuestion, 'kimicode');
  assertInteraction('Kimi question', kimiAsk, { kind: 'question', optionCount: 3, focusedPosition: 0 });
  const kimiPlan = parseTerminalInteraction(kimiPlanApproval, 'kimicode');
  assertInteraction('Kimi plan approval', kimiPlan, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  ok(kimiPlan!.options[2].acceptsText, 'Kimi Revise choice accepts feedback');
  const kimiMode = parseTerminalInteraction(kimiPermissionSelector, 'kimicode');
  assertInteraction('Kimi permission selector', kimiMode, { kind: 'permission', optionCount: 3, focusedPosition: 0 });
  equal(kimiMode!.responseMode, 'vertical', 'Kimi permission selector uses arrows');

  // Shared Dynamic Island state remains enabled only for verified enhanced
  // integrations. A verified interaction is authoritative wait_input state.
  equal(parseTerminalAgentStatus(codexWorking, 'codex'), 'working', 'Codex screen working');
  equal(parseTerminalAgentStatus(kimiWorking, 'kimicode'), 'working', 'Kimi screen working');
  equal(parseTerminalAgentStatus(kimiThinking, 'kimicode'), 'working', 'Kimi screen thinking');
  equal(parseTerminalAgentStatus(kimiMoonWorking, 'kimicode'), 'working', 'Kimi label-less moon frame');
  equal(parseTerminalAgentStatus(bashPermission, 'claude'), 'wait_input', 'Claude interaction waits');
  equal(parseTerminalAgentStatus(codexApproval, 'codex'), 'wait_input', 'Codex interaction waits');

  // Negatives
  equal(parseTerminalInteraction(markdownList, 'claude'), null, 'markdown numbered list');
  equal(parseTerminalInteraction(indentedList, 'claude'), null, 'indented numbered prose');
  equal(parseTerminalInteraction(testLog, 'claude'), null, 'test log');
  equal(parseTerminalInteraction(quotedUserMessage, 'claude'), null, '> quoted user message');
  equal(parseTerminalInteraction(typedInput, 'claude'), null, 'multi-line input box text');
  equal(parseTerminalInteraction(numberedProseWithEnter, 'claude'), null, 'numbered prose + enter wording');
  equal(parseTerminalInteraction(summaryMimickingMenu, 'claude'), null, 'summary mimicking a menu');
  // Stage-one restoration intentionally does not make SGR dim styling a hard
  // gate: real Claude versions/themes disagree on it. A verbatim copy of the
  // complete dialog remains the stage-two adversarial case; ordinary numbered
  // prose (including "enter to select") is already rejected above.
  ok(parseTerminalInteraction(proseWithExactMenuText, 'claude'), 'verbatim copied dialog is the documented stage-two case');
  equal(parseTerminalInteraction(multiSelect, 'claude'), null, 'multi-select flow');
  equal(parseTerminalInteraction(staleInScrollback, 'claude'), null, 'stale menu in scrollback');

  // The central safety rule: prose containing 1/2/3/4 is never actionable
  // without a supported tool's live footer, pointer/style, and structure.
  for (const tool of ['claude', 'codex', 'opencode', 'mimocode', 'kilo', 'kimicode'] as const) {
    equal(parseTerminalInteraction(copiedNumbersOnly, tool), null, `${tool}: copied 1/2/3/4 summary`);
  }
  equal(parseTerminalInteraction(kimiMultiSelect, 'kimicode'), null, 'Kimi multi-select stays native');

  const terminalOnlyTools = [
    'grok', 'pi', 'omp', 'qwen', 'antigravity', 'opencode', 'mimocode', 'kilo',
    'hermes', 'openclaw', 'crush', 'aider', 'goose', 'copilot', 'cursor', 'cline',
    'terminal', 'remote',
  ] as const;
  for (const tool of terminalOnlyTools) {
    equal(supportsTerminalInteraction(tool), false, `${tool}: Coffee interaction disabled`);
    equal(supportsConversationTool(tool), false, `${tool}: conversation mode disabled`);
    equal(parseTerminalInteraction(bashPermission, tool), null, `${tool}: selectors stay native`);
  }
  for (const tool of ['claude', 'codex', 'kimicode'] as const) {
    equal(supportsTerminalInteraction(tool), true, `${tool}: Coffee interaction enabled`);
    equal(supportsConversationTool(tool), true, `${tool}: conversation mode enabled`);
  }

  // A Claude-shaped prompt must not be accepted by another tool family.
  equal(parseTerminalInteraction(bashPermission, 'codex'), null, 'cross-family Claude prompt');

  // Same logical question re-flows to a stable fingerprint under resize (the
  // second is the same content re-wrapped at a narrower column).
  const resized = screen(
    line('Which color?', true),
    option('❯1. Red'),
    option(' 2. Blue'),
    option(' 3. Type something.'),
    line('Enter to select · ↑/↓ to navigate · Esc to cancel'),
  );
  equal(
    parseTerminalInteraction(askUserQuestion, 'claude')!.fingerprint,
    parseTerminalInteraction(resized, 'claude')!.fingerprint,
    'resize re-flow keeps the fingerprint stable',
  );

  console.log('OK: terminal-interaction fixtures pass');
}
