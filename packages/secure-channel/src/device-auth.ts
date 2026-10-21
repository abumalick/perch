// How a phone proves to the relay that it is an enrolled device: it fetches a single-use nonce
// from the relay and signs it with its Ed25519 device key. The relay admits a key the account's
// agent has published, and nothing it merely observes. A key the agent has not enrolled yet may
// instead carry an enrolment proof, a MAC under a key derived from the bearer token: the relay
// cannot check it (it never holds anything derived from the token) and hands it to the agent,
// which decides before dialing back.
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEd25519 } from './agent-auth';
import { constantTimeEqual } from './constant-time';
import { b64url } from './keys';

interface DeviceClaim {
  account: string;
  nonce: string;
  // The device's Ed25519 public key, base64url.
  device: string;
}

// Signs with a key the caller may not be able to read (a non-extractable WebCrypto key).
export type DeviceSigner = (message: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

export function deviceAuthMessage(claim: DeviceClaim): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(['perch-relay-device-v1', claim.account, claim.nonce, claim.device].join('\n')));
}

export async function signDeviceAuth(sign: DeviceSigner, claim: DeviceClaim): Promise<string> {
  return b64url.encode(await sign(deviceAuthMessage(claim)));
}

export async function verifyDeviceAuth(
  signature: string,
  claim: DeviceClaim,
  subtle: SubtleCrypto | undefined = typeof crypto === 'undefined' ? undefined : crypto.subtle,
): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  let key: Uint8Array<ArrayBuffer>;
  try {
    sig = b64url.decode(signature);
    key = b64url.decode(claim.device);
  } catch {
    return false;
  }
  if (sig.length !== 64 || key.length !== 32) return false;
  return verifyEd25519(sig, deviceAuthMessage(claim), key, subtle);
}

export function enrolKey(token: string, account: string): Uint8Array {
  const encode = (s: string) => new TextEncoder().encode(s);
  return hkdf(sha256, encode(token), encode(account), encode('perch-relay-enrol-v1'), 32);
}

export function enrolProof(key: Uint8Array, claim: DeviceClaim): string {
  return b64url.encode(hmac(sha256, key, deviceAuthMessage(claim)));
}

export function verifyEnrolProof(key: Uint8Array, proof: string, claim: DeviceClaim): boolean {
  return constantTimeEqual(enrolProof(key, claim), proof);
}
