import { useEffect, useState } from 'react';
import { commands } from '../../tauri';
import { welcomeGreeting } from '../../lib/welcome-greeting';

let computerName: Promise<string> | undefined;

export function WelcomeSessionMeta({ cwd, model }: { cwd: string | null; model?: string }) {
  return <div className="claude-empty-meta">
    <span className="claude-empty-directory">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
      <bdi dir="ltr">{cwd || '—'}</bdi>
    </span>
    {model && <>
      <span className="claude-empty-separator" aria-hidden="true">·</span>
      <span className="claude-empty-model" dir="ltr">{model}</span>
    </>}
  </div>;
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
