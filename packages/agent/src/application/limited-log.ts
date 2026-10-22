const EVERY_MS = 60_000;

// A line a stranger can trigger as fast as the relay lets them through: the journal gets one a
// minute for each key, so a stream of bad attempts cannot fill it nor hide the owner's own.
export class LimitedLog {
  private readonly entries = new Map<string, { last: number; held: number }>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly now: () => number,
    private readonly everyMs = EVERY_MS,
  ) {}

  line(key: string, text: string): void {
    const now = this.now();
    const entry = this.entries.get(key) ?? { last: -Infinity, held: 0 };
    if (now - entry.last >= this.everyMs) {
      const held = entry.held ? ` (and ${entry.held} more in the last minute)` : '';
      this.log(`${text}${held}`);
      this.entries.set(key, { last: now, held: 0 });
    } else {
      this.entries.set(key, { ...entry, held: entry.held + 1 });
    }
  }
}
