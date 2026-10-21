// A log that writes at most `max` lines per window and then says how many it dropped, so a flood
// cannot fill the journal (and push out what journald's own rate limit would keep).
export interface LineBudget {
  max: number;
  windowMs: number;
  now?: () => number;
}

export function lineBudget(write: (line: string) => void, budget: LineBudget): (line: string) => void {
  const now = budget.now ?? Date.now;
  let start = -Infinity;
  let written = 0;
  let dropped = 0;
  return (line) => {
    const at = now();
    if (at - start >= budget.windowMs) {
      if (dropped > 0) write(`relay trace: ${dropped} lines dropped in the last minute`);
      start = at;
      written = 0;
      dropped = 0;
    }
    if (written >= budget.max) {
      dropped += 1;
      return;
    }
    written += 1;
    write(line);
  };
}
