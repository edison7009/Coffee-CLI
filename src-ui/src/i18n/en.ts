export const en = {
  'app.title': 'Coffee CLI',
  // Explorer
  'explorer.tab.workspace': 'Workspace',
  'explorer.tab.history': 'Sessions',
  'explorer.workspace.select-dir': 'Click to select working directory',

  // Context Menu
  'menu.copy_abs': 'Copy Absolute Path',
  'menu.copy_rel': 'Copy Relative Path',
  'menu.copy_ref': 'Copy as @reference',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.select_all': 'Select All',
  'menu.rename': 'Rename',
  'menu.delete': 'Delete',
  'menu.show_in_folder': 'Reveal in File Explorer',
  'menu.open': 'Open',


  // Tools
  'tool.terminal': 'Terminal',
  'tool.remote': 'Remote Terminal',
  'tool.multi_agent': 'Multi-Agent',
  'tool.two_agent': 'Two-Agent',
  'tool.three_agent': 'Three-Agent',
  'library.agent_tools': 'Agent Tools',
  'sentinel.protocol': 'Sentinel Protocol',
  'tool.two_split': 'Independent Dual',
  'tool.three_split': 'Independent Triple',
  'tool.four_split': 'Independent Quad',
  'tool.hyper_agent': 'Hyper-Agent',
  'hyper_agent.ready': 'Hyper-Agent started: your local OpenClaw / Hermes Agent now have super-admin privilege to view and command every window in Coffee CLI. Talk to OpenClaw / Hermes Agent through your social app — they become your CEO, leading the agent team to keep working.',
  'hyper_agent.first_time_hint': 'First time? Paste the following rule into your OpenClaw / Hermes Agent so they know how to drive your running agents:',
  'hyper_agent.show_setup_again': 'Show setup instruction again',
  'tool_config.command': 'Launch command',
  'tool_config.extra_args': 'Extra arguments',
  'tool_config.default_cwd': 'Launch directory',
  'tool_config.history_path': 'Session history directory',
  'tool_config.reset': 'Reset',
  'tool_config.cancel': 'Cancel',
  'tool_config.save': 'Save',

  // Remote Terminal
  'remote.title': 'Remote Terminal',
  'remote.host': 'Host',
  'remote.host_placeholder': 'e.g. 192.168.1.100',
  'remote.username': 'Username',
  'remote.password': 'Password',
  'remote.connect': 'Connect',
  'remote.connecting': 'Connecting...',
  'remote.connect_failed': 'Connection Failed',

  // Tab
  'tab.new': 'Select Tool',
  'chat.no_records': 'No readable conversation records found.',


  // Task Board
  'task.notes_placeholder': 'Add notes...',
  'task.section.working': 'In Progress',
  'task.section.todo': 'To-do',
  'task.section.done': 'Done',
  'task.greeting.morning': 'Morning, what\u2019s the plan?',
  'task.greeting.afternoon': 'Afternoon, anything left to do?',
  'task.greeting.evening': 'Evening. Feeling ambitious?',
  'task.tab.tasks': 'Tasks',
  'task.tab.changes': 'Changes',
  'changes.empty': 'No changes yet.',
  'diff.loading': 'Loading…',
  'diff.error': 'Failed to load diff',
  'diff.no_changes': 'Identical to baseline',
  'task.default_title': 'New Task',
  'task.search_sessions': 'Search sessions...',
  'menu.no_recent': 'No recent sessions found',
  'task.messages': '{count} messages',

  // Actions
  'action.resume_terminal': 'Continue this session',

  // Time
  'time.just_now': 'Just now',
  'time.today': 'Today',
  'time.yesterday': 'Yesterday',
  'time.days_ago': '{days} days ago',

  // Session
  'session.max': 'Maximum 5 sessions can be open at once.',

  // Theme Menu
  'theme.section.color': 'Colors',
  'theme.section.shape': 'Shape',
  'theme.section.icons': 'Icon Style',
  'theme.color.light': 'Light',
  'theme.color.dark': 'Dark',
  'theme.color.cappuccino': 'Code Dark',
  'theme.color.sakura': 'Sakura',
  'theme.color.lavender': 'Lavender',
  'theme.color.mint': 'Mint',
  'theme.color.obsidian': 'Obsidian',
  'theme.color.cobalt': 'Cobalt',
  'theme.color.moss': 'Moss',

  // Gambit — floating compose window. Chess term for a calculated opening move.
  'gambit.title': 'GAMBIT',
  'gambit.placeholder': 'Compose your move... (Ctrl+Enter to send, Enter for newline, paste images)',
  'gambit.send_failed_hint': 'Open an active session first',
  'gambit.send_empty_hint': 'Type a message or paste an image first (Ctrl+V)',

  // Contribution heatmap (above pinned cards on Desktop launchpad).
  'heatmap.title': '{sessions} sessions · {messages} messages',
  'heatmap.title_empty': 'Story not started yet — chat with an AI to light up your first square',
  'heatmap.legend_less': 'Less',
  'heatmap.legend_more': 'More',
  'heatmap.tooltip_some': '{count} messages on {date}',
  'heatmap.tooltip_one': '1 message on {date}',
  'heatmap.tooltip_none': 'No activity on {date}',

  // Skills panel toggle toasts
  'skills.toast.enabled': 'Restart the tool to take effect.',
  'skills.toast.disabled': 'Disabled — restart the tool to apply.',

} as const;

export type I18nKey = keyof typeof en;
