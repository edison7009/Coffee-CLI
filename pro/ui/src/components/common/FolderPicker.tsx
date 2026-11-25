// Coffee CLI's folder and file picker: one window for the desktop app,
// browsers and phones. It browses the computer Coffee CLI runs on (through
// list_directory), offers recent projects first, and takes a typed or pasted
// path. Picking files (attachments) can also upload them from the device in
// hand when shown in a browser. The desktop app can still hand off to the
// system dialog for places such as network shares.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commands, type DirEntryInfo, type FolderPickerPlaces } from '../../tauri';
import { useT } from '../../i18n/useT';
import { IS_WEB } from '../../lib/viewport';
import { getProjectFolders } from '../../lib/project-folders';
import { uploadFile } from '../../remote/bridge';
import { crumbs, isHiddenFolder, normalizeTypedPath, parentOf, useFolderPickerRequest, type FolderPickerRequest } from '../../lib/folder-picker';
import './FolderPicker.css';

const FolderIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;
const FileIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>;
const DriveIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="12" width="20" height="8" rx="2" /><path d="M6 16h.01M10 16h.01" /><path d="M5 12 7.5 4h9L19 12" /></svg>;
const HomeIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></svg>;
const ClockIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const CheckIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7" /></svg>;
const ChevronIcon = <svg className="folder-picker-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>;

const lastSegment = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

export function FolderPickerHost() {
  const request = useFolderPickerRequest();
  return request ? <FolderPicker key={request.id} request={request} /> : null;
}

