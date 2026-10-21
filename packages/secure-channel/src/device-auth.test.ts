import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64url } from './keys';
import {
  deviceAuthMessage,
  enrolKey,
  enrolProof,
  signDeviceAuth,
  verifyDeviceAuth,
  verifyEnrolProof,
} from './device-auth';

function device() {
  const priv = ed25519.utils.randomSecretKey();
  return {
    key: b64url.encode(ed25519.getPublicKey(priv)),
    sign: async (message: Uint8Array) => ed25519.sign(message, priv),
  };
}

const claim = { account: 'acct', nonce: 'n-1' };

describe('device authentication to the relay', () => {
  it('verifies a signature over the relay nonce by the device key', async () => {
    const d = device();
    const sig = await signDeviceAuth(d.sign, { ...claim, device: d.key });
    expect(await verifyDeviceAuth(sig, { ...claim, device: d.key })).toBe(true);
  });

  it('refuses the signature for another nonce, account or device', async () => {
    const d = device();
    const sig = await signDeviceAuth(d.sign, { ...claim, device: d.key });
    expect(await verifyDeviceAuth(sig, { ...claim, nonce: 'n-2', device: d.key })).toBe(false);
    expect(await verifyDeviceAuth(sig, { ...claim, account: 'other', device: d.key })).toBe(false);
    expect(await verifyDeviceAuth(sig, { ...claim, device: device().key })).toBe(false);
  });

  it('refuses malformed input without throwing', async () => {
    const d = device();
    expect(await verifyDeviceAuth('not a signature', { ...claim, device: d.key })).toBe(false);
    expect(await verifyDeviceAuth(await signDeviceAuth(d.sign, { ...claim, device: d.key }), { ...claim, device: 'bad key' })).toBe(false);
  });

  it('verifies with noble alone when the runtime has no WebCrypto Ed25519', async () => {
    const d = device();
    const sig = await signDeviceAuth(d.sign, { ...claim, device: d.key });
    const noEd25519 = { importKey: () => Promise.reject(new Error('unsupported')) } as unknown as SubtleCrypto;
    expect(await verifyDeviceAuth(sig, { ...claim, device: d.key }, noEd25519)).toBe(true);
  });

  it('binds the message to its purpose, so an agent signature cannot stand in for it', () => {
    expect(new TextDecoder().decode(deviceAuthMessage({ ...claim, device: 'K' }))).toBe(
      'perch-relay-device-v1\nacct\nn-1\nK',
    );
  });
});

describe('enrolment proof', () => {
  it('is checked by whoever holds the token, for this nonce and device only', () => {
    const key = enrolKey('token-1', 'acct');
    const proof = enrolProof(key, { ...claim, device: 'K' });
    expect(verifyEnrolProof(key, proof, { ...claim, device: 'K' })).toBe(true);
    expect(verifyEnrolProof(key, proof, { ...claim, device: 'L' })).toBe(false);
    expect(verifyEnrolProof(key, proof, { ...claim, nonce: 'n-2', device: 'K' })).toBe(false);
    expect(verifyEnrolProof(enrolKey('token-2', 'acct'), proof, { ...claim, device: 'K' })).toBe(false);
    expect(verifyEnrolProof(enrolKey('token-1', 'other'), proof, { ...claim, device: 'K' })).toBe(false);
    expect(verifyEnrolProof(key, 'garbage', { ...claim, device: 'K' })).toBe(false);
  });

  it('never reveals the token: the key is a one-way derivation of it', () => {
    const key = enrolKey('token-1', 'acct');
    expect(key).toHaveLength(32);
    expect(new TextDecoder().decode(key)).not.toContain('token-1');
  });
});
