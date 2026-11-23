import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { commands } from '../../tauri';
import { welcomeGreeting } from '../../lib/welcome-greeting';

let computerName: Promise<string> | undefined;

/** The folder and model under the greeting: the path speaks for itself, no folder icon to line up beside it. */
export function WelcomeSessionMeta({ cwd, model }: { cwd: string | null; model?: string }) {
  return <div className="claude-empty-meta">
    <span className="claude-empty-directory">
      <bdi dir="ltr">{cwd || '—'}</bdi>
    </span>
    {model && <>
      <span className="claude-empty-separator" aria-hidden="true">·</span>
      <span className="claude-empty-model" dir="ltr">{model}</span>
    </>}
  </div>;
}

/** Shown on the welcome screen while a resumed conversation's history is still loading; `mark` is the tool's own working animation. */
export function WelcomeRestoring({ mark, className, labelClassName, label }: { mark: ReactNode; className?: string; labelClassName?: string; label?: string }) {
  const t = useT();
  return <div className={`claude-empty-restoring${className ? ` ${className}` : ''}`} role="status">{mark}<span className={labelClassName}>{label ?? t('conversation.restoring')}</span></div>;
}

export function WelcomeGreeting() {
  const [name, setName] = useState('');
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    let mounted = true;
    computerName ??= commands.computerName().then(value => typeof value === 'string' ? value : '').catch(() => '');
    void computerName.then(value => { if (mounted) setName(value); });
    const update = () => setHour(new Date().getHours());
    const timer = setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => { mounted = false; clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
  return <div className="claude-empty-title" lang="en">{welcomeGreeting(hour, name)}</div>;
}
