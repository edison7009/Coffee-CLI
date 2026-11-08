// SettingsModal.tsx — centered personalization modal opened by the titlebar
// gear. Consolidates what used to be two overloaded left-panel popovers (the
// theme menu's color/shape/icon/wallpaper/terminal controls + the language
// dropdown) into one sectioned surface. Gambit is deliberately NOT here — it's
// a compose action, not a setting, and keeps its own left-cluster button.
//
// Layout: an icon rail (left) + a content column whose header (section title +
// close) is fixed while the body scrolls, so a long list (language) can never
// slide under the close button. Theme colours render as two-tone preview cards
// (surface band + accent band) with the label BELOW the swatch, never on it.
//
// Dispatch + persistence mirror the former Explorer wiring exactly so behaviour
// is unchanged; only the presentation moved.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { SegmentedTabs } from './SegmentedTabs';
import { AgentSettings } from '../agent/AgentPages';
import { useAppState, useAppDispatch, HOTKEY_SCHEMES, type HotkeyScheme, type ThemeColor, type ThemeMode, type ThemeShape, type IconTheme } from '../../store/app-state';
import { playNotifySound } from '../../lib/notify-sound';
import { useT } from '../../i18n/useT';
import { IS_MACOS, IS_WINDOWS } from '../../lib/platform';
import { TERM_COLOR_SCHEMES } from '../center/TierTerminal';
import { commands, isTauri, type FontInfo } from '../../tauri';
import { FontPicker } from './FontPicker';
import { SettingsSlider } from './SettingsSlider';
import { setUiScale, useUiScale } from '../../lib/ui-scale';
import { THEME_COLORS, THEME_MODES, THEME_SHAPES, ICON_ART_THEMES, LANGUAGES, TASK_VIEW_MODES, isMaskTintTheme } from '../../lib/personalization';
import './SettingsModal.css';

type Section = 'general' | 'appearance' | 'wallpaper' | 'terminal' | 'gambit' | 'sound' | 'language' | 'agent' | 'feedback';
const SECTION_IDS: Section[] = ['general', 'appearance', 'wallpaper', 'terminal', 'gambit', 'sound', 'language', 'agent', 'feedback'];

// Trailing "opens outside the app" affordance on the feedback cards.
const ExternalLinkArrow = () => (
  <svg className="settings-feedback-card-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7" /><path d="M7 7h10v10" />
  </svg>
);

// Read a `cc-*` boolean localStorage preference. Module-level
// so the SettingsModal sound toggles can seed their useState initializers.
// Both sound prefs default to ON (absent = true).
/** A long sound file name, cut in the middle so its ending stays readable. */
function shortFileName(name: string): string {
  const characters = Array.from(name);
  return characters.length > 28 ? `${characters.slice(0, 16).join('')}…${characters.slice(-10).join('')}` : name;
}

function readSoundPref(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'false';
  } catch { return true; }
}

// Per-mode preview glyphs for the Tasks section (checklist vs sticky note).
const TASK_VIEW_ICONS: Record<'list' | 'note' | 'prompt', ReactNode> = {
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" />
      <path d="m3 6 1 1 2-2" /><path d="m3 12 1 1 2-2" /><circle cx="4" cy="18" r="1" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2Z" />
      <path d="M15 21v-5a1 1 0 0 1 1-1h5" />
    </svg>
  ),
  prompt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11V5a2 2 0 0 1 2-2h6l9 9-8 8-9-9Z" />
      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
};

const ICONS: Record<Section, ReactNode> = {
  agent: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" />
    </svg>
  ),
  appearance: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" /><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" /><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C21.5 6.012 17.262 2 12 2z" />
    </svg>
  ),
  wallpaper: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 11 2-2-2-2" /><path d="M11 13h4" /><rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </svg>
  ),
  gambit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10" />
    </svg>
  ),
  general: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
      <circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
    </svg>
  ),
  language: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
    </svg>
  ),
  sound: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  ),
  feedback: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m8 2 1.88 1.88" /><path d="M14.12 3.88 16 2" />
      <path d="M9 7.13V6a3 3 0 1 1 6 0v1.13" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6Z" />
      <path d="M12 20v-9" /><path d="M6.53 9C4.6 8.8 3 7.1 3 5" /><path d="M6 13H2" /><path d="M6 17c-1.7 0-3 1.3-3 3" />
      <path d="M17.47 9c1.93-.2 3.53-1.9 3.53-4" /><path d="M18 13h4" /><path d="M18 17c1.7 0 3 1.3 3 3" />
    </svg>
  ),
};

