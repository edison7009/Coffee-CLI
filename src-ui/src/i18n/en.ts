export const en = {
  'app.title': 'Coffee CLI',
  // Explorer
  'explorer.tab.computer': 'My Computer',
  'explorer.tab.workspace': 'Workspace',
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

  // Drive kinds (Quick Access)
  'drive.desktop': 'Desktop',
  'drive.downloads': 'Downloads',
  'drive.documents': 'Documents',
  'drive.pictures': 'Pictures',
  'drive.music': 'Music',
  'drive.videos': 'Videos',
  'drive.home': 'Home',
  'drive.drive': '{label}: Drive',
  'drive.root': 'Root (/)',
  'drive.volume': '{label}',

  // Tools
  'tool.terminal': 'Terminal',
  'tool.remote': 'Remote Terminal',
  'tool.remote.short': 'Remote',
  'tool.installer': 'Installer',
  'tool.vibeid': 'Personality Test',
  'tool.insights_prerun': 'Generating Usage Report...',
  'tool.multi_agent': 'Multi-Agent',
  'vibeid.need_insights_confirm': 'Personality Test needs your Claude Code usage report first.\n\nThe app will auto-run /insights now (takes about 1-2 minutes), then run the VibeID test automatically.\n\nContinue?',
  'vibeid.insights_timeout': 'Report generation took too long. Please try again, or run /insights manually in a Claude Code tab.',

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


  // Task Board
  'task.input_placeholder': 'Write a task...',
  'task.notes_placeholder': 'Add notes...',
  'task.section.working': 'In Progress',
  'task.section.todo': 'To-do',
  'task.section.done': 'Done',
  'task.greeting.morning': 'Morning, what\u2019s the plan?',
  'task.greeting.afternoon': 'Afternoon, anything left to do?',
  'task.greeting.evening': 'Evening. Feeling ambitious?',
  'task.tab.tasks': 'Tasks',
  'task.tab.sessions': 'History',
  'task.default_title': 'New Task',
  'task.search_sessions': 'Search sessions...',
  'menu.no_recent': 'No recent sessions found',
  'task.turns': '{count} turns',

  // Actions
  'action.close': 'Close',
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

  // Mode switch button (bottom-right): enter Arcade games / return to tools.
  'mode.take_a_break': 'Take a break',
  'mode.back_to_work': 'Back to work',

} as const;

export type I18nKey = keyof typeof en;
