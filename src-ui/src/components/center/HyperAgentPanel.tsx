// Hyper-Agent panel — minimal status view for the cross-tab admin MCP
// server that OpenClaw / Hermes Agent connect to.
//
// Architecture:
//   User → IM → OpenClaw / Hermes Agent (running anywhere on machine)
//                    ↓ MCP @ http://127.0.0.1:<stable port>/mcp
//                Coffee-CLI's Hyper-Agent anonymous MCP server
//                    ↓ existing send_to_pane (writes to PTY stdin)
//             Claude Code / Codex CLI / Gemini / ... panes (cross-tab)
//
// From a target pane's POV the dispatched text arrives as plain stdin —
// indistinguishable from human typing through Coffee-CLI's UI / Gambit.
// Zero modification needed on the target side.
//
// This panel does just three things:
//   1. Auto-start the MCP server on tab open (idempotent)
//   2. Show its endpoint URL + status
//   3. Show a copy-paste-ready instruction to give to OpenClaw /
//      Hermes Agent so their LLM knows the cross-tab dispatch pattern
//
// Setup is one-time per machine: register the URL in OpenClaw / Hermes
// configs (we do this automatically) + paste the rule into them once.

import { useEffect, useMemo, useState } from 'react';
import { commands, type McpEndpoint } from '../../tauri';
import { useT } from '../../i18n/useT';
import { clipboardWrite } from '../../lib/clipboard';

function buildSetupInstruction(mcpUrl: string): string {
  return `[Permanent rule — please save to your memory and follow forever]

You are running on a user's machine that also runs Coffee-CLI. Coffee-CLI's window shows a row of tabs at the top. Each tab is EITHER a single AI CLI session (Claude Code / Codex / Gemini / OpenCode / ...) OR a multi-agent tab containing 2–4 such CLIs side-by-side as panes in a grid. The user keeps these CLIs running for hours/days; their conversation context and current task state persist inside them.

You talk to Coffee-CLI through its MCP server at ${mcpUrl} (registered as "coffee-cli"). Verify you have its tools — list_panes / read_pane / send_to_pane — available.

  - If you're OpenClaw, Coffee-CLI already wrote the entry into your config. The tools should be there once you restart.
  - If you're Hermes Agent, run this in your shell once to register, then restart your session:
        hermes mcp add coffee-cli --url ${mcpUrl}
    (skip the auth prompt — it's a local loopback server with no auth — and accept all tools when asked.)
  - Any other orchestrator: add an HTTP/streamable MCP server pointing at ${mcpUrl}.

Whenever the user asks you (via social-app message or otherwise) to:
  - check on / read from one of their running agents
  - send a follow-up instruction to a specific agent
  - dispatch a new task to one of the running CLIs in their team

you MUST use the coffee-cli MCP server's tools:

  - list_panes()           — returns one row per running agent across the whole Coffee-CLI window. A single-CLI tab contributes one row; a multi-agent tab contributes one row per pane. Each row has id (e.g. "pane-2"), cli (claude/codex/gemini/...), state (idle/busy).
  - read_pane(id, n)       — read recent N lines of that agent's output.
  - send_to_pane(id, text) — write text to that agent's stdin. The receiving CLI sees it as if the user typed it (it cannot tell whether the input came from the user's keyboard, from Coffee-CLI's compose box, or from you).

Important context:
  - The receiving CLI does not know you exist. If continuity matters (e.g. you're following up on yesterday's session), put enough context in the message itself.
  - list_panes spans every tab. Pick the right target by id + cli — don't assume there's only one Codex or only one Claude.

Save this rule permanently to your memory.`;
}

interface Props {
  hasBg: boolean;
  bgUrl: string;
  bgType: 'image' | 'video' | 'none';
}

