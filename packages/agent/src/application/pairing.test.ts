import { describe, expect, it } from 'vitest';
import { PAIRING_RETAIN_MS, PAIRING_TTL_MS, addPairing, findPairing, redeemPairing, type Pairing } from './pairing';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);
const A = 'a'.repeat(43);
const B = 'b'.repeat(43);
const is = (secret: string) => (candidate: string) => candidate === secret;

describe('pairing secrets', () => {
  it('lives for ten minutes', () => {
    const list = addPairing([], A, NOW);
    expect(findPairing(list, is(A), later(PAIRING_TTL_MS - 1))).toEqual({ state: 'live', secret: A });
    expect(findPairing(list, is(A), later(PAIRING_TTL_MS + 49_000))).toEqual({ state: 'expired', secret: A, agoMs: 49_000 });
  });

  it('keeps a dead secret for a day, so a refusal can say what became of it, then forgets it', () => {
    const list = addPairing(addPairing([], A, NOW), B, later(PAIRING_TTL_MS + PAIRING_RETAIN_MS - 1));
    expect(list.map((p) => p.secret)).toEqual([A, B]);
    const next = addPairing(list, 'c'.repeat(43), later(PAIRING_TTL_MS + PAIRING_RETAIN_MS));
    expect(next.map((p) => p.secret)).toEqual([B, 'c'.repeat(43)]);
    expect(findPairing(next, is(A), later(PAIRING_TTL_MS + PAIRING_RETAIN_MS))).toBeNull();
  });

  it('is used once, by the first device to present it', () => {
    const list = addPairing(addPairing([], A, NOW), B, NOW);
    const first = redeemPairing(list, A, NOW, 'phone');
    expect(first.outcome).toBe('redeemed');
    expect(findPairing(first.list, is(A), NOW)).toEqual({ state: 'used', secret: A });
    expect(findPairing(first.list, is(B), NOW)).toEqual({ state: 'live', secret: B });
    expect(redeemPairing(first.list, A, later(1000), 'tablet').outcome).toBe('used');
  });

  it('is bound to that device: the same device presenting it again is not a second use', () => {
    const { list } = redeemPairing(addPairing([], A, NOW), A, NOW, 'phone');
    expect(list[0]!.usedBy).toBe('phone');
    expect(redeemPairing(list, A, later(1000), 'phone')).toEqual({ list, outcome: 'mine' });
  });

  // An agent from before used secrets were kept reads the record as expired, so it cannot be
  // spent a second time there either.
  it('records a used secret as already expired', () => {
    const { list } = redeemPairing(addPairing([], A, NOW), A, NOW, 'phone');
    const [used] = list as [Pairing];
    expect(Date.parse(used.expiresAt)).toBeLessThanOrEqual(NOW.getTime());
    expect(used.usedAt).toBe(NOW.toISOString());
  });

  it('cannot be redeemed once expired, or when it was never minted', () => {
    const list = addPairing([], A, NOW);
    expect(redeemPairing(list, A, later(PAIRING_TTL_MS), 'phone').outcome).toBe('expired');
    expect(redeemPairing(list, B, NOW, 'phone').outcome).toBe('unknown');
    expect(redeemPairing(list, '', NOW, 'phone').outcome).toBe('unknown');
  });
});
