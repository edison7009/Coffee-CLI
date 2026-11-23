// Remote mode (`?remote`): the desktop UI running somewhere other than its own computer —
// a phone or another browser, or a Coffee CLI window controlling another computer.
//
// The UI talks to its backend only through Tauri's IPC object. Here that object is provided by an
// encrypted connection to the paired desktop: commands go to `ui.invoke` (the desktop decides what
// is allowed and runs it) and desktop events arrive as `tauri.event`. Sessions this page starts
// are its own; the desktop's tabs stay the desktop's.
//
// This module must be imported before anything that reads `isTauri`.
import { CoffeeClient, RpcError, fromHex, toHex, generateKeyPair, type Desktop, type Hello, type PairingLink, type RpcEvent } from './protocol';

const SEARCH = typeof window !== 'undefined' ? window.location?.search ?? '' : '';
const REMOTE_PAGE = /[?&]remote(?:[=&]|$)/.test(SEARCH);

/**
 * A Coffee CLI window controlling another computer (src/remote_window.rs): this app's own UI on
 * that computer's data, nothing loaded from it. Tauri's IPC object here is locked, so the bridge
 * cannot replace it; vite.config.ts routes every read of it through `__COFFEE_TAURI__` instead.
 */
export const CONTROL = REMOTE_PAGE && /[?&]control(?:[=&]|$)/.test(SEARCH) && !!window.__TAURI_INTERNALS__;
export const REMOTE = REMOTE_PAGE && (CONTROL || !window.__TAURI_INTERNALS__);

type LocalIpc = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>; transformCallback(callback: (payload: unknown) => void, once?: boolean): number; unregisterCallback?(id: number): void };
/** This computer's own IPC, for what stays local in a control window: clipboard, links, the relayed connection, saved keys. */
const LOCAL = CONTROL ? (window.__TAURI_INTERNALS__ as unknown as LocalIpc) : null;
function local<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return LOCAL ? (LOCAL.invoke(cmd, args) as Promise<T>) : Promise.reject(new Error('not a control window'));
}

/**
 * A page opened as http://<computer's LAN address> is not a secure context, so
 * browsers leave out crypto.randomUUID, which the UI uses for tab and session
 * ids. getRandomValues stays available; build RFC 4122 v4 ids from it.
 */
export function ensureRandomUUID(target: { getRandomValues<T extends ArrayBufferView>(array: T): T; randomUUID?: () => string } | undefined) {
  if (!target || typeof target.randomUUID === 'function' || typeof target.getRandomValues !== 'function') return;
  target.randomUUID = () => {
    const b = target.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
  };
}
if (REMOTE) ensureRandomUUID(globalThis.crypto as never);

const STORAGE_KEY = 'coffee.remote.pairing.v0';
export interface RemotePairing { desktop: Desktop; computerName: string; deviceName: string; privateKey: string; publicKey: string }

