export const en = {
  'app.title': 'Coffee CLI',
  // Explorer
  'explorer.tab.computer': 'My Computer',
  'explorer.tab.workspace': 'Workspace',

  // Context Menu
  'menu.copy_abs': 'Copy Absolute Path',
  'menu.copy_rel': 'Copy Relative Path',
  'menu.copy_ref': 'Copy as @reference',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
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

  // Island
  'island.status.working': 'Thinking...',
  'island.status.wait_input': 'Waiting for input',
  'island.status.idle': 'Waiting for input', // fallback: same as wait_input

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

  // Arcade Games
  'game.pal': 'Sword and Fairy',
  'game.redalert': 'Red Alert',
  'game.doom': 'DOOM',
  'game.richman3': 'Richman 3',
  'game.simcity2000': 'SimCity 2000',

} as const;

export type I18nKey = keyof typeof en;
