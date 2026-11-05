import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { b64url, generateAgentKeys, isEd25519PublicKey } from './keys';

describe('agent keys', () => {
  it('generates 32-byte X25519 and Ed25519 key pairs whose public halves match', () => {
    const keys = generateAgentKeys();
    for (const pair of [keys.x25519, keys.ed25519]) {
      expect(b64url.decode(pair.publicKey)).toHaveLength(32);
      expect(b64url.decode(pair.privateKey)).toHaveLength(32);
    }
    expect(b64url.encode(x25519.getPublicKey(b64url.decode(keys.x25519.privateKey)))).toBe(keys.x25519.publicKey);
  });

  it('round-trips base64url without padding and rejects other alphabets', () => {
    const bytes = Uint8Array.of(251, 255, 0, 1);
    const text = b64url.encode(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect(b64url.decode(text)).toEqual(bytes);
    expect(() => b64url.decode('a+b/')).toThrow();
  });
});

describe('isEd25519PublicKey', () => {
  it('takes a 32-byte point outside the small-order subgroup, and nothing else', () => {
    expect(isEd25519PublicKey(generateAgentKeys().ed25519.publicKey)).toBe(true);
    expect(isEd25519PublicKey('AQ' + 'A'.repeat(41))).toBe(false);
    expect(isEd25519PublicKey('short')).toBe(false);
  });
});
