// WorkstationPanel — Multi-agent CLI orchestration workspace.
// Placeholder scaffold. The full vision is a Docker-CLI agent farm where
// each agent runs in an isolated container and users can "attach" to any
// running agent to see its live pty — the killer differentiator vs. the
// GUI-wrapper multi-agent frameworks that only show dashboards.

import './WorkstationPanel.css';

interface Props {
  onExit: () => void;
}

export function WorkstationPanel({ onExit }: Props) {
  return (
    <div className="workstation-panel">
      <div className="workstation-hero">
        <div className="workstation-badge">WORKSTATION · PREVIEW</div>
        <h1 className="workstation-title">CLI Agent Orchestration</h1>
        <p className="workstation-subtitle">
          Spawn isolated CLI agents, chain them into teams, attach to any
          running agent to watch its real terminal.
        </p>

        <div className="workstation-pillars">
          <div className="workstation-pillar">
            <div className="workstation-pillar-num">01</div>
            <div className="workstation-pillar-title">Isolated Agents</div>
            <div className="workstation-pillar-desc">
              Each agent runs in its own CLI-only Docker container — independent
              skills, model, API keys, and MCP config.
            </div>
          </div>
          <div className="workstation-pillar">
            <div className="workstation-pillar-num">02</div>
            <div className="workstation-pillar-title">Multi-CLI Native</div>
            <div className="workstation-pillar-desc">
              Mix Claude Code, Codex, Gemini, and others in one team. Pick the
              right CLI per role.
            </div>
          </div>
          <div className="workstation-pillar">
            <div className="workstation-pillar-num">03</div>
            <div className="workstation-pillar-title">Live Attach</div>
            <div className="workstation-pillar-desc">
              Click any working agent to see its live pty. The terminal is the
              truth — no translation layer, no lossy summary.
            </div>
          </div>
        </div>

        <div className="workstation-empty">
          <div className="workstation-empty-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </div>
          <div className="workstation-empty-title">No agent teams yet</div>
          <div className="workstation-empty-hint">
            Team blueprints, agent spawning, and the attach UX land here as we build.
          </div>
        </div>
      </div>

      <button className="workstation-exit" onClick={onExit} title="Back to tools">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        <span>Back</span>
      </button>
    </div>
  );
}
