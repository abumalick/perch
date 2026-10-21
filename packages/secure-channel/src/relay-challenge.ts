// The nonce a phone signs with its device key before the relay admits it. Stateless: it carries
// its own expiry and a MAC under a key only the relay holds, bound to the account, so handing one
// out writes nothing. The relay keeps the nonces already used in memory, for their short lifetime.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes } from '@noble/hashes/utils.js';
import { constantTimeEqual } from './constant-time';
import { b64url } from './keys';

const EXPIRY_LEN = 8;
const RANDOM_LEN = 16;
const MAC_LEN = 16;
const LABEL = new TextEncoder().encode('perch-relay-challenge-v1\0');

export function generateChallengeKey(): string {
  return b64url.encode(randomBytes(32));
}

function mac(key: string, account: string, body: Uint8Array): Uint8Array {
  const message = concatBytes(LABEL, new TextEncoder().encode(`${account}\0`), body);
  return hmac(sha256, b64url.decode(key), message).subarray(0, MAC_LEN);
}

export function mintChallenge(key: string, account: string, nowMs: number, ttlMs: number): string {
  const body = new Uint8Array(EXPIRY_LEN + RANDOM_LEN);
  new DataView(body.buffer).setBigUint64(0, BigInt(nowMs + ttlMs));
  body.set(randomBytes(RANDOM_LEN), EXPIRY_LEN);
  return b64url.encode(concatBytes(body, mac(key, account, body)));
}

// The challenge's expiry, or null when it is not one this key made for this account, has expired,
// or claims to live longer than `maxTtlMs`.
export function verifyChallenge(key: string, account: string, nonce: string, nowMs: number, maxTtlMs = Infinity): number | null {
  let bytes: Uint8Array;
  try {
    bytes = b64url.decode(nonce);
  } catch {
    return null;
  }
  if (bytes.length !== EXPIRY_LEN + RANDOM_LEN + MAC_LEN) return null;
  const body = bytes.subarray(0, EXPIRY_LEN + RANDOM_LEN);
  if (!constantTimeEqual(b64url.encode(mac(key, account, body)), b64url.encode(bytes.subarray(EXPIRY_LEN + RANDOM_LEN)))) return null;
  const expires = Number(new DataView(body.buffer, body.byteOffset, EXPIRY_LEN).getBigUint64(0));
  return expires > nowMs && expires - nowMs <= maxTtlMs ? expires : null;
}
