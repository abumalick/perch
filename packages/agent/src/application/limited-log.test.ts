import { describe, expect, it } from 'vitest';
import { LimitedLog } from './limited-log';

describe('LimitedLog', () => {
  function setup() {
    const lines: string[] = [];
    const clock = { now: 0 };
    const log = new LimitedLog((m) => lines.push(m), () => clock.now);
    return { lines, clock, log };
  }

  it('writes one line a minute per key, then says how many it held back', () => {
    const { lines, clock, log } = setup();
    log.line('bad-proof', 'refused a');
    log.line('bad-proof', 'refused b');
    log.line('bad-proof', 'refused c');
    expect(lines).toEqual(['refused a']);
    clock.now = 60_000;
    log.line('bad-proof', 'refused d');
    expect(lines).toEqual(['refused a', 'refused d (and 2 more in the last minute)']);
  });

  it('keeps keys apart, so a flood of one reason does not hide another', () => {
    const { lines, log } = setup();
    log.line('bad-proof', 'refused a');
    log.line('bad-proof', 'refused b');
    log.line('code-expired', 'expired');
    expect(lines).toEqual(['refused a', 'expired']);
  });
});
