// Coffee CLI mobile protocol v0 (mobile/PROTOCOL.md): the Noise IKpsk2 initiator,
// framed transport encryption and the JSON-RPC client.
//
// Shared by the phone app (mobile/) and the desktop UI's remote mode. It imports only
// the noble crypto packages so Node can run it directly
// for the interop test against the desktop (src/mobile_rpc/tests.rs).
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

export const PROTOCOL = 0;
export const MODE_RESUME = 0;
export const MODE_PAIR = 1;
const PATTERN = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256';
const TAG = 16;
const CHUNK = 65535 - TAG;
// Created on use, so importing this module needs nothing from its environment.
const encoder = { encode: (text: string) => new TextEncoder().encode(text) };
const decoder = { decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes) };

// ─── Bytes ────────────────────────────────────────────────

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
export const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const fromHex = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('invalid hex');
  return Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16));
};

export function generateKeyPair() {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
export const pairingPsk = (code: string) => sha256(encoder.encode(code));

// ─── Noise symmetric state ───────────────────────────────

function nonce(n: number) {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(n), true);
  return out;
}

class CipherState {
  private n = 0;
  private key: Uint8Array;
  constructor(key: Uint8Array) { this.key = key; }
  encrypt(ad: Uint8Array, plaintext: Uint8Array) { return chacha20poly1305(this.key, nonce(this.n++), ad).encrypt(plaintext); }
  decrypt(ad: Uint8Array, ciphertext: Uint8Array) { return chacha20poly1305(this.key, nonce(this.n++), ad).decrypt(ciphertext); }
}

function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3) {
  const temp = hmac(sha256, chainingKey, ikm);
  const one = hmac(sha256, temp, Uint8Array.of(1));
  const two = hmac(sha256, temp, concat(one, Uint8Array.of(2)));
  return outputs === 2 ? [one, two] : [one, two, hmac(sha256, temp, concat(two, Uint8Array.of(3)))];
}

class SymmetricState {
  ck: Uint8Array; h: Uint8Array; private cipher: CipherState | null = null;
  constructor() {
    const name = encoder.encode(PATTERN);
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
    this.ck = this.h;
  }
  mixHash(data: Uint8Array) { this.h = sha256(concat(this.h, data)); }
  mixKey(ikm: Uint8Array) { const [ck, k] = hkdf(this.ck, ikm, 2); this.ck = ck; this.cipher = new CipherState(k); }
  mixKeyAndHash(ikm: Uint8Array) { const [ck, h, k] = hkdf(this.ck, ikm, 3); this.ck = ck; this.mixHash(h); this.cipher = new CipherState(k); }
  encryptAndHash(plaintext: Uint8Array) {
    const out = this.cipher ? this.cipher.encrypt(this.h, plaintext) : plaintext;
    this.mixHash(out); return out;
  }
  decryptAndHash(ciphertext: Uint8Array) {
    const out = this.cipher ? this.cipher.decrypt(this.h, ciphertext) : ciphertext;
    this.mixHash(ciphertext); return out;
  }
  split() { const [a, b] = hkdf(this.ck, new Uint8Array(0), 2); return [new CipherState(a), new CipherState(b)]; }
}

// ─── Transport channel ───────────────────────────────────

/** Encrypted framing: each plaintext becomes chunks of `[u16 BE length][noise message]`. */
export class Channel {
  private send: CipherState; private receive: CipherState;
  constructor(send: CipherState, receive: CipherState) { this.send = send; this.receive = receive; }
  encrypt(plaintext: Uint8Array) {
    const parts: Uint8Array[] = [];
    const chunks = plaintext.length ? Array.from({ length: Math.ceil(plaintext.length / CHUNK) }, (_, i) => plaintext.subarray(i * CHUNK, (i + 1) * CHUNK)) : [plaintext];
    for (const chunk of chunks) {
      const sealed = this.send.encrypt(new Uint8Array(0), chunk);
      parts.push(Uint8Array.of(sealed.length >> 8, sealed.length & 0xff), sealed);
    }
    return concat(...parts);
  }
  decrypt(frame: Uint8Array) {
    const parts: Uint8Array[] = [];
    if (!frame.length) throw new Error('empty frame');
    for (let offset = 0; offset < frame.length;) {
      if (offset + 2 > frame.length) throw new Error('truncated frame');
      const length = (frame[offset] << 8) | frame[offset + 1];
      if (offset + 2 + length > frame.length) throw new Error('truncated frame');
      parts.push(this.receive.decrypt(new Uint8Array(0), frame.subarray(offset + 2, offset + 2 + length)));
      offset += 2 + length;
    }
    return concat(...parts);
  }
}

