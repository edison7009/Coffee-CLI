// TeamBar — the top strip of Workstation.
//
// Left: host info + capacity gauge (what SystemStats used to show).
// Right: chips for each created team + a "+" button that takes the user
// back to the template library.
//
// Replaces the internal "团队 / 模板库" tabs (they were redundant) and
// the separate bottom SystemStats row.

import type { TeamState, RuntimeKind } from './types';
import { findBlueprint } from './blueprints';

interface Props {
  teams: TeamState[];
  activeTeamId: string | null;
  availableRuntimes: RuntimeKind[];
  activeLocalAgents: number;
  onPickTeam: (id: string) => void;
  onNewTeam: () => void;
}

function readHostInfo() {
  const cores = navigator.hardwareConcurrency ?? 4;
  const ramGb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const platform = navigator.userAgent.toLowerCase().includes('mac') ? 'macOS'
                  : navigator.userAgent.toLowerCase().includes('win') ? 'Windows'
                  : 'Linux';
  const estMax = Math.max(3, Math.floor((ramGb - 4) * 1000 / 300));
  return { cores, ramGb, platform, estMax };
}

function teamIcon(team: TeamState): string {
  const bp = findBlueprint(team.blueprintId);
  return bp?.icon ?? '✨';
}

export function TeamBar({
  teams,
  activeTeamId,
  availableRuntimes,
  activeLocalAgents,
  onPickTeam,
  onNewTeam,
}: Props) {
  const { cores, ramGb, platform, estMax } = readHostInfo();
  const ratio = activeLocalAgents / estMax;
  const isNearLimit = ratio >= 0.7;
  const isAtLimit = activeLocalAgents >= estMax;
  const gaugeClass = isAtLimit ? 'full' : isNearLimit ? 'warn' : 'ok';

  return (
    <div className="team-bar">
      <div className="team-bar-host">
        <span className="team-bar-spec">
          {platform} · {ramGb} GB · {cores} 核
        </span>
        <span className="team-bar-divider">|</span>
        <span className="team-bar-capacity">
          {activeLocalAgents} / {estMax} 岗位
        </span>
        <div className={`team-bar-gauge team-bar-gauge--${gaugeClass}`}>
          <div
            className="team-bar-gauge-fill"
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
        {availableRuntimes.length === 0 && (
          <span className="team-bar-runtime-warn">· 未检测到容器 runtime</span>
        )}
      </div>

      <div className="team-bar-teams">
        {teams.length > 0 && (
          <div className="team-bar-teams-list">
            {teams.map(t => (
              <button
                key={t.id}
                className={`team-chip ${t.id === activeTeamId ? 'active' : ''}`}
                onClick={() => onPickTeam(t.id)}
                title={t.name}
              >
                <span className="team-chip-icon">{teamIcon(t)}</span>
                <span className="team-chip-name">{t.name}</span>
              </button>
            ))}
          </div>
        )}
        <button
          className="team-chip team-chip--new"
          onClick={onNewTeam}
          title={teams.length === 0 ? '选择一个模板' : '新建团队'}
        >
          <span className="team-chip-icon">＋</span>
          <span className="team-chip-name">
            {teams.length === 0 ? '选择模板' : '新建'}
          </span>
        </button>
      </div>
    </div>
  );
}
