// WorkstationPanel — Phase 1 shell.
//
// Layout:
//   ┌─ TeamBar (top): host info + team chips + "+" new ─┐
//   │                                                    │
//   │   TemplateLibrary  OR  WorkstationCanvas           │
//   │                                                    │
//   └────────────────────────────────────────────────────┘
//
// No internal tabs (TeamBar does the switching). Phase 3 will lift the
// team list into Coffee CLI's global AppState.

import { useState, useMemo, useCallback, useEffect } from 'react';
import { TemplateLibrary } from './workstation/TemplateLibrary';
import { WorkstationCanvas } from './workstation/WorkstationCanvas';
import { TeamBar } from './workstation/TeamBar';
import { findBlueprint } from './workstation/blueprints';
import type {
  Blueprint,
  TeamState,
  CliAvailability,
  RuntimeKind,
} from './workstation/types';
import './workstation/workstation.css';

export interface WorkstationActiveTeamInfo {
  name: string;
  icon: string;
}

interface Props {
  onExit: () => void;
  onActiveTeamChange?: (info: WorkstationActiveTeamInfo | null) => void;
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

function makeTeamFromBlueprint(bp: Blueprint): TeamState {
  return {
    id: `team-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    blueprintId: bp.id,
    name: bp.name,
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

export function WorkstationPanel({ onExit: _onExit, onActiveTeamChange }: Props) {
  const [teams, setTeams] = useState<TeamState[]>([]);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  const activeTeam = useMemo(
    () => teams.find(t => t.id === activeTeamId) ?? null,
    [teams, activeTeamId],
  );

  // Report the active team back to the parent (so the outer tab title
  // can follow the selected team's icon and name).
  useEffect(() => {
    if (!onActiveTeamChange) return;
    if (showLibrary || !activeTeam) {
      onActiveTeamChange(null);
      return;
    }
    const bp = findBlueprint(activeTeam.blueprintId);
    onActiveTeamChange({
      name: activeTeam.name,
      icon: bp?.icon ?? '✨',
    });
  }, [activeTeam, showLibrary, onActiveTeamChange]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  const handlePickTemplate = useCallback((bp: Blueprint) => {
    const team = makeTeamFromBlueprint(bp);
    setTeams(prev => [...prev, team]);
    setActiveTeamId(team.id);
    setShowLibrary(false);
  }, []);

  const handleTeamChange = useCallback((updated: TeamState) => {
    setTeams(prev => prev.map(t => t.id === updated.id ? updated : t));
  }, []);

  const handlePickTeam = useCallback((id: string) => {
    setActiveTeamId(id);
    setShowLibrary(false);
  }, []);

  const handleNewTeam = useCallback(() => {
    setShowLibrary(true);
  }, []);

  const activeLocalAgents = useMemo(
    () => teams.reduce((acc, t) =>
      acc + t.nodes.filter(n => n.status === 'active' || n.status === 'activating').length
    , 0),
    [teams],
  );

  return (
    <div className="workstation-root">
      <TeamBar
        teams={teams}
        activeTeamId={showLibrary ? null : activeTeamId}
        availableRuntimes={PLACEHOLDER_RUNTIMES}
        activeLocalAgents={activeLocalAgents}
        onPickTeam={handlePickTeam}
        onNewTeam={handleNewTeam}
      />

      <div className="workstation-body">
        {showLibrary || !activeTeam ? (
          <TemplateLibrary onPick={handlePickTemplate} />
        ) : (
          <WorkstationCanvas
            team={activeTeam}
            availability={PLACEHOLDER_AVAILABILITY}
            availableRuntimes={PLACEHOLDER_RUNTIMES}
            onTeamChange={handleTeamChange}
            onToast={showToast}
          />
        )}
      </div>

      {toast && (
        <div className="toast-notification" style={{ bottom: 52, top: 'auto' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
