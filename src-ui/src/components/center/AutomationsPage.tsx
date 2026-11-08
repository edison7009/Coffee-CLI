import { useMemo, useState, useSyncExternalStore } from 'react';
import { SegmentedTabs } from '../common/SegmentedTabs';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { ThemedSelect } from '../common/ThemedSelect';
import { getToolDisplayName } from '../../lib/tool-info';
import { getProjectFolders, subscribeProjectFolders } from '../../lib/project-folders';
import { AUTOMATION_TOOLS, getAutomations, removeAutomation, saveAutomation, setAutomations, subscribeAutomations, scheduleNext, runAutomationNow, folderName, scheduleSummary, type Automation, type AutomationSchedule, type AutomationTool } from '../../lib/automations';
import '../common/SettingsModal.css';
import './Automations.css';

type Kind = AutomationSchedule['kind'];
interface Draft { id?: string; name: string; prompt: string; tool: AutomationTool; cwd: string; kind: Kind; time: string; day: number; hours: number; at: string; createdAt?: number; enabled: boolean }

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function toDraft(a?: Automation, cwd = ''): Draft {
  const s = a?.schedule;
  return {
    id: a?.id, name: a?.name ?? '', prompt: a?.prompt ?? '', tool: a?.tool ?? 'claude', cwd: a?.cwd ?? cwd,
    kind: s?.kind ?? 'daily', time: s && 'time' in s ? s.time : '09:00', day: s?.kind === 'weekly' ? s.day : 1,
    hours: s?.kind === 'interval' ? s.hours : 4, at: localInput(s?.kind === 'once' ? s.at : Date.now() + 60 * 60 * 1000),
    createdAt: a?.createdAt, enabled: a?.enabled ?? true,
  };
}
function toSchedule(d: Draft): AutomationSchedule {
  switch (d.kind) {
    case 'once': return { kind: 'once', at: new Date(d.at).getTime() };
    case 'interval': return { kind: 'interval', hours: Math.max(1, Math.min(168, Math.round(d.hours) || 1)) };
    case 'weekly': return { kind: 'weekly', day: d.day, time: d.time };
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
    if (schedule.kind === 'once' && !(schedule.at > Date.now())) { setError(t('automation.need_future')); return; }
    const previous = automations.find(item => item.id === draft.id);
    saveAutomation({ ...previous, id: draft.id ?? crypto.randomUUID(), name: draft.name.trim() || draft.prompt.trim().split('\n')[0].slice(0, 40), prompt: draft.prompt.trim(),
      tool: draft.tool, cwd: draft.cwd.trim(), schedule, enabled: draft.enabled, createdAt: draft.createdAt ?? Date.now() });
    setDraft(null); setError('');
  };
  const pickFolder = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ directory: true, multiple: false });
    if (typeof path === 'string' && draft) setDraft({ ...draft, cwd: path });
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
            <button type="button" className="automations-folder-chip automations-folder-other" onClick={() => { void pickFolder(); }}>{t('automation.folder_pick')}</button>
          </div>
          {draft.cwd && <div className="automations-folder-path">{draft.cwd}</div>}
        </div>
        <div className="automations-field"><span>{t('automation.schedule')}</span>
          <div className="automations-schedule">
            <SegmentedTabs label={t('automation.schedule')} value={draft.kind} onChange={kind => setDraft({ ...draft, kind })}
              options={(['daily', 'weekdays', 'weekly', 'interval', 'once'] as const).map(kind => ({ value: kind, content: t(`automation.kind.${kind}`) }))} />
            {draft.kind === 'weekly' && <ThemedSelect label={t('automation.schedule')} value={String(draft.day)} options={[1, 2, 3, 4, 5, 6, 0].map(day => ({ value: String(day), label: weekday(day) }))} onChange={day => setDraft({ ...draft, day: Number(day) })} />}
            {(draft.kind === 'daily' || draft.kind === 'weekdays' || draft.kind === 'weekly') && <input type="time" value={draft.time} onChange={e => setDraft({ ...draft, time: e.target.value })} />}
            {draft.kind === 'interval' && <span className="automations-hours"><input type="number" min={1} max={168} value={draft.hours} onChange={e => setDraft({ ...draft, hours: Number(e.target.value) })} />{t('automation.hours')}</span>}
            {draft.kind === 'once' && <input type="datetime-local" value={draft.at} onChange={e => setDraft({ ...draft, at: e.target.value })} />}
          </div></div>
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
