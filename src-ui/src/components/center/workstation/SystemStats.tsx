// SystemStats — the quiet status bar at the bottom of Workstation.
//
// Tells the user their machine's rough capacity (ram / cores / how many
// agents it can host). When they approach the limit, a gentle nudge
// suggests adding a remote host.
//
// Phase 1 uses browser APIs + placeholder values. Phase 3 replaces with
// a Tauri command that reads real host specs.

import type { RuntimeKind } from './types';

interface Props {
  activeLocalAgents: number;
  availableRuntimes: RuntimeKind[];
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

export function SystemStats({ activeLocalAgents, availableRuntimes }: Props) {
  const { cores, ramGb, platform, estMax } = readHostInfo();
  const ratio = activeLocalAgents / estMax;
  const isNearLimit = ratio >= 0.7;
  const isAtLimit = activeLocalAgents >= estMax;
  const barClass = isAtLimit ? 'full' : isNearLimit ? 'warn' : 'ok';

  return (
    <div className={`system-stats system-stats--${barClass}`}>
      <div className="system-stats-left">
        <span className="system-stats-spec">
          {platform} · {ramGb} GB · {cores} 核
        </span>
        <span className="system-stats-divider">|</span>
        <span className="system-stats-capacity">
          本地岗位：{activeLocalAgents} / {estMax}
        </span>
      </div>

      <div className="system-stats-bar">
        <div
          className="system-stats-bar-fill"
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>

      <div className="system-stats-right">
        {availableRuntimes.length === 0 ? (
          <span className="system-stats-hint system-stats-hint--warn">
            未检测到容器 runtime · 激活前装一个 Podman 或 Docker
          </span>
        ) : isAtLimit ? (
          <span className="system-stats-hint system-stats-hint--warn">
            本地已满 · 考虑加远程主机
          </span>
        ) : isNearLimit ? (
          <span className="system-stats-hint">
            接近上限 · 可以加远程岗位分担
          </span>
        ) : (
          <span className="system-stats-hint">
            runtime: {availableRuntimes.join(' · ')}
          </span>
        )}
      </div>
    </div>
  );
}
