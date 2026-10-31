import type { ClaudeMode } from '../../store/app-state';

export function LaunchModeControl({ value = 'terminal', disabled = false, onChange, label: modeLabel, modes = ['terminal', 'conversation'] }: {
  value?: ClaudeMode; disabled?: boolean; onChange?: (mode: ClaudeMode) => void; label?: string;
  /** Tools with a single surface (DeepSeek Harness is desktop-only) list just that mode. */
  modes?: readonly ClaudeMode[];
}) {
  if (!onChange) return null;
  return <div className="launchpad-mode-tabs" role="group" aria-label={`${modeLabel ?? 'Claude'} launch mode`} lang="en" dir="ltr">
    {modes.map(mode => <button key={mode} type="button" className={value === mode ? 'is-selected' : ''} disabled={disabled} aria-pressed={value === mode} onClick={event => { event.stopPropagation(); onChange(mode); }}>{mode === 'terminal' ? 'Terminal' : 'Desktop'}</button>)}
  </div>;
}
