import { describe, expect, it } from 'vitest';
import { PushBudget } from './push-budget';

describe('PushBudget', () => {
  it('allows a device key so many pushes a minute, then refuses until the oldest is a minute old', () => {
    let now = 0;
    const budget = new PushBudget(() => now, 3);
    expect([budget.take('k'), budget.take('k'), budget.take('k'), budget.take('k')]).toEqual([true, true, true, false]);
    expect(budget.take('other')).toBe(true);
    now = 59_999;
    expect(budget.take('k')).toBe(false);
    now = 60_000;
    expect([budget.take('k'), budget.take('k'), budget.take('k'), budget.take('k')]).toEqual([true, true, true, false]);
  });
});
