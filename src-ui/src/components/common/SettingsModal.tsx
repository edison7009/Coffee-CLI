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

import { useEffect, useState, type ReactNode } from 'react';
import { useAppState, useAppDispatch, type ThemeColor, type ThemeShape, type IconTheme } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { IS_MACOS } from '../../lib/platform';
import { TERM_COLOR_SCHEMES } from '../center/TierTerminal';
import { commands, type FontInfo } from '../../tauri';
import { FontPicker } from './FontPicker';
import { THEME_COLORS, THEME_SHAPES, ICON_ART_THEMES, LANGUAGES, TASK_VIEW_MODES, isMaskTintTheme } from '../../lib/personalization';
import './SettingsModal.css';

type Section = 'appearance' | 'wallpaper' | 'terminal' | 'gambit' | 'tasks' | 'language';

// Per-mode preview glyphs for the Tasks section (checklist vs sticky note).
const TASK_VIEW_ICONS: Record<'list' | 'note', ReactNode> = {
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

  // Lazy-load the system font list when the Terminal section is first shown.
  useEffect(() => {
    if (!open || section !== 'terminal' || fonts !== null) return;
    commands.listSystemFonts().then(setFonts).catch(() => setFonts([]));
  }, [open, section, fonts]);

  if (!open) return null;

  // ── Handlers (identical to the former left-panel ThemeMenu/Lang wiring) ──
  const setTheme = (th: ThemeColor) => dispatch({ type: 'SET_THEME', theme: th });
  const setShape = (s: ThemeShape) => dispatch({ type: 'SET_SHAPE', shape: s });
  const setIconTheme = (th: IconTheme) => {
    dispatch({ type: 'SET_ICON_THEME', theme: th });
    try { localStorage.setItem('cc-icon-theme', th); } catch {}
  };
  const setLang = (code: string) => {
    dispatch({ type: 'SET_LANG', lang: code });
    try {
      localStorage.setItem('cc-lang', code);
      if (code !== 'en') localStorage.setItem('cc-native-lang', code);
    } catch {}
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
        try { localStorage.setItem('cc-bg-path', selected); localStorage.setItem('cc-bg-type', bgType); } catch {}
        dispatch({ type: 'SET_BG', path: selected, bgType });
      }
    } catch (err) { console.error('[Settings] background picker failed:', err); }
  };
  const clearBg = () => {
    try { localStorage.removeItem('cc-bg-path'); localStorage.removeItem('cc-bg-type'); } catch {}
    dispatch({ type: 'CLEAR_BG' });
  };
  const setScheme = (id: string) => {
    try { id ? localStorage.setItem('cc-term-scheme', id) : localStorage.removeItem('cc-term-scheme'); } catch {}
    dispatch({ type: 'SET_TERM_SCHEME', scheme: id });
  };
  const setFont = (family: string) => {
    // Strip quotes/backslashes — the value is interpolated into a CSS
    // fontFamily string, so don't let a stray quote break out of it.
    const clean = family.replace(/["\\]/g, '');
    try { clean ? localStorage.setItem('cc-term-font', clean) : localStorage.removeItem('cc-term-font'); } catch {}
    dispatch({ type: 'SET_TERM_FONT', font: clean });
  };
  const setOpacity = (n: number) => dispatch({ type: 'SET_WALLPAPER_OPACITY', opacity: n });
  const setTaskView = (mode: 'list' | 'note') => dispatch({ type: 'SET_TASK_VIEW_MODE', mode });
  const setEnterToSend = (value: boolean) => {
    dispatch({ type: 'SET_GAMBIT_ENTER_TO_SEND', value });
    try { localStorage.setItem('cc-gambit-enter-send', String(value)); } catch {}
  };

  const hasBg = state.bgType !== 'none' && state.bgPath !== '';
  const modKey = IS_MACOS ? '⌘' : 'Ctrl';

  const SECTIONS: { id: Section; label: string }[] = [
    { id: 'appearance', label: t('settings.appearance' as any) },
    { id: 'wallpaper',  label: t('settings.wallpaper' as any) },
    { id: 'terminal',   label: t('settings.terminal' as any) },
    { id: 'gambit',     label: t('settings.gambit' as any) },
    { id: 'tasks',      label: t('settings.tasks' as any) },
    { id: 'language',   label: t('settings.language' as any) },
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
          <div className="settings-rail-title">{t('settings.title' as any)}</div>
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
          {version && <div className="settings-rail-version">v{version}</div>}
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
                        <span className="settings-theme-preview" style={{ ['--ring' as any]: c.ring }}>
                          <span className="settings-theme-band-bg" style={{ background: c.swatch }} />
                          <span className="settings-theme-band-accent" style={{ background: c.ring }} />
                          {active && (
                            <span className="settings-theme-check" style={{ background: c.ring }}>
                              <svg viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                            </span>
                          )}
                        </span>
                        <span className="settings-theme-name">{t(c.labelKey as any)}</span>
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
                <div className="settings-section-label">{t('settings.wallpaper' as any)}</div>
                <div className="settings-wallpaper-actions">
                  <button className="settings-btn" onClick={pickBg}>{t('settings.wallpaper.pick' as any)}</button>
                  {hasBg && (
                    <button className="settings-btn settings-btn-danger" onClick={clearBg}>
                      {t('settings.wallpaper.clear' as any)}
                    </button>
                  )}
                </div>

                <div className="settings-section-label">{t('settings.wallpaper.opacity' as any)}</div>
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
                <div className="settings-section-label">{t('settings.terminal.scheme' as any)}</div>
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

                <div className="settings-section-label">{t('settings.terminal.font' as any) || '字体'}</div>
                <FontPicker fonts={fonts} value={state.termFont} onChange={setFont} />
                <div
                  className="settings-font-preview"
                  style={{ fontFamily: state.termFont ? `"${state.termFont}", monospace` : 'monospace' }}
                >
                  Coffee CLI · 终端字体预览 AaBb 123 {'{ }'} =&gt;
                </div>
              </>
            )}

            {section === 'gambit' && (
              <>
                <div className="settings-section-label">{t('settings.send.title' as any)}</div>
                <div className="settings-key-row">
                  <button
                    className={`settings-key-card${state.gambitEnterToSend ? ' active' : ''}`}
                    onClick={() => setEnterToSend(true)}
                    aria-pressed={state.gambitEnterToSend}
                  >
                    <span className="settings-key-combo"><kbd>Enter</kbd></span>
                    <span className="settings-key-sub">Shift+Enter {t('settings.send.newline' as any)}</span>
                  </button>
                  <button
                    className={`settings-key-card${!state.gambitEnterToSend ? ' active' : ''}`}
                    onClick={() => setEnterToSend(false)}
                    aria-pressed={!state.gambitEnterToSend}
                  >
                    <span className="settings-key-combo"><kbd>{modKey}</kbd><span className="settings-key-plus">+</span><kbd>Enter</kbd></span>
                    <span className="settings-key-sub">Enter {t('settings.send.newline' as any)}</span>
                  </button>
                </div>
              </>
            )}

            {section === 'tasks' && (
              <>
                <div className="settings-section-label">{t('settings.tasks.view' as any)}</div>
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
                          <span className="settings-taskview-label">{t(m.labelKey as any)}</span>
                        </span>
                        <span className="settings-key-sub">{t(m.subKey as any)}</span>
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
          </div>
        </section>
      </div>
    </div>
  );
}
