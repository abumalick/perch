import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

// The agent's relay identity. X25519 is its Noise static key (the phone pins the public half);
// Ed25519 signs its relay upgrades (the relay holds the public half). Both base64url.
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

// A phone's device identity has the same shape: X25519 for its Noise static key, Ed25519 to sign
// relay challenges. The PWA keeps its own in WebCrypto; this raw form is for Node clients.
export type DeviceKeys = AgentKeys;

export function generateDeviceKeys(): DeviceKeys {
  return generateAgentKeys();
}

export function ed25519Signer(privateKey: string): (message: Uint8Array) => Promise<Uint8Array> {
  const priv = b64url.decode(privateKey);
  return async (message) => ed25519.sign(message, priv);
}

export function generateAgentKeys(): AgentKeys {
  const xPriv = x25519.utils.randomSecretKey();
  const edPriv = ed25519.utils.randomSecretKey();
  return {
    x25519: { publicKey: b64url.encode(x25519.getPublicKey(xPriv)), privateKey: b64url.encode(xPriv) },
    ed25519: { publicKey: b64url.encode(ed25519.getPublicKey(edPriv)), privateKey: b64url.encode(edPriv) },
  };
}

// Derived from the signing key, so the relay can route by it without a registry, and nobody can
// claim an account id without the key it was derived from. Public, not a secret.
export function accountId(ed25519PublicKey: string): string {
  return b64url.encode(sha256(b64url.decode(ed25519PublicKey)).subarray(0, 16));
}
