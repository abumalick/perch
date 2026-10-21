import { describe, expect, it } from 'vitest';
import { SpentNonces } from './spent-nonces.ts';

// A Map that counts how many entries its sweeps walk.
class CountingMap extends Map<string, number> {
  walked = 0;
  override *[Symbol.iterator](): MapIterator<[string, number]> {
    for (const entry of super.entries()) {
      this.walked += 1;
      yield entry;
    }
  }
}

describe('SpentNonces', () => {
  it('refuses a nonce the second time while it is live', () => {
    const spent = new SpentNonces();
    expect(spent.use('a', 2_000, 1_000)).toBe(true);
    expect(spent.use('a', 2_000, 1_500)).toBe(false);
  });

  it('forgets a nonce once it has expired', () => {
    const map = new CountingMap();
    const spent = new SpentNonces(map);
    spent.use('a', 2_000, 1_000);
    spent.use('b', 9_000, 1_000);
    spent.use('c', 9_000, 3_000);
    expect(map.has('a')).toBe(false);
    expect(map.has('b')).toBe(true);
  });

  // A flood of upgrades must not each walk every nonce in use: that is quadratic in the rate.
  it('sweeps at most once a second, however many nonces are used meanwhile', () => {
    const map = new CountingMap();
    const spent = new SpentNonces(map);
    for (let i = 0; i < 1_000; i += 1) spent.use(`n${i}`, 60_000, 1_000);
    expect(map.walked).toBeLessThanOrEqual(1);
    spent.use('late', 60_000, 2_000);
    expect(map.walked).toBeLessThanOrEqual(1_001);
  });

  it('forgets everything on clear', () => {
    const spent = new SpentNonces();
    spent.use('a', 2_000, 1_000);
    spent.clear();
    expect(spent.use('a', 2_000, 1_000)).toBe(true);
  });
});
