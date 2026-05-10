import { useEffect, useState, useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { commands } from '../../tauri';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { parseFrontmatter, localizedField } from '../../utils/skill-meta';

interface SkillEntry {
  name: string;
  enabled: boolean;
  skillMd: string | null;
  iconDataUrl: string | null;
}

interface ParsedSkill extends SkillEntry {
  displayName: string;
  description: string;
}

interface Props {
  /** Top-of-screen iOS-style toast — owned by CenterPanel, wired through
   *  here so toggle confirmations slot into the existing animation pipe. */
  showToast: (msg: string) => void;
}

export function SkillsPanel({ showToast }: Props) {
  const { state } = useAppState();
  const lang = state.currentLang;
  const t = useT();
  const [skills, setSkills] = useState<ParsedSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyName, setBusyName] = useState<string | null>(null);

  // Mouse-tracked tooltip. Pure-CSS [data-tip]:hover::after worked in
  // theory but the description's overflow:hidden (needed for ellipsis)
  // clipped the pseudo-element, AND a fixed-position pill couldn't
  // dodge viewport edges (top/right of small windows clipped the tip).
  // React state + createPortal to document.body floats the tooltip
  // above all overflow contexts; a useLayoutEffect clamps the final
  // x/y so the pill never escapes the viewport.
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return;
    const el = tipRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = tip.x + 12;
    let top = tip.y + 16;
    // Right-edge clamp: if the tooltip would extend past the viewport,
    // flip to the LEFT of the cursor instead.
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, tip.x - rect.width - 12);
    }
    // Bottom-edge clamp: same idea, flip ABOVE the cursor.
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, tip.y - rect.height - 16);
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);

  const handleTipMove = (e: React.MouseEvent, text: string) => {
    if (!text) return;
    setTip({ x: e.clientX, y: e.clientY, text });
  };
  const handleTipLeave = () => setTip(null);

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
          const fm = parseFrontmatter(s.skillMd);
          return {
            ...s,
            displayName: localizedField(fm, 'name', lang) || s.name,
            description: localizedField(fm, 'description', lang),
          };
        })
      );
    } catch (e) {
      showToast(`Skills load failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [showToast, lang]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (skill: ParsedSkill) => {
    if (busyName) return;
    setBusyName(skill.name);
    try {
      const turningOn = !skill.enabled;
      // Per-tool conflict warnings: when a tool's skills dir already
      // contains a real folder with this skill name (user's manual
      // install), Coffee CLI doesn't clobber it. The toggle still
      // succeeds for every other tool — we just surface the skipped
      // tool(s) so the user knows their own version is in effect there.
      const warnings = await commands.skillsToggle(skill.name, turningOn);
      // Per the design contract: never kill the user's running CLI
      // sessions — passive toast only. The user owns the consequence
      // of ignoring it. See feedback_no_kill_running_sessions memory.
      showToast(turningOn ? t('skills.toast.enabled') : t('skills.toast.disabled'));
      // Surface skip-warnings as separate toasts so they aren't lost
      // alongside the primary success message. Each line is a per-tool
      // explanation including the conflicting path.
      for (const w of warnings) {
        showToast(w);
      }
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
    <>
      <div className="skills-grid">
        {skills.map(skill => (
          <div key={skill.name} className="skills-card">
            <div className="skills-card-icon">
              {skill.iconDataUrl
                ? <img src={skill.iconDataUrl} alt="" />
                : <span className="skills-card-icon-fallback">{skill.displayName.slice(0, 1).toUpperCase()}</span>}
            </div>
            <div
              className="skills-card-text"
              onMouseEnter={(e) => handleTipMove(e, skill.description || '')}
              onMouseMove={(e) => handleTipMove(e, skill.description || '')}
              onMouseLeave={handleTipLeave}
            >
              <div className="skills-card-name">{skill.displayName}</div>
              {skill.description && (
                <div className="skills-card-desc">{skill.description}</div>
              )}
            </div>
            <button
              className={`skills-toggle ${skill.enabled ? 'on' : 'off'} ${busyName === skill.name ? 'is-busy' : ''}`}
              onClick={() => toggle(skill)}
              disabled={busyName === skill.name}
              aria-label={skill.enabled ? 'Disable skill' : 'Enable skill'}
            >
              <span className="skills-toggle-track">
                <span className="skills-toggle-thumb" />
              </span>
            </button>
          </div>
        ))}
      </div>
      {tip && createPortal(
        <div
          ref={tipRef}
          className="skills-tooltip"
          style={{ left: tip.x + 12, top: tip.y + 16 }}
        >
          {tip.text}
        </div>,
        document.body
      )}
    </>
  );
}
