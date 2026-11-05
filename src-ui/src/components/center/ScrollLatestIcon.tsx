import type { ReactNode } from 'react';

const ARROW_PATH = 'M8 2v11M3 8l5 5 5-5';

/**
 * Icon of the "jump to latest" button. While the tool is working, `working`
 * (its own thinking mark) is shown; hovering swaps it back to the plain down
 * arrow, so the button always reads as a button under the pointer. The swap
 * is CSS-only (see `.claude-scroll-bottom` in ClaudeConversation.css).
 */
export function ScrollLatestIcon({ working }: { working?: ReactNode }) {
  const arrow = (
    <svg className={working ? 'scroll-latest-arrow' : undefined} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={ARROW_PATH} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  if (!working) return arrow;
  return <><span className="scroll-latest-working">{working}</span>{arrow}</>;
}
