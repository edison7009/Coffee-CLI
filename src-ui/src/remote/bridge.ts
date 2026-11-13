// Remote mode (`?remote`): the desktop UI running on a phone or another browser.
//
// The UI talks to its backend only through `window.__TAURI_INTERNALS__`. Here
// that object is provided by an encrypted connection to the paired desktop:
// commands go to `ui.invoke` (the desktop decides what is allowed and runs it)
// and desktop events arrive as `tauri.event`. Sessions this page starts are its
// own; the desktop's tabs stay the desktop's.
//
// This module must be imported before anything that reads `isTauri`.
import { CoffeeClient, RpcError, fromHex, toHex, generateKeyPair, type Desktop, type PairingLink, type RpcEvent } from './protocol';

export const REMOTE = typeof window !== 'undefined' && !window.__TAURI_INTERNALS__ && new URLSearchParams(window.location.search).has('remote');

const STORAGE_KEY = 'coffee.remote.pairing.v0';
export interface RemotePairing { desktop: Desktop; computerName: string; deviceName: string; privateKey: string; publicKey: string }

export function loadRemotePairing(): RemotePairing | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { return null; }
}
function saveRemotePairing(pairing: RemotePairing | null) {
  try { if (pairing) localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing)); else localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
}

type Callback = (payload: unknown) => void;
const callbacks = new Map<number, Callback>();
const listeners = new Map<string, Set<number>>();
let nextCallback = 1;
let client: CoffeeClient | null = null;
let waiters: (() => void)[] = [];
const statusListeners = new Set<(status: RemoteStatus) => void>();
const eventListeners = new Set<(event: RpcEvent) => void>();

export type RemoteStatus = 'unpaired' | 'connecting' | 'connected' | 'offline' | 'revoked';
let status: RemoteStatus = 'unpaired';
function setStatus(next: RemoteStatus) { status = next; for (const listener of statusListeners) listener(next); }
export function remoteStatus() { return status; }
export function onRemoteStatus(listener: (status: RemoteStatus) => void) { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; }
/** Protocol events other than desktop events (session list changes and the like). */
export function onRemoteEvent(listener: (event: RpcEvent) => void) { eventListeners.add(listener); return () => { eventListeners.delete(listener); }; }
export function remoteRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return connected().then(c => c.request<T>(method, params));
}

function connected(): Promise<CoffeeClient> {
  return client ? Promise.resolve(client) : new Promise(resolve => waiters.push(() => resolve(client!)));
}

function dispatch(event: string, payload: unknown) {
  for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
}

async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (cmd) {
    case 'plugin:event|listen': {
      const set = listeners.get(String(args.event)) ?? new Set<number>();
      set.add(Number(args.handler)); listeners.set(String(args.event), set);
      return args.handler;
    }
    case 'plugin:event|unlisten': listeners.get(String(args.event))?.delete(Number(args.eventId)); return null;
    case 'plugin:event|emit': case 'plugin:event|emit_to': dispatch(String(args.event), args.payload); return null;
    // Links open on the phone itself.
    case 'open_url': window.open(String(args.url), '_blank', 'noopener'); return null;
  }
  if (cmd.startsWith('plugin:')) throw new Error(`${cmd} is not available on a phone`);
  const c = await connected();
  return c.request('ui.invoke', { cmd, args });
}

/** Installs the replacement before the UI modules load. */
export function installRemoteBridge() {
  if (!REMOTE) return;
  const internals = {
    invoke: (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args).catch(error => { throw error instanceof RpcError ? error.message : error; }),
    transformCallback: (callback: Callback, once = false) => {
      const id = nextCallback++;
      callbacks.set(id, once ? (payload => { callbacks.delete(id); callback(payload); }) : callback);
      return id;
    },
    unregisterCallback: (id: number) => { callbacks.delete(id); },
    convertFileSrc: (path: string) => path,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    plugins: { path: { sep: '/', delimiter: ':' } },
  };
  Object.assign(window, {
    __TAURI_INTERNALS__: internals,
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); } },
  });
}

const BACKOFF = [1000, 2000, 5000, 10_000];
let attempt = 0, retry: ReturnType<typeof setTimeout> | undefined;

function attach(next: CoffeeClient, pairing: RemotePairing) {
  client = next; attempt = 0;
  const ready = waiters; waiters = [];
  next.onEvent(event => {
    if (event.event === 'tauri.event') dispatch(String(event.params.event), event.params.payload);
    else for (const listener of eventListeners) listener(event);
  });
  next.onClose(() => {
    if (client !== next) return;
    client = null; setStatus('offline');
    retry = setTimeout(() => void connectRemote(pairing), BACKOFF[0]);
  });
  // Remember the address that answered.
  if (next.host && next.host !== pairing.desktop.hosts[0]) saveRemotePairing({ ...pairing, desktop: { ...pairing.desktop, hosts: [next.host, ...pairing.desktop.hosts.filter(h => h !== next.host)] } });
  void next.request('ui.subscribe').then(() => { setStatus('connected'); for (const resolve of ready) resolve(); });
}

export async function connectRemote(pairing = loadRemotePairing()): Promise<void> {
  clearTimeout(retry);
  if (!pairing) { setStatus('unpaired'); return; }
  setStatus('connecting');
  try {
    const next = await CoffeeClient.connect({ desktop: pairing.desktop, keys: { privateKey: fromHex(pairing.privateKey), publicKey: fromHex(pairing.publicKey) }, deviceName: pairing.deviceName, platform: 'web', appVersion: 'remote', timeoutMs: 15_000 });
    attach(next, pairing);
  } catch (error) {
    if (error instanceof RpcError && error.code === 'unauthorized') { setStatus('revoked'); return; }
    setStatus('offline');
    retry = setTimeout(() => void connectRemote(pairing), BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
  }
}

/** Pairs with a QR link; the desktop asks its user to allow this device first. */
export async function pairRemote(link: PairingLink, deviceName: string): Promise<void> {
  clearTimeout(retry);
  const keys = generateKeyPair();
  const desktop = { hosts: link.hosts, port: link.port, publicKey: link.publicKey };
  setStatus('connecting');
  try {
    const next = await CoffeeClient.connect({ desktop, keys, pairingCode: link.code, deviceName, platform: 'web', appVersion: 'remote' });
    const pairing: RemotePairing = { desktop, computerName: next.hello.computerName, deviceName, privateKey: toHex(keys.privateKey), publicKey: toHex(keys.publicKey) };
    saveRemotePairing(pairing);
    attach(next, pairing);
  } catch (error) { setStatus('unpaired'); throw error; }
}

export function forgetRemote() {
  clearTimeout(retry);
  const open = client; client = null; open?.close();
  saveRemotePairing(null); setStatus('unpaired');
}

export function remoteComputerName() { return loadRemotePairing()?.computerName ?? ''; }

/**
 * A pairing link carried in the page address after `#pair=` (the settings page
 * builds it), so opening the link is enough. The fragment never reaches the
 * server; it is removed from the address bar once read.
 */
export function takePairingLinkFromAddress(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.hash.match(/^#pair=(.+)$/);
  if (!match) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

// Runs on import, before modules that read `isTauri` are evaluated.
installRemoteBridge();
