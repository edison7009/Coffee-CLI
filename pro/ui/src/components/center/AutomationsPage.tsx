import { useMemo, useState, useSyncExternalStore } from 'react';
import { SegmentedTabs } from '../common/SegmentedTabs';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { getToolDisplayName } from '../../lib/tool-info';
import { getProjectFolders, subscribeProjectFolders } from '../../lib/project-folders';
import { pickFolder } from '../../lib/folder-picker';
import { AUTOMATION_TOOLS, getAutomations, removeAutomation, saveAutomation, setAutomations, subscribeAutomations, scheduleNext, runAutomationNow, folderName, scheduleSummary, MIN_INTERVAL_MINUTES, type Automation, type AutomationSchedule, type AutomationTool } from '../../lib/automations';
import '../common/SettingsModal.css';
import './Automations.css';

type Kind = AutomationSchedule['kind'];
// Number and date fields hold what was typed; they are read on save.
interface Draft { id?: string; name: string; prompt: string; tool: AutomationTool; cwd: string; kind: Kind; time: string; days: number[]; everyH: string; everyM: string; date: string; onceTime: string; createdAt?: number; enabled: boolean }

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const digits = (value: string) => value.replace(/\D/g, '').slice(0, 4);
/** Monday first, as most calendars here show the week. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function toDraft(a?: Automation, cwd = ''): Draft {
  const s = a?.schedule;
  return {
    id: a?.id, name: a?.name ?? '', prompt: a?.prompt ?? '', tool: a?.tool ?? 'claude', cwd: a?.cwd ?? cwd,
    kind: s?.kind ?? 'daily', time: s && 'time' in s ? s.time : '09:00', days: s?.kind === 'weekly' ? s.days : [1],
    everyH: s?.kind === 'interval' ? String(Math.floor(s.minutes / 60)) : '4', everyM: s?.kind === 'interval' ? String(s.minutes % 60) : '0',
    date: localDate(s?.kind === 'once' ? s.at : Date.now() + 60 * 60 * 1000), onceTime: localTime(s?.kind === 'once' ? s.at : Date.now() + 60 * 60 * 1000),
    createdAt: a?.createdAt, enabled: a?.enabled ?? true,
  };
}
/** The schedule a draft describes, or the message for what is wrong with it. */
function toSchedule(d: Draft): AutomationSchedule | 'automation.need_interval' | 'automation.need_date' | 'automation.need_day' {
  switch (d.kind) {
    case 'once': {
      const date = d.date.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/), [h, m] = d.onceTime.split(':').map(Number);
      if (!date) return 'automation.need_date';
      const at = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), h || 0, m || 0);
      return at.getMonth() === Number(date[2]) - 1 ? { kind: 'once', at: at.getTime() } : 'automation.need_date';
    }
    case 'interval': {
      const minutes = (Number(d.everyH) || 0) * 60 + (Number(d.everyM) || 0);
      return minutes >= MIN_INTERVAL_MINUTES ? { kind: 'interval', minutes } : 'automation.need_interval';
    }
    case 'weekly': return d.days.length ? { kind: 'weekly', days: d.days, time: d.time } : 'automation.need_day';
    default: return { kind: d.kind, time: d.time };
  }
}

