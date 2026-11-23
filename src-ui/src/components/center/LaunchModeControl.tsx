import type { ClaudeMode } from '../../store/app-state';
import { useT } from '../../i18n/useT';

/** How a card opens its tool: as the IDE-style desktop conversation or in the tool's own native terminal. */
export function LaunchModeControl({ value = 'terminal', disabled = false, onChange, label: modeLabel, modes = ['conversation', 'terminal'] }: {
  value?: ClaudeMode; disabled?: boolean; onChange?: (mode: ClaudeMode) => void; label?: string;
  /** Tools with a single surface (DeepSeek Harness is desktop-only) list just that mode. */
  modes?: readonly ClaudeMode[];
}) {
  const t = useT();
  if (!onChange) return null;
  return <div className="launchpad-mode-tabs" role="group" aria-label={`${modeLabel ?? 'Claude'} launch mode`}>
    {/* Short on the card (IDE / CLI) so a long folder beside it still fits; it announces that word with the full name ("CLI · 原生终端"; the desktop name already holds "IDE"). */}
    {modes.map(mode => <button key={mode} type="button" className={value === mode ? 'is-selected' : ''} disabled={disabled} aria-pressed={value === mode} aria-label={mode === 'terminal' ? `CLI · ${t('tools.mode.terminal')}` : t('tools.mode.desktop')} onClick={event => { event.stopPropagation(); onChange(mode); }}>{mode === 'terminal' ? 'CLI' : 'IDE'}</button>)}
  </div>;
}
