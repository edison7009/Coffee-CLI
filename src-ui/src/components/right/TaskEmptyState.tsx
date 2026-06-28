// Empty-state greeting for the task board — shared by both the to-do list
// view and the sticky-note view. Time-of-day aware (sun/moon + greeting).
// Extracted from TaskBoard so the two views render an identical empty state
// without duplicating the IIFE.

import type { ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';

export function TaskEmptyState() {
  const t = useT();
  const { state } = useAppState();
  const isZh = state.currentLang.startsWith('zh');

  const hour = new Date().getHours();
  let greeting: string;
  let icon: ReactNode;

  const sunIcon = (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
  const moonIcon = (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );

  if (hour >= 5 && hour < 12) {
    greeting = t('task.greeting.morning');
    icon = sunIcon;
  } else if (hour >= 12 && hour < 18) {
    greeting = t('task.greeting.afternoon');
    icon = sunIcon;
  } else {
    greeting = t('task.greeting.evening');
    icon = moonIcon;
  }

  return (
    <div className="task-empty">
      <div className="task-empty-icon">{icon}</div>
      <div
        className="task-empty-text"
        style={isZh ? { fontFamily: 'var(--font, system-ui)', fontStyle: 'normal', fontWeight: 400, letterSpacing: '0.08em' } : undefined}
      >
        {greeting}
      </div>
    </div>
  );
}
