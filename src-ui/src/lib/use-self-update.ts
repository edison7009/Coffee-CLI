import { useCallback, useEffect, useRef, useState } from 'react';
import { commands, onSelfUpdateProgress, type SelfUpdateProgress } from '../tauri';
import { IS_WINDOWS } from './platform';

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
export function useSelfUpdate(version: string | null, onVersion: (version: string) => void) {
  const [progress, setProgress] = useState<SelfUpdateProgress | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const busy = progress !== null;
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!IS_WINDOWS || !version || busy || readyVersion === version) return;
    let active = true;
    commands.isUpdateDownloaded(version).then(
      ready => { if (ready && active && !pending.current) setReadyVersion(version); },
      () => { /* No receipt to read — offer the download. */ },
    );
    return () => { active = false; };
  }, [busy, readyVersion, version]);

  const ready = version !== null && readyVersion === version;
  const run = useCallback(async () => {
    if (pending.current || !version) return;
    pending.current = true;
    const installing = ready;
    // A download shows its progress on the button: the notes step aside. Installing keeps them up until the app closes.
    if (!installing) setConfirming(false);
    setProgress(installing ? { status: 'launching', percent: 100 } : { status: 'speed_test', percent: 0 });
    let unlisten: (() => void) | undefined;
    let closing = false;
    try {
      unlisten = await onSelfUpdateProgress(event => {
        if (mounted.current && pending.current) setProgress(event);
      });
      if (installing) {
        // Resolves true just before the app exits: keep "Restarting" until then.
        closing = await commands.installDownloadedUpdate(version);
        if (!closing && mounted.current) { setReadyVersion(null); setConfirming(false); }
        return;
      }
      const downloaded = await commands.downloadUpdate(version);
      if (!mounted.current) return;
      setConfirming(false);
      if (downloaded) {
        if (downloaded !== version) onVersion(downloaded);
        setReadyVersion(downloaded);
      }
    } catch {
      if (mounted.current) setConfirming(false);
      commands.openUrl('https://coffeecli.com');
    } finally {
      unlisten?.();
      if (!closing) {
        pending.current = false;
        if (mounted.current) setProgress(null);
      }
    }
  }, [onVersion, ready, version]);

  // The click: download straight away where a second click installs (Windows, nothing downloaded yet);
  // otherwise the step that installs, which shows the notes first.
  const activate = useCallback(async () => {
    if (pending.current || !version || confirming) return;
    if (IS_WINDOWS && !ready) { await run(); return; }
    setConfirming(true);
  }, [confirming, ready, run, version]);
  const confirm = useCallback(async () => { if (confirming) await run(); }, [confirming, run]);
  const cancel = useCallback(() => { if (!pending.current) setConfirming(false); }, []);

  return { progress, ready, activate, confirming, starting: confirming && progress !== null, confirm, cancel };
}