export function HyperAgentPanel({ hasBg, bgUrl, bgType }: Props) {
  const t = useT();
  const [endpoint, setEndpoint] = useState<McpEndpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Remember whether the user has copied the setup instruction at least
  // once. After that, the heavy "first time? paste this" card collapses
  // away on subsequent opens — the rule is already in OpenClaw / Hermes
  // Agent's memory, no need to re-paste. Small "show again" link below
  // the banner brings it back if the user wants to re-copy.
  const [setupDismissed, setSetupDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cc-hyper-agent-setup-done') === '1';
    } catch {
      return false;
    }
  });

  const setupText = useMemo(
    () => (endpoint ? buildSetupInstruction(endpoint.url) : ''),
    [endpoint],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Server starts + registrations run in background. We only
        // care about success/failure for the banner state; the URL,
        // port, and per-agent registration outcomes are technical
        // plumbing the user doesn't need to see.
        const status = await commands.startHyperAgentServer();
        if (!cancelled) setEndpoint(status.endpoint);
      } catch (e: unknown) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const copySetup = async () => {
    if (!setupText) return;
    try {
      await clipboardWrite(setupText);
      setCopied(true);
      // Mark as done — next tab open won't show the heavy card.
      try { localStorage.setItem('cc-hyper-agent-setup-done', '1'); } catch {}
      setTimeout(() => {
        setCopied(false);
        setSetupDismissed(true);
      }, 1500);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[hyper-agent] copy failed:', e);
    }
  };

  const showSetupAgain = () => {
    try { localStorage.removeItem('cc-hyper-agent-setup-done'); } catch {}
    setSetupDismissed(false);
  };

  return (
    <div
      className={`hyper-agent-panel${hasBg && bgUrl ? ' has-bg' : ''}`}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-mono, ui-monospace, Menlo, Consolas, monospace)',
        fontSize: '14px',
        overflow: 'hidden',
      }}
    >
      {hasBg && bgUrl && (
        <div className="launchpad-bg" style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
          {bgType === 'video'
            ? <video src={bgUrl} autoPlay loop muted playsInline />
            : <img src={bgUrl} alt="" />}
        </div>
      )}

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          padding: '20px 28px',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          gap: 18,
          overflowY: 'auto',
        }}
      >
        {/* Banner */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: '15px', lineHeight: 1.6 }}>
          <span style={{
            width: 9, height: 9, borderRadius: '50%',
            background: error ? '#c44' : endpoint ? '#3aa84a' : '#888',
            boxShadow: error ? '0 0 8px #c44' : endpoint ? '0 0 8px #3aa84a' : 'none',
            marginTop: 8, flexShrink: 0,
          }} />
          <div style={{ flex: 1 }}>
            {error
              ? <span>{error}</span>
              : endpoint
                ? <span>{t('hyper_agent.ready' as any)}</span>
                : null}
            {/* Re-show link when the heavy setup card is collapsed.
                Subtle — only takes one line of text after the banner. */}
            {endpoint && setupDismissed && (
              <div style={{ marginTop: 10, fontSize: '12.5px', opacity: 0.55 }}>
                <button
                  onClick={showSetupAgain}
                  style={{
                    background: 'none',
                    border: 0,
                    padding: 0,
                    color: 'inherit',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    fontSize: 'inherit',
                    fontFamily: 'inherit',
                    opacity: 0.85,
                  }}
                >
                  {t('hyper_agent.show_setup_again' as any)}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Endpoint card removed 2026-04-30 per user feedback —
            URL/port/pid/registration status are technical plumbing the
            user doesn't need to see. The MCP server still runs and is
            still registered with OpenClaw / Hermes Agent (background
            registration always happens), they just don't see it.

            (`endpoint.url` etc remain available in state for potential
            future "advanced details" disclosure.) */}

        {/* First-time hint card — only shown until user copies the
            setup instruction once. After that, dismissed via
            localStorage; user can bring it back via "show again" link.
            No internal scroll cap — the SETUP_INSTRUCTION is fixed
            length, this Tab has plenty of vertical room (no other
            chrome competes for it), so render the whole thing in one
            go. Outer container scrolls if viewport is too short. */}
        {endpoint && !setupDismissed && (
          <div
            style={{
              border: '1px solid var(--border, rgba(255,255,255,0.12))',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.22)',
              padding: '14px 16px',
              fontSize: '13.5px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <span style={{ opacity: 0.85, lineHeight: 1.5 }}>{t('hyper_agent.first_time_hint' as any)}</span>
              <button
                onClick={copySetup}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: copied ? 'rgba(58, 168, 74, 0.2)' : 'rgba(255,255,255,0.08)',
                  color: copied ? '#3aa84a' : 'inherit',
                  border: '1px solid var(--border, rgba(255,255,255,0.15))',
                  borderRadius: 4,
                  cursor: 'pointer',
                  flexShrink: 0,
                  lineHeight: 0,
                }}
              >
                {copied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="5 12 10 17 19 7" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
                  </svg>
                )}
              </button>
            </div>
            <pre
              style={{
                margin: 0,
                padding: '4px 2px 0',
                fontSize: '12.5px',
                lineHeight: 1.65,
                opacity: 0.85,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'inherit',
              }}
            >{setupText}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
