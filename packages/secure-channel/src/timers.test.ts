import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTimer } from './timers';

afterEach(() => vi.useRealTimers());

describe('startTimer', () => {
  it('fires once after the delay, and not at all once cancelled', () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    startTimer(() => fired.push('kept'), 100);
    const cancel = startTimer(() => fired.push('cancelled'), 100);
    cancel();
    vi.advanceTimersByTime(99);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['kept']);
  });
});
