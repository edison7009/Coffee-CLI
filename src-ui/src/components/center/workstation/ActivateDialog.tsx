// ActivateDialog — shown when the user clicks an inactive card.
//
// Two questions only:
//   1) Which CLI do you want?
//   2) Where do you want it deployed (host / Podman / Docker)?
//
// On activation, we always copy the host's CLI-specific config directory
// into the container. Users tweak, clear, or rebuild anything inside —
// that's content, not ours to manage.

import { useState } from 'react';
import type { CliKind, CliAvailability, RuntimeKind } from './types';

interface Props {
  roleName: string;
  availability: CliAvailability;
  availableRuntimes: RuntimeKind[];
  onConfirm: (cli: CliKind, runtime: RuntimeKind) => void;
  onCancel: () => void;
}

const CLI_OPTIONS: Array<{ id: CliKind; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex',  label: 'Codex CLI' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'qwen',   label: 'Qwen Code' },
];

// All deployment options are always shown (matches the CLI row's pattern).
// Install status badges mirror the CLI section. 'none' is always available
// so it has no badge — it's the "just run it on my machine" escape hatch.
const RUNTIME_OPTIONS: Array<{ id: RuntimeKind; label: string; alwaysOn?: true }> = [
  { id: 'none',   label: '不使用容器', alwaysOn: true },
  { id: 'podman', label: 'Podman' },
  { id: 'docker', label: 'Docker' },
];

export function ActivateDialog({
  roleName,
  availability,
  availableRuntimes,
  onConfirm,
  onCancel,
}: Props) {
  const firstInstalled = CLI_OPTIONS.find(o => availability[o.id])?.id ?? 'claude';
  const [cli, setCli] = useState<CliKind>(firstInstalled);
  // Prefer an installed container runtime; fall back to 'none' (always on).
  const installedRuntime = availableRuntimes.find(r => r !== 'none');
  const [runtime, setRuntime] = useState<RuntimeKind>(installedRuntime ?? 'none');

  const selectedInstalled = availability[cli];
  // 'none' is always a valid choice, so confirm is only blocked on missing CLI.
  const canConfirm = selectedInstalled;
  const runtimeInstalled = (id: RuntimeKind): boolean =>
    id === 'none' ? true : availableRuntimes.includes(id);

  return (
    <div className="activate-dialog-backdrop" onClick={onCancel}>
      <div className="activate-dialog" onClick={e => e.stopPropagation()}>
        <div className="activate-dialog-header">
          <span className="activate-dialog-title">激活 &quot;{roleName}&quot;</span>
          <button className="activate-dialog-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="activate-dialog-section">
          <div className="activate-dialog-section-label">选择 CLI</div>
          {CLI_OPTIONS.map(opt => {
            const installed = availability[opt.id];
            return (
              <label
                key={opt.id}
                className={`activate-dialog-option ${!installed ? 'activate-dialog-option--disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="cli"
                  value={opt.id}
                  checked={cli === opt.id}
                  onChange={() => installed && setCli(opt.id)}
                  disabled={!installed}
                />
                <span className="activate-dialog-option-label">{opt.label}</span>
                <span className={`activate-dialog-option-badge ${installed ? 'ok' : 'missing'}`}>
                  {installed ? '已安装' : '未找到'}
                </span>
              </label>
            );
          })}
        </div>

        <div className="activate-dialog-section">
          <div className="activate-dialog-section-label">部署容器</div>
          {RUNTIME_OPTIONS.map(opt => {
            const installed = runtimeInstalled(opt.id);
            return (
              <label
                key={opt.id}
                className={`activate-dialog-option ${!installed ? 'activate-dialog-option--disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="runtime"
                  value={opt.id}
                  checked={runtime === opt.id}
                  onChange={() => installed && setRuntime(opt.id)}
                  disabled={!installed}
                />
                <span className="activate-dialog-option-label">{opt.label}</span>
                {!opt.alwaysOn && (
                  <span className={`activate-dialog-option-badge ${installed ? 'ok' : 'missing'}`}>
                    {installed ? '已安装' : '未找到'}
                  </span>
                )}
              </label>
            );
          })}
        </div>

        <div className="activate-dialog-footer">
          <button className="activate-dialog-btn" onClick={onCancel}>取消</button>
          <button
            className="activate-dialog-btn activate-dialog-btn--primary"
            disabled={!canConfirm}
            onClick={() => onConfirm(cli, runtime)}
          >
            激活
          </button>
        </div>
      </div>
    </div>
  );
}
