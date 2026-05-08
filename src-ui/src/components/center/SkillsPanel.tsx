import { useEffect, useState, useCallback } from 'react';
import { commands } from '../../tauri';

interface SkillEntry {
  name: string;
  enabled: boolean;
  skillMd: string | null;
}

interface ParsedSkill extends SkillEntry {
  displayName: string;
  description: string;
}

/**
 * Parse YAML-frontmatter style metadata at the top of SKILL.md. The
 * curated openai/skills set uses a fixed shape:
 *
 *     ---
 *     name: "screenshot"
 *     description: "Use when the user explicitly asks for…"
 *     ---
 *
 * Returns the raw values for `name` and `description`. We do not pull in
 * a YAML parser for two fields — a tiny line-level scan is enough.
 */
function parseFrontmatter(md: string | null): { name?: string; description?: string } {
  if (!md) return {};
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const eq = line.indexOf(':');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes — frontmatter values may be
    // quoted ("name") or bare (name); both are valid YAML scalars.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

interface Props {
  /** Top-of-screen iOS-style toast — owned by CenterPanel, wired through
   *  here so toggle confirmations slot into the existing animation pipe. */
  showToast: (msg: string) => void;
}

export function SkillsPanel({ showToast }: Props) {
  const [skills, setSkills] = useState<ParsedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyName, setBusyName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // ensure_dirs is idempotent — it (a) creates ~/.coffee-cli/{skills,
      // skills-library} on first run, and (b) seeds the bundled curated
      // skills into skills-library/ if missing. Cheap to call on every
      // panel mount; lets the user always see fresh state if they wiped
      // their home dir externally.
      await commands.skillsEnsureDirs();
      const raw = await commands.skillsList();
      setSkills(
        raw.map(s => {
          const meta = parseFrontmatter(s.skillMd);
          return {
            ...s,
            displayName: meta.name || s.name,
            description: meta.description || '',
          };
        })
      );
    } catch (e) {
      showToast(`Skills load failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (skill: ParsedSkill) => {
    if (busyName) return;
    setBusyName(skill.name);
    try {
      const turningOn = !skill.enabled;
      await commands.skillsToggle(skill.name, turningOn);
      // Per the design contract: never kill the user's running CLI
      // sessions — passive toast only. The user owns the consequence
      // of ignoring it. See feedback_no_kill_running_sessions memory.
      showToast(turningOn ? '需重启工具才能生效' : '已关闭需重启工具');
      await refresh();
    } catch (e) {
      showToast(`Toggle failed: ${e}`);
    } finally {
      setBusyName(null);
    }
  };

  if (loading) {
    return (
      <div className="skills-empty">Loading…</div>
    );
  }

  if (skills.length === 0) {
    return (
      <div className="skills-empty">No skills available yet.</div>
    );
  }

  return (
    <div className="skills-grid">
      {skills.map(skill => (
        <div key={skill.name} className={`skills-card ${skill.enabled ? 'is-enabled' : ''}`}>
          <div className="skills-card-head">
            <div className="skills-card-name">{skill.displayName}</div>
            <button
              className={`skills-toggle ${skill.enabled ? 'on' : 'off'}`}
              onClick={() => toggle(skill)}
              disabled={busyName === skill.name}
              aria-label={skill.enabled ? 'Disable skill' : 'Enable skill'}
            >
              <span className="skills-toggle-track">
                <span className="skills-toggle-thumb" />
              </span>
            </button>
          </div>
          {skill.description && (
            <div className="skills-card-desc">{skill.description}</div>
          )}
        </div>
      ))}
    </div>
  );
}
