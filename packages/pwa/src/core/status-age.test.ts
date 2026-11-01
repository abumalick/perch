import { describe, expect, it } from 'vitest';
import { statusAge } from './status-age';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('statusAge', () => {
  it('reads under a minute as <1m', () => {
    expect(statusAge(1_000, 1_000 + 59_000)).toBe('<1m');
  });

  it('uses the largest whole unit', () => {
    expect(statusAge(0, 5 * MIN + 30_000)).toBe('5m');
    expect(statusAge(0, 3 * HOUR + 59 * MIN)).toBe('3h');
    expect(statusAge(0, 2 * DAY + 5 * HOUR)).toBe('2d');
  });

  it('switches unit at the boundary', () => {
    expect(statusAge(0, HOUR - 1)).toBe('59m');
    expect(statusAge(0, HOUR)).toBe('1h');
    expect(statusAge(0, DAY)).toBe('1d');
  });

  it('treats a timestamp ahead of the phone clock (agent skew) as just now', () => {
    expect(statusAge(10 * MIN, 0)).toBe('<1m');
  });
});
