import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { commands, type ToolMemoryDocument } from '../../tauri';
import { useT } from '../../i18n/useT';
import type { I18nKey } from '../../i18n/en';

interface Draft {
  document?: ToolMemoryDocument;
  text: string;
  loading: boolean;
  saving?: boolean;
  saved?: boolean;
  error?: I18nKey;
}
const editable = (text: string | null) => (text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const errors: Record<string, I18nKey> = {
  memory_read: 'tools.memory.read_error', memory_conflict: 'tools.memory.conflict', memory_readonly: 'tools.memory.readonly',
  memory_size: 'tools.memory.size', memory_encoding: 'tools.memory.encoding', memory_write: 'tools.memory.write_error',
};

export function ToolMemoryPanel({ active, tools }: { active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[] }) {
  const t = useT();
  const [selectedTool, setTool] = useState('claude');
  const tool = tools.some(item => item.value === selectedTool) ? selectedTool : tools[0]?.value ?? '';
  const installed = tools.find(item => item.value === tool)?.installed !== false;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [confirmReload, setConfirmReload] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ label: string; left: number; top: number } | null>(null);
  const showToolName = (button: HTMLButtonElement, label: string) => {
    const rect = button.getBoundingClientRect();
    setTooltip({ label, left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), top: rect.bottom + 6 });
  };
  const selectTool = (key: string) => { setTool(key); setConfirmReload(null); setTooltip(null); };
  useEffect(() => {
    if (!tooltip) return;
    const hide = () => setTooltip(null);
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [tooltip]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const update = useCallback((key: string, patch: Partial<Draft>) => {
    if (mounted.current) setDrafts(previous => ({ ...previous, [key]: { ...(previous[key] ?? { text: '', loading: false }), ...patch } }));
  }, []);
  const reload = useCallback(async (key: string) => {
    update(key, { loading: true, error: undefined, saved: false });
    try {
      const document = await commands.readToolMemory(key);
      update(key, { document, text: editable(document.content), loading: false });
    } catch (error) { update(key, { loading: false, error: errors[String(error)] ?? 'tools.memory.read_error' }); }
  }, [update]);
  useEffect(() => {
    if (!active || !tool || !installed || drafts[tool]) return;
    const timer = setTimeout(() => { void reload(tool); }, 0);
    return () => clearTimeout(timer);
  }, [active, tool, installed, drafts, reload]);
  const draft = drafts[tool], document = draft?.document;
  const dirty = installed && !!document?.path && draft.text !== editable(document.content);
  const busy = installed && (!!draft?.loading || !!draft?.saving);
  const status = !installed ? '' : draft?.loading ? t('diff.loading') : dirty ? t('tools.memory.unsaved') : draft?.saved ? t('tools.memory.saved') : '';
  const infoRefs = useRef(new Map<string, HTMLDivElement>());
  const [detailWidths, setDetailWidths] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      const widths = Object.fromEntries([...infoRefs.current].map(([key, element]) => [key, element.scrollWidth]));
      setDetailWidths(previous => Object.keys(previous).length === Object.keys(widths).length && Object.keys(widths).every(key => previous[key] === widths[key]) ? previous : widths);
    };
    measure();
    const observer = new ResizeObserver(measure);
    infoRefs.current.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [active, tools, drafts, tool, t]);
  const save = async () => {
    if (!document?.path || !draft || busy || !dirty) return;
    update(tool, { saving: true, error: undefined, saved: false });
    try {
      const saved = await commands.saveToolMemory(tool, document.path, document.content, draft.text);
      update(tool, { document: saved, text: editable(saved.content), saving: false, saved: true });
    } catch (error) { update(tool, { saving: false, error: errors[String(error)] ?? 'tools.memory.write_error' }); }
  };
  return <div className="tool-memory" aria-busy={busy}>
    {active && tooltip && createPortal(<span className="tool-memory-tool-tip" role="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.label}</span>, window.document.body)}
    <div className="tool-memory-toolbar">
      {active && tools.length > 0 && <div className="tool-memory-tools" role="toolbar" aria-label={t('usage.tool')} onScroll={() => setTooltip(null)} onTransitionStart={event => { if (event.propertyName === 'width') setTooltip(null); }}>
          {tools.map((item, index) => <div className={`tool-memory-item${tool === item.value ? ' is-selected' : ''}`} key={item.value}>
          <button type="button" aria-label={item.label} aria-pressed={tool === item.value} tabIndex={tool === item.value ? 0 : -1} disabled={!!draft?.saving} onClick={() => selectTool(item.value)} onMouseEnter={event => showToolName(event.currentTarget, item.label)} onMouseLeave={() => setTooltip(null)} onFocus={event => showToolName(event.currentTarget, item.label)} onBlur={() => setTooltip(null)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tools.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tools.length) % tools.length;
            selectTool(tools[next].value); event.currentTarget.closest('.tool-memory-tools')?.querySelectorAll('button')[next]?.focus();
          }}><span className="tool-memory-tool-icon" aria-hidden="true">{item.icon}</span></button>
          <div className="tool-memory-tool-details" aria-hidden={tool !== item.value} style={{ width: tool === item.value ? detailWidths[item.value] ?? 0 : 0 }}>
            <div className="tool-memory-tool-info" ref={element => { if (element) infoRefs.current.set(item.value, element); else infoRefs.current.delete(item.value); }}>
              <span className="tool-memory-name">{item.label}</span>
              {item.installed !== false && drafts[item.value]?.document?.path && <code className="tool-memory-path">{drafts[item.value]?.document?.path}</code>}
              {tool === item.value && status && <span className="tool-memory-status" role="status">{status}</span>}
            </div>
          </div>
          </div>)}
      </div>}
      <div className="tool-memory-actions">
        <button type="button" className="tool-memory-button" disabled={busy || !tool || !installed} onClick={() => dirty ? setConfirmReload(tool) : void reload(tool)}>{t('tools.memory.reload')}</button>
        <button type="button" className="tool-memory-button tool-memory-save" disabled={busy || !dirty} onClick={() => { void save(); }}>{t('tool_config.save')}</button>
      </div>
    </div>
    {installed && draft?.error && document?.path && <p className="tool-memory-notice" role="alert">{t(draft.error)}</p>}
    {installed && confirmReload === tool && <div className="tool-memory-confirm" role="alertdialog" aria-label={t('tools.memory.discard')}>
      <span>{t('tools.memory.discard')}</span>
      <button type="button" className="tool-memory-button" onClick={() => setConfirmReload(null)}>{t('tool_config.cancel')}</button>
      <button type="button" className="tool-memory-button" onClick={() => { setConfirmReload(null); void reload(tool); }}>{t('tools.memory.discard_reload')}</button>
    </div>}
    {installed && document?.path ? <textarea className="tool-memory-editor" aria-label={t('tools.tab.memory')} value={draft.text} disabled={busy} spellCheck={false} onChange={event => update(tool, { text: event.target.value, saved: false })} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void save(); }
      }} /> : <span className="tool-memory-editor tool-memory-empty" role={draft?.error ? 'alert' : 'status'}>
        <span>{!tool ? t('tools.memory.no_tools') : !installed ? t('control.not_installed') : draft?.error ? t(draft.error) : document ? t('tools.memory.unsupported') : ''}</span>
      </span>}
  </div>;
}
