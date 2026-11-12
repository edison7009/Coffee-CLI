// The pairing record: the desktop to dial and this phone's own key pair.
// Native builds keep it in the keychain/keystore; the web preview uses localStorage.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { fromHex, toHex, type Desktop } from './protocol';

const KEY = 'coffee.pairing.v0';

export interface Pairing { desktop: Desktop; computerName: string; deviceName: string; privateKey: Uint8Array; publicKey: Uint8Array }
interface Stored { desktop: Desktop; computerName: string; deviceName: string; privateKey: string; publicKey: string }

async function read(): Promise<string | null> {
  if (Platform.OS === 'web') { try { return localStorage.getItem(KEY); } catch { return null; } }
  return SecureStore.getItemAsync(KEY);
}
async function write(value: string | null) {
  if (Platform.OS === 'web') { try { if (value === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, value); } catch { /* private mode */ } return; }
  if (value === null) await SecureStore.deleteItemAsync(KEY); else await SecureStore.setItemAsync(KEY, value);
}

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const stored = JSON.parse((await read()) ?? 'null') as Stored | null;
    if (!stored?.desktop || !stored.privateKey) return null;
    return { ...stored, privateKey: fromHex(stored.privateKey), publicKey: fromHex(stored.publicKey) };
  } catch { return null; }
}
export async function savePairing(pairing: Pairing) {
  const stored: Stored = { ...pairing, privateKey: toHex(pairing.privateKey), publicKey: toHex(pairing.publicKey) };
  await write(JSON.stringify(stored));
}
export const forgetPairing = () => write(null);
