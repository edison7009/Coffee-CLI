// Owns the connection to the paired desktop: loads the pairing, connects, and reconnects with backoff.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { CoffeeClient, RpcError, generateKeyPair, type PairingLink } from './protocol';
import { forgetPairing, loadPairing, savePairing, type Pairing } from './storage';

export type Status = 'loading' | 'unpaired' | 'connecting' | 'connected' | 'offline' | 'revoked';
interface Connection {
  status: Status;
  client: CoffeeClient | null;
  pairing: Pairing | null;
  pair(link: PairingLink, deviceName: string): Promise<void>;
  forget(): Promise<void>;
}
const ConnectionContext = createContext<Connection | null>(null);
export function useConnection() {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error('useConnection outside ConnectionProvider');
  return value;
}

const APP_VERSION = '0.0.1';
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000];

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [client, setClient] = useState<CoffeeClient | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const pairingRef = useRef(pairing), statusRef = useRef(status);
  useEffect(() => { pairingRef.current = pairing; statusRef.current = status; }, [pairing, status]);
  const attempt = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), current = useRef<CoffeeClient | null>(null), live = useRef(true);

  const connect = useCallback(async (record: Pairing) => {
    clearTimeout(timer.current);
    setStatus('connecting');
    try {
      const next = await CoffeeClient.connect({ desktop: record.desktop, keys: record, deviceName: record.deviceName, platform: Platform.OS, appVersion: APP_VERSION, timeoutMs: 15_000 });
      if (!live.current) return next.close();
      attempt.current = 0;
      current.current = next;
      setClient(next); setStatus('connected');
      next.onClose(() => {
        if (current.current !== next) return;
        current.current = null; setClient(null); setStatus('offline');
        timer.current = setTimeout(() => void connect(record), BACKOFF[0]);
      });
    } catch (error) {
      if (!live.current) return;
      // The desktop hangs up on a phone it no longer knows: it was removed there.
      if (error instanceof RpcError && error.code === 'unauthorized') { setStatus('revoked'); return; }
      setStatus('offline');
      const delay = BACKOFF[Math.min(attempt.current++, BACKOFF.length - 1)];
      timer.current = setTimeout(() => void connect(record), delay);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void loadPairing().then(record => {
      if (!live.current) return;
      setPairing(record);
      if (record) void connect(record); else setStatus('unpaired');
    });
    // Coming back to the app retries at once instead of waiting out the backoff.
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && !current.current && pairingRef.current && statusRef.current === 'offline') { attempt.current = 0; void connect(pairingRef.current); }
    });
    return () => { live.current = false; clearTimeout(timer.current); subscription.remove(); current.current?.close(); };
  }, [connect]);

  /** Pairs with the code from the QR link; the desktop asks its user to allow this phone first. */
  const pair = useCallback(async (link: PairingLink, deviceName: string) => {
    clearTimeout(timer.current);
    current.current?.close();
    const keys = generateKeyPair();
    const desktop = { host: link.host, port: link.port, publicKey: link.publicKey };
    const next = await CoffeeClient.connect({ desktop, keys, pairingCode: link.code, deviceName, platform: Platform.OS, appVersion: APP_VERSION });
    const record: Pairing = { desktop, computerName: next.hello.computerName, deviceName, ...keys };
    await savePairing(record);
    setPairing(record);
    // Keep the paired connection; its close starts the normal reconnect loop.
    current.current = next; attempt.current = 0;
    setClient(next); setStatus('connected');
    next.onClose(() => {
      if (current.current !== next) return;
      current.current = null; setClient(null); setStatus('offline');
      timer.current = setTimeout(() => void connect(record), BACKOFF[0]);
    });
  }, [connect]);

  const forget = useCallback(async () => {
    clearTimeout(timer.current);
    const open = current.current; current.current = null; open?.close();
    await forgetPairing();
    setClient(null); setPairing(null); setStatus('unpaired');
  }, []);

  return <ConnectionContext.Provider value={{ status, client, pairing, pair, forget }}>{children}</ConnectionContext.Provider>;
}
