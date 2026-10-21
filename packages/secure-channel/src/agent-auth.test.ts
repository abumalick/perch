import { describe, expect, it, vi } from 'vitest';
import { generateAgentKeys } from './keys';
import { b64url } from './keys';
import { isEd25519PublicKey, signAgentAuth, verifyAgentAuth, verifyEd25519 } from './agent-auth';

const NOW = 1_800_000_000_000;
const keys = generateAgentKeys();
const other = generateAgentKeys();
const claim = { account: 'acct', role: 'dial' as const, dialId: 'd1' };

describe('agent auth header', () => {
  it('verifies a header signed by the account key', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW);
    expect(header).toMatch(/^Perch-Agent \d+\.[A-Za-z0-9_-]+$/);
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW)).toBe(true);
  });

  it('verifies the control role without a dial id', async () => {
    const control = { account: 'acct', role: 'agent' as const };
    const header = signAgentAuth(keys.ed25519.privateKey, control, NOW);
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, control, NOW)).toBe(true);
  });

  it('refuses a header signed by another key', async () => {
    const header = signAgentAuth(other.ed25519.privateKey, claim, NOW);
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW)).toBe(false);
  });

  it.each([61_000, -61_000])('refuses a header %ims away from now', async (skew) => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW + skew);
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW)).toBe(false);
  });

  it('accepts a header within the window', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW - 59_000);
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW)).toBe(true);
  });

  it('binds the account, the role and the dial id', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW);
    const pub = keys.ed25519.publicKey;
    expect(await verifyAgentAuth(header, pub, { ...claim, account: 'other' }, NOW)).toBe(false);
    expect(await verifyAgentAuth(header, pub, { ...claim, role: 'agent' }, NOW)).toBe(false);
    expect(await verifyAgentAuth(header, pub, { ...claim, dialId: 'd2' }, NOW)).toBe(false);
    expect(await verifyAgentAuth(header, pub, { account: 'acct', role: 'dial' }, NOW)).toBe(false);
  });

  it.each([undefined, '', 'Bearer x', 'Perch-Agent', 'Perch-Agent 123', 'Perch-Agent abc.def', 'Perch-Agent 1.+/='])(
    'refuses the malformed header %j',
    async (header) => {
      expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW)).toBe(false);
    },
  );

  it('refuses a malformed public key instead of throwing', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW);
    expect(await verifyAgentAuth(header, 'not-a-key', claim, NOW)).toBe(false);
  });

  it('verifies with WebCrypto where the runtime has Ed25519', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW);
    const subtle = globalThis.crypto.subtle;
    const verify = vi.spyOn(subtle, 'verify');
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW, subtle)).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
  });

  it('falls back to the pure-JS verifier where WebCrypto has no Ed25519', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW);
    const forged = signAgentAuth(other.ed25519.privateKey, claim, NOW);
    const noEd25519 = {
      importKey: () => Promise.reject(new DOMException('Unrecognized name', 'NotSupportedError')),
    } as unknown as SubtleCrypto;
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW, noEd25519)).toBe(true);
    expect(await verifyAgentAuth(forged, keys.ed25519.publicKey, claim, NOW, noEd25519)).toBe(false);
  });
});

// The identity point is a small-order public key. Under ZIP-215 rules (noble's default) the
// signature R = identity, S = 0 verifies for it over any message; WebCrypto refuses it.
const IDENTITY = new Uint8Array(32);
IDENTITY[0] = 1;
const FORGED = new Uint8Array(64);
FORGED.set(IDENTITY, 0);
const noEd25519 = { importKey: () => Promise.reject(new Error('no Ed25519')) } as unknown as SubtleCrypto;

describe('verifyEd25519 and small-order keys', () => {
  it('refuses the identity-point forgery on the noble path as WebCrypto does', async () => {
    const message = new TextEncoder().encode('anything');
    expect(await verifyEd25519(FORGED, message, IDENTITY, crypto.subtle)).toBe(false);
    expect(await verifyEd25519(FORGED, message, IDENTITY, noEd25519)).toBe(false);
    expect(await verifyEd25519(FORGED, message, IDENTITY, undefined)).toBe(false);
  });

  it('still verifies a real signature on the noble path', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, claim, NOW);
    expect(await verifyAgentAuth(header, keys.ed25519.publicKey, claim, NOW, noEd25519)).toBe(true);
  });

  it('tells a usable public key from a small-order or malformed one', () => {
    expect(isEd25519PublicKey(keys.ed25519.publicKey)).toBe(true);
    expect(isEd25519PublicKey(b64url.encode(IDENTITY))).toBe(false);
    expect(isEd25519PublicKey('A'.repeat(43))).toBe(false);
    expect(isEd25519PublicKey('_'.repeat(43))).toBe(false);
    expect(isEd25519PublicKey('short')).toBe(false);
  });
});
