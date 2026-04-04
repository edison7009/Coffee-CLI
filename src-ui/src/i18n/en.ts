export const en = {
  // Explorer
  'explorer.watching': 'Watching - {n} files',
  'explorer.no_folder': 'No folder open',

  // Tab
  'tab.new': 'Select Tool',

  // Island
  'island.status.working': 'Thinking...',
  'island.status.wait_input': 'Waiting for input',
  'island.status.idle': 'Waiting for input', // fallback: same as wait_input

  // Builder (right panel)
  'goal.placeholder': 'Describe what you want to build or change...',
} as const;

export type I18nKey = keyof typeof en;