export function loadRemotePairing(): RemotePairing | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); } catch { return null; }
}
function saveRemotePairing(pairing: RemotePairing | null) {
  try { if (pairing) localStorage.setItem(STORAGE_KEY, JSON.stringify(pairing)); else localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  // A control window's storage is private and ends with it; the key is kept by this computer.
  if (CONTROL) void local('remote_pairing_save', { pairing }).catch(error => console.error('[remote pairing]', error));
}

let controlLink: string | null = null;
/**
 * Before a control window's UI starts: the pairing link it was opened with, or else the saved key
 * for its computer. A pasted link means pairing again (the window reloads for it), so it wins over
 * a saved key; that key is replaced once the new pairing succeeds.
 */
export async function prepareControl(): Promise<void> {
  if (!CONTROL) return;
  const info = await local<{ pairing: RemotePairing | null; pairLink: string | null }>('remote_control_info');
  controlLink = info.pairLink;
  try {
    if (controlLink) localStorage.removeItem(STORAGE_KEY);
    else if (info.pairing) localStorage.setItem(STORAGE_KEY, JSON.stringify(info.pairing));
  } catch { /* private mode */ }
}
export function controlPairLink() { return controlLink; }
/** Names the control window after its computer once connected. */
export function setControlName(name: string) {
  if (CONTROL && name) void local('remote_window_set_name', { name }).catch(() => {});
}
/** This computer's own app version, to compare with the controlled one's. */
export function localVersion(): Promise<string> { return local<string>('plugin:app|version'); }

type Callback = (payload: unknown) => void;
const callbacks = new Map<number, Callback>();
const listeners = new Map<string, Set<number>>();
let nextCallback = 1;
let client: CoffeeClient | null = null;
let waiters: (() => void)[] = [];
const statusListeners = new Set<(status: RemoteStatus) => void>();
const eventListeners = new Set<(event: RpcEvent) => void>();

/** `unsupported`: the computer's Coffee CLI predates running the desktop UI remotely (before v4.0.2). */
export type RemoteStatus = 'unpaired' | 'connecting' | 'connected' | 'offline' | 'revoked' | 'unsupported';
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
    // Links open on this device: the phone's browser, or this computer's for a control window.
    case 'open_url': if (CONTROL) return local('open_url', args); window.open(String(args.url), '_blank', 'noopener'); return null;
    // The file tree's folder is watched on the computer by a watcher of this browser's own.
    case 'start_fs_watcher': return (await connected()).request('ui.watch', { path: String(args.path ?? '') });
    case 'stop_fs_watcher': return (await connected()).request('ui.watch', { path: null });
    // A pasted image (composers, terminals) becomes a file on the computer: upload it instead of one large frame.
    case 'save_clipboard_image': {
      const ext = String(args.extension ?? 'png');
      return uploadBase64(`pasted-${Date.now()}.${ext}`, String(args.dataBase64 ?? ''));
    }
  }
  // A control window copies and pastes with this computer's clipboard.
  if (CONTROL && cmd.startsWith('plugin:clipboard-manager|')) return local(cmd, args);
  // Voice input listens with this computer's microphone and account: the words land in the draft, which goes out as usual.
  if (CONTROL && cmd.startsWith('voice_')) return local(cmd, localVoiceArgs(args));
  if (cmd.startsWith('plugin:')) throw new Error(`${cmd} is not available on a phone`);
  const c = await connected();
  return c.request('ui.invoke', { cmd, args });
}

/** A control window's voice arguments for this computer: the folder is the other computer's (dropped), and a
 *  channel made through the bridge is relayed through one of this computer's IPC, which is what calls it back. */
function localVoiceArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if ('cwd' in out) out.cwd = null;
  for (const [key, value] of Object.entries(out)) {
    const ref = (value as { toJSON?: () => unknown } | null)?.toJSON?.();
    const match = typeof ref === 'string' && /^__CHANNEL__:(\d+)$/.exec(ref);
    if (!match) continue;
    const bridged = Number(match[1]);
    const relay: number = LOCAL!.transformCallback(message => {
      callbacks.get(bridged)?.(message);
      if (message && typeof message === 'object' && 'end' in message) LOCAL!.unregisterCallback?.(relay);
    });
    out[key] = `__CHANNEL__:${relay}`;
  }
  return out;
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
  const events = { unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); } };
  // Every read of Tauri's objects looks here first (vite.config.ts TAURI_GLOBALS).
  Object.assign(globalThis, { __COFFEE_TAURI__: internals, __COFFEE_TAURI_EVENTS__: events });
  // In a browser there is nothing to collide with; a control window's own objects are locked and stay as they are.
  if (!CONTROL) Object.assign(window, { __TAURI_INTERNALS__: internals, __TAURI_EVENT_PLUGIN_INTERNALS__: events });
}

// ─── A control window's connection, made by this computer (src/remote_link.rs) ───
// The page cannot open sockets to the LAN itself everywhere (WebView security rules); this
// computer opens it and passes the encrypted frames through unchanged.

