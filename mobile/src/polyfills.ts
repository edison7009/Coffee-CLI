import { getRandomValues } from 'expo-crypto';

// Hermes has no Web Crypto; the noble libraries draw randomness from crypto.getRandomValues.
const scope = globalThis as { crypto?: { getRandomValues?: unknown } };
if (typeof scope.crypto?.getRandomValues !== 'function') {
  scope.crypto = { ...(scope.crypto ?? {}), getRandomValues };
}
