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
  'library.agent_tools': 'Agent Tools',
  'sentinel.protocol': 'Sentinel Protocol',
  'tool.two_split': 'Independent Dual',
  'tool.three_split': 'Independent Triple',
  'tool.four_split': 'Independent Quad',
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
  'launchpad.open_folder': 'Open Folder',
  'changes.clean': 'No changes — working tree clean.',
  'changes.no_git': 'Git is not installed — code diff, branches and other git features are unavailable.',
  'changes.not_repo': 'This folder is not a Git repository.',
  'changes.init_here': 'Initialize Git here',
  'changes.initializing': 'Initializing…',
  'changes.staged': 'Staged',
  'changes.unstaged': 'Unstaged',
  'changes.untracked': 'Untracked',
  'diff.loading': 'Loading…',
  'diff.error': 'Failed to load diff',
  'diff.no_changes': 'No changes',
  'diff.too_large': 'File too large to show inline diff',
  'diff.unchanged_lines': '⋯ {count} unchanged lines',
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

  // Settings modal (titlebar gear)
  'settings.title': 'Settings',
  'settings.appearance': 'Appearance',
  'settings.wallpaper': 'Wallpaper',
  'settings.terminal': 'Terminal',
  'settings.language': 'Language',
  'settings.wallpaper.pick': 'Choose image or video',
  'settings.wallpaper.clear': 'Remove wallpaper',
  'settings.wallpaper.opacity': 'Opacity',
  'settings.terminal.scheme': 'Text color',
  'settings.terminal.font': 'Font',
  'settings.terminal.font.default': 'Default (bundled)',
  'settings.font.monospace': 'Monospace',
  'settings.font.other': 'Other fonts',
  'settings.font.search': 'Search fonts…',
  'settings.gambit': 'Gambit',
  'settings.send.title': 'Send message',
  'settings.send.newline': 'for a new line',
  'settings.gambit.hotkey': 'Toggle shortcut',
  // Task board form (to-do list vs sticky notes)
  'settings.tasks': 'Tasks',
  'settings.tasks.view': 'Task style',
  'task.view.list': 'To-do List',
  'task.view.note': 'Sticky Notes',
  'task.view.list.sub': 'Compact checklist, tick off one by one',
  'task.view.note.sub': 'Roomy notes — jot freely, send the whole thing',
  'task.note_placeholder': 'Jot something down, send it all to your agent…',
  // Seeded once for brand-new users as a roomy welcome note (sticky-note view).
  'task.welcome_note': `Welcome to Coffee CLI ☕

This is a sticky note — jot anything down, then hit ▶ (top-right) to send the whole thing to your AI. No more cramped little input box.

Three steps to start:
1. Pick a tool in the middle (Claude / Codex / OpenCode…), choose a folder, and you're off
2. The three dots set priority (red / amber / green) and auto-sort; drag the bottom edge to resize the note
3. "Changes" (top-right) shows which files the AI touched; Settings has themes, language, and the To-do / Sticky-note switch

Delete this note whenever you're ready, and start your first task.`,
  'task.show_guide': 'View the usage guide',

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
  'theme.color.crimson': 'Crimson',
  'theme.color.sunset': 'Sunset',
  'theme.color.amber': 'Amber',
  'theme.color.emerald': 'Emerald',
  'theme.color.teal': 'Teal',
  'theme.color.indigo': 'Indigo',
  'theme.color.fuchsia': 'Fuchsia',

  // Gambit — floating compose window. Chess term for a calculated opening move.
  'gambit.title': 'GAMBIT',
  'gambit.placeholder': 'Compose your move... ({send} to send, {newline} for newline, paste images)',
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
  'skills.toast.enabled': 'Enabled',
  'skills.toast.disabled': 'Disabled',

} as const;

export type I18nKey = keyof typeof en;
