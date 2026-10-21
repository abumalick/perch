import { describe, expect, it } from 'vitest';
import { lineBudget } from './line-budget.ts';

describe('lineBudget', () => {
  it('writes up to its budget a minute, then says how many it dropped once the minute is over', () => {
    let now = 0;
    const lines: string[] = [];
    const trace = lineBudget((line) => lines.push(line), { max: 2, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 5; i += 1) trace(`line ${i}`);
    expect(lines).toEqual(['line 0', 'line 1']);
    now += 60_000;
    trace('next');
    expect(lines).toEqual(['line 0', 'line 1', 'relay trace: 3 lines dropped in the last minute', 'next']);
  });
});
