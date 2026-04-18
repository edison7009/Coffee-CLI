// ActivateDialog — shown when the user clicks an inactive card.
//
// Two questions only, per product philosophy:
//   1) Which CLI do you want inside this container?
//   2) Copy your local config or start fresh?
//
// We do NOT ask for models, skills, system prompts, API keys. All of that
// lives inside the container — the user's business, not ours.

import { useState } from 'react';
import type { CliKind, InitMode, CliAvailability, RuntimeKind } from './types';

interface Props {
  roleName: string;
  availability: CliAvailability;
  availableRuntimes: RuntimeKind[];
  onConfirm: (cli: CliKind, initMode: InitMode, runtime: RuntimeKind) => void;
  onCancel: () => void;
}

const CLI_OPTIONS: Array<{ id: CliKind; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex',  label: 'Codex CLI' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'qwen',   label: 'Qwen Code' },
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
  const [initMode, setInitMode] = useState<InitMode>('copy-local');
  const [runtime, setRuntime] = useState<RuntimeKind>(availableRuntimes[0] ?? 'podman');

  const selectedInstalled = availability[cli];
  const canConfirm = selectedInstalled && availableRuntimes.length > 0;

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
          <div className="activate-dialog-section-label">初始配置</div>
          <label className="activate-dialog-option">
            <input
              type="radio"
              name="initMode"
              value="copy-local"
              checked={initMode === 'copy-local'}
              onChange={() => setInitMode('copy-local')}
            />
            <span className="activate-dialog-option-label">复制我本机配置（推荐）</span>
          </label>
          <label className="activate-dialog-option">
            <input
              type="radio"
              name="initMode"
              value="fresh"
              checked={initMode === 'fresh'}
              onChange={() => setInitMode('fresh')}
            />
            <span className="activate-dialog-option-label">全新空白</span>
          </label>
        </div>

        <div className="activate-dialog-section">
          <div className="activate-dialog-section-label">部署 Runtime</div>
          {availableRuntimes.length === 0 ? (
            <div className="activate-dialog-runtime-empty">
              未检测到容器 runtime。请先安装 Podman 或 Docker。
            </div>
          ) : (
            availableRuntimes.map(r => (
              <label key={r} className="activate-dialog-option">
                <input
                  type="radio"
                  name="runtime"
                  value={r}
                  checked={runtime === r}
                  onChange={() => setRuntime(r)}
                />
                <span className="activate-dialog-option-label">
                  {r === 'docker' ? 'Docker' : 'Podman'}
                </span>
              </label>
            ))
          )}
        </div>

        <div className="activate-dialog-footer">
          <button className="activate-dialog-btn" onClick={onCancel}>取消</button>
          <button
            className="activate-dialog-btn activate-dialog-btn--primary"
            disabled={!canConfirm}
            onClick={() => onConfirm(cli, initMode, runtime)}
          >
            激活
          </button>
        </div>
      </div>
    </div>
  );
}
