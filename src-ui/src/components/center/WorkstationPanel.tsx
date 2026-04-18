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
import { isTauri, commands } from '../../tauri';
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

// Fallback values for the split second between mount and the first Tauri
// `detect_*` response, plus for non-Tauri environments (Vite dev preview).
const FALLBACK_AVAILABILITY: CliAvailability = {
  claude: false,
  codex: false,
  gemini: false,
  qwen: false,
};

const FALLBACK_RUNTIMES: RuntimeKind[] = [];

// Coerce a string coming back from Rust into our RuntimeKind union.
function asRuntime(s: string): RuntimeKind | null {
  return s === 'docker' || s === 'podman' || s === 'none' ? s : null;
}

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

  // Phase 3a: real host detection via Tauri. Falls back to placeholders
  // in non-Tauri environments (dev preview / tests). Detection runs once
  // on mount; Phase 3c may add manual "rescan" when user installs a CLI
  // without closing the app.
  const [availability, setAvailability] = useState<CliAvailability>(FALLBACK_AVAILABILITY);
  const [availableRuntimes, setAvailableRuntimes] = useState<RuntimeKind[]>(FALLBACK_RUNTIMES);

  useEffect(() => {
    if (!isTauri) return;
    commands.detectClis().then(a => setAvailability(a)).catch(() => {});
    commands.detectRuntimes().then(rs => {
      const kinds = rs.map(asRuntime).filter((x): x is RuntimeKind => x !== null);
      setAvailableRuntimes(kinds);
    }).catch(() => {});
  }, []);

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

    // Phase 3b: materialize the team directory tree on disk so the
    // paths shown in the activate dialog are real. Fire-and-forget —
    // failure surfaces as a toast but doesn't block the canvas.
    if (isTauri) {
      commands.createTeamFs(team.id, bp).catch(err => {
        showToast(`团队目录创建失败：${err}`);
      });
    }
  }, [showToast]);

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
        availableRuntimes={availableRuntimes}
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
            availability={availability}
            availableRuntimes={availableRuntimes}
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