export function SettingsModal() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  // Held in app state so other places can open a section (Coffee Agent's channel status opens 'agent').
  // Wallpaper, sound and shortcuts were sections of their own; a request for one opens the section that holds it now.
  const requested = state.settingsSection === 'wallpaper' ? 'appearance' : state.settingsSection === 'sound' || state.settingsSection === 'gambit' ? 'general' : state.settingsSection;
  const section: Section = SECTION_IDS.includes(requested as Section) ? requested as Section : 'general';
  const setSection = (next: Section) => dispatch({ type: 'SET_SETTINGS_SECTION', section: next });
  const uiScale = useUiScale();
  const scalePercent = uiScale.requestedPercent ?? uiScale.percent;
  const [dragPercent, setDragPercent] = useState<number | null>(null);
  const sliderPercent = dragPercent ?? scalePercent;
  const finishScaleDrag = () => setDragPercent(null);
  const [version, setVersion] = useState('');
  // Installed fonts for the terminal font picker — loaded lazily (Rust scan)
  // the first time the Terminal section is opened. null = not loaded yet.
  const [fonts, setFonts] = useState<FontInfo[] | null>(null);
  // Probed shell availability, fed to the default-shell picker so it only
  // offers shells the user actually has installed. null = not probed yet.
  // Platform-specific fields are absent cross-OS — read with optional
  // chaining.
  const [shellCaps, setShellCaps] = useState<{
    pwsh_available?: boolean; pwsh_version?: string | null; powershell_version?: string | null;
    git_bash_available?: boolean;
    zsh_available?: boolean; bash_available?: boolean;
    fish_available?: boolean; sh_available?: boolean;
    wsl_available: boolean;
  } | null>(null);

  // Sound notification toggles (Settings ▸ Sound). State must live above the
  // `if (!open) return null` early-return — hooks can't run conditionally.
  const [soundDone, setSoundDone] = useState(() => readSoundPref('cc-sound-done'));
  const [soundWait, setSoundWait] = useState(() => readSoundPref('cc-sound-wait'));
  const [soundFiles, setSoundFiles] = useState<{ done: string | null; wait: string | null }>({ done: null, wait: null });
  const [soundFailed, setSoundFailed] = useState<'done' | 'wait' | null>(null);
  useEffect(() => {
    setSoundFailed(null);
    if (section !== 'general' || !state.settingsOpen || !isTauri) return;
    commands.notifySoundFiles().then(setSoundFiles, err => console.warn('[Settings] sound files unavailable:', err));
  }, [section, state.settingsOpen]);

  const open = state.settingsOpen;
  const close = () => { finishScaleDrag(); dispatch({ type: 'SET_SETTINGS_OPEN', open: false }); };

  // App version for the rail footer — pulled from the Tauri runtime (matches
  // tauri.conf.json) once, lazily so non-Tauri dev just shows nothing.
  useEffect(() => {
    let cancelled = false;
    import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then(v => { if (!cancelled) setVersion(v); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Lazy-load the system font list + probe available shells when the
  // Terminal section is first shown. Both come from the Rust side and are
  // cheap, but no point paying them when the user never opens Terminal.
  useEffect(() => {
    if (!open || section !== 'terminal') return;
    if (fonts === null) commands.listSystemFonts().then(setFonts).catch(() => setFonts([]));
    if (shellCaps === null) commands.detectShells().then(setShellCaps).catch(() => {});
  }, [open, section, fonts, shellCaps]);

  if (!open) return null;

  // ── Handlers (identical to the former left-panel ThemeMenu/Lang wiring) ──
  const setTheme = (th: ThemeColor) => dispatch({ type: 'SET_THEME', theme: th });
  const setThemeMode = (mode: ThemeMode) => dispatch({ type: 'SET_THEME_MODE', mode });
  const setShape = (s: ThemeShape) => dispatch({ type: 'SET_SHAPE', shape: s });
  const setIconTheme = (th: IconTheme) => {
    dispatch({ type: 'SET_ICON_THEME', theme: th });
    try { localStorage.setItem('cc-icon-theme', th); } catch { /* Best-effort operation; failure is non-fatal. */ }
  };
  const setLang = (code: string) => {
    dispatch({ type: 'SET_LANG', lang: code });
    try {
      localStorage.setItem('cc-lang', code);
      if (code !== 'en') localStorage.setItem('cc-native-lang', code);
    } catch { /* Best-effort operation; failure is non-fatal. */ }
  };
  const pickBg = async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const selected = await openDialog({
        filters: [{ name: 'Background', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm'] }],
      });
      if (selected && typeof selected === 'string') {
        const ext = selected.split('.').pop()?.toLowerCase() || '';
        const bgType = ['mp4', 'webm'].includes(ext) ? 'video' : 'image';
        try { localStorage.setItem('cc-bg-path', selected); localStorage.setItem('cc-bg-type', bgType); } catch { /* Best-effort operation; failure is non-fatal. */ }
        dispatch({ type: 'SET_BG', path: selected, bgType });
      }
    } catch (err) { console.error('[Settings] background picker failed:', err); }
  };
  const clearBg = () => {
    try { localStorage.removeItem('cc-bg-path'); localStorage.removeItem('cc-bg-type'); } catch { /* Best-effort operation; failure is non-fatal. */ }
    dispatch({ type: 'CLEAR_BG' });
  };
  const setScheme = (id: string) => {
    try {
      if (id) localStorage.setItem('cc-term-scheme', id);
      else localStorage.removeItem('cc-term-scheme');
    } catch { /* Best-effort operation; failure is non-fatal. */ }
    dispatch({ type: 'SET_TERM_SCHEME', scheme: id });
  };
  const setFont = (family: string) => {
    // Strip quotes/backslashes — the value is interpolated into a CSS
    // fontFamily string, so don't let a stray quote break out of it.
    const clean = family.replace(/["\\]/g, '');
    try {
      if (clean) localStorage.setItem('cc-term-font', clean);
      else localStorage.removeItem('cc-term-font');
    } catch { /* Best-effort operation; failure is non-fatal. */ }
    dispatch({ type: 'SET_TERM_FONT', font: clean });
  };
  const setDefaultShell = (shell: string) => {
    try {
      if (shell) localStorage.setItem('cc-default-shell', shell);
      else localStorage.removeItem('cc-default-shell');
    } catch { /* Best-effort operation; failure is non-fatal. */ }
    dispatch({ type: 'SET_DEFAULT_SHELL', shell });
  };
  const setOpacity = (n: number) => dispatch({ type: 'SET_WALLPAPER_OPACITY', opacity: n });
  const setTaskView = (mode: 'list' | 'note' | 'prompt') => dispatch({ type: 'SET_TASK_VIEW_MODE', mode });
  const setEnterToSend = (value: boolean) => {
    dispatch({ type: 'SET_GAMBIT_ENTER_TO_SEND', value });
    try { localStorage.setItem('cc-gambit-enter-send', String(value)); } catch { /* Best-effort operation; failure is non-fatal. */ }
  };
  const setHotkeyScheme = (value: HotkeyScheme) => {
    dispatch({ type: 'SET_HOTKEY_SCHEME', value });
    try { localStorage.setItem('cc-hotkey-scheme', value); } catch { /* Best-effort operation; failure is non-fatal. */ }
  };

  // Sound notification toggles — local state + localStorage only. The
  // notify-sound module reads these keys live on native title state changes,
  // so no app-state wiring is needed. Both default to ON.
  const writeSoundPref = (key: string, setter: (v: boolean) => void) => (v: boolean) => {
    setter(v);
    try { localStorage.setItem(key, String(v)); } catch { /* Best-effort operation; failure is non-fatal. */ }
  };
  const pickSound = async (kind: 'done' | 'wait') => {
    setSoundFailed(null);
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const selected = await openDialog({ filters: [{ name: 'Audio', extensions: ['mp3', 'wav'] }] });
      if (selected && typeof selected === 'string') {
        const name = await commands.notifySoundChoose(kind, selected);
        setSoundFiles(files => ({ ...files, [kind]: name }));
      }
    } catch (err) { console.warn('[Settings] sound picker failed:', err); setSoundFailed(kind); }
  };
  const clearSound = (kind: 'done' | 'wait') => {
    setSoundFailed(null);
    commands.notifySoundClear(kind).then(() => setSoundFiles(files => ({ ...files, [kind]: null })), err => { console.warn('[Settings] sound removal failed:', err); setSoundFailed(kind); });
  };
  const setSoundDonePref = writeSoundPref('cc-sound-done', setSoundDone);
  const setSoundWaitPref = writeSoundPref('cc-sound-wait', setSoundWait);

  const hasBg = state.bgType !== 'none' && state.bgPath !== '';
  const modKey = IS_MACOS ? '⌘' : 'Ctrl';

  const SECTIONS: { id: Section; label: string }[] = [
    { id: 'general',    label: t('settings.general') },
    { id: 'appearance', label: t('settings.appearance') },
    { id: 'terminal',   label: t('settings.terminal') },
    { id: 'language',   label: t('settings.language') },
    { id: 'agent',      label: 'Coffee Agent' },
    { id: 'feedback',   label: t('settings.feedback') },
  ];
  const currentLabel = SECTIONS.find(s => s.id === section)?.label ?? '';

  return (
    // A page over the centre area, like usage and tool settings, not a dialog over the whole window.
    <div className="settings-page">
      <div className="settings-modal settings-modal--page" role="region" aria-label={t('settings.title')}>
        <aside className="settings-rail">
          {/* The page covers the whole window, so its first entry leads back. */}
          <button type="button" className="settings-rail-back" onClick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            {t('settings.back')}
          </button>
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={`settings-rail-item${section === s.id ? ' active' : ''}`}
              onClick={() => { finishScaleDrag(); setSection(s.id); }}
            >
              <span className="settings-rail-icon">{ICONS[s.id]}</span>
              {s.label}
            </button>
          ))}
          {version && (
            <div className="settings-rail-version">
              <span className="settings-rail-version-num">v{version}</span>
              <button
                type="button"
                className="settings-rail-version-link"
                onClick={() => commands.openUrl('https://coffeecli.com').catch(() => {})}
              >
                CoffeeCLI.com
              </button>
            </div>
          )}
        </aside>

        <section className="settings-content">
          <header className="settings-header">
            <span className="settings-header-title">{currentLabel}</span>
          </header>

          <div className={`settings-body${section === 'agent' ? ' settings-body--agent' : ''}`}>
            {section === 'agent' && <AgentSettings />}
            {section === 'appearance' && (
              <>
                <div className="settings-section-head">
                  <span className="settings-section-label">{t('theme.section.color')}</span>
                  {/* Mode lives on the section header: it picks which half of
                      every family below is applied, so it reads left-to-right
                      "colors, then which half". */}
                  <div className="settings-mode-tabs" role="tablist">
                    {THEME_MODES.map(m => (
                      <button
                        key={m.code}
                        type="button"
                        role="tab"
                        aria-selected={state.themeMode === m.code}
                        className={`settings-mode-tab${state.themeMode === m.code ? ' active' : ''}`}
                        onClick={() => setThemeMode(m.code)}
                      >
                        {t(m.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-theme-grid">
                  {THEME_COLORS.map(c => {
                    const active = c.code === state.currentTheme;
                    // Follow-system cards stand for a family rather than one
                    // half, so their preview is the day/night split; the label
                    // stays the family's single name in every tab.
                    const follow = state.themeMode === 'system';
                    // The night tab shows the night half only; the day tab and
                    // the follow tab both start from the day half.
                    const showDay = follow || state.themeMode === 'light';
                    const bg = showDay ? c.daySwatch : c.swatch;
                    const ring = showDay ? c.dayRing : c.ring;
                    return (
                      <button
                        key={c.code}
                        className={`settings-theme-card${active ? ' active' : ''}`}
                        onClick={() => setTheme(c.code)}
                        aria-pressed={active}
                      >
                        <span className={`settings-theme-preview${follow ? ' split' : ''}`} style={{ '--ring': ring } as CSSProperties}>
                          <span className="settings-theme-half">
                            <span className="settings-theme-band-bg" style={{ background: bg }} />
                            <span className="settings-theme-band-accent" style={{ background: ring }} />
                          </span>
                          {follow && (
                            <span className="settings-theme-half">
                              <span className="settings-theme-band-bg" style={{ background: c.swatch }} />
                              <span className="settings-theme-band-accent" style={{ background: c.ring }} />
                            </span>
                          )}
                          {active && (
                            <span className="settings-theme-check" style={{ background: ring }}>
                              <svg viewBox="0 0 24 24" fill="none" stroke={bg} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                            </span>
                          )}
                        </span>
                        <span className="settings-theme-name">
                          {t(c.labelKey)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="settings-section-label">{t('theme.section.shape')}</div>
                <div className="settings-chip-row">
                  {THEME_SHAPES.map(s => (
                    <button
                      key={s.code}
                      className={`settings-chip${s.code === state.currentShape ? ' active' : ''}`}
                      onClick={() => setShape(s.code)}
                    >
                      {t(s.labelKey)}
                    </button>
                  ))}
                </div>

                <div className="settings-section-label">{t('theme.section.icons')}</div>
                <div className="settings-chip-row settings-icon-row">
                  {ICON_ART_THEMES.map(({ id, folderSrc }) => (
                    <button
                      key={id}
                      className={`settings-icon-chip${state.iconTheme === id ? ' active' : ''}`}
                      onClick={() => setIconTheme(id)}
                    >
                      {isMaskTintTheme(id) ? (
                        <span
                          className="settings-icon-mask"
                          style={{ WebkitMaskImage: `url("${folderSrc}")`, maskImage: `url("${folderSrc}")` }}
                          aria-label={id}
                        />
                      ) : (
                        <img src={folderSrc} alt={id} width="24" height="24" />
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* The window is roomy now: wallpaper sits under appearance, sounds under general. */}
            {section === 'appearance' && (
              <>
                <div className="settings-group-gap" aria-hidden="true" />
                <div className="settings-section-label">{t('settings.wallpaper')}</div>
                <div className="settings-wallpaper-actions">
                  <button className="settings-btn" onClick={pickBg}>{t('settings.wallpaper.pick')}</button>
                  {hasBg && (
                    <button className="settings-btn settings-btn-danger" onClick={clearBg}>
                      {t('settings.wallpaper.clear')}
                    </button>
                  )}
                </div>

                <div className="settings-section-head">
                  <label className="settings-section-label" htmlFor="settings-wallpaper-opacity">{t('settings.wallpaper.opacity')}</label>
                  <div className="settings-scale-actions"><output htmlFor="settings-wallpaper-opacity">{state.wallpaperOpacity}%</output></div>
                </div>
                <SettingsSlider
                  id="settings-wallpaper-opacity"
                  min={0} max={100} step={5}
                  ticks={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]}
                  marks={[0, 50, 100]}
                  value={state.wallpaperOpacity}
                  onChange={setOpacity}
                  disabled={!hasBg}
                  label={t('settings.wallpaper.opacity')}
                />
              </>
            )}

            {section === 'terminal' && (
              <>
                <div className="settings-section-label">{t('settings.terminal.scheme')}</div>
                <div className="settings-chip-row">
                  <button
                    className={`settings-term-chip reset${state.termColorScheme === '' ? ' active' : ''}`}
                    onClick={() => setScheme('')}
                  >
                    Aa
                  </button>
                  {TERM_COLOR_SCHEMES.map(s => (
                    <button
                      key={s.id}
                      className={`settings-term-chip${state.termColorScheme === s.id ? ' active' : ''}`}
                      style={{ color: s.fg }}
                      onClick={() => setScheme(state.termColorScheme === s.id ? '' : s.id)}
                    >
                      Aa
                    </button>
                  ))}
                </div>

                <div className="settings-section-label">{t('settings.terminal.font')}</div>
                <FontPicker fonts={fonts} value={state.termFont} onChange={setFont} />
                <div
                  className="settings-font-preview"
                  style={{ fontFamily: state.termFont ? `"${state.termFont}", monospace` : 'monospace' }}
                >
                  {'Coffee CLI · AaBb 0123 {}=>'}
                </div>

                {/* Default shell picker. Shell NAMES are not translated
                    (read from the OS / detection as-is); only this label
                    and the "not recommended" suffix are localized. Card
                    style reuses the gambit keyboard-card — same control
                    surface the user already knows from hotkey selection.
                    Shells that weren't detected installed are omitted so
                    the user can't pick a dead one; Auto is always first. */}
                <div className="settings-section-label">{t('settings.terminal.shell')}</div>
                <div className="settings-key-row">
                  <button
                    className={`settings-key-card${state.defaultShell === '' ? ' active' : ''}`}
                    onClick={() => setDefaultShell('')}
                    aria-pressed={state.defaultShell === ''}
                  >
                    <span className="settings-key-combo"><kbd>Auto</kbd></span>
                    <span className="settings-key-sub">{t('settings.terminal.shell.auto')}</span>
                  </button>
                  {IS_WINDOWS && (() => {
                    const caps = shellCaps;
                    // Order: pwsh (PowerShell 7) → PowerShell 5 (inbox) →
                    // Git Bash → cmd (末位). pwsh / git-bash only when
                    // detected; PowerShell 5 + cmd are inbox on every
                    // supported Windows so always offered.
                    //
                    // Labels show the major version (PowerShell 7 / 5) plus
                    // the EXACT probed version as a sub-label — 7 and 5 are
                    // distinct CLIs with different runtimes (.NET 8+ cross-
                    // platform vs inbox Windows-only) and users have
                    // opinions. A bare "pwsh" vs "PowerShell" pair was
                    // opaque; showing the real build (e.g. 7.4.6) lets users
                    // pick the one they want (most prefer 7) and proves the
                    // detection is live.
                    const opts: { id: string; label: string; show: boolean; version?: string; notRecommended?: boolean }[] = [
                      { id: 'pwsh', label: 'PowerShell 7', show: !!caps?.pwsh_available, version: caps?.pwsh_version ?? undefined },
                      { id: 'powershell', label: 'PowerShell 5', show: true, version: caps?.powershell_version ?? undefined },
                      { id: 'git-bash', label: 'Git Bash', show: !!caps?.git_bash_available },
                      { id: 'cmd', label: 'Command Prompt', show: true, notRecommended: true },
                    ];
                    return opts.filter(o => o.show).map(o => {
                      const active = state.defaultShell === o.id;
                      return (
                        <button
                          key={o.id}
                          className={`settings-key-card${active ? ' active' : ''}`}
                          onClick={() => setDefaultShell(o.id)}
                          aria-pressed={active}
                        >
                          <span className="settings-key-combo"><kbd>{o.label}</kbd></span>
                          {o.version && (
                            <span className="settings-key-sub">{o.version}</span>
                          )}
                          {o.notRecommended && !o.version && (
                            <span className="settings-key-sub">{t('settings.terminal.shell.not_recommended')}</span>
                          )}
                        </button>
                      );
                    });
                  })()}
                  {!IS_WINDOWS && (() => {
                    // macOS/Linux: each candidate is probed via `which`, so
                    // only installed shells get a card (fish is absent by
                    // default on macOS → no dead card). Auto reads $SHELL.
                    const caps = shellCaps;
                    const opts = [
                      { id: 'zsh', label: 'zsh', show: !!caps?.zsh_available },
                      { id: 'bash', label: 'bash', show: !!caps?.bash_available },
                      { id: 'fish', label: 'fish', show: !!caps?.fish_available },
                      { id: 'sh', label: 'sh', show: !!caps?.sh_available },
                    ];
                    return opts.filter(o => o.show).map(o => {
                      const active = state.defaultShell === o.id;
                      return (
                        <button
                          key={o.id}
                          className={`settings-key-card${active ? ' active' : ''}`}
                          onClick={() => setDefaultShell(o.id)}
                          aria-pressed={active}
                        >
                          <span className="settings-key-combo"><kbd>{o.label}</kbd></span>
                        </button>
                      );
                    });
                  })()}
                </div>
              </>
            )}


            {section === 'general' && (
              <>
                <div className="settings-section-head">
                  <label className="settings-section-label" htmlFor="settings-ui-scale">{t('settings.uiScale')}</label>
                  <div className="settings-scale-actions">
                    <output htmlFor="settings-ui-scale">{Math.round(sliderPercent / 10) * 10}%</output>
                    <button type="button" className="settings-scale-reset" disabled={uiScale.pending || uiScale.percent === 100 && !uiScale.failed} onClick={() => void setUiScale(100)}>{t('settings.uiScale.reset')}</button>
                  </div>
                </div>
                <SettingsSlider
                  id="settings-ui-scale"
                  label={t('settings.uiScale')}
                  min={70} max={150} step={10}
                  ticks={[70, 80, 90, 100, 110, 120, 130, 140, 150]}
                  marks={[70, 100, 150]}
                  value={scalePercent}
                  commitOnRelease
                  onChange={percent => void setUiScale(percent)}
                  onPreview={setDragPercent}
                />
                {uiScale.failed && <div className="settings-scale-error" role="alert">{t('settings.uiScale.error')}</div>}
                <div className="settings-section-label">{t('settings.tasks.view')}</div>
                <div className="settings-key-row">
                  {TASK_VIEW_MODES.map(m => {
                    const active = state.taskViewMode === m.code;
                    return (
                      <button
                        key={m.code}
                        className={`settings-key-card settings-taskview-card${active ? ' active' : ''}`}
                        onClick={() => setTaskView(m.code)}
                        aria-pressed={active}
                      >
                        <span className="settings-key-combo">
                          <span className="settings-taskview-icon">{TASK_VIEW_ICONS[m.code]}</span>
                          <span className="settings-taskview-label">{t(m.labelKey)}</span>
                        </span>
                        <span className="settings-key-sub">{t(m.subKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {section === 'general' && (
              <>
                {/* Shortcuts, one line each like the sounds: what the key does at the left; its choice at the right,
                    with a line under it saying what the chosen keys do. */}
                <div className="settings-sound-list">
                  <div className="settings-sound-row settings-choice-row">
                    <div className="settings-sound-title">{t('settings.send.title')}</div>
                    <div className="settings-choice">
                      <SegmentedTabs compact label={t('settings.send.title')} value={state.gambitEnterToSend ? 'enter' : 'mod'} onChange={value => setEnterToSend(value === 'enter')}
                        options={[{ value: 'enter', content: <kbd>Enter</kbd> }, { value: 'mod', content: <><kbd>{modKey}</kbd>+<kbd>Enter</kbd></> }]} />
                      <div className="settings-choice-hint">{state.gambitEnterToSend ? 'Shift+Enter' : 'Enter'} {t('settings.send.newline')}</div>
                    </div>
                  </div>
                  <div className="settings-sound-row settings-choice-row">
                    <div className="settings-sound-title">{t('settings.gambit.hotkey')}</div>
                    <div className="settings-choice">
                      <SegmentedTabs compact label={t('settings.gambit.hotkey')} value={state.hotkeyScheme} onChange={setHotkeyScheme}
                        options={HOTKEY_SCHEMES.map(h => ({ value: h.code, content: <><kbd>{h.mod}</kbd>+<kbd>{h.keys.left.key}</kbd><kbd>{h.keys.gambit.key}</kbd><kbd>{h.keys.right.key}</kbd></> }))} />
                      {(() => { const h = HOTKEY_SCHEMES.find(item => item.code === state.hotkeyScheme) ?? HOTKEY_SCHEMES[0]; return <div className="settings-choice-hint">{t('settings.gambit.hotkey_hint', { left: `${h.mod}+${h.keys.left.key}`, gambit: `${h.mod}+${h.keys.gambit.key}`, right: `${h.mod}+${h.keys.right.key}` })}</div>; })()}
                    </div>
                  </div>
                </div>
              </>
            )}

            {section === 'general' && (
              <>
                {/* One line per sound: name at the left; the sound in use (× restores the default for a custom
                    file, Change picks another), Preview and the switch at the right. */}
                <div className="settings-sound-list">
                {([
                  { labelKey: 'settings.sound.done', value: soundDone, set: setSoundDonePref, preview: 'done' as const },
                  { labelKey: 'settings.sound.wait', value: soundWait, set: setSoundWaitPref, preview: 'wait' as const },
                ] as const).map(row => (
                  <div key={row.labelKey} className="settings-sound-item">
                    <div className="settings-sound-row">
                      <div className="settings-sound-title">{t(row.labelKey)}</div>
                      {row.value && <>
                        <span className="settings-sound-current">
                          <span className="settings-sound-name">{soundFiles[row.preview] ? shortFileName(soundFiles[row.preview]!) : t('settings.sound.default')}</span>
                          {soundFiles[row.preview] && <button type="button" className="settings-sound-remove" aria-label={t('settings.sound.remove')} onClick={() => clearSound(row.preview)}>
                            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m3 3 6 6m0-6-6 6" /></svg>
                          </button>}
                          <button type="button" className="settings-sound-link" onClick={() => { void pickSound(row.preview); }}>{t('settings.sound.change')}</button>
                        </span>
                        <button type="button" className="settings-sound-play" aria-label={t('settings.sound.preview')} onClick={() => playNotifySound(row.preview)}>
                          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
                        </button>
                      </>}
                      <button type="button" role="switch" className="settings-switch" aria-checked={row.value} aria-label={t(row.labelKey)} onClick={() => row.set(!row.value)}><span /></button>
                    </div>
                    {soundFailed === row.preview && <div className="settings-sound-failed" role="alert">{t('settings.sound.failed')}</div>}
                  </div>
                ))}
                </div>
              </>
            )}

            {section === 'language' && (
              <div className="settings-lang-list">
                {LANGUAGES.map(lang => (
                  <button
                    key={lang.code}
                    className={`settings-lang-item${lang.code === state.currentLang ? ' active' : ''}`}
                    onClick={() => setLang(lang.code)}
                  >
                    <span className="settings-lang-glyph">{lang.glyph}</span>
                    <span className="settings-lang-label">{lang.label}</span>
                    {lang.code === state.currentLang && (
                      <span className="settings-lang-check">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {section === 'feedback' && (
              <>
                <p className="settings-feedback-desc">{t('settings.feedback.desc')}</p>
                <div className="settings-feedback-cards">
                  <button
                    type="button"
                    className="settings-feedback-card"
                    onClick={() => commands.openUrl('https://github.com/edison7009/Coffee-CLI/issues').catch(() => {})}
                  >
                    <span className="settings-feedback-card-icon">
                      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                      </svg>
                    </span>
                    <span className="settings-feedback-card-label">GitHub</span>
                    <ExternalLinkArrow />
                  </button>
                  {state.currentLang === 'zh-CN' && (
                    <button
                      type="button"
                      className="settings-feedback-card"
                      onClick={() => commands.openUrl('https://gitcode.com/edison7009/Coffee-CLI/issues').catch(() => {})}
                    >
                      <span className="settings-feedback-card-label">国内访问：GitCode</span>
                      <ExternalLinkArrow />
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
