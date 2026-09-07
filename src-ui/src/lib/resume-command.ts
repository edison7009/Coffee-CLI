// Resume command builder - TS mirror of `AGENT_PRESETS` in src/terminal.rs.
//
// The Rust backend assembles the real spawn argv (program + before + token
// + after, with cwd validation + token-format guard) at server.rs:628-657.
// That path is for *spawning* a resume terminal. Here we only need the
// copy-pasteable command STRING for the session-history context menu's
// "复制恢复命令" item, so we mirror just the (program + before-flag) shape.
//
// Every preset in AGENT_PRESETS has resume_args_after = [] (verified
// 2026-07-11), so the command is always: `<program> <before...> <token>`.
//
// KEEP IN SYNC with AGENT_PRESETS (src/terminal.rs:283-464). If a tool's
// resume flag changes upstream, update both this table and the Rust preset.

interface ResumeShape {
  program: string;
  argsBefore: string[];
}

const RESUME_SHAPES: Record<string, ResumeShape> = {
  claude:      { program: 'claude',  argsBefore: ['--resume'] },
  antigravity: { program: 'agy',     argsBefore: ['--conversation'] },
  hermes:      { program: 'hermes',  argsBefore: ['--resume'] },
  opencode:    { program: 'opencode', argsBefore: ['--session'] },
  mimocode:    { program: 'mimo',    argsBefore: ['--session'] },
  codex:       { program: 'codex',   argsBefore: ['resume'] },
  grok:        { program: 'grok',    argsBefore: ['--resume'] },
  qwen:        { program: 'qwen',    argsBefore: ['--resume'] },
  pi:          { program: 'pi',      argsBefore: ['--session'] },
  omp:         { program: 'omp',     argsBefore: ['--resume'] },
  kimicode:    { program: 'kimi',    argsBefore: ['--session'] },
  // openclaw has resume_program: None in AGENT_PRESETS - no CLI resume.
};

/** Returns the copy-pasteable resume command for a tool+token, or null if
 *  the tool doesn't support CLI resume (openclaw) or the token is missing. */
export function buildResumeCommand(tool: string, token: string | null): string | null {
  if (!token) return null;
  const shape = RESUME_SHAPES[tool];
  if (!shape) return null;
  return [shape.program, ...shape.argsBefore, token].join(' ');
}
