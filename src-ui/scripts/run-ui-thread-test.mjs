import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Tauri executes synchronous commands on its UI thread. These IPC entry points
// can wait on pipes, filesystem probes or another session's locks.
for (const [file, names] of Object.entries({
  'server.rs': ['detect_shells', 'check_tools_installed', 'maintain_tool_integration', 'tier_terminal_input', 'tier_terminal_raw_write', 'tier_terminal_resize', 'list_directory', 'read_text_file', 'start_fs_watcher', 'stop_fs_watcher'],
  'claude_session.rs': ['claude_session_send', 'claude_session_respond', 'claude_session_close'],
  'codex_session.rs': ['codex_session_respond', 'codex_session_close'],
  'git.rs': ['git_changes', 'git_show_file', 'git_init', 'git_capture_baseline', 'git_commit_files'],
  'orchestration.rs': ['orchestration_get', 'orchestration_restore_worker', 'orchestration_detach_worker', 'orchestration_remove_worker', 'orchestration_close_group', 'orchestration_set_agent', 'orchestration_sync', 'orchestration_pending', 'orchestration_resolve'],
})) {
  const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
  for (const name of names) {
    const entry = source.match(new RegExp(`async fn ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(entry, `${name} must not run blocking I/O on the UI thread`);
    assert.ok(entry.includes('spawn_blocking') || name === 'tier_terminal_raw_write' && entry.includes('tier_terminal_input(session_id, data, state).await')
      || name === 'tier_terminal_resize' && entry.includes('resize_terminal_session('), `${name} must offload blocking work, not just change its signature`);
  }
}
console.log('OK: blocking session and launch commands use asynchronous IPC dispatch');
