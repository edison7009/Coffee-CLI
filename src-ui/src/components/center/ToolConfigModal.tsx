// Per-tool launch override modal.
//
// Reached from the small gear icon that appears on launchpad cards when
// hovered. Lets users customize how a specific CLI tool gets spawned
// — for cases where the built-in `where claude` / `which claude`
// auto-detect can't find the binary (WSL Hermes, conda envs, custom
// forks, docker exec, etc).
//
// UX rules:
//   - On open: pre-fill form with the user's current overrides if any,
//     OR with the built-in defaults if no override has been saved. So
//     the user always sees what's CURRENTLY in effect, not blanks.
//   - On Reset: form goes back to the built-in defaults AND backend
//     storage is cleared. User can keep editing or just close.
//   - On Save: any field whose value matches the built-in default is
//     persisted as empty (= "use built-in"), so tools.json never
//     accumulates redundant entries that would freeze users at today's
//     defaults if Coffee CLI's defaults change in the future.
//
// Persisted via the backend Tauri command into `~/.coffee-cli/tools.json`
// (atomic write, the empty-entry case removes the tool's record entirely).

import { useEffect, useMemo, useState } from 'react';
import { commands, type ToolConfigEntry } from '../../tauri';

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

// Built-in defaults mirroring what `tier_terminal_start_blocking` in
// `src/server.rs` produces for each tool when no override is set.
// Kept here so the modal can pre-populate fields and so Reset has a
// meaningful target. Source-of-truth still lives in Rust; this table
// only exists to surface those values in the UI.
const TOOL_DEFAULTS: Record<string, ToolConfigEntry> = {
  claude:   { command: 'claude',   extra_args: [], default_cwd: '', history_path: '~/.claude/projects' },
  codex:    { command: 'codex',    extra_args: [], default_cwd: '', history_path: '~/.codex/sessions' },
  gemini:   { command: 'gemini',   extra_args: [], default_cwd: '', history_path: '~/.gemini/tmp' },
  qwen:     { command: 'qwen',     extra_args: [], default_cwd: '', history_path: '' },
  opencode: { command: 'opencode', extra_args: [], default_cwd: '', history_path: '~/.local/share/opencode' },
  openclaw: { command: 'openclaw', extra_args: [], default_cwd: '', history_path: '' },
  hermes:   { command: 'hermes',   extra_args: [], default_cwd: '', history_path: '~/.hermes/sessions' },
};

const defaultsFor = (key: string): ToolConfigEntry => TOOL_DEFAULTS[key] ?? EMPTY;

// Merge user override on top of defaults: any non-empty user field wins.
function withFallback(user: ToolConfigEntry, def: ToolConfigEntry): ToolConfigEntry {
  return {
    command:      user.command      || def.command,
    extra_args:   user.extra_args.length ? user.extra_args : def.extra_args,
    default_cwd:  user.default_cwd  || def.default_cwd,
    history_path: user.history_path || def.history_path,
  };
}

// Compare a form value to its default. If equal, we want to persist as
// empty so the tools.json entry doesn't pin the user to today's default.
function diffField<T extends string | string[]>(value: T, defaultValue: T): T {
  if (Array.isArray(value) && Array.isArray(defaultValue)) {
    const a = value.join('\n'); const b = defaultValue.join('\n');
    return (a === b ? ([] as unknown as T) : value);
  }
  return value === defaultValue ? ('' as unknown as T) : value;
}