function FolderPicker({ request }: { request: FolderPickerRequest }) {
  const t = useT();
  const files = request.mode === 'files';
  const [places, setPlaces] = useState<FolderPickerPlaces | null>(null);
  const [path, setPath] = useState('');
  const [typed, setTyped] = useState('');
  const [entries, setEntries] = useState<DirEntryInfo[] | null>(null);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const recent = useMemo(() => getProjectFolders(), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadId = useRef(0);
  const sep = places?.separator ?? '/';

  const open = useCallback(async (target: string) => {
    const id = ++loadId.current;
    setError(''); setEntries(null);
    try {
      const list = await commands.listDirectory(target);
      if (id !== loadId.current) return;
      setPath(target); setTyped(target); setEntries(files ? list : list.filter(entry => entry.is_dir));
    } catch {
      if (id !== loadId.current) return;
      setTyped(target); setEntries([]); setError(t('picker.error'));
    }
  }, [files, t]);

  useEffect(() => {
    let live = true;
    void commands.folderPickerPlaces().then(result => {
      if (!live) return;
      setPlaces(result);
      const start = request.start || recent[0] || result.home || result.places[0]?.path;
      if (start) void open(start);
    }).catch(() => { if (live) setError(t('picker.error')); });
    return () => { live = false; };
  }, [open, recent, request.start, t]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !upload) request.resolve(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, upload]);

  const visible = (entries ?? []).filter(entry => showHidden || !isHiddenFolder(entry.name, sep));
  const parent = path ? parentOf(path, sep) : null;
  const trail = path ? crumbs(path, sep) : [];
  const toggle = (file: string) => setSelected(list => list.includes(file) ? list.filter(p => p !== file) : [...list, file]);

  const openSystemDialog = async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const chosen = await openDialog(files ? { directory: false, multiple: true, defaultPath: path || undefined } : { directory: true, defaultPath: path || undefined });
      const list = Array.isArray(chosen) ? chosen : typeof chosen === 'string' ? [chosen] : [];
      if (list.length) request.resolve(list);
    } catch { /* Stay in the picker. */ }
  };

  // Web: files on the device in hand are uploaded to the computer, then attached by their new path.
  const uploadFromDevice = async (list: FileList | null) => {
    const chosen = [...(list ?? [])];
    if (!chosen.length) return;
    setError(''); setUpload({ done: 0, total: chosen.length });
    const paths: string[] = [];
    try {
      for (const file of chosen) { paths.push(await uploadFile(file)); setUpload({ done: paths.length, total: chosen.length }); }
      request.resolve(paths);
    } catch (e) {
      setUpload(null);
      setError(t('picker.upload_failed', { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  return (
    <div className="folder-picker-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !upload) request.resolve(null); }}>
      <div className="folder-picker" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
        <header className="folder-picker-head">
          <h2 id="folder-picker-title">{request.title ?? t(files ? 'picker.files_title' : 'picker.title')}</h2>
          <button type="button" className="folder-picker-close" aria-label={t('picker.cancel')} disabled={!!upload} onClick={() => request.resolve(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>

        {files && IS_WEB && <div className="folder-picker-device">
          <span>{t('picker.device_hint')}</span>
          <button type="button" className="folder-picker-secondary" disabled={!!upload} onClick={() => fileInput.current?.click()}>{t('picker.upload')}</button>
          <input ref={fileInput} type="file" multiple hidden onChange={event => { void uploadFromDevice(event.target.files); event.target.value = ''; }} />
        </div>}

        <form className="folder-picker-path" onSubmit={event => { event.preventDefault(); const next = normalizeTypedPath(typed, sep); if (next) void open(next); }}>
          <button type="button" className="folder-picker-up" disabled={!parent} aria-label={t('picker.up')} onClick={() => { if (parent) void open(parent); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
          </button>
          <input value={typed} spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-label={t('picker.path')} placeholder={t('picker.path')} onChange={event => setTyped(event.target.value)} />
        </form>

        <div className="folder-picker-body">
          <nav className="folder-picker-side" aria-label={t('picker.places')}>
            {recent.length > 0 && <>
              <div className="folder-picker-label">{t('picker.recent')}</div>
              {recent.map(folder => (
                // A recent project is the answer when picking a folder, and a place to start when picking files.
                <button key={folder} type="button" className="folder-picker-place" onClick={() => files ? void open(folder) : request.resolve([folder])}>
                  {ClockIcon}<span>{lastSegment(folder)}</span>
                </button>
              ))}
            </>}
            <div className="folder-picker-label">{t('picker.places')}</div>
            {places?.places.map(place => (
              <button key={place.path} type="button" className={`folder-picker-place${path === place.path ? ' active' : ''}`} onClick={() => void open(place.path)}>
                {place.kind === 'drive' ? DriveIcon : place.kind === 'home' ? HomeIcon : FolderIcon}
                <span>{place.kind === 'home' ? t('picker.home') : place.kind === 'drive' ? place.name : t(`picker.${place.kind}`)}</span>
              </button>
            ))}
          </nav>

          <section className="folder-picker-main" aria-live="polite">
            <div className="folder-picker-crumbs">
              {trail.map((crumb, index) => <button key={crumb.path} type="button" aria-current={index === trail.length - 1 ? 'location' : undefined} onClick={() => void open(crumb.path)}>{crumb.name}</button>)}
            </div>
            <div className="folder-picker-list" role="list">
              {entries === null && !error && <div className="folder-picker-note">{t('picker.loading')}</div>}
              {error && <div className="folder-picker-note folder-picker-error" role="alert">{error}</div>}
              {entries !== null && !error && visible.length === 0 && <div className="folder-picker-note">{t(files ? 'picker.empty_files' : 'picker.empty')}</div>}
              {visible.map(entry => entry.is_dir ? (
                <button key={entry.path} type="button" role="listitem" className="folder-picker-row" onClick={() => void open(entry.path)}>
                  {FolderIcon}<span>{entry.name}</span>{ChevronIcon}
                </button>
              ) : (
                <button key={entry.path} type="button" role="listitem" aria-pressed={selected.includes(entry.path)} className="folder-picker-row folder-picker-file" onClick={() => toggle(entry.path)}>
                  {FileIcon}<span>{entry.name}</span><i className="folder-picker-check" aria-hidden="true">{selected.includes(entry.path) ? CheckIcon : null}</i>
                </button>
              ))}
            </div>
          </section>
        </div>

        <footer className="folder-picker-foot">
          <label className="folder-picker-hidden"><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />{t('picker.show_hidden')}</label>
          {!IS_WEB && <button type="button" className="folder-picker-secondary" onClick={() => void openSystemDialog()}>{t('picker.system')}</button>}
          <span className="folder-picker-spacer" />
          {upload && <span className="folder-picker-progress" role="status">{t('picker.uploading', { done: String(upload.done), total: String(upload.total) })}</span>}
          <button type="button" className="folder-picker-secondary" disabled={!!upload} onClick={() => request.resolve(null)}>{t('picker.cancel')}</button>
          {files
            ? <button type="button" className="folder-picker-primary" disabled={!selected.length || !!upload} onClick={() => request.resolve(selected)}>{selected.length ? t('picker.add_files', { count: String(selected.length) }) : t('picker.add_files_none')}</button>
            : <button type="button" className="folder-picker-primary" disabled={!path || !!error} onClick={() => request.resolve([path])}>{t('picker.choose')}</button>}
        </footer>
      </div>
    </div>
  );
}
