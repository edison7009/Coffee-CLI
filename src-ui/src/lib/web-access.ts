// Shared pieces of Web access: the pairing address a browser opens, and a pairing request
// handed from the sidebar menu to Settings → Web 端.
import type { MobileRpcPairing } from '../tauri';

/** The address a browser opens: this computer's Web 端 page, with the pairing link after `#` so it never reaches a server log. */
export function webPairingUrl(pairing: Pick<MobileRpcPairing, 'host' | 'port' | 'uri'>, host = pairing.host): string {
  const shown = host.includes(':') ? `[${host}]` : host;
  return `http://${shown}:${pairing.port}/?remote#pair=${encodeURIComponent(pairing.uri)}`;
}

let pairingRequested = false;
let listener: (() => void) | null = null;
/** Settings → Web 端 shows a pairing QR code as soon as it opens, or right away when it already is. */
export function requestPairingOnOpen(): void { if (listener) listener(); else pairingRequested = true; }
/** Settings subscribes while mounted; a request made before it opened is delivered on subscribe. */
export function onPairingRequest(handler: () => void): () => void {
  listener = handler;
  if (pairingRequested) { pairingRequested = false; handler(); }
  return () => { if (listener === handler) listener = null; };
}