export function ToolConfigModal({ toolKey, toolLabel, onClose }: Props) {
  const def = useMemo(() => defaultsFor(toolKey), [toolKey]);
  const [entry, setEntry] = useState<ToolConfigEntry>(def);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [extraArgsText, setExtraArgsText] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await commands.getToolConfig(toolKey);
        if (cancelled) return;
        const merged = withFallback(user, def);
        setEntry(merged);
        setExtraArgsText(merged.extra_args.join('\n'));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[tool-config] load failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [toolKey, def]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const args = extraArgsText
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
      // For each field: if the value the user is saving equals the
      // built-in default, persist as empty so the entry stays a
      // pure "override only" record.
      const payload: ToolConfigEntry = {
        command:      diffField(entry.command.trim(), def.command),
        extra_args:   diffField(args, def.extra_args),
        default_cwd:  diffField(entry.default_cwd.trim(), def.default_cwd),
        history_path: diffField(entry.history_path.trim(), def.history_path),
      };
      await commands.setToolConfig(toolKey, payload);
      onClose();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[tool-config] save failed:', err);
      alert('Save failed: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset all custom settings for ' + toolLabel + ' to defaults?')) return;
    setSaving(true);
    try {
      // Clear the user's override in tools.json — Coffee CLI will
      // fall back to the built-in defaults on next launch.
      await commands.setToolConfig(toolKey, EMPTY);
      // Restore the form so the user sees what's now in effect.
      setEntry(def);
      setExtraArgsText(def.extra_args.join('\n'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: 'var(--bg-color, #15151a)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: 10,
          padding: '24px 26px',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono, ui-monospace, Menlo, Consolas, monospace)',
          fontSize: 13,
          boxShadow: '0 24px 60px -16px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {toolLabel} <span style={{ opacity: 0.5, fontWeight: 400 }}>· launch settings</span>
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 0,
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 18,
              opacity: 0.6,
              padding: '0 4px',
            }}
          >×</button>
        </div>
        <p style={{ marginTop: 6, marginBottom: 18, opacity: 0.6, fontSize: 12, lineHeight: 1.55 }}>
          All fields are optional. Empty = use Coffee CLI's built-in default.
          For WSL: e.g. command <code style={{ opacity: 0.8 }}>wsl ~/.local/bin/hermes</code>.
        </p>

        {loading ? (
          <p style={{ opacity: 0.5 }}>Loading…</p>
        ) : (
          <>
            <Field
              label="Launch command"
              hint="e.g. wsl ~/.local/bin/hermes — first token is the binary, rest are prepended to args. Empty = use PATH."
              value={entry.command}
              onChange={v => setEntry({ ...entry, command: v })}
              placeholder={defaultCommandFor(toolKey)}
            />

            <FieldMultiline
              label="Extra launch args"
              hint="One per line. Appended after the built-in args. Example: --dangerously-skip-permissions"
              value={extraArgsText}
              onChange={setExtraArgsText}
              rows={3}
            />

            <Field
              label="Default working directory"
              hint="Pre-fills the folder selector when starting a new tab. Empty = use the launchpad's last-used cwd."
              value={entry.default_cwd}
              onChange={v => setEntry({ ...entry, default_cwd: v })}
              placeholder="(empty — fall back to last-used)"
            />

            <Field
              label="Session history path"
              hint="Directory containing this tool's session files. Useful for WSL — e.g. \\\\wsl.localhost\\Ubuntu\\home\\user\\.hermes\\sessions"
              value={entry.history_path}
              onChange={v => setEntry({ ...entry, history_path: v })}
              placeholder={defaultHistoryFor(toolKey)}
            />
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
          <button
            onClick={handleReset}
            disabled={saving || loading}
            style={btnStyle('subtle')}
          >
            Reset
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            style={btnStyle('subtle')}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={btnStyle('primary')}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, hint, value, onChange, placeholder,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          width: '100%',
          padding: '7px 10px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: 5,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 12.5,
          outline: 'none',
        }}
      />
      <p style={{ marginTop: 4, marginBottom: 0, fontSize: 11, opacity: 0.5, lineHeight: 1.5 }}>{hint}</p>
    </div>
  );
}

function FieldMultiline({
  label, hint, value, onChange, rows,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        style={{
          width: '100%',
          padding: '7px 10px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))',
          borderRadius: 5,
          color: 'inherit',
          fontFamily: 'inherit',
          fontSize: 12.5,
          outline: 'none',
          resize: 'vertical',
        }}
      />
      <p style={{ marginTop: 4, marginBottom: 0, fontSize: 11, opacity: 0.5, lineHeight: 1.5 }}>{hint}</p>
    </div>
  );
}

function btnStyle(kind: 'primary' | 'subtle'): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '7px 16px',
    fontSize: 13,
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
    border: '1px solid var(--border, rgba(255,255,255,0.15))',
  };
  if (kind === 'primary') {
    return {
      ...base,
      background: 'var(--accent, #c4956a)',
      color: '#1a1a1c',
      fontWeight: 600,
      borderColor: 'transparent',
    };
  }
  return {
    ...base,
    background: 'transparent',
    color: 'inherit',
  };
}

// Placeholders mirror TOOL_DEFAULTS so a cleared field still reminds
// the user what value the system will fall back to.
const defaultCommandFor = (tool: string) => defaultsFor(tool).command;
const defaultHistoryFor = (tool: string) => defaultsFor(tool).history_path;
