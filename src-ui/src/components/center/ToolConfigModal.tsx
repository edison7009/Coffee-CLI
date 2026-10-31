// Per-tool launch override modal — minimal version.
//
// Reached from the gear on tool cards. Lets the user override
// how a specific CLI tool is spawned: launch path (e.g. wsl claude),
// extra args, default cwd, custom history scan path. All four fields
// are optional — empty falls through to Coffee CLI's built-in default.
//
// Stripped of explanatory text on purpose: anyone reaching this modal
// is already comfortable with CLI args + paths. 4 field labels + 3
// button labels = 7 total i18n keys, nothing else.
//
// Styling references theme tokens (--bg-panel / --text-1 / --accent
// etc.) so dark and light themes are picked up automatically — no
// hard-coded rgba values that go invisible on white.
//
// Persisted via Tauri command into ~/.coffee-cli/tools.json.

import { useEffect, useMemo, useState } from 'react';
import { commands, type ToolConfigEntry } from '../../tauri';
import { useT } from '../../i18n/useT';
import { ThemedSelect } from '../common/ThemedSelect';

interface Props {
  toolKey: string;
  toolLabel: string;
  onClose: () => void;
}

const EMPTY: ToolConfigEntry = {
  command: '',
  extra_args: [],
  default_cwd: '',
  history_path: '',
};

// Built-in defaults mirroring tier_terminal_start_blocking. Used as the
// initial form values when no user override exists, and as the target of
// the Reset button. Source of truth still lives in Rust; this table only
// surfaces those values to the UI.
const TOOL_DEFAULTS: Record<string, ToolConfigEntry> = {
  claude:   { command: 'claude',   extra_args: [], default_cwd: '', history_path: '~/.claude/projects' },
  codex:    { command: 'codex',    extra_args: [], default_cwd: '', history_path: '~/.codex/sessions' },
  // Grok Build - per-session dirs under ~/.grok/sessions/<encoded-cwd>/<uuid>/.
  // GROK_HOME env (and this history_path override) both redirect the scan.
  grok:     { command: 'grok',     extra_args: [], default_cwd: '', history_path: '~/.grok/sessions' },
  qwen:     { command: 'qwen',     extra_args: [], default_cwd: '', history_path: '' },
  opencode: { command: 'opencode', extra_args: [], default_cwd: '', history_path: '~/.local/share/opencode' },
  // MiMo Code — Xiaomi's OpenCode fork. `command` is a best guess (could be
  // `mimocode`). Show the primary db root like OpenCode does (clarity — an
  // empty field reads as a bug); the backend also probes `~/.config/mimocode`
  // as a fallback, and treats an empty override as "use this default" anyway.
  mimocode: { command: 'mimo',     extra_args: [], default_cwd: '', history_path: '~/.local/share/mimocode' },
  openclaw: { command: 'openclaw', extra_args: [], default_cwd: '', history_path: '~/.openclaw/agents' },
  // Hermes data root is platform-dependent (`%LOCALAPPDATA%\hermes` on
  // Windows, `~/.hermes` elsewhere; `$HERMES_HOME` overrides both); leave
  // history_path empty so the backend resolves via tools::hermes::hermes_home
  // rather than the UI mis-displaying `~/.hermes/sessions` on Windows.
  hermes:   { command: 'hermes',   extra_args: [], default_cwd: '', history_path: '' },
  // Pi — depth-2 JSONL walker at ~/.pi/agent/sessions (same shape as Claude).
  pi:       { command: 'pi',   extra_args: [], default_cwd: '', history_path: '~/.pi/agent/sessions' },
  omp:      { command: 'omp',  extra_args: [], default_cwd: '', history_path: '~/.omp/agent/sessions' },
  // CodeBuddy — depth-2 JSONL walker at ~/.codebuddy/projects (same shape as
  // Claude's projects/). CODEBUDDY_CONFIG_DIR moves the root; the backend
  // reads it, and this override can point the scan anywhere else.
  codebuddy: { command: 'codebuddy', extra_args: [], default_cwd: '', history_path: '~/.codebuddy/projects' },
  // Kimi Code — index-based layout under ~/.kimi-code (flat on every OS).
  kimicode: { command: 'kimi', extra_args: [], default_cwd: '', history_path: '~/.kimi-code' },
};

// Tools whose session history Coffee CLI's history scanner actually reads
// (load_native_history_blocking in src/server.rs). For these we surface
// the history_path field. For tools outside this set, the field is hidden — letting the
// user fill a path that nothing ever scans would just be a footgun.
const HISTORY_SCANNED_TOOLS = new Set([
  'claude', 'codex', 'grok', 'hermes', 'opencode', 'openclaw', 'mimocode', 'kilo', 'pi', 'kimicode', 'omp', 'codebuddy',
]);

const defaultsFor = (key: string): ToolConfigEntry => TOOL_DEFAULTS[key] ?? EMPTY;

function withFallback(user: ToolConfigEntry, def: ToolConfigEntry): ToolConfigEntry {
  return {
    command:      user.command      || def.command,
    extra_args:   user.extra_args.length ? user.extra_args : def.extra_args,
    default_cwd:  user.default_cwd  || def.default_cwd,
    history_path: user.history_path || def.history_path,
  };
}

