import { useEffect } from 'react';
import { useT } from '../../i18n/useT';
import { formatElapsed, formatTokens } from '../../lib/claude-i18n';
import { costOf, refreshModelPrices, type TokenUsage } from '../../lib/model-prices';

export interface TurnSummaryStats { durationMs?: number; usage: TokenUsage; model?: string; cost?: number }

const costKey = (session: string, message: string) => `cc-turn-cost:${session}:${message}`;
function savedCost(session: string, message: string): number | undefined {
  try { const value = Number(localStorage.getItem(costKey(session, message))); return Number.isFinite(value) && value > 0 ? value : undefined; } catch { return undefined; }
}

/**
 * The line under a turn's last message: how long it took, the tokens it used and what it cost. A tool's own figure for
 * a live turn is kept per session and message, so history shows it later; otherwise the cost is estimated from list
 * prices, and left out for a model with no price.
 */
export function TurnSummary({ stats, sessionKey, messageId, prefix }: { stats: TurnSummaryStats; sessionKey: string; messageId: string; prefix?: string }) {
  const t = useT();
  useEffect(() => { void refreshModelPrices(); }, []);
  useEffect(() => {
    if (!sessionKey || stats.cost === undefined || stats.cost <= 0) return;
    try { localStorage.setItem(costKey(sessionKey, messageId), String(stats.cost)); } catch { /* Best-effort operation; failure is non-fatal. */ }
  }, [sessionKey, messageId, stats.cost]);
  const { input, output, cacheRead = 0, cacheWrite = 0 } = stats.usage;
  const tokens = input + output + cacheRead + cacheWrite;
  const cost = stats.cost ?? (sessionKey ? savedCost(sessionKey, messageId) : undefined) ?? costOf(stats.model, stats.usage);
  return <div className="claude-turn-summary" role={prefix ? 'status' : undefined}>
    {[prefix, stats.durationMs !== undefined && t('claude.worked_for', { duration: formatElapsed(stats.durationMs, t) }), tokens > 0 && t('claude.tokens', { count: formatTokens(tokens) }),
      cost !== undefined && cost > 0 && `~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`].filter(Boolean).join(' · ')}
  </div>;
}
