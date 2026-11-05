import { ed25519, x25519 } from '@noble/curves/ed25519.js';

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

// The agent's identity. X25519 is its Noise static key (the phone pins the public half). The
// Ed25519 pair once signed its relay upgrades and is kept only as part of the key file's format.
// Both base64url.
export interface AgentKeys {
  x25519: KeyPair;
  ed25519: KeyPair;
}

export const b64url = {
  encode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  },
};

// A phone's device identity has the same shape: X25519 for its Noise static key, and an Ed25519
// key its hello names. The PWA keeps its own in WebCrypto; this raw form is for Node clients.
export type DeviceKeys = AgentKeys;

export function generateDeviceKeys(): DeviceKeys {
  return generateAgentKeys();
}

export function generateAgentKeys(): AgentKeys {
  const xPriv = x25519.utils.randomSecretKey();
  const edPriv = ed25519.utils.randomSecretKey();
  return {
    x25519: { publicKey: b64url.encode(x25519.getPublicKey(xPriv)), privateKey: b64url.encode(xPriv) },
    ed25519: { publicKey: b64url.encode(ed25519.getPublicKey(edPriv)), privateKey: b64url.encode(edPriv) },
  };
}

// Signs with a key the caller may not be able to read (a non-extractable WebCrypto key).
export type DeviceSigner = (message: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

// 32 bytes of base64url naming a point on the curve outside its small-order subgroup.
export function isEd25519PublicKey(key: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return false;
  try {
    return !ed25519.Point.fromBytes(b64url.decode(key)).isSmallOrder();
  } catch {
    return false;
  }
}
