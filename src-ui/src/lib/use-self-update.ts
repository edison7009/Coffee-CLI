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
export function useSelfUpdate(version: string | null, onVersion: (version: string) => void) {
  const [progress, setProgress] = useState<SelfUpdateProgress | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
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
  const activate = useCallback(async () => {
    if (pending.current || !version) return;
    pending.current = true;
    const installing = ready;
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
        if (!closing && mounted.current) setReadyVersion(null);
        return;
      }
      const downloaded = await commands.downloadUpdate(version);
      if (!mounted.current) return;
      if (downloaded) {
        if (downloaded !== version) onVersion(downloaded);
        setReadyVersion(downloaded);
      }
    } catch {
      commands.openUrl('https://coffeecli.com');
    } finally {
      unlisten?.();
      if (!closing) {
        pending.current = false;
        if (mounted.current) setProgress(null);
      }
    }
  }, [onVersion, ready, version]);

  return { progress, ready, activate };
}
