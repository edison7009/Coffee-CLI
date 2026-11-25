import { useEffect, useSyncExternalStore } from 'react';
import { commands, onSelfUpdateProgress, type SelfUpdateProgress } from '../tauri';
import { IS_WINDOWS } from './platform';
import { fetchLatestManifest, isNewerVersion } from './update-manifest';

// In-app self-update in two clicks the user controls. The first downloads the
// installer into Downloads (a ring fills meanwhile). Windows then waits with an
// "Install" button; only the second click closes Coffee CLI and runs the
// installer. macOS opens the DMG and Linux the folder right after downloading,
// and the button goes back to its idle state. A failed download opens the
// website instead. An installer downloaded in an earlier run is offered for
// installation straight away.
//
// The step that installs asks first (as EchoBird does): `activate` opens the
// new version's notes (`confirming`), and only `confirm` (开始更新) goes on —
// on Windows that is the second click (install), elsewhere the first (the
// download opens the installer).
//
// One update for the whole window: Code's sidebar and Work's rail both show it, and switching between them
// mid-download keeps the same progress rather than starting a second download.
interface UpdateState { installed: string; version: string | null; progress: SelfUpdateProgress | null; readyVersion: string | null; confirming: boolean }
let state: UpdateState = { installed: '', version: null, progress: null, readyVersion: null, confirming: false };
let pending = false, checked = false, closing = false;
const listeners = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => state;

/** Once per window: is there a newer Coffee CLI, and (Windows) was it already downloaded in an earlier run? */
function check() {
  if (checked) return;
  checked = true;
  void (async () => {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      // Domestic mirrors and the website are asked together; the newest version any of them reports wins.
      const [local, remote] = await Promise.all([getVersion(), fetchLatestManifest()]);
      set({ installed: local });
      if (!remote || !isNewerVersion(remote.version, local)) return;
      const version = remote.version.replace(/^v/, '');
      set({ version });
      if (IS_WINDOWS && await commands.isUpdateDownloaded(version).catch(() => false) && !pending) set({ readyVersion: version });
    } catch { /* offline or fetch failed — silent */ }
  })();
}

async function run() {
  const version = state.version;
  if (pending || !version) return;
  pending = true;
  const installing = state.readyVersion === version;
  // A download shows its progress on the button: the notes step aside. Installing keeps them up until the app closes.
  set({ progress: installing ? { status: 'launching', percent: 100 } : { status: 'speed_test', percent: 0 }, ...(installing ? {} : { confirming: false }) });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await onSelfUpdateProgress(event => { if (pending) set({ progress: event }); });
    if (installing) {
      // Resolves true just before the app exits: keep "Restarting" until then.
      closing = await commands.installDownloadedUpdate(version);
      if (!closing) set({ readyVersion: null, confirming: false });
      return;
    }
    const downloaded = await commands.downloadUpdate(version);
    set({ confirming: false });
    if (downloaded) set({ version: downloaded, readyVersion: downloaded });
  } catch {
    set({ confirming: false });
    commands.openUrl('https://coffeecli.com');
  } finally {
    unlisten?.();
    if (!closing) { pending = false; set({ progress: null }); }
  }
}

export function useSelfUpdate() {
  useEffect(check, []);
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const ready = current.version !== null && current.readyVersion === current.version;
  return {
    installed: current.installed, version: current.version, progress: current.progress, ready, confirming: current.confirming,
    starting: current.confirming && current.progress !== null,
    // The click: download straight away where a second click installs (Windows, nothing downloaded yet);
    // otherwise the step that installs, which shows the notes first.
    activate: async () => {
      if (pending || !state.version || state.confirming) return;
      if (IS_WINDOWS && state.readyVersion !== state.version) { await run(); return; }
      set({ confirming: true });
    },
    confirm: async () => { if (state.confirming) await run(); },
    cancel: () => { if (!pending) set({ confirming: false }); },
  };
}