/** Initiator of `Noise_IKpsk2_25519_ChaChaPoly_SHA256`; the desktop is the responder. */
export class Initiator {
  private state = new SymmetricState();
  private ephemeral = generateKeyPair();
  private local: { privateKey: Uint8Array; publicKey: Uint8Array }; private remoteStatic: Uint8Array; private psk: Uint8Array;
  constructor(local: { privateKey: Uint8Array; publicKey: Uint8Array }, remoteStatic: Uint8Array, psk: Uint8Array) {
    this.local = local; this.remoteStatic = remoteStatic; this.psk = psk;
    if (remoteStatic.length !== 32 || psk.length !== 32) throw new Error('invalid key');
    this.state.mixHash(new Uint8Array(0)); // prologue
    this.state.mixHash(remoteStatic); // <- s
  }
  /** `[mode] ++ (e, es, s, ss)` */
  firstMessage(mode: number) {
    const s = this.state, e = this.ephemeral;
    s.mixHash(e.publicKey); s.mixKey(e.publicKey); // psk handshakes also mix e into the key
    s.mixKey(x25519.getSharedSecret(e.privateKey, this.remoteStatic));
    const encryptedStatic = s.encryptAndHash(this.local.publicKey);
    s.mixKey(x25519.getSharedSecret(this.local.privateKey, this.remoteStatic));
    const payload = s.encryptAndHash(new Uint8Array(0));
    return concat(Uint8Array.of(mode), e.publicKey, encryptedStatic, payload);
  }
  /** `(e, ee, se, psk)`; throws when the desktop key or psk does not match. */
  finish(message: Uint8Array) {
    if (message.length < 32 + TAG) throw new Error('handshake rejected');
    const s = this.state, re = message.subarray(0, 32);
    // A bad ephemeral key (e.g. a low-order point) and a failed tag are the same refusal.
    try {
      s.mixHash(re); s.mixKey(re);
      s.mixKey(x25519.getSharedSecret(this.ephemeral.privateKey, re));
      s.mixKey(x25519.getSharedSecret(this.local.privateKey, re));
      s.mixKeyAndHash(this.psk);
      s.decryptAndHash(message.subarray(32));
    } catch { throw new Error('handshake rejected'); }
    const [send, receive] = s.split();
    return new Channel(send, receive);
  }
}

// ─── Pairing link ────────────────────────────────────────

/** `hosts` is best first: LAN addresses, then the computer's `.local` name. */
export interface Desktop { hosts: string[]; port: number; publicKey: string }
export interface PairingLink extends Desktop { code: string }

/** `coffeecli://pair?v=0&hosts=a,b&port=…&pk=…&code=…` from the desktop QR code. */
export function parsePairingLink(text: string): PairingLink {
  const match = text.trim().match(/^coffeecli:\/\/pair\?(.*)$/);
  if (!match) throw new Error('not a Coffee CLI pairing code');
  const params = new Map(match[1].split('&').map(pair => { const i = pair.indexOf('='); return [decodeURIComponent(pair.slice(0, i)), decodeURIComponent(pair.slice(i + 1))] as const; }));
  if (params.get('v') !== String(PROTOCOL)) throw new Error('unsupported pairing version');
  const port = Number(params.get('port')), publicKey = params.get('pk') ?? '', code = params.get('code') ?? '';
  const hosts = (params.get('hosts') ?? params.get('host') ?? '').split(',').map(h => h.trim()).filter(h => /^[0-9a-z.:-]{1,253}$/i.test(h)).slice(0, 8);
  if (!hosts.length || !Number.isInteger(port) || port <= 0 || port > 65535 || !/^[0-9a-f]{64}$/i.test(publicKey) || !/^[0-9a-f]{32}$/i.test(code)) throw new Error('incomplete pairing code');
  return { hosts, port, publicKey: publicKey.toLowerCase(), code };
}

// ─── RPC client ──────────────────────────────────────────