/** The automations page: prompts that open a desktop conversation on a schedule. */
export function AutomationsPage() {
  const t = useT();
  const { state, dispatch } = useAppState();
  const automations = useSyncExternalStore(subscribeAutomations, getAutomations, getAutomations);
  const folders = useSyncExternalStore(subscribeProjectFolders, getProjectFolders, getProjectFolders);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const lang = state.currentLang;
  const weekday = useMemo(() => { const f = new Intl.DateTimeFormat(lang, { weekday: 'short' }); return (day: number) => f.format(new Date(2024, 0, 7 + day)); }, [lang]);
  const when = (ms: number) => new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
  const summary = (s: AutomationSchedule) => scheduleSummary(s, t, lang);

  const save = () => {
    if (!draft) return;
    if (!draft.prompt.trim()) { setError(t('automation.need_prompt')); return; }
    if (!draft.cwd.trim()) { setError(t('automation.need_folder')); return; }
    const schedule = toSchedule(draft);
    if (typeof schedule === 'string') { setError(t(schedule)); return; }
    if (schedule.kind === 'once' && !(schedule.at > Date.now())) { setError(t('automation.need_future')); return; }
    const previous = automations.find(item => item.id === draft.id);
    saveAutomation({ ...previous, id: draft.id ?? crypto.randomUUID(), name: draft.name.trim() || draft.prompt.trim().split('\n')[0].slice(0, 40), prompt: draft.prompt.trim(),
      tool: draft.tool, cwd: draft.cwd.trim(), schedule, enabled: draft.enabled, createdAt: draft.createdAt ?? Date.now() });
    setDraft(null); setError('');
  };
  const chooseFolder = async () => {
    const path = await pickFolder({ start: draft?.cwd || null });
    if (path && draft) setDraft({ ...draft, cwd: path });
  };
  const toggle = (a: Automation) => setAutomations(current => current.map(item => item.id === a.id ? scheduleNext({ ...item, enabled: !item.enabled }, Date.now()) : item));

  return <div className="automations-page">
    <div className="automations-content">
      <header className="automations-head">
        <h1>{t('automation.title')}</h1>
        {/* Hidden, not removed, while editing: the header keeps its height and the note below stays put. */}
        <button type="button" className="settings-btn automations-new" hidden={!!draft} onClick={() => { setDraft(toDraft(undefined, folders[0] ?? '')); setError(''); }}>+ {t('automation.new')}</button>
      </header>

      {draft && <section className="automations-editor" aria-label={t('automation.new')}>
        <label className="automations-field"><span>{t('automation.name')}</span>
          <input value={draft.name} placeholder={t('automation.name_placeholder')} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="automations-field"><span>{t('automation.prompt')}</span>
          <textarea rows={4} value={draft.prompt} placeholder={t('automation.prompt_placeholder')} onChange={e => setDraft({ ...draft, prompt: e.target.value })} /></label>
        <div className="automations-field"><span>{t('automation.app')}</span>
          <SegmentedTabs label={t('automation.app')} value={draft.tool} onChange={tool => setDraft({ ...draft, tool })}
            options={AUTOMATION_TOOLS.map(tool => ({ value: tool, content: getToolDisplayName(tool) }))} /></div>
        <div className="automations-field"><span>{t('automation.folder')}</span>
          {/* The launchpad's projects, one click each; another folder joins them by name once chosen. */}
          <div className="automations-folders" role="radiogroup" aria-label={t('automation.folder')}>
            {[...new Set([...folders, draft.cwd].filter(Boolean))].map(folder => <button key={folder} type="button" role="radio" aria-checked={draft.cwd === folder} className="automations-folder-chip" onClick={() => setDraft({ ...draft, cwd: folder })}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
              <span>{folderName(folder)}</span>
            </button>)}
            <button type="button" className="automations-folder-chip automations-folder-other" onClick={() => { void chooseFolder(); }}>{t('automation.folder_pick')}</button>
          </div>
          {draft.cwd && <div className="automations-folder-path">{draft.cwd}</div>}
        </div>
        <div className="automations-field"><span>{t('automation.schedule')}</span>
          {/* The kind and its details share a line; a week's days take a line of their own below. */}
          <div className="automations-schedule">
            <SegmentedTabs label={t('automation.schedule')} value={draft.kind} onChange={kind => setDraft({ ...draft, kind })}
              options={(['daily', 'weekdays', 'weekly', 'interval', 'once'] as const).map(kind => ({ value: kind, content: t(`automation.kind.${kind}`) }))} />
            {(draft.kind === 'daily' || draft.kind === 'weekdays') && <input type="time" aria-label={t('automation.schedule')} value={draft.time} onChange={e => setDraft({ ...draft, time: e.target.value })} />}
            {draft.kind === 'interval' && <>
              <label className="automations-amount"><input type="text" inputMode="numeric" value={draft.everyH} onChange={e => setDraft({ ...draft, everyH: digits(e.target.value) })} />{t('automation.hours')}</label>
              <label className="automations-amount"><input type="text" inputMode="numeric" value={draft.everyM} onChange={e => setDraft({ ...draft, everyM: digits(e.target.value) })} />{t('automation.minutes')}</label>
            </>}
            {draft.kind === 'once' && <>
              <input type="text" className="automations-date" inputMode="numeric" placeholder="2026-11-08" aria-label={t('automation.kind.once')} value={draft.date} onChange={e => setDraft({ ...draft, date: e.target.value })} />
              <input type="time" aria-label={t('automation.schedule')} value={draft.onceTime} onChange={e => setDraft({ ...draft, onceTime: e.target.value })} />
            </>}
          </div>
          {draft.kind === 'weekly' && <div className="automations-week">
            <div className="automations-days" role="group" aria-label={t('automation.kind.weekly')}>
              {WEEK.map(day => <button key={day} type="button" className="automations-folder-chip automations-day" aria-pressed={draft.days.includes(day)}
                onClick={() => setDraft({ ...draft, days: draft.days.includes(day) ? draft.days.filter(d => d !== day) : [...draft.days, day] })}>{weekday(day)}</button>)}
            </div>
            <input type="time" aria-label={t('automation.schedule')} value={draft.time} onChange={e => setDraft({ ...draft, time: e.target.value })} />
          </div>}
        </div>
        <p className="automations-hint" role="note">{t('automation.permission_note')}</p>
        {error && <p className="automations-error" role="alert">{error}</p>}
        <div className="automations-actions">
          <button type="button" className="settings-btn" onClick={() => { setDraft(null); setError(''); }}>{t('automation.cancel')}</button>
          <button type="button" className="settings-btn automations-primary" onClick={save}>{t('automation.save')}</button>
        </div>
      </section>}

      {/* Nothing yet: what automations need, once, under the title. */}
      {!automations.length && !draft && <p className="automations-empty-note">{t('automation.permission_note')}</p>}
      {/* While one is being created or edited, the form is all the page shows. */}
      {automations.length > 0 && !draft && <div className="settings-sound-list automations-list">
        {automations.map(a => {
          const open = a.lastRun?.sessionId && state.terminals.some(tab => tab.id === a.lastRun!.sessionId);
          return <div key={a.id} className="settings-sound-item">
            <div className="settings-sound-row automations-row">
              <div className="automations-row-text">
                <div className="automations-row-title">
                  <span className="settings-sound-title">{a.name}</span>
                  <span className="automations-row-state">{a.enabled && a.nextAt !== undefined ? t('automation.next', { time: when(a.nextAt) }) : t('automation.paused')}</span>
                </div>
                <div className="automations-row-sub">
                  {getToolDisplayName(a.tool)} · {summary(a.schedule)} · {folderName(a.cwd)}
                  {a.lastRun && <> · <span className={a.lastRun.ok ? '' : 'automations-failed'}>{t(a.lastRun.ok ? 'automation.last_ok' : 'automation.last_failed', { time: when(a.lastRun.at) })}</span></>}
                  {open && <> · <button type="button" className="settings-sound-link" onClick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: a.lastRun!.sessionId! })}>{t('automation.open_session')}</button></>}
                </div>
              </div>
              <button type="button" className="settings-sound-link" onClick={() => runAutomationNow(a.id)}>{t('automation.run_now')}</button>
              <button type="button" className="settings-sound-link" onClick={() => { setDraft(toDraft(a)); setError(''); }}>{t('automation.edit')}</button>
              <button type="button" className="settings-sound-link automations-delete" onClick={() => removeAutomation(a.id)}>{t('automation.delete')}</button>
              <button type="button" role="switch" className="settings-switch" aria-checked={a.enabled} aria-label={a.name} onClick={() => toggle(a)}><span /></button>
            </div>
          </div>;
        })}
      </div>}
    </div>
  </div>;
}
