// ActivateDialog — the "给分身上岗" ceremony.
//
// Two-column layout:
//   Left (identity):  avatar · name · description
//   Right (config):   CLI · 部署容器 · 心跳 · 目录信息
//
// We always copy the host's CLI-specific config dir into the deployment
// target. Users tweak, clear, or rebuild anything inside after launch —
// that's content, not ours to manage. Heartbeat is optional and empty
// by default so idle agents stay free.

import { useState } from 'react';
import type {
  CliKind,
  CliAvailability,
  RuntimeKind,
  AgentLaunchConfig,
} from './types';

interface Props {
  roleName: string;                // blueprint default; editable below
  roleDefaults?: {
    avatar?: string;
    description?: string;
  };
  agentId: string;                 // for the directory preview
  teamId: string;                  // for the shared-directory preview
  availability: CliAvailability;
  availableRuntimes: RuntimeKind[];
  onConfirm: (config: AgentLaunchConfig) => void;
  onCancel: () => void;
}

const CLI_OPTIONS: Array<{ id: CliKind; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex',  label: 'Codex CLI' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'qwen',   label: 'Qwen Code' },
];

const RUNTIME_OPTIONS: Array<{ id: RuntimeKind; label: string; alwaysOn?: true }> = [
  { id: 'none',   label: '不使用容器', alwaysOn: true },
  { id: 'podman', label: 'Podman' },
  { id: 'docker', label: 'Docker' },
];

const AVATAR_CHOICES = ['👤', '🤖', '💻', '🎨', '🎮', '✍️', '📚', '🔬', '📊', '🎯', '🚀', '🧠'];

const INTERVAL_CHOICES: Array<{ value: string; label: string }> = [
  { value: '5m',        label: '每 5 分钟' },
  { value: '10m',       label: '每 10 分钟' },
  { value: '30m',       label: '每 30 分钟' },
  { value: '1h',        label: '每 1 小时' },
  { value: '6h',        label: '每 6 小时' },
  { value: 'daily-9am', label: '每天 9 点' },
];

export function ActivateDialog({
  roleName,
  roleDefaults,
  agentId,
  teamId,
  availability,
  availableRuntimes,
  onConfirm,
  onCancel,
}: Props) {
  const [avatar, setAvatar] = useState(roleDefaults?.avatar ?? '👤');
  const [name, setName] = useState(roleName);
  const [description, setDescription] = useState(roleDefaults?.description ?? '');

  const firstInstalledCli = CLI_OPTIONS.find(o => availability[o.id])?.id ?? 'claude';
  const [cli, setCli] = useState<CliKind>(firstInstalledCli);
  const installedRuntime = availableRuntimes.find(r => r !== 'none');
  const [runtime, setRuntime] = useState<RuntimeKind>(installedRuntime ?? 'none');

  const [heartbeatEnabled, setHeartbeatEnabled] = useState(false);
  const [heartbeatInterval, setHeartbeatInterval] = useState('10m');
  const [heartbeatPrompt, setHeartbeatPrompt] = useState('');

  const selectedInstalled = availability[cli];
  const canConfirm = selectedInstalled && name.trim().length > 0;
  const runtimeInstalled = (id: RuntimeKind): boolean =>
    id === 'none' ? true : availableRuntimes.includes(id);

  const handleStart = () => {
    const config: AgentLaunchConfig = {
      avatar,
      name: name.trim(),
      description: description.trim(),
      cli,
      runtime,
    };
    if (heartbeatEnabled && heartbeatPrompt.trim().length > 0) {
      config.heartbeat = {
        interval: heartbeatInterval,
        prompt: heartbeatPrompt.trim(),
      };
    }
    onConfirm(config);
  };

  return (
    <div className="activate-dialog-backdrop" onClick={onCancel}>
      <div className="activate-dialog activate-dialog--wide" onClick={e => e.stopPropagation()}>
        <div className="activate-dialog-header">
          <span className="activate-dialog-title">启动 &quot;{name || roleName}&quot;</span>
          <button className="activate-dialog-close" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="activate-dialog-body">
          {/* ─── Left: Identity ─── */}
          <div className="activate-dialog-col activate-dialog-col--left">
            <div className="activate-dialog-section">
              <div className="activate-dialog-section-label">头像</div>
              <div className="avatar-picker">
                {AVATAR_CHOICES.map(a => (
                  <button
                    key={a}
                    className={`avatar-picker-option ${avatar === a ? 'active' : ''}`}
                    onClick={() => setAvatar(a)}
                    type="button"
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div className="activate-dialog-section">
              <div className="activate-dialog-section-label">名字</div>
              <input
                className="activate-dialog-input"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="主程序"
                maxLength={32}
              />
            </div>

            <div className="activate-dialog-section">
              <div className="activate-dialog-section-label">描述</div>
              <textarea
                className="activate-dialog-textarea"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="这个分身负责什么？"
                rows={3}
                maxLength={240}
              />
            </div>
          </div>

          {/* ─── Right: Configuration ─── */}
          <div className="activate-dialog-col activate-dialog-col--right">
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
              <div className="activate-dialog-section-label">部署容器（数据和配置隔离）</div>
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

            <div className="activate-dialog-section">
              <label className="activate-dialog-section-toggle">
                <input
                  type="checkbox"
                  checked={heartbeatEnabled}
                  onChange={e => setHeartbeatEnabled(e.target.checked)}
                />
                <span>心跳（可选定时任务）</span>
              </label>
              {heartbeatEnabled && (
                <div className="activate-dialog-heartbeat">
                  <div className="activate-dialog-heartbeat-row">
                    <label className="activate-dialog-subsection-label">间隔</label>
                    <select
                      className="activate-dialog-select"
                      value={heartbeatInterval}
                      onChange={e => setHeartbeatInterval(e.target.value)}
                    >
                      {INTERVAL_CHOICES.map(i => (
                        <option key={i.value} value={i.value}>{i.label}</option>
                      ))}
                    </select>
                  </div>
                  <label className="activate-dialog-subsection-label">每次触发执行</label>
                  <textarea
                    className="activate-dialog-textarea"
                    value={heartbeatPrompt}
                    onChange={e => setHeartbeatPrompt(e.target.value)}
                    placeholder="检查 /team/mailboxes/me/inbox/ 有没有新消息，有就处理"
                    rows={2}
                    maxLength={240}
                  />
                </div>
              )}
            </div>

            <div className="activate-dialog-section activate-dialog-paths">
              <div className="activate-dialog-section-label">分身的目录</div>
              <div className="activate-dialog-path-row">
                <span className="activate-dialog-path-icon">🏠</span>
                <span className="activate-dialog-path-kind">家目录</span>
                <code className="activate-dialog-path">~/.coffee/agents/{agentId}/</code>
              </div>
              <div className="activate-dialog-path-row">
                <span className="activate-dialog-path-icon">🤝</span>
                <span className="activate-dialog-path-kind">团队共享</span>
                <code className="activate-dialog-path">~/.coffee/teams/{teamId}/shared/</code>
              </div>
            </div>
          </div>
        </div>

        <div className="activate-dialog-footer">
          <button className="activate-dialog-btn" onClick={onCancel}>取消</button>
          <button
            className="activate-dialog-btn activate-dialog-btn--primary"
            disabled={!canConfirm}
            onClick={handleStart}
          >
            启动
          </button>
        </div>
      </div>
    </div>
  );
}
