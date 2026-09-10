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
import { useAppState, useAppDispatch, HOTKEY_SCHEMES, type HotkeyScheme, type TitlebarToggleDisplay, type ThemeColor, type ThemeShape, type IconTheme } from '../../store/app-state';
import { playNotifySound } from '../../lib/notify-sound';
import { useT } from '../../i18n/useT';
import { IS_MACOS, IS_WINDOWS } from '../../lib/platform';
import { TERM_COLOR_SCHEMES } from '../center/TierTerminal';
import { commands, type FontInfo } from '../../tauri';
import { FontPicker } from './FontPicker';
import { THEME_COLORS, THEME_SHAPES, ICON_ART_THEMES, LANGUAGES, TASK_VIEW_MODES, isMaskTintTheme } from '../../lib/personalization';
import './SettingsModal.css';

type Section = 'appearance' | 'wallpaper' | 'terminal' | 'gambit' | 'sound' | 'tasks' | 'language' | 'feedback';

// Trailing "opens outside the app" affordance on the feedback cards.
const ExternalLinkArrow = () => (
  <svg className="settings-feedback-card-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7" /><path d="M7 7h10v10" />
  </svg>
);

// Read a `cc-*` boolean localStorage preference. Module-level
// so the SettingsModal sound toggles can seed their useState initializers.
// Both sound prefs default to ON (absent = true).
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
  tasks: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" />
      <path d="m9 11 3 3L22 4" />
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
  const [section, setSection] = useState<Section>('appearance');
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

  const open = state.settingsOpen;
  const close = () => dispatch({ type: 'SET_SETTINGS_OPEN', open: false });

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
  const setTitlebarToggleDisplay = (value: TitlebarToggleDisplay) => {
    dispatch({ type: 'SET_TITLEBAR_TOGGLE_DISPLAY', value });
    try { localStorage.setItem('cc-titlebar-toggle-display', value); } catch { /* Best-effort operation; failure is non-fatal. */ }
  };

  // Sound notification toggles — local state + localStorage only. The
  // notify-sound module reads these keys live on native title state changes,
  // so no app-state wiring is needed. Both default to ON.
  const writeSoundPref = (key: string, setter: (v: boolean) => void) => (v: boolean) => {
    setter(v);
    try { localStorage.setItem(key, String(v)); } catch { /* Best-effort operation; failure is non-fatal. */ }
  };
  const setSoundDonePref = writeSoundPref('cc-sound-done', setSoundDone);
  const setSoundWaitPref = writeSoundPref('cc-sound-wait', setSoundWait);

  const hasBg = state.bgType !== 'none' && state.bgPath !== '';
  const modKey = IS_MACOS ? '⌘' : 'Ctrl';

  const SECTIONS: { id: Section; label: string }[] = [
    { id: 'appearance', label: t('settings.appearance') },
    { id: 'wallpaper',  label: t('settings.wallpaper') },
    { id: 'terminal',   label: t('settings.terminal') },
    { id: 'gambit',     label: t('settings.gambit') },
    { id: 'sound',      label: t('settings.sound') },
    { id: 'tasks',      label: t('settings.tasks') },
    { id: 'language',   label: t('settings.language') },
    { id: 'feedback',   label: t('settings.feedback') },
  ];
  const currentLabel = SECTIONS.find(s => s.id === section)?.label ?? '';

  return (
    <div className="settings-overlay" onMouseDown={close}>
      <div
        className="settings-modal"
        onMouseDown={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <aside className="settings-rail">
          <div className="settings-rail-title">{t('settings.title')}</div>
          {SECTIONS.map(s => (
            <button
              key={s.id}
              className={`settings-rail-item${section === s.id ? ' active' : ''}`}
              onClick={() => setSection(s.id)}
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
            <button className="settings-close" onClick={close} aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          </header>

          <div className="settings-body">
            {section === 'appearance' && (
              <>
                <div className="settings-section-label">{t('theme.section.color')}</div>
                <div className="settings-theme-grid">
                  {THEME_COLORS.map(c => {
                    const active = c.code === state.currentTheme;
                    return (
                      <button
                        key={c.code}
                        className={`settings-theme-card${active ? ' active' : ''}`}
                        onClick={() => setTheme(c.code)}
                        aria-pressed={active}
                      >
                        <span className="settings-theme-preview" style={{ '--ring': c.ring } as CSSProperties}>
                          <span className="settings-theme-band-bg" style={{ background: c.swatch }} />
                          <span className="settings-theme-band-accent" style={{ background: c.ring }} />
                          {active && (
                            <span className="settings-theme-check" style={{ background: c.ring }}>
                              <svg viewBox="0 0 24 24" fill="none" stroke={c.swatch} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                            </span>
                          )}
                        </span>
                        <span className="settings-theme-name">{t(c.labelKey)}</span>
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
                      {s.label}
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

            {section === 'wallpaper' && (
              <>
                <div className="settings-section-label">{t('settings.wallpaper')}</div>
                <div className="settings-wallpaper-actions">
                  <button className="settings-btn" onClick={pickBg}>{t('settings.wallpaper.pick')}</button>
                  {hasBg && (
                    <button className="settings-btn settings-btn-danger" onClick={clearBg}>
                      {t('settings.wallpaper.clear')}
                    </button>
                  )}
                </div>

                <div className="settings-section-label">{t('settings.wallpaper.opacity')}</div>
                <div className="settings-slider-row">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={state.wallpaperOpacity}
                    onChange={e => setOpacity(parseInt(e.target.value, 10))}
                    className="settings-slider"
                    disabled={!hasBg}
                    aria-label="Wallpaper opacity"
                  />
                  <span className="settings-slider-value">{state.wallpaperOpacity}%</span>
                </div>
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

            {section === 'gambit' && (
              <>
                <div className="settings-section-label">{t('settings.send.title')}</div>
                <div className="settings-key-row">
                  <button
                    className={`settings-key-card${state.gambitEnterToSend ? ' active' : ''}`}
                    onClick={() => setEnterToSend(true)}
                    aria-pressed={state.gambitEnterToSend}
                  >
                    <span className="settings-key-combo"><kbd>Enter</kbd></span>
                    <span className="settings-key-sub">Shift+Enter {t('settings.send.newline')}</span>
                  </button>
                  <button
                    className={`settings-key-card${!state.gambitEnterToSend ? ' active' : ''}`}
                    onClick={() => setEnterToSend(false)}
                    aria-pressed={!state.gambitEnterToSend}
                  >
                    <span className="settings-key-combo"><kbd>{modKey}</kbd><span className="settings-key-plus">+</span><kbd>Enter</kbd></span>
                    <span className="settings-key-sub">Enter {t('settings.send.newline')}</span>
                  </button>
                </div>

                <div className="settings-section-label">{t('settings.gambit.hotkey')}</div>
                <div className="settings-key-row settings-key-row--keys">
                  {HOTKEY_SCHEMES.map(s => {
                    const active = state.hotkeyScheme === s.code;
                    return (
                      <button
                        key={s.code}
                        className={`settings-key-card${active ? ' active' : ''}`}
                        onClick={() => setHotkeyScheme(s.code)}
                        aria-pressed={active}
                      >
                        {/* Modifier + the three keys (left · Gambit · right, in
                            that L→R order). Titlebar hints show which is which. */}
                        <span className="settings-key-combo"><kbd>{s.mod}</kbd><span className="settings-key-plus">+</span><kbd>{s.keys.left.key}</kbd><kbd>{s.keys.gambit.key}</kbd><kbd>{s.keys.right.key}</kbd></span>
                      </button>
                    );
                  })}
                </div>

                <div className="settings-section-label">{t('settings.titlebar.toggle')}</div>
                <div className="settings-key-row">
                  {([
                    { code: 'icon-hotkey', labelKey: 'settings.titlebar.toggle.icon-hotkey' },
                    { code: 'icon', labelKey: 'settings.titlebar.toggle.icon' },
                    { code: 'hidden', labelKey: 'settings.titlebar.toggle.hidden' },
                  ] as const).map(m => {
                    const active = state.titlebarToggleDisplay === m.code;
                    return (
                      <button key={m.code} className={`settings-key-card${active ? ' active' : ''}`} onClick={() => setTitlebarToggleDisplay(m.code)} aria-pressed={active}>
                        <span className="settings-key-combo">{t(m.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {section === 'sound' && (
              <>
                {/* Each row: setting label + On/Off cards (same settings-key-card
                    idiom as the other toggles). The two sound kinds get a
                    preview button that plays the chime immediately. */}
                {([
                  { labelKey: 'settings.sound.done', value: soundDone, set: setSoundDonePref, preview: 'done' as const },
                  { labelKey: 'settings.sound.wait', value: soundWait, set: setSoundWaitPref, preview: 'wait' as const },
                ] as const).map(row => (
                  <div key={row.labelKey} style={{ marginBottom: 18 }}>
                    <div className="settings-section-label">{t(row.labelKey)}</div>
                    <div className="settings-key-row">
                      <button
                        className={`settings-key-card${row.value ? ' active' : ''}`}
                        onClick={() => row.set(true)}
                        aria-pressed={row.value}
                      >
                        <span className="settings-key-combo">{t('settings.sound.on')}</span>
                      </button>
                      <button
                        className={`settings-key-card${!row.value ? ' active' : ''}`}
                        onClick={() => row.set(false)}
                        aria-pressed={!row.value}
                      >
                        <span className="settings-key-combo">{t('settings.sound.off')}</span>
                      </button>
                      {row.preview && (
                        <button
                          className="settings-key-card"
                          onClick={() => playNotifySound(row.preview!)}
                        >
                          <span className="settings-key-combo">{t('settings.sound.preview')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}

            {section === 'tasks' && (
              <>
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
