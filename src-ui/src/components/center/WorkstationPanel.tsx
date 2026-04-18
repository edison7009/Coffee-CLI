// WorkstationPanel — Phase 1 shell.
//
// Orchestrates three views:
//   - TemplateLibrary: grid of blueprints
//   - WorkstationCanvas: react-flow view for an active team
//   - SystemStats: persistent footer showing host capacity
//
// All state lives in this component for Phase 1. Phase 3 will lift the
// team list into Coffee CLI's global AppState so it survives reloads
// and plugs into Docker lifecycle.

import { useState, useMemo, useCallback } from 'react';
import { TemplateLibrary } from './workstation/TemplateLibrary';
import { WorkstationCanvas } from './workstation/WorkstationCanvas';
import { SystemStats } from './workstation/SystemStats';
import type {
  Blueprint,
  TeamState,
  CliAvailability,
  RuntimeKind,
} from './workstation/types';
import './workstation/workstation.css';

interface Props {
  onExit: () => void;
}

// Phase 1 placeholder. Phase 3 replaces with Tauri `detect_clis()` command.
const PLACEHOLDER_AVAILABILITY: CliAvailability = {
  claude: true,
  codex: true,
  gemini: false,
  qwen: false,
};

// Phase 1 placeholder. Phase 3 replaces with real runtime probing.
const PLACEHOLDER_RUNTIMES: RuntimeKind[] = ['podman', 'docker'];

type ViewTab = 'teams' | 'library';

function makeTeamFromBlueprint(bp: Blueprint, defaultRuntime: RuntimeKind | null): TeamState {
  return {
    id: `team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    blueprintId: bp.id,
    name: bp.name,
    runtime: defaultRuntime,
    nodes: bp.nodes.map(n => ({
      id: n.id,
      name: n.name,
      hint: n.hint,
      position: n.position,
      status: 'inactive' as const,
    })),
    edges: bp.edges.map(e => ({ source: e.source, target: e.target })),
  };
}

export function WorkstationPanel({ onExit: _onExit }: Props) {
  const [teams, setTeams] = useState<TeamState[]>([]);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [tab, setTab] = useState<ViewTab>('library');
  const [toast, setToast] = useState<string | null>(null);

  const activeTeam = useMemo(
    () => teams.find(t => t.id === activeTeamId) ?? null,
    [teams, activeTeamId],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  const handlePickTemplate = useCallback((bp: Blueprint) => {
    const defaultRuntime = PLACEHOLDER_RUNTIMES[0] ?? null;
    const team = makeTeamFromBlueprint(bp, defaultRuntime);
    setTeams(prev => [...prev, team]);
    setActiveTeamId(team.id);
    setTab('teams');
  }, []);

  const handleTeamChange = useCallback((updated: TeamState) => {
    setTeams(prev => prev.map(t => t.id === updated.id ? updated : t));
  }, []);

  const handleBackToLibrary = useCallback(() => {
    setTab('library');
  }, []);

  const activeLocalAgents = useMemo(
    () => teams.reduce((acc, t) =>
      acc + t.nodes.filter(n => n.status === 'active' || n.status === 'activating').length
    , 0),
    [teams],
  );

  return (
    <div className="workstation-root">
      <div className="workstation-tabs">
        <button
          className={`workstation-tab ${tab === 'teams' ? 'active' : ''}`}
          onClick={() => setTab('teams')}
          disabled={teams.length === 0}
        >
          团队
          {teams.length > 0 && (
            <span className="workstation-tab-count">{teams.length}</span>
          )}
        </button>
        <button
          className={`workstation-tab ${tab === 'library' ? 'active' : ''}`}
          onClick={() => setTab('library')}
        >
          模板库
        </button>
      </div>

      <div className="workstation-body">
        {tab === 'library' && (
          <TemplateLibrary onPick={handlePickTemplate} />
        )}
        {tab === 'teams' && activeTeam && (
          <WorkstationCanvas
            team={activeTeam}
            availability={PLACEHOLDER_AVAILABILITY}
            availableRuntimes={PLACEHOLDER_RUNTIMES}
            onTeamChange={handleTeamChange}
            onBackToLibrary={handleBackToLibrary}
            onToast={showToast}
          />
        )}
        {tab === 'teams' && !activeTeam && (
          <TemplateLibrary onPick={handlePickTemplate} />
        )}
      </div>

      <SystemStats
        activeLocalAgents={activeLocalAgents}
        availableRuntimes={PLACEHOLDER_RUNTIMES}
      />

      {toast && (
        <div className="toast-notification" style={{ bottom: 52, top: 'auto' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