function diffField<T extends string | string[]>(value: T, defaultValue: T): T {
  if (Array.isArray(value) && Array.isArray(defaultValue)) {
    const a = value.join('\n'); const b = defaultValue.join('\n');
    return (a === b ? ([] as unknown as T) : value);
  }
  return value === defaultValue ? ('' as unknown as T) : value;
}

export function ToolConfigModal({ toolKey, toolLabel, onClose }: Props) {
  const t = useT();
  const def = useMemo(() => defaultsFor(toolKey), [toolKey]);
  const [entry, setEntry] = useState<ToolConfigEntry>(def);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [extraArgsText, setExtraArgsText] = useState('');
  const presets = toolKey === 'claude' ? [
    { value: 'claude', label: 'claude' },
    { value: 'claude --permission-mode plan', label: t('claude.permission.plan') },
    { value: 'claude --permission-mode acceptEdits', label: t('claude.permission.edit') },
    { value: 'claude --dangerously-skip-permissions', label: t('claude.permission.bypass') },
  ] : toolKey === 'codex' ? [
    { value: 'codex', label: 'codex' },
    { value: 'codex -c sandbox_mode=read-only -c approval_policy=on-request', label: t('codex.read_only') },
    { value: 'codex -c sandbox_mode=workspace-write -c approval_policy=on-request', label: t('codex.workspace') },
    { value: 'codex -c sandbox_mode=danger-full-access -c approval_policy=never', label: t('codex.full_access') },
  ] : toolKey === 'opencode' ? [
    { value: 'opencode', label: 'opencode' },
    { value: 'opencode --auto', label: t('claude.permission.bypass') },
  ] : [];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await commands.getToolConfig(toolKey);
        if (cancelled) return;
        const merged = withFallback(user, def);
        setEntry(merged);
        setExtraArgsText(merged.extra_args.join('\n'));
      } catch {
        /* swallow — leave the form at defaults */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [toolKey, def]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const args = extraArgsText.split('\n').map(s => s.trim()).filter(Boolean);
      const payload: ToolConfigEntry = {
        command:      diffField(entry.command.trim(), def.command),
        extra_args:   diffField(args, def.extra_args),
        default_cwd:  diffField(entry.default_cwd.trim(), def.default_cwd),
        history_path: diffField(entry.history_path.trim(), def.history_path),
      };
      await commands.setToolConfig(toolKey, payload);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await commands.setToolConfig(toolKey, EMPTY);
      setEntry(def);
      setExtraArgsText(def.extra_args.join('\n'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onMouseDown={event => { if (event.button === 0 && event.target === event.currentTarget) onClose(); }} className="tool-config-backdrop">
      <div onClick={e => e.stopPropagation()} className="tool-config-modal">
        <div className="tool-config-header">
          <span>{toolLabel}</span>
          <button onClick={onClose} className="tool-config-close close-button" aria-label="close">×</button>
        </div>

        {!loading && (
          <div className="tool-config-body">
            <div className="tool-config-field">
              <label className="tool-config-field-label" htmlFor="tool-launch-command">{t('tool_config.command')}</label>
              <div className={`tool-config-command${presets.length ? ' has-presets' : ''}`}>
                <input id="tool-launch-command" type="text" className="tool-config-input" spellCheck={false} value={entry.command} onChange={event => setEntry({ ...entry, command: event.target.value })} />
                {presets.length > 0 && <ThemedSelect className="tool-command-presets" align="end" label={t('tool_config.presets')} value={entry.command} options={presets} disabled={saving} onChange={command => setEntry({ ...entry, command })} />}
              </div>
            </div>
            <Field
              label={t('tool_config.extra_args')}
              value={extraArgsText}
              onChange={setExtraArgsText}
              multiline
              rows={3}
            />
            <Field
              label={t('tool_config.default_cwd')}
              value={entry.default_cwd}
              onChange={v => setEntry({ ...entry, default_cwd: v })}
            />
            {HISTORY_SCANNED_TOOLS.has(toolKey) && (
              <Field
                label={t('tool_config.history_path')}
                value={entry.history_path}
                onChange={v => setEntry({ ...entry, history_path: v })}
                placeholder={toolKey === 'hermes' ? '<HERMES_HOME>/sessions' : undefined}
              />
            )}
          </div>
        )}

        <div className="tool-config-buttons">
          <button onClick={handleReset} disabled={saving || loading} className="tool-config-btn tool-config-btn-subtle">
            {t('tool_config.reset')}
          </button>
          <button onClick={onClose} disabled={saving} className="tool-config-btn tool-config-btn-subtle">
            {t('tool_config.cancel')}
          </button>
          <button onClick={handleSave} disabled={saving || loading} className="tool-config-btn tool-config-btn-primary">
            {t('tool_config.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, multiline, rows, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="tool-config-field">
      <span className="tool-config-field-label">{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={rows ?? 3}
          spellCheck={false}
          placeholder={placeholder}
          className="tool-config-input"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          spellCheck={false}
          placeholder={placeholder}
          className="tool-config-input"
        />
      )}
    </label>
  );
}
