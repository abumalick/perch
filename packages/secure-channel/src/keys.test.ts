import { describe, expect, it } from 'vitest';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { accountId, b64url, ed25519Signer, generateAgentKeys, generateDeviceKeys } from './keys';

describe('agent keys', () => {
  it('generates 32-byte X25519 and Ed25519 key pairs whose public halves match', () => {
    const keys = generateAgentKeys();
    for (const pair of [keys.x25519, keys.ed25519]) {
      expect(b64url.decode(pair.publicKey)).toHaveLength(32);
      expect(b64url.decode(pair.privateKey)).toHaveLength(32);
    }
    expect(b64url.encode(x25519.getPublicKey(b64url.decode(keys.x25519.privateKey)))).toBe(keys.x25519.publicKey);
  });

  it('derives a stable 22-character account id from the signing key', () => {
    const keys = generateAgentKeys();
    const id = accountId(keys.ed25519.publicKey);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(accountId(keys.ed25519.publicKey)).toBe(id);
    expect(accountId(generateAgentKeys().ed25519.publicKey)).not.toBe(id);
  });

  it('round-trips base64url without padding and rejects other alphabets', () => {
    const bytes = Uint8Array.of(251, 255, 0, 1);
    const text = b64url.encode(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(b64url.decode(text)).toEqual(bytes);
    expect(() => b64url.decode('a+b/')).toThrow();
  });
});

describe('device keys', () => {
  it('signs with the raw Ed25519 half, verifiable against the public half', async () => {
    const { ed25519: pair } = generateDeviceKeys();
    const message = new TextEncoder().encode('m');
    const sig = await ed25519Signer(pair.privateKey)(message);
    expect(ed25519.verify(sig, message, b64url.decode(pair.publicKey))).toBe(true);
  });
});
