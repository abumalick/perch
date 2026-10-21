import { describe, expect, it } from 'vitest';
import { b64url } from './keys';
import { generateChallengeKey, mintChallenge, verifyChallenge } from './relay-challenge';

const NOW = 1_800_000_000_000;
const TTL = 30_000;
const key = generateChallengeKey();

describe('relay challenge', () => {
  it('fits the nonce shape a phone sends back', () => {
    const nonce = mintChallenge(key, 'acct', NOW, TTL);
    expect(nonce).toMatch(/^[\w-]{1,128}$/);
    expect(mintChallenge(key, 'acct', NOW, TTL) === nonce).toBe(false);
  });

  it('verifies within its lifetime and gives its expiry', () => {
    const nonce = mintChallenge(key, 'acct', NOW, TTL);
    expect(verifyChallenge(key, 'acct', nonce, NOW + TTL - 1)).toBe(NOW + TTL);
  });

  it('refuses one that has expired', () => {
    const nonce = mintChallenge(key, 'acct', NOW, TTL);
    expect(verifyChallenge(key, 'acct', nonce, NOW + TTL)).toBe(null);
  });

  it('refuses one made for another account or under another key', () => {
    const nonce = mintChallenge(key, 'acct', NOW, TTL);
    expect(verifyChallenge(key, 'other', nonce, NOW)).toBe(null);
    expect(verifyChallenge(generateChallengeKey(), 'acct', nonce, NOW)).toBe(null);
  });

  it('refuses a tampered or malformed one', () => {
    const nonce = mintChallenge(key, 'acct', NOW, TTL);
    const bytes = b64url.decode(nonce);
    bytes[0] = bytes[0]! ^ 1;
    expect(verifyChallenge(key, 'acct', b64url.encode(bytes), NOW)).toBe(null);
    expect(verifyChallenge(key, 'acct', 'never-issued', NOW)).toBe(null);
    expect(verifyChallenge(key, 'acct', '', NOW)).toBe(null);
  });

  it('refuses one whose expiry was pushed out, however far', () => {
    const nonce = mintChallenge(key, 'acct', NOW, 10 * 60_000);
    expect(verifyChallenge(key, 'acct', nonce, NOW, TTL)).toBe(null);
  });
});