type LinkEvent = { id: string; kind: 'open' | 'message' | 'close'; data?: string };
const relays = new Map<string, RelaySocket>();
let linkEvents: Promise<unknown> | null = null;
function listenLinks() {
  linkEvents ??= local('plugin:event|listen', {
    event: 'remote-link', target: { kind: 'Any' },
    handler: LOCAL!.transformCallback(event => {
      const { id, kind, data } = (event as { payload: LinkEvent }).payload;
      const socket = relays.get(id);
      if (!socket) return;
      if (kind === 'open') socket.onopen?.();
      else if (kind === 'message' && data !== undefined) socket.onmessage?.({ data: base64ToBuffer(data) });
      else if (kind === 'close') socket.finish();
    }),
  });
  return linkEvents;
}
function base64ToBuffer(text: string): ArrayBuffer {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
class RelaySocket {
  binaryType = 'arraybuffer';
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private readonly id = crypto.randomUUID();
  private closed = false;
  constructor(url: string) {
    relays.set(this.id, this);
    // Closed before the listener was ready: never dial, or the link would stay open with nobody on it.
    void listenLinks().then(() => this.closed ? undefined : local('remote_link_open', { id: this.id, url })).catch(() => this.fail());
  }
  send(data: Uint8Array) {
    if (!this.closed) void local('remote_link_send', { id: this.id, data: bytesToBase64(data) }).catch(() => this.fail());
  }
  close() {
    if (this.closed) return;
    this.closed = true; relays.delete(this.id);
    void local('remote_link_close', { id: this.id }).catch(() => {});
  }
  private fail() { if (!this.closed) this.onerror?.(); this.finish(); }
  finish() {
    if (this.closed) return;
    this.closed = true; relays.delete(this.id);
    this.onclose?.();
  }
}
const createSocket = CONTROL ? (url: string) => new RelaySocket(url) : undefined;

const BACKOFF = [1000, 2000, 5000, 10_000];
let attempt = 0, retry: ReturnType<typeof setTimeout> | undefined;

let hello: Hello | null = null;
/** What the connected computer said about itself (version, capabilities). */
export function remoteHello() { return hello; }

function attach(next: CoffeeClient, pairing: RemotePairing) {
  hello = next.hello;
  // Before v4.0.2 a computer could not run the desktop UI remotely; say so instead of waiting forever.
  if (!next.hello.capabilities?.includes('ui')) { next.close(); setStatus('unsupported'); return; }
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
  // Requests waiting for a connection wait for the next one if this one drops before it is ready.
  void next.request('ui.subscribe').then(
    () => { setStatus('connected'); for (const resolve of ready) resolve(); },
    () => { waiters.push(...ready); },
  );
}

export async function connectRemote(pairing = loadRemotePairing()): Promise<void> {
  clearTimeout(retry);
  if (!pairing) { setStatus('unpaired'); return; }
  setStatus('connecting');
  try {
    const next = await CoffeeClient.connect({ desktop: pairing.desktop, keys: { privateKey: fromHex(pairing.privateKey), publicKey: fromHex(pairing.publicKey) }, deviceName: pairing.deviceName, platform: 'web', appVersion: 'remote', timeoutMs: 15_000, createSocket });
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
    const next = await CoffeeClient.connect({ desktop, keys, pairingCode: link.code, deviceName, platform: 'web', appVersion: 'remote', createSocket });
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

// ─── Uploads: files from this device become files on the computer ───────────

/** Raw bytes per chunk; matches the computer's limit with room for base64. */
const CHUNK = 384 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function sendChunks(name: string, size: number, chunks: AsyncIterable<string> | Iterable<string>, onProgress?: (sent: number, size: number) => void): Promise<string> {
  const { id } = await remoteRequest<{ id: number }>('upload.begin', { name, size });
  for await (const data of chunks) {
    const { written } = await remoteRequest<{ written: number }>('upload.chunk', { id, data });
    onProgress?.(written, size);
  }
  return (await remoteRequest<{ path: string }>('upload.finish', { id })).path;
}

/** Uploads base64 data (a pasted image) without decoding it: slices on 4-character boundaries are valid base64. */
function uploadBase64(name: string, base64: string): Promise<string> {
  const clean = base64.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const size = Math.floor(clean.length / 4) * 3 - padding;
  const step = (CHUNK / 3) * 4;
  const slices = Array.from({ length: Math.max(1, Math.ceil(clean.length / step)) }, (_, i) => clean.slice(i * step, (i + 1) * step));
  return sendChunks(name, size, size === 0 ? [] : slices);
}

/** Uploads a file picked, dropped or pasted on this device; resolves with its path on the computer. */
export function uploadFile(file: File, onProgress?: (sent: number, size: number) => void): Promise<string> {
  async function* chunks() {
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      yield bytesToBase64(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
    }
  }
  return sendChunks(file.name || 'file', file.size, chunks(), onProgress);
}

/** Files dropped onto the page from this device go to the same drop targets desktop drops reach. */
export function installWebFileDrop(route: (paths: string[], position: { x: number; y: number }) => boolean) {
  const hasFiles = (event: DragEvent) => !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  window.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    const position = { x: event.clientX, y: event.clientY };
    void Promise.all(files.map(file => uploadFile(file))).then(paths => route(paths, position), error => console.error('[web drop]', error));
  });
}

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