export interface Hello { protocol: number; desktopVersion: string; computerName: string; capabilities: string[] }
export interface RpcEvent { event: string; params: Record<string, unknown>; seq: number }
export class RpcError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type WebSocketLike = { binaryType: string; send(data: Uint8Array): void; close(): void; onmessage: ((e: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; onopen: (() => void) | null };

export interface ConnectOptions {
  desktop: Desktop;
  keys: { privateKey: Uint8Array; publicKey: Uint8Array };
  /** Present only when pairing from a QR code. */
  pairingCode?: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  timeoutMs?: number;
  /** How long to wait for any address to answer. */
  dialTimeoutMs?: number;
  createSocket?: (url: string) => WebSocketLike;
}

export class CoffeeClient {
  hello!: Hello;
  /** The address that answered first; callers move it to the front for next time. */
  host = '';
  private nextId = 2;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(event: RpcEvent) => void>();
  private closeListeners = new Set<() => void>();
  private closed = false;
  private socket: WebSocketLike; private channel: Channel;
  private constructor(socket: WebSocketLike, channel: Channel) { this.socket = socket; this.channel = channel; }

  /**
   * Dials every advertised address at once and keeps the first socket that opens;
   * only that one runs the handshake, so a pairing code is spent once.
   * Rejects when nothing answers, or when the desktop drops or refuses the phone.
   */
  static async connect(options: ConnectOptions): Promise<CoffeeClient> {
    const { socket, host } = await CoffeeClient.dial(options);
    const client = await CoffeeClient.handshake(options, socket);
    client.host = host;
    return client;
  }

  private static dial(options: ConnectOptions): Promise<{ socket: WebSocketLike; host: string }> {
    const { desktop } = options, create = options.createSocket ?? (url => new WebSocket(url) as unknown as WebSocketLike);
    return new Promise((resolve, reject) => {
      let settled = false, failed = 0;
      const sockets = desktop.hosts.map(host => {
        const socket = create(`ws://${host.includes(':') ? `[${host}]` : host}:${desktop.port}`);
        socket.binaryType = 'arraybuffer';
        const lose = () => {
          socket.onopen = socket.onerror = socket.onclose = null;
          if (!settled && ++failed === sockets.length) { settled = true; clearTimeout(timer); reject(new RpcError('unreachable', 'connection failed')); }
        };
        socket.onopen = () => {
          if (settled) { try { socket.close(); } catch { /* closing */ } return; }
          settled = true; clearTimeout(timer);
          socket.onopen = socket.onerror = socket.onclose = null;
          for (const other of sockets) if (other !== socket) { other.onopen = other.onerror = other.onclose = null; try { other.close(); } catch { /* closing */ } }
          resolve({ socket, host });
        };
        socket.onerror = lose; socket.onclose = lose;
        return socket;
      });
      // An address that never answers (wrong network, firewall) must not hold up the rest.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        for (const socket of sockets) { socket.onopen = socket.onerror = socket.onclose = null; try { socket.close(); } catch { /* closing */ } }
        reject(new RpcError('unreachable', 'timed out'));
      }, options.dialTimeoutMs ?? 8000);
      if (!sockets.length) { settled = true; clearTimeout(timer); reject(new RpcError('unreachable', 'no address')); }
    });
  }

  private static handshake(options: ConnectOptions, socket: WebSocketLike): Promise<CoffeeClient> {
    const { desktop, keys, pairingCode, timeoutMs = 130_000 } = options;
    const initiator = new Initiator(keys, fromHex(desktop.publicKey), pairingCode ? pairingPsk(pairingCode) : new Uint8Array(32));
    return new Promise((resolve, reject) => {
      let step: 'handshake' | 'hello' = 'handshake', channel: Channel | null = null;
      const fail = (message: string, code = 'unreachable') => { clearTimeout(timer); socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* already closed */ } reject(new RpcError(code, message)); };
      // Pairing waits for the person at the desktop to allow the phone.
      const timer = setTimeout(() => fail('timed out'), timeoutMs);
      // The desktop answers an unknown phone or a wrong code by hanging up during the handshake.
      const dropped = () => step === 'handshake' ? fail('desktop refused this phone', 'unauthorized') : fail('connection closed');
      socket.onerror = dropped;
      socket.onclose = dropped;
      socket.onmessage = ({ data }) => {
        try {
          const bytes = binary(data);
          if (step === 'handshake') {
            channel = initiator.finish(bytes);
            step = 'hello';
            socket.send(channel.encrypt(encoder.encode(JSON.stringify({ id: 1, method: 'hello', params: { protocol: PROTOCOL, deviceName: options.deviceName, platform: options.platform, appVersion: options.appVersion } }))));
            return;
          }
          const reply = JSON.parse(decoder.decode(channel!.decrypt(bytes)));
          clearTimeout(timer);
          if (reply.error) return fail(reply.error.message ?? 'refused', reply.error.code ?? 'unauthorized');
          const client = new CoffeeClient(socket, channel!);
          client.hello = reply.result;
          client.attach();
          resolve(client);
        } catch (error) { fail(error instanceof Error ? error.message : String(error), 'unauthorized'); }
      };
      socket.send(initiator.firstMessage(pairingCode ? MODE_PAIR : MODE_RESUME));
    });
  }

  private attach() {
    this.socket.onmessage = ({ data }) => {
      let frame: { id?: number; result?: unknown; error?: { code: string; message: string }; event?: string; params?: Record<string, unknown>; seq?: number };
      // Anything that fails to decrypt ends the connection, mirroring the desktop.
      try { frame = JSON.parse(decoder.decode(this.channel.decrypt(binary(data)))); } catch { return this.close(); }
      if (frame.event) { for (const listener of this.listeners) listener(frame as RpcEvent); return; }
      const waiter = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
      if (!waiter) return;
      this.pending.delete(frame.id!);
      if (frame.error) waiter.reject(new RpcError(frame.error.code, frame.error.message)); else waiter.resolve(frame.result);
    };
    this.socket.onclose = () => this.close();
    this.socket.onerror = () => this.close();
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('unreachable', 'connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.send(this.channel.encrypt(encoder.encode(JSON.stringify({ id, method, params }))));
    });
  }

  onEvent(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: () => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
    try { this.socket.close(); } catch { /* already closed */ }
    for (const { reject } of this.pending.values()) reject(new RpcError('unreachable', 'connection closed'));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}

function binary(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error('expected a binary frame');
}
