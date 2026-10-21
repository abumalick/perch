import type { DeviceSigner, StaticKey } from '@perch/secure-channel';

// Where a private key lives: a non-extractable WebCrypto key (the page can use it, never read
// it), or raw bytes in IndexedDB where the browser has no WebCrypto X25519/Ed25519.
export type KeyStorage = 'webcrypto' | 'noble';

// This installed PWA's device identity, created on first use and kept for good. The X25519 key
// is its Noise static key (the agent enrols and checks it); the Ed25519 key signs the relay's
// challenges.
export interface DeviceIdentity {
  x25519: StaticKey;
  x25519Public: string;
  ed25519Public: string;
  sign: DeviceSigner;
  storage: { x25519: KeyStorage; ed25519: KeyStorage };
  // Why a key is a stored key rather than a WebCrypto one, when WebCrypto was tried and failed.
  fallback: { x25519?: string; ed25519?: string };
}

// The device key failed, as opposed to the handshake it was used in: lets the socket report the
// real cause instead of blaming the agent's key.
export class DeviceKeyError extends Error {}

// The stored identity reads back malformed. It has never authenticated anything, so replacing it
// loses nothing; the user is offered that (never for an identity that reads back intact).
export class UnreadableDeviceKeyError extends Error {}
