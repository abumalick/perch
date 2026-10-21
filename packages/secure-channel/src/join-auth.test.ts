import { describe, expect, it } from 'vitest';
import { b64url, generateAgentKeys } from './keys';
import { generateJoinKey, isJoinKey, signJoinAuth, verifyJoinAuth } from './join-auth';

const NOW = 1_800_000_000_000;
const joinKey = generateJoinKey();
const claim = { account: 'acct', role: 'join' as const };

describe('join key', () => {
  it('is 32 random bytes in base64url', () => {
    expect(b64url.decode(joinKey)).toHaveLength(32);
    expect(generateJoinKey() === joinKey).toBe(false);
    expect(isJoinKey(joinKey)).toBe(true);
    expect(isJoinKey('short')).toBe(false);
    expect(isJoinKey(`${joinKey.slice(0, 42)}+`)).toBe(false);
  });
});

describe('join-key header', () => {
  it('verifies a header made with the same key', () => {
    const header = signJoinAuth(joinKey, claim, NOW);
    expect(header).toMatch(/^Perch-Join \d+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyJoinAuth(header, joinKey, claim, NOW)).toBe(true);
  });

  it('refuses a header made with another key', () => {
    expect(verifyJoinAuth(signJoinAuth(generateJoinKey(), claim, NOW), joinKey, claim, NOW)).toBe(false);
  });

  it('binds the account and the role', () => {
    const header = signJoinAuth(joinKey, claim, NOW);
    expect(verifyJoinAuth(header, joinKey, { account: 'other', role: 'join' }, NOW)).toBe(false);
    expect(verifyJoinAuth(header, joinKey, { account: 'acct', role: 'remove' }, NOW)).toBe(false);
  });

  it.each([61_000, -61_000])('refuses a header %ims away from now', (skew) => {
    expect(verifyJoinAuth(signJoinAuth(joinKey, claim, NOW + skew), joinKey, claim, NOW)).toBe(false);
  });

  it('refuses malformed headers and a malformed key', () => {
    for (const header of [undefined, null, '', 'Perch-Join x.y', 'Perch-Agent 1.abc']) {
      expect(verifyJoinAuth(header, joinKey, claim, NOW)).toBe(false);
    }
    expect(verifyJoinAuth(signJoinAuth(joinKey, claim, NOW), 'not a key', claim, NOW)).toBe(false);
  });

  it('is not an agent signature: the same claim signed with an Ed25519 key does not pass', () => {
    const agent = generateAgentKeys();
    expect(verifyJoinAuth(`Perch-Join ${Math.floor(NOW / 1000)}.${agent.ed25519.publicKey}`, joinKey, claim, NOW)).toBe(false);
  });
});
