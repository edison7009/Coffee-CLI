// The pairing address a browser opens, shared by Settings and the sidebar's connect window.
import type { MobileRpcPairing } from '../tauri';

/** The address a browser opens: this computer's Web 端 page, with the pairing link after `#` so it never reaches a server log. */
export function webPairingUrl(pairing: Pick<MobileRpcPairing, 'host' | 'port' | 'uri'>, host = pairing.host): string {
  const shown = host.includes(':') ? `[${host}]` : host;
  return `http://${shown}:${pairing.port}/?remote#pair=${encodeURIComponent(pairing.uri)}`;
}
